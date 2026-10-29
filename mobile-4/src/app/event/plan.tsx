/**
 * PLAN A MEETUP — creates a normal event (POST /v1/events) that anyone can see and RSVP to.
 * Nobody is invited or notified: you share it with whoever you like. Squirrel Dates opens this
 * pre-filled with its suggested place and time (params `venue`, `starts_at`); Events opens it empty.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { campusApi, errorText, type EventCreate } from '@/api/campus';
import { EmptyNote, LoadingRows } from '@/components/campus/States';
import { FeatureGate, SoonScreen } from '@/components/Locked';
import { Button, Chips, Header, Screen, tap } from '@/components/ui';
import { invalidateCampus, useAction, useConfig } from '@/hooks/useCampus';
import { useApp } from '@/state/AppState';
import { colors, fonts, radius } from '@/theme';

const TYPES = ['Run', 'Walk', 'Hang out'] as const;
const TYPE_VALUE: Record<(typeof TYPES)[number], EventCreate['type']> = { Run: 'run', Walk: 'walk', 'Hang out': 'social' };
const HOURS = Array.from({ length: 16 }, (_, i) => i + 6); // 6 AM – 9 PM
const SIZES = ['No limit', '2', '4', '6', '10'] as const;
const DAYS_AHEAD = 8;

const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const dayLabel = (d: Date, i: number) =>
  i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });

export default function PlanRoute() {
  return (
    <FeatureGate feature="events" fallback={<SoonScreen title="Plan a meetup" body="Planning meetups opens with Events — switching on soon." onBack={() => (router.canGoBack() ? router.back() : router.replace('/home'))} />}>
      <Plan />
    </FeatureGate>
  );
}

function Plan() {
  const params = useLocalSearchParams<{ venue?: string; starts_at?: string; title?: string }>();
  const config = useConfig();
  const { toast } = useApp();

  // When the screen opened: the day chips and the "too soon" check are relative to it.
  const [openedAt] = useState(() => Date.now());
  const days = useMemo(() => {
    const start = new Date(openedAt);
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: DAYS_AHEAD }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return { date: d, label: dayLabel(d, i) };
    });
  }, [openedAt]);
  const suggested = params.starts_at ? new Date(params.starts_at) : null;
  const suggestedDay = suggested && days.find((d) => d.date.toDateString() === suggested.toDateString());

  const [type, setType] = useState<(typeof TYPES)[number]>('Run');
  const [venue, setVenue] = useState(params.venue ?? '');
  const [title, setTitle] = useState(params.title ?? (params.venue ? `Run at ${params.venue}` : ''));
  const [day, setDay] = useState(suggestedDay?.label ?? days[1].label);
  const [hour, setHour] = useState(hourLabel(suggested && suggestedDay ? suggested.getHours() : 18));
  const [size, setSize] = useState<(typeof SIZES)[number]>('No limit');
  const [notes, setNotes] = useState('');

  const startsAt = useMemo(() => {
    const d = new Date(days.find((x) => x.label === day)!.date);
    d.setHours(HOURS.find((h) => hourLabel(h) === hour)!, 0, 0, 0);
    return d;
  }, [days, day, hour]);
  const tooSoon = startsAt.getTime() < openedAt + 5 * 60_000;

  const create = useAction(() =>
    campusApi.createEvent({
      title: title.trim(),
      type: TYPE_VALUE[type],
      starts_at: startsAt.toISOString(),
      ends_at: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
      venue: venue.trim(),
      capacity: size === 'No limit' ? null : Number(size),
      description: notes.trim(),
    }),
  );

  if (!config.data) {
    return (
      <Screen tabBar={false}>
        <Header back title="Plan a meetup" />
        <LoadingRows rows={3} />
      </Screen>
    );
  }
  if (!config.data.features.create_event) {
    return (
      <Screen tabBar={false}>
        <Header back title="Plan a meetup" />
        <EmptyNote icon="lock-outline" title="Planning isn’t open yet" body="You can RSVP to events on campus for now." action="Browse events" onAction={() => router.replace('/events')} />
      </Screen>
    );
  }

  const submit = async () => {
    tap('impact');
    const r = await create.run();
    if (r) {
      tap('success');
      invalidateCampus('events');
      toast('Meetup planned. Share it with whoever you like', 'calendar-check', colors.primary);
      router.replace({ pathname: '/event/[id]', params: { id: r.id } });
    }
  };

  return (
    <Screen tabBar={false}>
      <Header back title="Plan a meetup" />
      <Text style={styles.note}>This creates an event anyone on campus can see and join. Nobody is invited or notified — share it yourself.</Text>

      <Text style={styles.label}>What</Text>
      <Chips items={TYPES} value={type} onChange={setType} icons={{ Run: 'run', Walk: 'walk', 'Hang out': 'account-group' }} style={{ marginTop: -6 }} />
      <TextInput style={styles.input} value={title} onChangeText={setTitle} maxLength={80} placeholder="e.g. Easy 3 km loop" placeholderTextColor={colors.mute} accessibilityLabel="Title" />

      <Text style={styles.label}>Where</Text>
      <TextInput style={styles.input} value={venue} onChangeText={setVenue} maxLength={80} placeholder="e.g. Library steps" placeholderTextColor={colors.mute} accessibilityLabel="Place" />

      <Text style={styles.label}>When</Text>
      <Chips items={days.map((d) => d.label)} value={day} onChange={setDay} style={{ marginTop: -6 }} />
      <Chips items={HOURS.map(hourLabel)} value={hour} onChange={setHour} style={{ marginTop: -12 }} />
      {tooSoon && <Text style={styles.err}>Pick a time later than now.</Text>}

      <Text style={styles.label}>How many</Text>
      <Chips items={SIZES} value={size} onChange={setSize} style={{ marginTop: -6 }} />

      <Text style={styles.label}>Notes (optional)</Text>
      <TextInput style={[styles.input, { minHeight: 70, textAlignVertical: 'top' }]} value={notes} onChangeText={setNotes} maxLength={500} multiline placeholder="Pace, what to bring, where exactly to meet" placeholderTextColor={colors.mute} accessibilityLabel="Notes" />

      {create.status === 'error' && <Text style={styles.err}>{errorText(create.error)}</Text>}
      <Button label={create.status === 'loading' ? 'Planning…' : 'Plan it'} iconLeft="calendar-plus" disabled={create.status === 'loading' || title.trim().length < 3 || tooSoon} onPress={submit} style={{ marginTop: 22 }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { color: colors.sub, fontFamily: fonts.medium, fontSize: 14, lineHeight: 19, marginTop: 4 },
  label: { color: colors.dim, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', marginTop: 16, marginBottom: 6 },
  input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, color: colors.text, fontFamily: fonts.regular, fontSize: 15 },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 13, marginTop: 8 },
});
