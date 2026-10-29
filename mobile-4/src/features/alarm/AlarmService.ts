/**
 * AlarmService — the only thing the alarm screens talk to for alarms. It owns:
 *   - the alarms themselves (saved on this device; no backend is involved),
 *   - scheduling them with the platform (an `AlarmScheduler`, below),
 *   - turning "an alarm went off" into opening the challenge (`/alarm/ring/{id}`),
 *   - recording a defeated alarm (local history → streak).
 *
 * Platform reality, stated honestly:
 *   - iOS / Android today: a scheduled LOCAL NOTIFICATION (expo-notifications, daily trigger) rings
 *     with the notification sound; tapping it opens the challenge. If the app is open, the
 *     challenge opens straight away. The OS lets people swipe a notification away, and an app
 *     can't force itself open, so this is not yet a true system alarm.
 *   - Web: alarms fire only while the app is open in a tab (an in-page timer).
 *
 * NATIVE INTEGRATION POINT — a real system alarm (`NativeAlarmScheduler`): Android AlarmManager
 * `setAlarmClock` + a full-screen-intent notification that launches straight into the challenge,
 * and iOS AlarmKit (iOS 26+) / a time-sensitive notification with a critical-alert entitlement.
 * Both need a config plugin + native module (development build). Implement `AlarmScheduler` with
 * it and return it from `pickScheduler()`; the screens don't change.
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { nextFireAt, formatClock, type ClockTime } from '@/logic/alarmTime';
import { challengeById, challengeSummary, type ChallengeId } from '@/logic/movementChallenges';

export type Alarm = {
  id: string;
  time: ClockTime;
  enabled: boolean;
  challenge: ChallengeId;
  /** Seconds or reps, per the challenge's unit. */
  amount: number;
  label: string | null;
  createdAt: string;
};

export type AlarmDraft = Omit<Alarm, 'id' | 'createdAt'> & { id?: string };

export type SchedulerKind = 'notification' | 'in-app' | 'native';
export type SchedulerInfo = {
  kind: SchedulerKind;
  /** One honest line for the setup screen. */
  note: string;
};

/** How alarms reach the platform. One implementation is active per device. */
export interface AlarmScheduler {
  readonly info: SchedulerInfo;
  /** Ask for whatever the scheduler needs (notification permission). */
  ensurePermission(): Promise<'granted' | 'denied'>;
  schedule(alarm: Alarm): Promise<void>;
  cancel(alarmId: string): Promise<void>;
}

export const ALARM_ROUTE = (id: string) => `/alarm/ring/${encodeURIComponent(id)}`;
const NOTIFICATION_KIND = 'movement-alarm';
const CHANNEL = 'movement-alarm';

// ---------------------------------------------------------------------------------------------
// Storage (this device only)
// ---------------------------------------------------------------------------------------------

const KEY = 'squirrel.alarms.v1';
const HISTORY_KEY = 'squirrel.alarms.history.v1';
const store = {
  get: async (k: string) => {
    try {
      return Platform.OS === 'web' ? globalThis.localStorage?.getItem(k) ?? null : await SecureStore.getItemAsync(k);
    } catch {
      return null;
    }
  },
  set: async (k: string, v: string) => {
    try {
      if (Platform.OS === 'web') globalThis.localStorage?.setItem(k, v);
      else await SecureStore.setItemAsync(k, v);
    } catch {
      // storage unavailable: alarms live for this session only
    }
  },
};

let cache: Alarm[] | null = null;
const listeners = new Set<(a: Alarm[]) => void>();
const emit = () => listeners.forEach((l) => l(cache ?? []));

async function load(): Promise<Alarm[]> {
  if (cache) return cache;
  try {
    const raw = await store.get(KEY);
    const parsed = raw ? (JSON.parse(raw) as Alarm[]) : [];
    cache = Array.isArray(parsed) ? parsed.filter((a) => a && typeof a.id === 'string' && a.time) : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function save(list: Alarm[]) {
  cache = [...list].sort((a, b) => a.time.hour * 60 + a.time.minute - (b.time.hour * 60 + b.time.minute));
  await store.set(KEY, JSON.stringify(cache));
  emit();
}

// ---------------------------------------------------------------------------------------------
// Schedulers
// ---------------------------------------------------------------------------------------------

/** iOS / Android: a daily local notification that opens the challenge. */
class NotificationAlarmScheduler implements AlarmScheduler {
  readonly info: SchedulerInfo = {
    kind: 'notification',
    note: 'Rings as a notification. Tap it and the challenge opens — it only stops once you’ve moved.',
  };
  private channelReady = false;

  async ensurePermission() {
    const cur = await Notifications.getPermissionsAsync();
    if (cur.granted) return 'granted' as const;
    if (!cur.canAskAgain) return 'denied' as const;
    const next = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
    return next.granted ? ('granted' as const) : ('denied' as const);
  }

  private async channel() {
    if (this.channelReady || Platform.OS !== 'android') return;
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: 'Movement alarms',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'default',
      vibrationPattern: [0, 600, 300, 600, 300, 600],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: false,
    });
    this.channelReady = true;
  }

  async schedule(alarm: Alarm) {
    await this.cancel(alarm.id);
    if (!alarm.enabled) return;
    await this.channel();
    const c = challengeById(alarm.challenge);
    await Notifications.scheduleNotificationAsync({
      identifier: `alarm-${alarm.id}`,
      content: {
        title: 'WAKE UP, SQUIRREL. ⏰',
        body: `No snoozing. ${c.verb} to switch it off — ${challengeSummary(alarm.challenge, alarm.amount)}.`,
        sound: 'default',
        priority: Notifications.AndroidNotificationPriority.MAX,
        data: { kind: NOTIFICATION_KIND, alarmId: alarm.id, route: ALARM_ROUTE(alarm.id) },
        ...(Platform.OS === 'ios' ? { interruptionLevel: 'timeSensitive' as const } : {}),
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: alarm.time.hour, minute: alarm.time.minute, channelId: CHANNEL },
    });
  }

  async cancel(alarmId: string) {
    await Notifications.cancelScheduledNotificationAsync(`alarm-${alarmId}`).catch(() => {});
  }
}

/** Web: rings only while the app is open in a tab. */
class InAppAlarmScheduler implements AlarmScheduler {
  readonly info: SchedulerInfo = {
    kind: 'in-app',
    note: 'On the web, alarms only ring while Squirrel Social is open in a tab. Use the phone app for real wake-ups.',
  };
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  async ensurePermission() {
    return 'granted' as const;
  }

  async schedule(alarm: Alarm) {
    await this.cancel(alarm.id);
    if (!alarm.enabled) return;
    const arm = () => {
      // setTimeout drifts on long waits / sleeping tabs: re-arm in ≤ 1-minute hops and fire on time.
      const wait = nextFireAt(alarm.time).getTime() - Date.now();
      const t = setTimeout(
        () => {
          if (wait <= 60_000) {
            fire(alarm.id);
            setTimeout(arm, 61_000);
          } else arm();
        },
        Math.min(wait, 60_000),
      );
      this.timers.set(alarm.id, t);
    };
    arm();
  }

  async cancel(alarmId: string) {
    const t = this.timers.get(alarmId);
    if (t) clearTimeout(t);
    this.timers.delete(alarmId);
  }
}

function pickScheduler(): AlarmScheduler {
  // NATIVE INTEGRATION POINT: return a NativeAlarmScheduler here once the native module exists.
  return Platform.OS === 'web' ? new InAppAlarmScheduler() : new NotificationAlarmScheduler();
}

const scheduler: AlarmScheduler = pickScheduler();

// ---------------------------------------------------------------------------------------------
// Firing → challenge
// ---------------------------------------------------------------------------------------------

type FireHandler = (route: string, alarmId: string) => void;
let onFire: FireHandler | null = null;
let pendingRoute: { route: string; alarmId: string } | null = null;
/** Alarms currently ringing on screen, so a repeat trigger doesn't stack challenges. */
const ringing = new Set<string>();

function fire(alarmId: string) {
  if (ringing.has(alarmId)) return;
  const route = ALARM_ROUTE(alarmId);
  if (onFire) onFire(route, alarmId);
  else pendingRoute = { route, alarmId };
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export type AlarmHistoryEntry = { alarmId: string; challenge: ChallengeId; amount: number; defeatedAt: string; secondsToDefeat: number; usedBackup: boolean };

export const AlarmService = {
  scheduler: scheduler.info,

  list: () => load(),

  subscribe(fn: (a: Alarm[]) => void): () => void {
    listeners.add(fn);
    void load().then(fn);
    return () => listeners.delete(fn);
  },

  async get(id: string): Promise<Alarm | null> {
    return (await load()).find((a) => a.id === id) ?? null;
  },

  /** Create or update. Returns the saved alarm and whether the platform permission is in place. */
  async save(draft: AlarmDraft): Promise<{ alarm: Alarm; permission: 'granted' | 'denied' }> {
    const list = await load();
    const existing = draft.id ? list.find((a) => a.id === draft.id) : undefined;
    const c = challengeById(draft.challenge);
    const alarm: Alarm = {
      id: existing?.id ?? `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      time: { hour: Math.max(0, Math.min(23, draft.time.hour)), minute: Math.max(0, Math.min(59, draft.time.minute)) },
      enabled: draft.enabled,
      challenge: c.id,
      amount: c.amounts.includes(draft.amount) ? draft.amount : c.defaultAmount,
      label: draft.label?.trim() || null,
    };
    const permission = alarm.enabled ? await scheduler.ensurePermission().catch(() => 'denied' as const) : 'granted';
    await save(existing ? list.map((a) => (a.id === alarm.id ? alarm : a)) : [...list, alarm]);
    if (permission === 'granted') await scheduler.schedule(alarm).catch(() => {});
    return { alarm, permission };
  },

  async setEnabled(id: string, enabled: boolean) {
    const a = await AlarmService.get(id);
    if (!a) return null;
    return AlarmService.save({ ...a, enabled });
  },

  async remove(id: string) {
    await scheduler.cancel(id).catch(() => {});
    await save((await load()).filter((a) => a.id !== id));
  },

  /** Re-register every enabled alarm with the platform (app start; also repairs a cleared schedule). */
  async resync() {
    for (const a of await load()) {
      if (a.enabled) await scheduler.schedule(a).catch(() => {});
      else await scheduler.cancel(a.id).catch(() => {});
    }
  },

  /** The root layout registers how to open a ringing alarm; one that fired earlier is delivered now. */
  setFireHandler(fn: FireHandler | null) {
    onFire = fn;
    if (fn && pendingRoute) {
      const p = pendingRoute;
      pendingRoute = null;
      fn(p.route, p.alarmId);
    }
  },

  /** A notification (foreground or tapped) belongs to the alarm system? Returns its alarm id. */
  alarmIdOf(data: unknown): string | null {
    const d = data as { kind?: unknown; alarmId?: unknown } | null | undefined;
    return d && d.kind === NOTIFICATION_KIND && typeof d.alarmId === 'string' ? d.alarmId : null;
  },

  fire,

  markRinging(id: string, on: boolean) {
    if (on) ringing.add(id);
    else ringing.delete(id);
  },

  /** The challenge was beaten: clear the delivered notification and remember it for the streak. */
  async defeated(entry: AlarmHistoryEntry) {
    ringing.delete(entry.alarmId);
    if (Platform.OS !== 'web') await Notifications.dismissAllNotificationsAsync().catch(() => {});
    const raw = await store.get(HISTORY_KEY);
    let hist: AlarmHistoryEntry[] = [];
    try {
      hist = raw ? (JSON.parse(raw) as AlarmHistoryEntry[]) : [];
    } catch {
      hist = [];
    }
    hist = [entry, ...hist].slice(0, 120);
    await store.set(HISTORY_KEY, JSON.stringify(hist));
    return { streak: streakOf(hist), total: hist.length };
  },

  async history(): Promise<AlarmHistoryEntry[]> {
    try {
      const raw = await store.get(HISTORY_KEY);
      return raw ? (JSON.parse(raw) as AlarmHistoryEntry[]) : [];
    } catch {
      return [];
    }
  },

  label: (a: Pick<Alarm, 'time'>) => formatClock(a.time),
};

/** Consecutive days (ending today or yesterday) with at least one defeated alarm. */
export function streakOf(hist: AlarmHistoryEntry[], now = new Date()): number {
  const days = new Set(hist.map((h) => new Date(h.defeatedAt).toDateString()));
  let streak = 0;
  const d = new Date(now);
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1);
  while (days.has(d.toDateString())) {
    streak += 1;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}
