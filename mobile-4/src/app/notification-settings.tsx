/**
 * NOTIFICATION SETTINGS — per category push / in-app switches and quiet hours, from Social
 * (GET·PATCH /v1/notifications/preferences, api/notificationPrefs.ts). The server decides delivery;
 * a switch shows its new value straight away and goes back (with a toast) if the save fails.
 * Announcements (`system`) can't be turned off. Reached from the gear on the notifications list.
 */
import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { errorCode, errorText } from '@/api/campus';
import type { NotificationCategory, NotificationPreferences, NotificationPreferencesPatch } from '@/api/featureContracts';
import { notificationPrefsApi } from '@/api/notificationPrefs';
import { TimePicker } from '@/components/alarm/AlarmParts';
import { EmptyNote, ErrorState, LoadingRows } from '@/components/campus/States';
import { Button, Card, Header, Icon, Screen, SectionHeader, tap } from '@/components/ui';
import { useCampus } from '@/hooks/useCampus';
import { applyToggle, CATEGORIES, CATEGORY_TEXT, isMutable, quietHoursError, quietHoursPatch, quietHoursText, toClock, toMinutes, togglePatch, type Channel } from '@/logic/notificationPrefs';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';

/** Where the quiet-hours pickers start when they're first turned on (nothing is saved until Save). */
const QUIET_START = 22 * 60;
const QUIET_END = 7 * 60;

export default function NotificationSettings() {
  const { toast } = useApp();
  const r = useCampus<NotificationPreferences>('notification-prefs', () => notificationPrefsApi.get());
  // Saves in flight, per switch ("bubble:push") or "quiet": that control waits for its answer.
  const [saving, setSaving] = useState<Set<string>>(() => new Set());

  // The latest preferences, for undoing one failed change without undoing another saved meanwhile.
  const latest = useRef(r.data);
  useEffect(() => {
    latest.current = r.data;
  });

  /** Shows `change` now, saves `patch`, then shows the server's answer — or applies `undo`. */
  const save = async (key: string, patch: NotificationPreferencesPatch, change: (p: NotificationPreferences) => NotificationPreferences, undo: (p: NotificationPreferences) => NotificationPreferences): Promise<boolean> => {
    if (!latest.current || saving.has(key)) return false;
    setSaving((s) => new Set(s).add(key));
    r.mutate((latest.current = change(latest.current)));
    try {
      r.mutate((latest.current = await notificationPrefsApi.update(patch)));
      return true;
    } catch (e) {
      if (latest.current) r.mutate((latest.current = undo(latest.current)));
      toast(errorCode(e) === 'not_mutable' ? 'Announcements can’t be turned off.' : `Not saved: ${errorText(e)}`, 'alert-circle-outline', colors.coral);
      return false;
    } finally {
      setSaving((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  };

  const toggle = (c: NotificationCategory, channel: Channel, value: boolean) => {
    const p = r.data;
    const patch = togglePatch(c, channel, value);
    if (!p || !patch || !isMutable(p, c)) return;
    tap();
    void save(`${c}:${channel}`, patch, (x) => applyToggle(x, c, channel, value), (x) => applyToggle(x, c, channel, !value));
  };

  return (
    <Screen tabBar={false}>
      <Header back title="Settings" subtitle="Notifications" />
      {r.signedOut ? (
        <EmptyNote icon="account-lock-outline" title="Sign in to change notifications" action="Sign in" onAction={() => router.push('/sign-in')} />
      ) : r.error && !r.data ? (
        <ErrorState cause={r.cause} onRetry={r.reload} feature="Notification settings" />
      ) : !r.data ? (
        <LoadingRows rows={5} height={72} style={{ marginTop: 12 }} />
      ) : (
        <>
          <QuietHours prefs={r.data} busy={saving.has('quiet')} onSave={(start, end) => {
            const patch = quietHoursPatch(start, end);
            const was = { quiet_hours_start: r.data!.quiet_hours_start, quiet_hours_end: r.data!.quiet_hours_end };
            return patch ? save('quiet', patch, (x) => ({ ...x, quiet_hours_start: start, quiet_hours_end: end }), (x) => ({ ...x, ...was })) : Promise.resolve(false);
          }} />

          <SectionHeader title="What reaches you" style={{ marginTop: 22 }} />
          <View style={styles.legend}>
            <Text style={[styles.small, { flex: 1 }]}>{Platform.OS === 'web' ? 'In-app off: notifications don’t arrive in your in-app list.' : 'In-app off: it doesn’t arrive at all. Push off: it’s in this list, without buzzing your phone.'}</Text>
          </View>
          <View style={{ gap: 10, marginTop: 10 }}>
            {CATEGORIES.map((c) => {
              const ch = r.data!.categories[c];
              if (!ch) return null;
              const locked = !isMutable(r.data!, c);
              return (
                <Card key={c} style={styles.row}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.label}>{CATEGORY_TEXT[c].label}</Text>
                    <Text style={styles.small}>{locked ? 'Can’t be turned off' : CATEGORY_TEXT[c].hint}</Text>
                  </View>
                  {locked ? (
                    <View style={styles.locked} accessibilityLabel={`${CATEGORY_TEXT[c].label}: always on, can’t be turned off`}>
                      <Icon name="lock-outline" size={16} color={colors.dim} />
                      <Text style={styles.lockedText}>Always on</Text>
                    </View>
                  ) : (
                    <View style={styles.switches}>
                      {(Platform.OS === 'web' ? (['in_app'] as const) : (['push', 'in_app'] as const)).map((channel) => (
                        <View key={channel} style={styles.switchCol}>
                          <Switch
                            value={ch[channel]}
                            disabled={saving.has(`${c}:${channel}`)}
                            onValueChange={(v) => toggle(c, channel, v)}
                            trackColor={{ false: colors.lineHi, true: colors.primaryDeep }}
                            thumbColor={ch[channel] ? colors.primary : colors.dim}
                            accessibilityLabel={`${CATEGORY_TEXT[c].label}: ${channel === 'push' ? 'push' : 'in-app'}`}
                          />
                          <Text style={styles.switchLabel}>{channel === 'push' ? 'Push' : 'In-app'}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </Card>
              );
            })}
          </View>
        </>
      )}
    </Screen>
  );
}

/** Quiet hours: no pushes between start and end (they still land in the list). Both or neither. */
function QuietHours({ prefs, busy, onSave }: { prefs: NotificationPreferences; busy: boolean; onSave: (start: number | null, end: number | null) => Promise<boolean> }) {
  const savedOn = prefs.quiet_hours_start != null && prefs.quiet_hours_end != null;
  // Draft times while editing; null = not editing (the saved value shows).
  const [draft, setDraft] = useState<{ start: number; end: number } | null>(null);
  const on = savedOn || draft != null;
  const start = draft?.start ?? prefs.quiet_hours_start ?? QUIET_START;
  const end = draft?.end ?? prefs.quiet_hours_end ?? QUIET_END;
  const problem = draft ? quietHoursError(draft.start, draft.end) : null;
  const changed = draft != null && (draft.start !== prefs.quiet_hours_start || draft.end !== prefs.quiet_hours_end);

  const flip = async (v: boolean) => {
    tap();
    if (v) return setDraft({ start, end });
    setDraft(null);
    if (savedOn) await onSave(null, null);
  };
  const submit = async () => {
    if (!draft || problem) return;
    if (await onSave(draft.start, draft.end)) setDraft(null);
  };

  return (
    <Card style={{ marginTop: 12, gap: 10 }}>
      <View style={styles.rowInner}>
        <Icon name="weather-night" size={22} color={colors.violet} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.label}>Quiet hours</Text>
          <Text style={styles.small}>{savedOn && !draft ? quietHoursText(prefs.quiet_hours_start, prefs.quiet_hours_end) : 'No pushes during these hours. They still land here.'}</Text>
        </View>
        <Switch
          value={on}
          disabled={busy}
          onValueChange={flip}
          trackColor={{ false: colors.lineHi, true: colors.primaryDeep }}
          thumbColor={on ? colors.primary : colors.dim}
          accessibilityLabel="Quiet hours"
        />
      </View>
      {on && (
        <>
          {savedOn && !draft ? (
            <Button label="Change times" size="sm" variant="secondary" iconLeft="clock-edit-outline" disabled={busy} onPress={() => setDraft({ start, end })} style={{ alignSelf: 'flex-start' }} />
          ) : (
            <>
              <Text style={styles.pickLabel}>From</Text>
              <TimePicker value={toClock(start)} onChange={(t) => setDraft({ start: toMinutes(t), end })} />
              <Text style={styles.pickLabel}>Until</Text>
              <TimePicker value={toClock(end)} onChange={(t) => setDraft({ start, end: toMinutes(t) })} />
              {!problem && <Text style={styles.small}>{quietHoursText(start, end)}</Text>}
              {!!problem && <Text style={styles.err} accessibilityLiveRegion="polite">{problem}</Text>}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Button label={busy ? 'Saving…' : 'Save quiet hours'} size="md" iconLeft="check" disabled={busy || !!problem || !changed} onPress={submit} style={{ flex: 1 }} />
                <Button label="Cancel" size="md" variant="ghost" disabled={busy} onPress={() => setDraft(null)} />
              </View>
            </>
          )}
        </>
      )}
      <Text style={styles.tz}>Times are in {prefs.timezone}.</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  legend: { flexDirection: 'row', marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  rowInner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 15, letterSpacing: 0.6, textTransform: 'uppercase' },
  small: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  switches: { flexDirection: 'row', gap: 10 },
  switchCol: { alignItems: 'center', gap: 2 },
  switchLabel: { color: colors.dim, fontFamily: fonts.label, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' },
  locked: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: alpha(colors.dim, 0.08), paddingHorizontal: 10, paddingVertical: 5 },
  lockedText: { color: colors.dim, fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  pickLabel: { color: colors.dim, fontFamily: fonts.labelBold, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase' },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 13 },
  tz: { color: colors.mute, fontFamily: fonts.regular, fontSize: 11 },
});
