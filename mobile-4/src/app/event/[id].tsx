/** EVENT DETAILS — date/time, location, participants, type, territory challenge, RSVP / cancel. */
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Scene } from '@/art/Scene';
import { campusApi, errorText, type EventDetail } from '@/api/campus';
import { eventType } from '@/components/campus/EventRow';
import { isStudyBreak } from '@/components/events/StudyBreak';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { ErrorState, LoadingRows, SourceBadge } from '@/components/campus/States';
import { Button, Card, Display, Icon, IconButton, Kicker, Scrim, SectionHeader, tap } from '@/components/ui';
import { formatEventDate } from '@/logic/format';
import { invalidateCampus, useAction, useCampus } from '@/hooks/useCampus';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, MAX_WIDTH } from '@/theme';
import { FeatureGate, SoonScreen } from '@/components/Locked';

export default function EventRoute() {
  return (
    <FeatureGate feature="events" fallback={<SoonScreen title="Events" body="Campus events, study-break walks and RSVPs — switching on soon." onBack={() => (router.canGoBack() ? router.back() : router.replace('/home'))} />}>
      <EventScreen />
    </FeatureGate>
  );
}

function EventScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { toast } = useApp();
  const r = useCampus<EventDetail>(`event:${id}`, () => campusApi.event(id));
  const rsvp = useAction((going: boolean) => campusApi.rsvp(id, going));
  const e = r.data;
  const back = () => (router.canGoBack() ? router.back() : router.replace('/events'));

  if (!e) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 10, paddingHorizontal: 16 }}>
        <IconButton icon="chevron-left" size={26} onPress={back} label="Back" />
        <View style={{ marginTop: 16 }}>{r.error ? <ErrorState cause={r.cause} onRetry={r.reload} /> : <LoadingRows rows={4} height={80} />}</View>
      </View>
    );
  }
  const t = eventType(isStudyBreak(e) ? 'study_break_walk' : e.type);
  const walk = isStudyBreak(e);
  const going = e.my_rsvp === 'going';
  const full = e.capacity != null && e.participants_count >= e.capacity && !going;
  const toggle = async () => {
    tap();
    const next = await rsvp.run(!going);
    if (next) {
      r.mutate(next); // the server's answer, not a guess
      invalidateCampus('events');
      invalidateCampus('meetups');
      toast(next.my_rsvp ? (walk ? 'You’re in. See you there 👟' : `You’re going to ${next.title}`) : walk ? 'You left the walk' : 'RSVP cancelled', next.my_rsvp ? 'calendar-check' : 'calendar-remove', next.my_rsvp ? colors.primary : colors.dim);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}>
      <View style={{ height: 220 + insets.top }}>
        <Scene kind={walk || e.type === 'walk' ? 'lake' : e.type === 'social' ? 'crew' : 'stadium'} seed={e.title.length} aspect={Math.min(width, MAX_WIDTH) / (220 + insets.top)} style={StyleSheet.absoluteFill} />
        <Scrim strong />
        <View style={[styles.top, { top: insets.top + 8 }]}>
          <IconButton icon="chevron-left" size={26} onPress={back} label="Back" />
          <SourceBadge />
        </View>
        <View style={styles.heroText}>
          <Kicker color={t.color}>{t.label}</Kicker>
          <Display size={34} color={colors.onImage} style={{ marginTop: 4 }}>{e.title}</Display>
          <Text style={styles.host}>by {e.host.name}</Text>
        </View>
      </View>

      <View style={styles.col}>
        <Card style={{ gap: 10 }}>
          <Line icon="calendar-clock" text={formatEventDate(e.starts_at) + (e.ends_at ? ` → ${new Date(e.ends_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : '')} />
          {walk && <Line icon="timer-outline" text={`${e.duration_min ?? 20} min campus reset`} />}
          <Line
            icon="map-marker"
            text={walk && e.meeting_point ? `${e.meeting_point} · ${e.location.name}` : e.location.name}
            onPress={e.location.zone_id ? () => router.push({ pathname: '/zone/[id]', params: { id: e.location.zone_id! } }) : undefined}
          />
          <Line icon="account-group" text={`${e.participants_count} going${e.capacity != null ? ` · ${Math.max(0, e.capacity - e.participants_count)} spots left` : ''}`} />
        </Card>

        {e.territory_challenge && (
          <Card style={{ marginTop: 12, borderColor: alpha(colors.secondary, 0.5), gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="sword-cross" size={18} color={colors.secondary} />
              <Text style={styles.chTitle}>Territory challenge</Text>
            </View>
            <Text style={styles.body}>{e.territory_challenge.summary}</Text>
            <Text style={styles.meta}>
              {e.territory_challenge.zone_ids.length} zones in play{e.territory_challenge.reward_xp ? ` · +${e.territory_challenge.reward_xp} XP for the winners` : ''}
            </Text>
            <Button label="See zones on the map" variant="secondary" size="sm" iconLeft="map-marker-radius" onPress={() => router.push('/explore')} />
          </Card>
        )}

        {!!e.description && <Text style={[styles.body, { marginTop: 14 }]}>{e.description}</Text>}

        <View style={{ marginTop: 16, gap: 8 }}>
          <Button
            label={rsvp.status === 'loading' ? (going ? 'Cancelling…' : 'Saving…') : walk ? (going ? 'You’re in · Leave walk' : full ? 'Walk full' : e.rsvp_open ? 'Join walk' : 'Walk closed') : going ? 'Going · Cancel RSVP' : full ? 'Event full' : e.rsvp_open ? 'RSVP · I’m going' : 'RSVPs closed'}
            iconLeft={going ? 'check' : walk ? 'walk' : 'calendar-plus'}
            variant={going ? 'secondary' : 'primary'}
            disabled={rsvp.status === 'loading' || (!going && (full || !e.rsvp_open))}
            onPress={toggle}
          />
          {rsvp.status === 'error' && <Text style={styles.err}>{errorText(rsvp.error)}</Text>}
          {going && e.meetup_id && <Button label="Meetup check-in" variant="ghost" size="sm" iconLeft="map-marker-check" onPress={() => router.push({ pathname: '/meetup/[id]', params: { id: e.meetup_id! } })} />}
        </View>

        <SectionHeader title={`Participants · ${e.participants_count}`} />
        {e.participants.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
            {e.participants.map((p) => (
              <View key={p.user_id} style={{ alignItems: 'center', width: 60 }}>
                <PersonAvatar person={p} size={50} />
                <Text style={styles.member} numberOfLines={1}>{p.display_name.split(' ')[0]}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.meta}>Be the first to RSVP.</Text>
        )}
      </View>
    </ScrollView>
  );
}

function Line({ icon, text, onPress }: { icon: React.ComponentProps<typeof Icon>['name']; text: string; onPress?: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Icon name={icon} size={18} color={colors.primary} />
      <Text style={[styles.line, onPress && { textDecorationLine: 'underline' }]} onPress={onPress}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  heroText: { position: 'absolute', left: 16, right: 16, bottom: 14 },
  host: { color: colors.onImageSub, fontFamily: fonts.medium, fontSize: 13, marginTop: 2 },
  col: { paddingHorizontal: 16, width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', marginTop: 14 },
  line: { flex: 1, color: colors.text, fontFamily: fonts.medium, fontSize: 14 },
  chTitle: { color: colors.secondary, fontFamily: fonts.label, fontSize: 14, letterSpacing: 1, textTransform: 'uppercase' },
  body: { color: colors.sub, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11 },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 13, textAlign: 'center' },
  member: { color: colors.sub, fontFamily: fonts.medium, fontSize: 12, marginTop: 6 },
});
