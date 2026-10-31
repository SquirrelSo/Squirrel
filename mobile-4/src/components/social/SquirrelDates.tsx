/**
 * SQUIRREL DATES — a light, optional nudge: "you both know this part of campus". The backend picks
 * who, where and when from zone visits you share; this only presents it. Advisory only: nothing is
 * sent to anyone. To meet, you plan an event yourself ("Plan a meetup", pre-filled) and share it.
 * Off by default and opt-in on both sides. Campus discovery, not a dating app: no photos-first, no
 * romantic framing, one tap to dismiss.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { errorText, featureUnavailable } from '@/api/campus';
import { dismissDateSuggestion, getDateSuggestions, setDatesEnabled } from '@/api/campus/discovery';
import type { DateSuggestion, DateSuggestions } from '@/api/campus/types';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { EmptyNote, ErrorState, LoadingRows, NotLiveYet } from '@/components/campus/States';
import { whenText } from '@/components/events/StudyBreak';
import { useLocks } from '@/components/Locked';
import { Button, Icon, SectionHeader, tap } from '@/components/ui';
import { invalidateCampus, useAction, useCampus } from '@/hooks/useCampus';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';

export function SquirrelDateCard({ s, onGone }: { s: DateSuggestion; onGone: (id: string) => void }) {
  const { guard } = useLocks();
  const later = useAction(() => dismissDateSuggestion(s.id));
  const first = s.person.display_name.split(' ')[0];
  const plan = guard('events', () => {
    tap('impact');
    router.push({ pathname: '/event/plan', params: { ...(s.zone ? { venue: s.zone.name } : {}), ...(s.suggested_time ? { starts_at: s.suggested_time } : {}) } });
  });
  const dismiss = async () => {
    tap();
    if (await later.run()) onGone(s.id);
  };
  return (
    <View style={styles.card} accessibilityLabel={`Squirrel Date suggestion: ${s.person.display_name}. ${s.reason}`}>
      <View style={styles.head}>
        <Icon name="map-marker-account-outline" size={14} color={colors.secondary} />
        <Text style={styles.kicker}>Squirrel Date</Text>
      </View>
      <Text style={styles.title}>You both know this campus.</Text>

      <View style={styles.person}>
        <PersonAvatar person={s.person} size={48} ring={colors.secondary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>{s.person.display_name}</Text>
          {s.person.level != null && <Text style={styles.level}>Level {s.person.level}</Text>}
        </View>
      </View>
      <Text style={styles.reason}>{s.reason}</Text>

      {(s.zone || s.suggested_time) && (
        <View style={styles.suggest}>
          <Text style={styles.suggestK}>Suggested</Text>
          {!!s.zone && <Text style={styles.suggestV} numberOfLines={2}>{s.zone.name}</Text>}
          {!!s.suggested_time && <Text style={styles.suggestT}>{whenText(s.suggested_time)}</Text>}
        </View>
      )}

      <View style={styles.actions}>
        <Button label="View profile" size="sm" onPress={() => router.push({ pathname: '/user/[id]', params: { id: s.person.user_id } })} style={{ flex: 1 }} />
        <Button label="Plan a meetup" size="sm" variant="secondary" iconLeft="calendar-plus" onPress={plan} style={{ flex: 1 }} />
      </View>
      <Text style={styles.fine}>Nothing is sent to {first}. Plan it, then share it if you like.</Text>
      <Text style={styles.later} onPress={later.status === 'loading' ? undefined : dismiss} accessibilityRole="button">
        {later.status === 'loading' ? 'Hiding…' : 'Maybe later'}
      </Text>
      {later.status === 'error' && <Text style={styles.err}>{errorText(later.error)}</Text>}
    </View>
  );
}

/** Off by default: both people have to turn it on before either is suggested to the other. */
function DatesOptIn({ onChanged }: { onChanged: () => void }) {
  const turnOn = useAction(() => setDatesEnabled(true));
  const run = async () => {
    tap('impact');
    if (await turnOn.run()) onChanged();
  };
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Icon name="map-marker-account-outline" size={14} color={colors.secondary} />
        <Text style={styles.kicker}>Off</Text>
      </View>
      <Text style={styles.reason}>
        Get a suggestion when someone else who turned this on keeps running the same campus spots as you — with a place and a time to meet. It uses which campus zones your runs pass, never your route. Nothing is sent to anyone.
      </Text>
      <Button label={turnOn.status === 'loading' ? 'Turning on…' : 'Turn on Squirrel Dates'} size="sm" variant="secondary" onPress={run} disabled={turnOn.status === 'loading'} style={{ marginTop: 4 }} />
      {turnOn.status === 'error' && <Text style={styles.err}>{errorText(turnOn.error)}</Text>}
    </View>
  );
}

/** Social tab section: one suggestion at a time; "Not live yet" (layout kept, no actions) until its backend ships. */
export function SquirrelDatesSection() {
  const { toast } = useApp();
  const r = useCampus<DateSuggestions>('dates:suggestions', () => getDateSuggestions());
  const turnOff = useAction(() => setDatesEnabled(false));
  const [gone, setGone] = useState<string[]>([]);
  const list = (r.data?.suggestions ?? []).filter((s) => !gone.includes(s.id));
  if (r.data && !r.data.available) return null;
  const changed = () => {
    invalidateCampus('dates');
    r.reload();
  };
  const off = async () => {
    if (await turnOff.run()) {
      toast('Squirrel Dates is off. Its zone history was deleted', 'map-marker-off-outline', colors.dim);
      changed();
    }
  };
  return (
    <View style={{ marginBottom: 14 }}>
      <SectionHeader title="Squirrel Dates" action={r.data?.enabled ? (turnOff.status === 'loading' ? 'Turning off…' : 'Turn off') : undefined} onAction={off} />
      {r.error && !r.data && featureUnavailable(r.cause) ? (
        <NotLiveYet name="Squirrel Dates" compact body="Suggestions for people you share campus spots with switch on once their backend is ready." />
      ) : r.error && !r.data ? (
        <ErrorState cause={r.cause} onRetry={r.reload} compact feature="Squirrel Dates" />
      ) : !r.data ? (
        <LoadingRows rows={1} height={200} />
      ) : !r.data.enabled ? (
        <DatesOptIn onChanged={changed} />
      ) : list.length === 0 ? (
        <EmptyNote icon="map-search-outline" title="No matches yet." body="Suggestions come from runs you and someone else keep finishing around the same campus spots." />
      ) : (
        <SquirrelDateCard key={list[0].id} s={list[0]} onGone={(id) => setGone((g) => [...g, id])} />
      )}
    </View>
  );
}

/** On someone's profile: shown only when the backend has a suggestion for this person. */
export function ProfileDateSuggestion({ userId }: { userId: string }) {
  const r = useCampus<DateSuggestions>(`dates:for:${userId}`, () => getDateSuggestions(userId));
  const [gone, setGone] = useState(false);
  const s = r.data?.available ? r.data.suggestions[0] : undefined;
  if (!s || gone) return null;
  return (
    <View style={{ marginTop: 14 }}>
      <SquirrelDateCard s={s} onGone={() => setGone(true)} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.xl, borderWidth: 1, borderColor: alpha(colors.secondary, 0.45), padding: 16, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  kicker: { color: colors.secondary, fontFamily: fonts.labelBold, fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase' },
  title: { color: colors.text, fontFamily: fonts.display, fontSize: 24, letterSpacing: 0.4, textTransform: 'uppercase' },
  person: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  name: { color: colors.text, fontFamily: fonts.bold, fontSize: 16 },
  level: { color: colors.violet, fontFamily: fonts.label, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase' },
  reason: { color: colors.sub, fontFamily: fonts.medium, fontSize: 14, lineHeight: 19 },
  suggest: { gap: 2, backgroundColor: colors.cardHi, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 9 },
  suggestK: { color: colors.dim, fontFamily: fonts.label, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase' },
  suggestT: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 14, letterSpacing: 0.8, textTransform: 'uppercase' },
  suggestV: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 16, letterSpacing: 0.8, textTransform: 'uppercase' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  fine: { color: colors.dim, fontFamily: fonts.medium, fontSize: 12, textAlign: 'center' },
  later: { color: colors.dim, fontFamily: fonts.medium, fontSize: 13, textAlign: 'center', paddingVertical: 4 },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 12, textAlign: 'center' },
});
