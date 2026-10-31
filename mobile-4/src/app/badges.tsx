/** BADGES — unlocked, locked and in-progress, from the backend. New badge ids render without UI changes. */
import { StyleSheet, Text, View } from 'react-native';
import { campusApi, type Badge } from '@/api/campus';
import { BadgeTile } from '@/components/campus/Social';
import { EmptyNote, ErrorState, LoadingRows, SignedOutState, SourceBadge } from '@/components/campus/States';
import { Display, Header, Kicker, Screen, SectionHeader } from '@/components/ui';
import { useCampus } from '@/hooks/useCampus';
import { colors, fonts } from '@/theme';

export default function Badges() {
  const r = useCampus<Badge[]>('badges', () => campusApi.badges());
  const unlocked = (r.data ?? []).filter((b) => b.unlocked);
  const locked = (r.data ?? []).filter((b) => !b.unlocked);
  return (
    <Screen tabBar={false}>
      <Header back title="" right={<SourceBadge />} />
      <Kicker>Badges</Kicker>
      <Display size={40} style={{ marginTop: 4 }}>Earned <Text style={{ color: colors.primary }}>IRL</Text></Display>
      {r.signedOut ? (
        <SignedOutState what="your badges" />
      ) : r.error && !r.data ? (
        <ErrorState cause={r.cause} onRetry={r.reload} />
      ) : !r.data ? (
        <LoadingRows rows={2} height={170} style={{ marginTop: 14 }} />
      ) : !r.data.length ? (
        <EmptyNote icon="medal-outline" title="No badges yet" body="Move around campus to start earning them." />
      ) : (
        <>
          <Text style={styles.count}>
            {unlocked.length}/{r.data.length} unlocked
          </Text>
          {unlocked.length > 0 && <SectionHeader title="Unlocked" />}
          <View style={styles.grid}>{unlocked.map((b) => <BadgeTile key={b.id} badge={b} />)}</View>
          {locked.length > 0 && <SectionHeader title="Keep going" />}
          <View style={styles.grid}>{locked.map((b) => <BadgeTile key={b.id} badge={b} />)}</View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  count: { color: colors.dim, fontFamily: fonts.mono, fontSize: 12, marginTop: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
});
