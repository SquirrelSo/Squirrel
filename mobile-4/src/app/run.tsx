/**
 * RUN / WALK. Start → live GPS route on the campus map → stop → summary (distance, duration,
 * route, zones interacted with, zones eligible to claim + the action where the backend allows).
 *
 * A run never claims anything by itself. Zone eligibility, claim / steal / defend availability
 * and ownership all come from the backend after the activity is recorded.
 *
 * Handles: permission denied/blocked, location services off, weak GPS, no fix, a single
 * background location task with a foreground-only fallback, discard, and resumable upload retry.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Animated, AppState as RNAppState, Easing, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import Constants, { AppOwnership } from 'expo-constants';
import { Scene } from '@/art/Scene';
import { RunRoute } from '@/art/CityMap';
import { Mascot } from '@/art/Mascot';
import { campusApi, CAMPUS_MAP_ON_SERVICE, CAMPUS_SOURCE, type ActivityType, type LatLng } from '@/api/campus';
import { formatArea, rejectionText, submitRun, TERMINAL_STATUSES, xpApi, type RunSummary } from '@/api/endpoints';
import { useAuth } from '@/auth/AuthProvider';
import { CampusMap } from '@/components/campus/CampusMap';
import { RunZones, type RunZonesState } from '@/components/campus/RunZones';
import { Button, Display, Icon, IconButton, Kicker, NATIVE, Pulse, Segmented, tap } from '@/components/ui';
import { useMe, useTerritorySync, useZones } from '@/hooks/useCampus';
import { DEMO_SPEED, demoPosition } from '@/logic/demoRoute';
import { localVerdict, MAX_ACCURACY_M, type Fix, type Verdict } from '@/logic/track';
import {
  addRunTrackingFix,
  BACKGROUND_LOCATION_OPTIONS,
  beginRunTracking,
  clearRunTracking,
  endRunTracking,
  getRunTrackingSnapshot,
  noteRunLocationFix,
  prepareRunTracking,
  RUN_LOCATION_TASK,
  setRunTrackingPaused,
  subscribeRunTracking,
  waitForRunTrackingStartupCleanup,
} from '@/logic/runTracking';
import { uploadAndClearOnSuccess } from '@/logic/uploadLifecycle';
import { recordedRunReason } from '@/logic/runOutcome';
import { useApp, type FinishRunResult } from '@/state/AppState';
import { StatusBar } from 'expo-status-bar';
import { alpha, colors, fonts, MAX_WIDTH, radius, statusBarStyle } from '@/theme';

const two = (n: number) => String(Math.floor(n)).padStart(2, '0');
const fmtPace = (secPerKm: number) => (Number.isFinite(secPerKm) && secPerKm > 0 ? `${Math.floor(secPerKm / 60)}'${two(secPerKm % 60)}"` : `--'--"`);
const fmtClock = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${two((s % 3600) / 60)}:${two(s % 60)}` : `${two(s / 60)}:${two(s % 60)}`);

type Phase = 'setup' | 'countdown' | 'running' | 'paused' | 'uploading' | 'done';
type Perm = 'checking' | 'undetermined' | 'granted' | 'denied' | 'blocked' | 'approximate' | 'services_off' | 'web';
/** The demo route always starts from zero: 0.00 km, 0:00. */
const DEMO_START = 0;

/** Approximate (coarse / reduced-accuracy) location can't record a reliable route or claim territory. */
function isApproximate(p: Location.LocationPermissionResponse) {
  if (Platform.OS === 'android') return p.android?.accuracy != null && p.android.accuracy !== 'fine';
  if (Platform.OS === 'ios') return p.ios?.accuracy === 'reduced';
  return false;
}
type Outcome = Verdict | 'processing';
type Source = 'gps' | 'demo';
const STAGE_TEXT = { uploading: 'Uploading your route…', finishing: 'Closing it out…', polling: 'Verifying your activity…' } as const;
const KINDS = ['Run', 'Walk'] as const;

const VERDICT_UI: Record<Outcome, { label: string; icon: React.ComponentProps<typeof Icon>['name']; color: string }> = {
  accepted: { label: 'Activity accepted', icon: 'check-decagram', color: colors.primary },
  flagged: { label: 'Flagged for review', icon: 'alert-decagram', color: colors.gold },
  rejected: { label: 'Activity rejected', icon: 'close-octagon', color: colors.coral },
  processing: { label: 'Still processing', icon: 'progress-clock', color: colors.dim },
};

/** Backoff for re-reading zones while campus-service verifies an activity. */
const ZONE_POLL_MS = [3000, 5000, 8000, 13000, 20000];
const VERIFYING_NOTE = 'The campus is still verifying your GPS. Zones appear here as soon as it’s done — this usually takes a few seconds.';
const APP_RESUME_TIMEOUT_MS = 5000;

/** Wait briefly for permission dialogs or Settings to return the app to the foreground. */
function waitForAppToBecomeActive(timeoutMs = APP_RESUME_TIMEOUT_MS): Promise<boolean> {
  if (RNAppState.currentState === 'active') return Promise.resolve(true);
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (active: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      subscription.remove();
      resolve(active);
    };
    const subscription = RNAppState.addEventListener('change', (state) => {
      if (state === 'active') finish(true);
    });
    timeout = setTimeout(() => finish(RNAppState.currentState === 'active'), timeoutMs);
    if (RNAppState.currentState === 'active') finish(true);
  });
}

type Summary = FinishRunResult & { verdict: Outcome; reason: string; km: number; time: string; pace: string; uploadNote?: string; areaText?: string; uploadFailed?: boolean };

export default function Run() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const params = useLocalSearchParams<{ type?: string }>();
  const { finishRun, toast, syncServerXp } = useApp();
  const auth = useAuth();
  const live = auth.mode === 'live';
  const zones = useZones();
  const me = useMe();
  useTerritorySync();
  const meId = me.data?.user_id ?? null;

  const [kind, setKind] = useState<ActivityType>(params.type === 'walk' ? 'walk' : 'run');
  const [phase, setPhase] = useState<Phase>('setup');
  const [count, setCount] = useState(3);
  const [perm, setPerm] = useState<Perm>(Platform.OS === 'web' ? 'web' : 'checking');
  const [source, setSource] = useState<Source | null>(null);
  const [sec, setSec] = useState(0);
  const tracking = useSyncExternalStore(subscribeRunTracking, getRunTrackingSnapshot, getRunTrackingSnapshot);
  const track = tracking.track;
  const [finishedPoints, setFinishedPoints] = useState<Fix[] | null>(null);
  const [finishedMovingSec, setFinishedMovingSec] = useState<number | null>(null);
  const [, setBackgroundAvailable] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [zonesState, setZonesState] = useState<RunZonesState>({ status: 'idle' });
  const [zonePolls, setZonePolls] = useState(0);
  const [stage, setStage] = useState<keyof typeof STAGE_TEXT>('uploading');
  const [canSkipWait, setCanSkipWait] = useState(false);

  const pollAbort = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
  const activityIdRef = useRef<string | null>(null);
  const startedAt = useRef(0);
  const pausedAt = useRef(0);
  const pausedTotalMs = useRef(0);
  const endedAt = useRef(0);
  const phaseRef = useRef<Phase>('setup');
  const sourceRef = useRef<Source | null>(null);
  const backgroundAvailableRef = useRef(false);
  const backgroundPermissionRequestedRef = useRef(false);
  const startInProgressRef = useRef(false);
  const demoMeters = useRef(0);
  const lastKmMarker = useRef(0);
  const [progress] = useState(() => new Animated.Value(0.2));
  const [pop] = useState(() => new Animated.Value(0));
  const setBackgroundCapability = (available: boolean) => {
    backgroundAvailableRef.current = available;
    setBackgroundAvailable(available);
  };
  const elapsedSeconds = (at = Date.now()) => {
    const end = pausedAt.current ? Math.min(at, pausedAt.current) : at;
    return Math.max(0, Math.floor((end - startedAt.current - pausedTotalMs.current) / 1000));
  };
  useEffect(() => {
    phaseRef.current = phase;
    sourceRef.current = source;
  });
  useEffect(() => () => pollAbort.current?.abort(), []);

  // ---- Location permission + a foreground-only fallback when background tracking is unavailable.
  const startWatch = useCallback(async () => {
    try {
      if (!(await Location.hasServicesEnabledAsync())) return setPerm('services_off');
      setPerm('granted');
      return await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 }, (loc) => {
        const acc = loc.coords.accuracy ?? null;
        const fix = { lat: loc.coords.latitude, lon: loc.coords.longitude, t: loc.timestamp, accuracy: acc };
        if (phaseRef.current === 'running' && sourceRef.current === 'gps') addRunTrackingFix(fix);
        else noteRunLocationFix(fix);
      });
    } catch {
      setPerm('services_off');
      return null;
    }
  }, []);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const foregroundWatchStartRef = useRef<Promise<boolean> | null>(null);
  const startForegroundFallback = useCallback(async () => {
    if (watchRef.current) return true;
    if (foregroundWatchStartRef.current) return foregroundWatchStartRef.current;
    const pending = (async () => {
      const subscription = await startWatch();
      watchRef.current = subscription ?? null;
      return !!subscription;
    })();
    foregroundWatchStartRef.current = pending;
    try {
      return await pending;
    } finally {
      if (foregroundWatchStartRef.current === pending) foregroundWatchStartRef.current = null;
    }
  }, [startWatch]);
  const stopForegroundFallback = useCallback(async () => {
    if (foregroundWatchStartRef.current) await foregroundWatchStartRef.current;
    watchRef.current?.remove();
    watchRef.current = null;
  }, []);
  const startBackgroundUpdates = useCallback(async () => {
    if (Platform.OS === 'web' || Constants.appOwnership === AppOwnership.Expo || !backgroundAvailableRef.current) return false;
    if (RNAppState.currentState !== 'active') return false;
    try {
      if (!(await TaskManager.isAvailableAsync())) throw new Error('Background location tasks are unavailable');
      if (RNAppState.currentState !== 'active') return false;
      if (await Location.hasStartedLocationUpdatesAsync(RUN_LOCATION_TASK)) {
        await Location.stopLocationUpdatesAsync(RUN_LOCATION_TASK);
      }
      // Recheck immediately before the native start: Android requires this foreground service
      // to be started while the app is visible, never in response to a background event.
      if (RNAppState.currentState !== 'active') return false;
      await Location.startLocationUpdatesAsync(RUN_LOCATION_TASK, BACKGROUND_LOCATION_OPTIONS);
      return true;
    } catch {
      try {
        if (await Location.hasStartedLocationUpdatesAsync(RUN_LOCATION_TASK)) {
          await Location.stopLocationUpdatesAsync(RUN_LOCATION_TASK);
        }
      } catch {
        // Fall back to the foreground watcher if the native task could not start cleanly.
      }
      setBackgroundCapability(false);
      return false;
    }
  }, []);
  const stopBackgroundUpdates = useCallback(async () => {
    try {
      if (await Location.hasStartedLocationUpdatesAsync(RUN_LOCATION_TASK)) {
        await Location.stopLocationUpdatesAsync(RUN_LOCATION_TASK);
      }
    } catch {
      // A task that already stopped needs no further cleanup.
    }
  }, []);
  const stopLocationSources = useCallback(async () => {
    await stopForegroundFallback();
    await stopBackgroundUpdates();
    endRunTracking();
  }, [stopBackgroundUpdates, stopForegroundFallback]);
  useEffect(() => () => { void stopLocationSources(); }, [stopLocationSources]);
  const configureBackgroundPermission = useCallback(async (ask: boolean) => {
    if (Platform.OS === 'web' || Constants.appOwnership === AppOwnership.Expo) {
      setBackgroundCapability(false);
      return false;
    }
    try {
      if (!(await TaskManager.isAvailableAsync())) {
        setBackgroundCapability(false);
        return false;
      }
      if (ask) backgroundPermissionRequestedRef.current = true;
      const permission = ask
        ? await Location.requestBackgroundPermissionsAsync()
        : await Location.getBackgroundPermissionsAsync();
      const allowed = permission.status === 'granted';
      setBackgroundCapability(allowed);
      return allowed;
    } catch {
      setBackgroundCapability(false);
      return false;
    }
  }, []);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    (async () => {
      try {
        const p = await Location.getForegroundPermissionsAsync();
        if (cancelled) return;
        if (p.status === 'granted' && isApproximate(p)) setPerm('approximate');
        else if (p.status === 'granted') {
          setPerm('granted');
          // Keep the GPS warm and populate the setup map until the run task takes over.
          await startForegroundFallback();
          if (cancelled) {
            await stopForegroundFallback();
            return;
          }
          await configureBackgroundPermission(false);
        } else setPerm(p.status === 'denied' ? (p.canAskAgain ? 'denied' : 'blocked') : 'undetermined');
      } catch {
        if (!cancelled) setPerm('services_off');
      }
    })();
    return () => {
      cancelled = true;
      watchRef.current?.remove();
    };
  }, [configureBackgroundPermission, startForegroundFallback, stopForegroundFallback]);

  const askPermission = async () => {
    tap();
    if (perm === 'blocked' || perm === 'approximate') return Linking.openSettings();
    const p = await Location.requestForegroundPermissionsAsync();
    if (p.status === 'granted' && isApproximate(p)) setPerm('approximate');
    else if (p.status === 'granted') {
      setPerm('granted');
      const backgroundGranted = await configureBackgroundPermission(true);
      if (!backgroundGranted) {
        await startForegroundFallback();
        setNotice('Background location is not enabled. Keep Squirrel open during your run; the route will pause when the app is backgrounded.');
      } else {
        await stopForegroundFallback();
        setNotice(null);
      }
    } else setPerm(p.canAskAgain ? 'denied' : 'blocked');
  };

  // ---- Countdown
  useEffect(() => {
    if (phase !== 'countdown') return;
    pop.setValue(0);
    Animated.timing(pop, { toValue: 1, duration: 800, easing: Easing.out(Easing.back(2)), useNativeDriver: NATIVE }).start();
    const t = setTimeout(() => {
      if (count <= 1) {
        tap('success');
        startedAt.current = Date.now();
        pausedAt.current = 0;
        pausedTotalMs.current = 0;
        beginRunTracking(sourceRef.current ?? 'gps', startedAt.current);
        setPhase('running');
      } else {
        tap('impact');
        setCount(count - 1);
      }
    }, 850);
    return () => clearTimeout(t);
  }, [phase, count, pop]);

  // ---- Clock (+ demo movement, + no-fix detection)
  useEffect(() => {
    if (phase !== 'running') return;
    const id = setInterval(() => {
      setSec(elapsedSeconds());
      if (sourceRef.current === 'demo') {
        demoMeters.current += DEMO_SPEED[kind];
        const [lat, lon] = demoPosition(demoMeters.current);
        addRunTrackingFix({ lat, lon, t: Date.now(), accuracy: 5 });
      } else if (Date.now() - getRunTrackingSnapshot().lastFixAt > 20_000) {
        setNotice('No GPS fix for 20 s. Head into open sky — distance only counts with a location fix.');
      }
    }, 1000);
    return () => clearInterval(id);
  }, [phase, kind]);

  const currentFix = tracking.latestFix;
  const here: LatLng | null = currentFix ? [currentFix.lat, currentFix.lon] : null;
  const accuracy = currentFix?.accuracy ?? null;
  const km = track.meters / 1000;
  const movingSec = track.movingSec;
  const paceSec = km >= 0.05 ? movingSec / km : NaN;
  const time = fmtClock(sec);
  const kcal = Math.round(km * (kind === 'walk' ? 55 : 80.5));
  const displayedPoints = finishedPoints ?? track.points;
  const route = useMemo(() => displayedPoints.map((p) => [p.lat, p.lon] as LatLng), [displayedPoints]);
  const weak = source === 'gps' && accuracy != null && accuracy > MAX_ACCURACY_M;

  useEffect(() => {
    if (phase !== 'running') return;
    const whole = Math.floor(km);
    if (whole > lastKmMarker.current && whole > 0) {
      lastKmMarker.current = whole;
      tap('success');
      toast(`${whole} km! 🎉`, 'flag-checkered', colors.gold);
    }
  }, [km, phase, toast]);
  useEffect(() => {
    Animated.timing(progress, { toValue: Math.min(1, 0.2 + (km % 1) * 0.8), duration: 900, useNativeDriver: false }).start();
  }, [km, progress]);

  const start = async (src: Source) => {
    if (startInProgressRef.current) return;
    startInProgressRef.current = true;
    try {
      // BG-2 cleanup runs at module load without holding app startup; serialize run start behind it.
      await waitForRunTrackingStartupCleanup();
      // A real activity needs precise location permission — never start one without it.
      if (src === 'gps' && perm !== 'granted') return;
      let backgroundReady = src === 'gps' && backgroundAvailableRef.current;
      let backgroundFailure: 'permission' | 'app_resume' | null = null;
      if (src === 'gps' && !backgroundReady && !backgroundPermissionRequestedRef.current) {
        // Ask for Always/background permission while the run screen is still foregrounded.
        backgroundReady = await configureBackgroundPermission(true);
        if (!backgroundReady) backgroundFailure = 'permission';
      }
      if (src === 'gps' && backgroundReady) {
        // The OS may leave the app inactive while the permission dialog or Settings is open.
        // Give it up to five seconds to foreground before starting the native foreground service.
        if (!(await waitForAppToBecomeActive())) {
          backgroundReady = false;
          backgroundFailure = 'app_resume';
        }
      }
      if (src === 'gps' && backgroundReady) {
        await stopForegroundFallback();
        // This is the only startLocationUpdatesAsync path and it is called from the foreground
        // Start action, after an AppState check inside startBackgroundUpdates.
        backgroundReady = await startBackgroundUpdates();
        if (!backgroundReady) {
          backgroundFailure = RNAppState.currentState === 'active' ? 'permission' : 'app_resume';
        }
      }
      if (src === 'gps' && !backgroundReady) await startForegroundFallback();
      if (src === 'demo') {
        await stopForegroundFallback();
        await stopBackgroundUpdates();
      }
      tap('impact');
      setSource(src);
      prepareRunTracking(src);
      setFinishedPoints(null);
      setFinishedMovingSec(null);
      setSec(src === 'demo' ? DEMO_START : 0);
      demoMeters.current = DEMO_START;
      lastKmMarker.current = 0;
      setNotice(src === 'gps' && !backgroundReady
        ? backgroundFailure === 'app_resume'
          ? 'Squirrel is still returning to the foreground. Keep the app open during your run; background tracking did not start.'
          : 'Background location is not enabled. Keep Squirrel open during your run; the route will pause when the app is backgrounded.'
        : null);
      setCount(3);
      setPhase('countdown');
    } finally {
      startInProgressRef.current = false;
    }
  };

  const toggleManualPause = () => {
    tap('impact');
    if (phase === 'running') {
      const now = Date.now();
      pausedAt.current = now;
      setSec(elapsedSeconds(now));
      setRunTrackingPaused(true);
      setPhase('paused');
    } else if (phase === 'paused') {
      if (pausedAt.current) pausedTotalMs.current += Date.now() - pausedAt.current;
      pausedAt.current = 0;
      setRunTrackingPaused(false);
      setPhase('running');
    }
  };

  // ---- Zones: recorded activity → backend eligibility (never inferred here)
  const loadZones = useCallback(async () => {
    setZonesState({ status: 'loading' });
    setZonePolls(0);
    try {
      if (CAMPUS_SOURCE === 'off') return setZonesState({ status: 'unavailable', note: 'Zone claiming switches on when the campus backend goes live.' });
      const points = finishedPoints ?? track.points;
      // campus-service decides zones from GPS it verifies itself and doesn't know Run Module run
      // ids, so the same points go to it one-shot, after (never instead of) the Run Module upload.
      // Only real, signed-in GPS activities: a demo route never reaches real territory.
      const toCampusService = CAMPUS_MAP_ON_SERVICE && live && sourceRef.current === 'gps' && points.length > 1;
      let id = CAMPUS_MAP_ON_SERVICE ? activityIdRef.current : (activityIdRef.current ?? runIdRef.current);
      if ((CAMPUS_SOURCE === 'mock' || toCampusService) && !activityIdRef.current) {
        // The dev mock and campus-service record the route themselves; the Run Module keeps its own copy.
        const pts = points.map((p) => ({ lat: p.lat, lng: p.lon, recorded_at: new Date(p.t).toISOString(), accuracy_m: p.accuracy ?? 10 }));
        const r = await campusApi.submitActivity({ type: kind, started_at: new Date(startedAt.current).toISOString(), ended_at: new Date(endedAt.current).toISOString(), points: pts });
        activityIdRef.current = r.activity_id;
        id = r.activity_id;
      }
      if (!id) {
        return setZonesState({
          status: 'unavailable',
          note:
            sourceRef.current === 'demo'
              ? 'Demo activities (no GPS) can’t unlock zones.'
              : CAMPUS_MAP_ON_SERVICE && !live
                ? 'Sign in to unlock zones — the campus checks your route once it has it.'
                : 'Upload the activity first — zones are checked once the server has your route.',
        });
      }
      const data = await campusApi.activityZones(id);
      setZonesState({ status: 'ready', data, note: CAMPUS_MAP_ON_SERVICE && data.status === 'processing' ? VERIFYING_NOTE : undefined });
    } catch (e) {
      setZonesState({ status: 'error', error: e });
    }
  }, [finishedPoints, track.points, kind, live]);

  // campus-service verifies asynchronously: while it answers 'processing', look again a few times
  // (backing off, ~50 s in all), then leave it to "Check again". Never a tight loop.
  useEffect(() => {
    const d = zonesState.status === 'ready' ? zonesState.data : undefined;
    const id = activityIdRef.current;
    if (!CAMPUS_MAP_ON_SERVICE || !d || d.status !== 'processing' || !id || zonePolls >= ZONE_POLL_MS.length) return;
    let current = true;
    const t = setTimeout(async () => {
      try {
        const data = await campusApi.activityZones(id);
        if (current) setZonesState({ status: 'ready', data, note: data.status === 'processing' ? VERIFYING_NOTE : undefined });
      } catch {
        // Keep "still verifying" on screen; the next look (or Check again) tries again.
      }
      if (current) setZonePolls((n) => n + 1);
    }, ZONE_POLL_MS[zonePolls]);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [zonesState, zonePolls]);

  // ---- Upload to the Run Module (live), resumable
  const upload = useCallback(async (fixes: Fix[] = track.points): Promise<Partial<Summary> & { kmFinal?: number; minutes?: number; pace?: string; serverXpTotal?: number }> => {
    setStage('uploading');
    const before = await xpApi.me().catch(() => null);
    const ctrl = new AbortController();
    pollAbort.current = ctrl;
    let skipTimer: ReturnType<typeof setTimeout> | undefined;
    const r: RunSummary = await submitRun(startedAt.current, fixes, {
      signal: ctrl.signal,
      runId: runIdRef.current ?? undefined,
      onCreated: (id) => (runIdRef.current = id),
      activityType: kind,
      onStage: (st) => {
        setStage(st);
        if (st === 'polling') skipTimer = setTimeout(() => setCanSkipWait(true), 15_000);
      },
    }).finally(() => {
      clearTimeout(skipTimer);
      setCanSkipWait(false);
    });
    const out: Partial<Summary> & { kmFinal?: number; minutes?: number; pace?: string; serverXpTotal?: number } = {};
    if (r.stats?.distance_m != null) out.kmFinal = +(r.stats.distance_m / 1000).toFixed(2);
    if (r.stats?.moving_time_s != null) {
      out.minutes = Math.round(r.stats.moving_time_s / 60);
      out.pace = fmtPace((out.kmFinal ?? km) > 0 ? r.stats.moving_time_s / (out.kmFinal ?? km) : NaN);
    }
    const terminal = TERMINAL_STATUSES.includes(r.status);
    const outcome: Outcome = !terminal ? 'processing' : r.status === 'finalized' ? 'accepted' : r.status === 'flagged' ? 'flagged' : 'rejected';
    out.verdict = outcome;
    // A route that encloses no ground is still a recorded activity: say why nothing was claimed.
    out.reason = outcome === 'rejected' ? rejectionText(r.rejection) : recordedRunReason(outcome, r.territory_reason);
    const area = r.territory && typeof r.territory.area_m2 === 'number' ? r.territory.area_m2 : undefined;
    if (area != null && outcome !== 'rejected') out.areaText = `${formatArea(area)} of route area`;
    const after = terminal ? await xpApi.me().catch(() => null) : null;
    if (after) {
      out.serverXpTotal = after.xp;
      const gained = before ? Math.max(0, after.xp - before.xp) : undefined;
      if (gained != null) {
        out.xp = gained;
        out.lines = [{ label: 'Awarded by the server', xp: gained }];
      }
    }
    out.uploadNote = `Run ${r.run_id.slice(0, 8)} · ${r.status}`;
    return out;
  }, [track.points, kind, km]);

  const finish = useCallback(async () => {
    tap('success');
    endedAt.current = Date.now();
    setConfirmDiscard(false);
    const elapsedAtFinish = elapsedSeconds(endedAt.current);
    await stopLocationSources();
    const finalTrack = getRunTrackingSnapshot().track;
    const finalKm = finalTrack.meters / 1000;
    const finalMovingSec = finalTrack.movingSec;
    setFinishedPoints(finalTrack.points);
    setFinishedMovingSec(finalMovingSec);
    const finalPaceSec = finalKm >= 0.05 ? finalMovingSec / finalKm : NaN;
    let kmFinal = +finalKm.toFixed(2);
    let minutes = Math.max(1, Math.round(finalMovingSec / 60));
    let pace = fmtPace(finalPaceSec);
    const rejectedRatio = finalTrack.points.length ? finalTrack.rejected / (finalTrack.points.length + finalTrack.rejected) : 0;
    const local = source === 'demo' ? { verdict: 'accepted' as Verdict, reason: 'Demo activity — no GPS, the route is simulated.' } : localVerdict(kmFinal, finalMovingSec, rejectedRatio);
    let s: Partial<Summary> = { verdict: local.verdict, reason: local.reason };
    let serverXpTotal: number | undefined;
    if (live && source === 'gps' && finalTrack.points.length > 1) {
      setPhase('uploading');
      try {
        const u = await uploadAndClearOnSuccess(() => upload(finalTrack.points), clearRunTracking);
        kmFinal = u.kmFinal ?? kmFinal;
        minutes = u.minutes ?? minutes;
        pace = u.pace ?? pace;
        serverXpTotal = u.serverXpTotal;
        s = { ...s, ...u };
      } catch (e) {
        s = { ...s, uploadFailed: true, uploadNote: `Couldn’t upload (${e instanceof Error ? e.message : 'error'}). Your route is kept — retry below.` };
      }
    } else if (!live) {
      s.uploadNote = source === 'demo' ? 'Demo mode · nothing was uploaded.' : 'Not signed in · the activity stays on this phone.';
    }
    const res = finishRun({ km: kmFinal, minutes, verdict: s.verdict === 'processing' || !s.verdict ? 'accepted' : s.verdict, serverXp: s.xp, serverLines: s.lines });
    if (serverXpTotal != null) syncServerXp(serverXpTotal);
    setSummary({ ...res, ...s, xp: s.xp ?? res.xp, lines: s.lines ?? res.lines, verdict: s.verdict ?? 'accepted', reason: s.reason ?? '', km: kmFinal, time: fmtClock(elapsedAtFinish), pace } as Summary);
    setPhase('done');
  }, [source, live, finishRun, syncServerXp, stopLocationSources, upload]);

  // Zones load once the summary is up (and again after a successful retry).
  useEffect(() => {
    if (phase !== 'done' || zonesState.status !== 'idle') return;
    const t = setTimeout(() => void loadZones(), 0); // after this render, not inside it
    return () => clearTimeout(t);
  }, [phase, zonesState.status, loadZones]);

  const retryUpload = async () => {
    if (!summary) return;
    setPhase('uploading');
    try {
      const u = await uploadAndClearOnSuccess(() => upload(finishedPoints ?? track.points), clearRunTracking);
      if (u.serverXpTotal != null) syncServerXp(u.serverXpTotal);
      setSummary({ ...summary, ...u, uploadFailed: false, km: u.kmFinal ?? summary.km, pace: u.pace ?? summary.pace } as Summary);
      setZonesState({ status: 'idle' });
    } catch (e) {
      setSummary({ ...summary, uploadFailed: true, uploadNote: `Still couldn’t upload (${e instanceof Error ? e.message : 'error'}).` });
    }
    setPhase('done');
  };

  const discardConfirmed = useRef(false);
  const discard = () => {
    if (!confirmDiscard) {
      tap();
      setConfirmDiscard(true);
      return;
    }
    tap('impact');
    discardConfirmed.current = true;
    void stopLocationSources().finally(() => router.back());
  };
  // Back gesture / hardware back during an activity asks first — a run is never dropped silently.
  const navigation = useNavigation();
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e) => {
        if (discardConfirmed.current || (phaseRef.current !== 'running' && phaseRef.current !== 'paused')) return;
        e.preventDefault();
        tap();
        setConfirmDiscard(true);
      }),
    [navigation],
  );
  const close = () => (phase === 'running' || phase === 'paused' ? discard() : router.back());

  // ---- Render
  const heroH = Math.max(300, height * 0.46);
  const zoneList = zones.data ?? [];
  const gpsPill =
    source === 'demo'
      ? { text: 'Demo · simulated route', color: colors.dim }
      : perm === 'granted'
        ? accuracy == null
          ? { text: 'GPS · searching', color: colors.gold }
          : weak
            ? { text: `Weak GPS · ±${Math.round(accuracy)} m`, color: colors.orange }
            : { text: `GPS · ±${Math.round(accuracy)} m`, color: colors.primary }
        : perm === 'web'
          ? { text: 'No GPS on web', color: colors.dim }
          : perm === 'checking'
            ? { text: 'Checking location…', color: colors.dim }
            : { text: 'Location off', color: colors.coral };
  const title = kind === 'walk' ? (phase === 'setup' ? 'Walk' : 'Walking') : phase === 'setup' ? 'Run' : 'Running';

  return (
    <View style={styles.root}>
      <StatusBar style={statusBarStyle} />
      <View style={{ height: heroH }}>
        {zoneList.length ? (
          <CampusMap zones={zoneList} meId={meId} route={route} me={here} interactive={false} style={[StyleSheet.absoluteFill, { borderRadius: 0, borderWidth: 0 }]} />
        ) : (
          <>
            <Scene kind="city-night" seed={9} aspect={width / heroH} style={StyleSheet.absoluteFill} />
            <RunRoute progress={progress} style={StyleSheet.absoluteFill} />
          </>
        )}
      </View>

      <View style={[styles.overlay, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <View style={styles.header}>
          <IconButton icon={phase === 'running' || phase === 'paused' ? 'close' : 'chevron-down'} size={24} onPress={close} label={phase === 'running' || phase === 'paused' ? 'Discard activity' : 'Close'} />
          <Display size={30} color={colors.onImage} style={{ flex: 1, marginLeft: 10 }}>{title}</Display>
          <View style={[styles.gps, { borderColor: `${gpsPill.color}88` }]} accessibilityLabel={gpsPill.text}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: gpsPill.color }}>{perm === 'granted' && source !== 'demo' && <Pulse size={8} color={gpsPill.color} />}</View>
            <Text style={[styles.gpsText, { color: gpsPill.color }]}>{gpsPill.text}</Text>
          </View>
        </View>
        {(notice || weak) && phase === 'running' && (
          <Pressable onPress={() => setNotice(null)} style={styles.notice} accessibilityRole="alert">
            <Icon name={weak ? 'signal-cellular-1' : 'information-outline'} size={16} color={colors.gold} />
            <Text style={styles.noticeText}>{notice ?? `Weak GPS (±${Math.round(accuracy ?? 0)} m). Points worse than ±${MAX_ACCURACY_M} m are skipped.`}</Text>
          </Pressable>
        )}
      </View>

      {phase === 'setup' ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.col, { paddingTop: 16, paddingBottom: insets.bottom + 18 }]}>
          <Kicker>Start activity</Kicker>
          <Segmented items={KINDS} value={kind === 'walk' ? 'Walk' : 'Run'} onChange={(k) => setKind(k === 'Walk' ? 'walk' : 'run')} style={{ marginTop: 8 }} />
          <Text style={styles.setupText}>
            Your route shows on the campus map as you go. Afterwards you’ll see which zones you moved through — and any you’re eligible to claim. Crossing a zone never claims it on its own.
          </Text>
          {perm === 'granted' ? (
            <Button label={`Start ${kind}`} icon="arrow-right" onPress={() => start('gps')} style={{ marginTop: 16 }} />
          ) : perm === 'checking' ? (
            <View style={{ marginTop: 16, alignItems: 'center' }}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : (
            <View style={styles.permBox}>
              <Icon name={perm === 'services_off' ? 'map-marker-off-outline' : perm === 'web' ? 'monitor' : 'map-marker-alert-outline'} size={26} color={colors.gold} />
              <Text style={styles.permTitle}>
                {perm === 'web'
                  ? 'GPS tracking needs the phone app'
                  : perm === 'services_off'
                    ? 'Location services are off'
                    : perm === 'approximate'
                      ? 'Precise location required'
                      : perm === 'undetermined'
                        ? 'Squirrel needs your location'
                        : 'Location required'}
              </Text>
              <Text style={styles.setupText}>
                {perm === 'web'
                  ? 'The web preview can’t read GPS. You can try a demo route instead — it’s clearly marked and never counts as a real activity.'
                  : perm === 'services_off'
                    ? 'Turn on location in your phone settings, then come back.'
                    : perm === 'approximate'
                      ? 'Approximate location can’t record a reliable route. Switch Squirrel to Precise location in Settings.'
                      : perm === 'undetermined'
                        ? 'We use it only while you record, to draw your route and check which zones you moved through. Other people never see your location.'
                        : 'Turn on location permission to track your run.'}
              </Text>
              {perm === 'undetermined' && <Button label="Allow location" iconLeft="crosshairs-gps" size="md" onPress={askPermission} style={{ alignSelf: 'stretch', marginTop: 10 }} />}
              {(perm === 'denied' || perm === 'blocked' || perm === 'approximate' || perm === 'services_off') && (
                <Button label="Open settings" iconLeft="cog-outline" size="md" onPress={() => void Linking.openSettings()} style={{ alignSelf: 'stretch', marginTop: 10 }} />
              )}
              {perm === 'denied' && <Button label="Ask again" variant="ghost" size="md" onPress={askPermission} style={{ alignSelf: 'stretch', marginTop: 6 }} />}
              {/* The labelled demo is only offered where GPS can't exist (the web preview). */}
              {perm === 'web' && <Button label="Try a demo route" variant="secondary" size="md" onPress={() => start('demo')} style={{ alignSelf: 'stretch', marginTop: 8 }} />}
            </View>
          )}
        </ScrollView>
      ) : (
        <View style={[styles.col, { flex: 1, justifyContent: 'flex-end', paddingBottom: insets.bottom + 18 }]}>
          <View style={styles.panel}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center' }}>
              <Text style={styles.km}>{km.toFixed(2)}</Text>
              <Text style={styles.kmUnit}> KM</Text>
            </View>
            <View style={styles.metrics}>
              {[
                [time, 'Duration'],
                [fmtPace(paceSec), 'Pace'],
                [String(kcal), 'Calories'],
              ].map(([v, l], i) => (
                <View key={l} style={[styles.metric, i > 0 && { borderLeftWidth: 1, borderLeftColor: colors.line }]}>
                  <Text style={styles.metricV}>{v}</Text>
                  <Text style={styles.metricL}>{l}</Text>
                </View>
              ))}
            </View>
            {source === 'demo' && <Text style={styles.demoNote}>Demo route · simulated, not a real activity</Text>}
          </View>

          <View style={styles.controls}>
            <Pressable
              onPress={toggleManualPause}
              onLongPress={finish}
              disabled={phase === 'countdown' || phase === 'uploading'}
              accessibilityLabel={phase === 'running' ? 'Pause' : 'Resume'}
              accessibilityHint="Long press to finish"
              style={({ pressed }) => [styles.pauseWrap, { transform: [{ scale: pressed ? 0.94 : 1 }] }]}>
              {phase === 'running' && <Pulse size={104} color={colors.primary} />}
              <View style={styles.pause}>
                <Icon name={phase === 'running' ? 'pause' : 'play'} size={48} color={colors.onPrimary} />
              </View>
            </Pressable>
          </View>
          {phase === 'paused' ? (
            <View style={{ gap: 10, marginTop: 14 }}>
              <Button label={`Finish ${kind}`} iconLeft="flag-checkered" onPress={finish} />
              <Button label={confirmDiscard ? 'Tap again to discard — nothing is saved' : 'Discard'} variant="secondary" size="md" iconLeft="delete-outline" onPress={discard} />
            </View>
          ) : (
            <Text style={styles.hint}>{confirmDiscard ? 'Tap ✕ again to discard this activity' : 'Tap to pause · hold to finish'}</Text>
          )}
        </View>
      )}

      {phase === 'countdown' && (
        <View style={styles.overlayFull}>
          <Animated.Text style={[styles.countText, { opacity: pop, transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [2, 1] }) }] }]}>{count}</Animated.Text>
          <Text style={styles.countSub}>Get ready…</Text>
        </View>
      )}

      {phase === 'uploading' && (
        <View style={styles.overlayFull}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.countSub, { marginTop: 14 }]}>{STAGE_TEXT[stage]}</Text>
          {canSkipWait && <Button label="Don't wait" variant="secondary" size="md" onPress={() => pollAbort.current?.abort()} style={{ marginTop: 18 }} />}
        </View>
      )}

      {phase === 'done' && summary && (
        <View style={[styles.overlayFull, { justifyContent: 'flex-start', padding: 0 }]}>
          <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, alignItems: 'center' }}>
            <View style={styles.summary}>
              <Mascot pose={summary.verdict === 'rejected' ? 'sit' : 'celebrate'} size={96} animated />
              <View style={[styles.verdict, { borderColor: VERDICT_UI[summary.verdict].color }]}>
                <Icon name={VERDICT_UI[summary.verdict].icon} size={16} color={VERDICT_UI[summary.verdict].color} />
                <Text style={[styles.verdictText, { color: VERDICT_UI[summary.verdict].color }]}>{VERDICT_UI[summary.verdict].label}</Text>
              </View>
              {!!summary.reason && <Text style={styles.reason}>{summary.reason}</Text>}
              <Display size={34} style={{ marginTop: 6 }}>{summary.km.toFixed(2)} km</Display>
              <Text style={styles.sumLine}>{summary.time} · {summary.pace}/km · {kind}</Text>

              {zoneList.length > 0 && route.length > 1 && (
                <CampusMap zones={zoneList} meId={meId} route={route} interactive={false} highlight={zonesState.data?.zones.map((z) => z.zone_id)} style={styles.sumMap} />
              )}

              <RunZones state={zonesState} meId={meId} onRetry={loadZones} />

              <View style={styles.xpBox}>
                <Kicker>XP</Kicker>
                {summary.lines.map((l) => (
                  <View key={l.label} style={styles.xpRow}>
                    <Text style={styles.xpLabel}>{l.label}</Text>
                    <Text style={[styles.xpVal, l.xp < 0 && { color: colors.dim }]}>{l.xp >= 0 ? `+${l.xp}` : l.xp}</Text>
                  </View>
                ))}
                <View style={[styles.xpRow, { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, marginTop: 4 }]}>
                  <Text style={[styles.xpLabel, { color: colors.text, fontFamily: fonts.label }]}>TOTAL</Text>
                  <Text style={[styles.xpVal, { fontSize: 18 }]}>+{summary.xp} XP</Text>
                </View>
              </View>
              {summary.areaText && <Text style={styles.note}>{summary.areaText}</Text>}
              {summary.uploadNote && <Text style={[styles.note, summary.uploadFailed && { color: colors.coral }]}>{summary.uploadNote}</Text>}
              {summary.uploadFailed && <Button label="Retry upload" iconLeft="cloud-upload-outline" size="md" onPress={retryUpload} style={{ alignSelf: 'stretch', marginTop: 10 }} />}

              {summary.verdict !== 'rejected' && source !== 'demo' && (
                <Button
                  label="Share to feed"
                  iconLeft="send"
                  onPress={() => router.replace({ pathname: '/compose', params: { km: summary.km.toFixed(2), min: String(Math.round((finishedMovingSec ?? movingSec) / 60)), pace: summary.pace } })}
                  style={{ alignSelf: 'stretch', marginTop: 14 }}
                />
              )}
              <Button
                label={summary.leveledUp ? 'See level up' : 'Open campus map'}
                variant="secondary"
                size="md"
                onPress={() => (summary.leveledUp ? router.replace('/level-up') : router.replace('/explore'))}
                style={{ alignSelf: 'stretch', marginTop: 10 }}
              />
              <Button label="Done" variant="ghost" size="sm" onPress={() => router.back()} style={{ alignSelf: 'stretch', marginTop: 8 }} />
            </View>
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 16, width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center' },
  col: { paddingHorizontal: 16, width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center' },
  gps: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: alpha(colors.panel, 0.88), borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1 },
  gpsText: { fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  notice: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 10, backgroundColor: alpha(colors.panel, 0.93), borderRadius: radius.md, borderWidth: 1, borderColor: alpha(colors.gold, 0.5), padding: 10 },
  noticeText: { flex: 1, color: colors.sub, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  setupText: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, marginTop: 10, textAlign: 'left' },
  permBox: { marginTop: 16, alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 16, gap: 4 },
  permTitle: { color: colors.text, fontFamily: fonts.label, fontSize: 17, letterSpacing: 0.8, textTransform: 'uppercase', textAlign: 'center', marginTop: 4 },
  panel: { backgroundColor: colors.bg, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, paddingTop: 16, paddingBottom: 12, paddingHorizontal: 12 },
  km: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 64, lineHeight: 76, letterSpacing: 1 },
  kmUnit: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 24 },
  metrics: { flexDirection: 'row', marginTop: 8 },
  metric: { flex: 1, alignItems: 'center' },
  metricV: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 26, letterSpacing: 0.5 },
  metricL: { color: colors.dim, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  demoNote: { color: colors.dim, fontFamily: fonts.mono, fontSize: 10, textAlign: 'center', marginTop: 8 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  pauseWrap: { alignItems: 'center', justifyContent: 'center', borderRadius: 56, shadowColor: colors.primary, shadowOpacity: 0.7, shadowRadius: 24, shadowOffset: { width: 0, height: 0 }, elevation: 14 },
  pause: { width: 104, height: 104, borderRadius: 52, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  hint: { color: colors.mute, fontSize: 11, fontFamily: fonts.mono, textAlign: 'center', marginTop: 14 },
  overlayFull: { ...StyleSheet.absoluteFill, backgroundColor: alpha(colors.panel, 0.94), alignItems: 'center', justifyContent: 'center', padding: 20 },
  countText: { color: colors.primary, fontFamily: fonts.display, fontSize: 150 },
  countSub: { color: colors.onImageSub, fontFamily: fonts.mono, fontSize: 14, letterSpacing: 2, textTransform: 'uppercase' },
  summary: { width: '100%', maxWidth: 440, alignItems: 'center', backgroundColor: colors.bg2, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, padding: 16 },
  sumMap: { alignSelf: 'stretch', height: 200, marginTop: 12 },
  verdict: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1.5, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 5, marginTop: 4 },
  verdictText: { fontFamily: fonts.label, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  reason: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, marginTop: 6, textAlign: 'center' },
  sumLine: { color: colors.sub, fontFamily: fonts.mono, fontSize: 13 },
  xpBox: { alignSelf: 'stretch', marginTop: 12, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 12, gap: 6 },
  xpRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  xpLabel: { color: colors.sub, fontFamily: fonts.regular, fontSize: 13 },
  xpVal: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 15 },
  note: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11, textAlign: 'center', marginTop: 8 },
});
