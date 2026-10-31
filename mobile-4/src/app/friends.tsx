/**
 * FRIEND MODE — activity-based suggestions from the backend: shared zones/routes/crews,
 * backend-written icebreakers (hidden when there are none) and a challenge invite.
 */
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Mascot } from '@/art/Mascot';
import { campusApi } from '@/api/campus';
import { PersonCardView } from '@/components/campus/Social';
import { EmptyNote, ErrorState, LoadingRows, SourceBadge } from '@/components/campus/States';
import { Display, Header, IconButton, Kicker, Screen } from '@/components/ui';
import { useCampus, useRefreshOnFocus } from '@/hooks/useCampus';
import { colors, fonts } from '@/theme';

export default function FriendMode() {
  const list = useCampus('people:friends', () => campusApi.suggestedPeople('friends'));
  useRefreshOnFocus(list.reload, 5 * 60_000);
  const people = list.data ?? [];
  return (
    <Screen tabBar={false} scroll={false}>
      <Header back title="" right={<><IconButton icon="radar" onPress={() => router.push('/active')} label="Active now" /><SourceBadge /></>} />
      <FlatList
        data={people}
        keyExtractor={(p) => p.user_id}
        contentContainerStyle={{ gap: 12, paddingBottom: 40 }}
        ListHeaderComponent={
          <View style={{ marginBottom: 6 }}>
            <Kicker>Friend Mode</Kicker>
            <Display size={40} style={{ marginTop: 4 }}>Same routes,{'\n'}<Text style={{ color: colors.primary }}>new people</Text></Display>
            <Text style={styles.lead}>Suggested because you move in the same places. Tap an icebreaker to start — or challenge them for a zone.</Text>
          </View>
        }
        renderItem={({ item }) => <PersonCardView p={item} onChallenge={() => router.push({ pathname: '/invite/new', params: { userId: item.user_id } })} />}
        ListEmptyComponent={
          list.signedOut ? (
            <EmptyNote icon="account-lock-outline" title="Sign in for Friend Mode" action="Sign in" onAction={() => router.push('/sign-in')} />
          ) : list.error ? (
            <ErrorState cause={list.cause} onRetry={list.reload} />
          ) : list.loading ? (
            <LoadingRows rows={3} height={170} />
          ) : (
            <View style={{ alignItems: 'center' }}>
              <Mascot pose="run" size={120} />
              <EmptyNote title="No suggestions yet" body="Log a few runs or walks around campus — suggestions come from where you actually move." action="Start a run" onAction={() => router.push('/run')} />
            </View>
          )
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  lead: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, marginTop: 8 },
});
