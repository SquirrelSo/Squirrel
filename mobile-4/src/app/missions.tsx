/**
 * TODAY'S GOALS — the progress-service's daily goals (GET /v1/progress/daily), counted by the
 * server from your runs and workouts. Nothing to tap to "log": the server is the record.
 * Meal & water goals belong to a feature that isn't launched, so they show as Coming soon.
 */
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Mascot } from '@/art/Mascot';
import { GoalCard, LockedGoalCard } from '@/components/cards';
import { ErrorState, LoadingRows, NotConnected } from '@/components/campus/States';
import { Display, FadeIn, Header, Icon, ProgressBar, Screen } from '@/components/ui';
import { isLocked } from '@/data/features';
import { useDailyProgress } from '@/hooks/useDailyProgress';
import { colors, fonts, radius } from '@/theme';

export default function Missions() {
  const r = useDailyProgress();
  const goals = r.data?.goals ?? [];
  const done = goals.filter((g) => g.completed || g.current >= g.target).length;
  const totalXp = goals.reduce((s, g) => s + g.xp, 0);

  return (
    <Screen tabBar={false}>
      <Header back title="" right={<Text style={styles.chLink} onPress={() => router.push('/challenges')}>Challenges →</Text>} />
      <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
        <Display size={56} style={{ lineHeight: 56, flex: 1 }}>
          Today’s{'\n'}
          <Text style={{ color: colors.primary }}>Goals</Text>
        </Display>
        <Mascot pose="cheer" accessory="crown" size={108} animated style={{ marginBottom: -6 }} />
      </View>

      {r.state !== 'ready' ? (
        <NotConnected name="Today’s goals" reason={r.state} body={r.state === 'signed_out' ? 'Your daily goals come from your account. Sign in to see them.' : 'Daily goals come from the progress service, which isn’t connected to this build yet.'} />
      ) : r.error && !r.data ? (
        <ErrorState cause={r.cause} onRetry={r.reload} title="Couldn’t load today’s goals" />
      ) : !r.data ? (
        <LoadingRows rows={3} height={72} />
      ) : (
        <>
          <View style={styles.summary}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sumTitle}>{done}/{goals.length} complete · +{r.data.xp} XP today · {totalXp} XP in goals</Text>
              <ProgressBar progress={goals.length ? done / goals.length : 0} color={colors.primary} color2={colors.gold} height={6} style={{ marginTop: 8 }} />
            </View>
            <View style={styles.reset}>
              <Icon name="fire" size={14} color={colors.orange} />
              <Text style={styles.resetText}>{r.data.streak.current}-day streak</Text>
            </View>
          </View>
          <View style={{ gap: 10 }}>
            {goals.length === 0 && <Text style={styles.hint}>No goals set for today.</Text>}
            {goals.map((g, i) => (
              <FadeIn key={g.id} index={i}>
                <GoalCard goal={g} />
              </FadeIn>
            ))}
          </View>
          <Text style={styles.hint}>Counted by the server from your runs and workouts.</Text>
        </>
      )}

      {isLocked('mealWater') && (
        <View style={{ gap: 10, marginTop: 18 }}>
          <LockedGoalCard title="Drink water" icon="cup-water" />
          <LockedGoalCard title="Log a healthy meal" icon="food-apple-outline" />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  chLink: { color: colors.secondary, fontFamily: fonts.label, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', marginRight: 6 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12, marginBottom: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12 },
  sumTitle: { color: colors.text, fontFamily: fonts.semibold, fontSize: 13 },
  reset: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 130 },
  resetText: { color: colors.orange, fontFamily: fonts.semibold, fontSize: 11, flexShrink: 1 },
  hint: { color: colors.dim, fontSize: 12, textAlign: 'center', marginTop: 12, fontFamily: fonts.regular },
});
