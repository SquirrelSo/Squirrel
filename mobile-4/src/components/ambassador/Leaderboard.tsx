/** Active ambassadors by activated referrals, then task XP (GET /v1/ambassador/leaderboard). The server ranks. */
import { StyleSheet, Text, View } from 'react-native';
import { ambassadorApi, type AmbassadorLeaderboardEntry } from '@/api/ambassador';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { EmptyNote, ErrorState, LoadingRows } from '@/components/campus/States';
import { Card } from '@/components/ui';
import { useCampus } from '@/hooks/useCampus';
import { alpha, colors, fonts } from '@/theme';

export function AmbassadorLeaderboard() {
  const r = useCampus<{ entries: AmbassadorLeaderboardEntry[] }>('ambassador:leaderboard', () => ambassadorApi.leaderboard());
  if (r.error && !r.data) return <ErrorState cause={r.cause} onRetry={r.reload} compact feature="The ambassador leaderboard" />;
  if (!r.data) return <LoadingRows rows={3} height={56} />;
  if (!r.data.entries.length) return <EmptyNote icon="podium" title="No ranks yet" body="Active ambassadors rank here by the people they bring in." />;
  return (
    <View style={{ gap: 8 }}>
      {r.data.entries.map((e) => (
        <Card key={e.user.id} style={[styles.row, e.is_me && { borderColor: alpha(colors.primary, 0.5) }]}>
          <Text style={[styles.rank, e.rank <= 3 && { color: colors.gold }]}>#{e.rank}</Text>
          <PersonAvatar person={{ user_id: e.user.id, display_name: e.user.display_name, avatar_url: e.user.avatar_url }} size={36} link={!e.is_me} />
          <Text style={styles.name} numberOfLines={1}>{e.is_me ? 'You' : e.user.display_name}</Text>
          <View style={{ alignItems: 'flex-end' }} accessibilityLabel={`${e.activated_referrals} active referrals, ${e.task_xp} task XP`}>
            <Text style={styles.value}>{e.activated_referrals} active</Text>
            <Text style={styles.meta}>{e.task_xp.toLocaleString('en-IN')} task XP</Text>
          </View>
        </Card>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  rank: { width: 34, color: colors.dim, fontFamily: fonts.display, fontSize: 18 },
  name: { flex: 1, color: colors.text, fontFamily: fonts.semibold, fontSize: 15 },
  value: { color: colors.text, fontFamily: fonts.label, fontSize: 14 },
  meta: { color: colors.dim, fontFamily: fonts.regular, fontSize: 11 },
});
