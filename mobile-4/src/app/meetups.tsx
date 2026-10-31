/**
 * MEETUPS — your upcoming meetups, each with a check-in. With campus-service configured these are its
 * meetups (host + invitees; cancelled and declined ones hidden): an invite you haven't answered says
 * so, and new ones are planned from a zone.
 */
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { campusApi, CAMPUS_MAP_ON_SERVICE, isEndpointAvailable, type Meetup } from '@/api/campus';
import { EmptyNote, ErrorState, LoadingRows, SourceBadge } from '@/components/campus/States';
import { Header, Icon, PressScale, Screen } from '@/components/ui';
import { formatEventDate } from '@/logic/format';
import { useCampus, useRefreshOnFocus } from '@/hooks/useCampus';
import { checkInOpen } from '@/logic/meetups';
import { colors, fonts, radius } from '@/theme';
import { isLocked } from '@/data/features';


export default function Meetups() {
  const list = useCampus<Meetup[]>('meetups', () => campusApi.meetups());
  useRefreshOnFocus(list.reload, 30_000);
  const checkInLive = !CAMPUS_MAP_ON_SERVICE || isEndpointAvailable('meetupCheckIn');
  return (
    <Screen tabBar={false} scroll={false}>
      <Header back title="Meetups" right={<SourceBadge />} />
      <FlatList
        data={list.data ?? []}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ gap: 10, paddingBottom: 40 }}
        renderItem={({ item: m }) => {
          const open = checkInLive && checkInOpen(m);
          return (
            <PressScale onPress={() => router.push({ pathname: '/meetup/[id]', params: { id: m.id } })} style={[styles.row, open && !m.my_check_in_at && { borderColor: colors.primary }]} scaleTo={0.985} accessibilityLabel={m.title}>
              <Icon name={m.my_check_in_at ? 'map-marker-check' : 'map-marker-radius'} size={26} color={m.my_check_in_at ? colors.green : open ? colors.primary : colors.dim} />
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{m.title}</Text>
                <Text style={styles.meta}>{formatEventDate(m.starts_at)} · {m.location.name}</Text>
                {m.my_rsvp === 'invited' ? (
                  <Text style={[styles.meta, { color: colors.secondary }]}>You’re invited · tap to answer</Text>
                ) : checkInLive && (
                  <Text style={[styles.meta, { color: m.my_check_in_at ? colors.green : open ? colors.primary : colors.dim }]}>
                    {m.my_check_in_at ? 'Checked in' : open ? 'Check-in open' : `Check-in opens ${formatEventDate(m.check_in_opens_at)}`}
                  </Text>
                )}
              </View>
              <Icon name="chevron-right" size={20} color={colors.dim} />
            </PressScale>
          );
        }}
        ListEmptyComponent={
          list.signedOut ? (
            <EmptyNote icon="account-lock-outline" title="Sign in to see meetups" action="Sign in" onAction={() => router.push('/sign-in')} />
          ) : list.error ? (
            <ErrorState cause={list.cause} onRetry={list.reload} />
          ) : list.loading ? (
            <LoadingRows rows={3} height={80} />
          ) : (
            <EmptyNote icon="calendar-blank-outline" title="No meetups coming up" body={CAMPUS_MAP_ON_SERVICE ? 'Plan one from any zone on the map, or wait for an invite: it appears here.' : 'RSVP to an event and your meetup appears here.'} action={isLocked('events') ? undefined : 'Browse events'} onAction={() => router.push('/events')} />
          )
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1.5, borderColor: colors.line, padding: 14 },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11, marginTop: 2 },
});
