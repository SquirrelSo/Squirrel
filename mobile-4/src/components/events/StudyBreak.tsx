/**
 * Study Break Walk — a 20-minute campus reset, served by the existing Events API (Dev A's
 * template). Join state is always the server's `my_rsvp`; this card never assumes it.
 */
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { campusApi, errorText, type EventDetail, type EventSummary } from '@/api/campus';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { Button, Icon, PressScale, tap } from '@/components/ui';
import { invalidateCampus, useAction } from '@/hooks/useCampus';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';
import { isLocked } from '@/data/features';

export const isStudyBreak = (e: Pick<EventSummary, 'type' | 'template'>) => e.template === 'study_break_walk' || e.type === 'study_break_walk';

/** "in 40 min" soon, a clock time today, a weekday otherwise. */
export function whenText(iso: string) {
  const t = Date.parse(iso);
  const mins = Math.round((t - Date.now()) / 60_000);
  if (mins <= 0 && mins > -30) return 'Starting now';
  if (mins > 0 && mins < 60) return `In ${mins} min`;
  const d = new Date(t);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return new Date().toDateString() === d.toDateString() ? `Today · ${time}` : `${d.toLocaleDateString('en-US', { weekday: 'short' })} · ${time}`;
}

export function StudyBreakCard({ event: e, onChanged }: { event: EventSummary | EventDetail; onChanged?: (next: EventDetail) => void }) {
  // Study-break walks run on the Events API: while Events is locked there is no joinable card.
  if (isLocked('events')) return null;
  return <StudyBreakCardLive event={e} onChanged={onChanged} />;
}

function StudyBreakCardLive({ event: e, onChanged }: { event: EventSummary | EventDetail; onChanged?: (next: EventDetail) => void }) {
  const { toast } = useApp();
  const join = useAction((going: boolean) => campusApi.rsvp(e.id, going));
  const going = e.my_rsvp === 'going';
  const spots = e.capacity != null ? Math.max(0, e.capacity - e.participants_count) : null;
  const full = spots === 0 && !going;
  const people = 'participants' in e ? e.participants : [];
  const toggle = async () => {
    tap(going ? 'select' : 'impact');
    const next = await join.run(!going);
    if (next) {
      tap('success');
      invalidateCampus('events');
      invalidateCampus(`event:${e.id}`);
      onChanged?.(next);
      if (next.my_rsvp) toast('You’re in. See you there 👟', 'walk', colors.secondary);
    }
  };
  return (
    <PressScale onPress={() => router.push({ pathname: '/event/[id]', params: { id: e.id } })} style={[styles.card, going && styles.cardIn]} scaleTo={0.99} accessibilityRole="button" accessibilityLabel={`Study break walk, ${e.duration_min ?? 20} minutes, ${whenText(e.starts_at)}, ${e.meeting_point ?? e.location.name}. Open`}>
      <View style={styles.top}>
        <View style={styles.tag}>
          <Icon name="coffee-outline" size={13} color={colors.secondary} />
          <Text style={styles.tagText}>Study break walk</Text>
        </View>
        <Text style={styles.when}>{whenText(e.starts_at)}</Text>
      </View>
      <Text style={styles.title}>{e.duration_min ?? 20} min campus reset</Text>
      <Text style={styles.line} numberOfLines={1}>
        <Icon name="map-marker" size={13} color={colors.primary} /> {e.meeting_point ?? e.location.name}
      </Text>
      <View style={styles.bottom}>
        <View style={styles.people}>
          {people.slice(0, 4).map((p, i) => (
            <View key={p.user_id} style={{ marginLeft: i ? -10 : 0 }}>
              <PersonAvatar person={p} size={26} link={false} />
            </View>
          ))}
          <Text style={styles.count}>
            {e.participants_count} going{spots != null ? ` · ${spots} ${spots === 1 ? 'spot' : 'spots'} left` : ''}
          </Text>
        </View>
        <Button
          label={join.status === 'loading' ? '…' : going ? 'You’re in' : full ? 'Full' : 'Join walk'}
          iconLeft={going ? 'check' : undefined}
          size="sm"
          variant={going ? 'secondary' : 'accent'}
          disabled={join.status === 'loading' || full}
          onPress={toggle}
          accessibilityLabel={going ? 'You’re in. Tap to leave the walk' : 'Join walk'}
        />
      </View>
      {join.status === 'error' && <Text style={styles.err}>{errorText(join.error)}</Text>}
    </PressScale>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: alpha(colors.secondary, 0.4), padding: 14, gap: 4 },
  cardIn: { borderColor: colors.primary },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  tagText: { color: colors.secondary, fontFamily: fonts.labelBold, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase' },
  when: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase' },
  title: { color: colors.text, fontFamily: fonts.display, fontSize: 24, letterSpacing: 0.4, textTransform: 'uppercase', marginTop: 2 },
  line: { color: colors.sub, fontFamily: fonts.medium, fontSize: 13 },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 8 },
  people: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 },
  count: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, flexShrink: 1 },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 12, marginTop: 4 },
});
