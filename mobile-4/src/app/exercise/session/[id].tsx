import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { formatDuration, type ExerciseReport, type OverviewExercise } from '@/api/exercise';
import { MiniBars } from '@/components/cards';
import { RemoteStatus, ScoreRing, StatTile, scoreColor } from '@/components/ExerciseParts';
import { Card, Display, EmptyState, FadeIn, Header, Icon, Kicker, PressScale, ProgressBar, Screen, SectionHeader } from '@/components/ui';
import { useExerciseReport, useExerciseUser, useSessionOverview } from '@/hooks/useExercise';
import { colors, fonts, radius } from '@/theme';

/** One session: overview (GET …/overview) and a drill-down report per exercise (GET …/exercises/{ex}/report). */
export default function ExerciseSession() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sid = String(id);
  const user = useExerciseUser();
  const ov = useSessionOverview(user?.user_id, sid);
  const [open, setOpen] = useState<string | null>(null);

  if (!user) {
    return (
      <Screen tabBar={false}>
        <Header back title="Session" />
        <EmptyState title="No coach profile" body="Create a coach profile to see your sessions." action="Back to coach" onAction={() => router.replace('/exercise')} />
      </Screen>
    );
  }

  const o = ov.data;
  return (
    <Screen tabBar={false}>
      <Header back title="Session" subtitle={o ? `${o.day} ${o.date} · ${o.start_time}` : undefined} />
      <RemoteStatus loading={ov.loading} error={ov.error} hasData={!!o} onRetry={ov.reload} label="session" />
      {o && (
        <>
          <FadeIn>
            <Card glow={scoreColor(o.session_score)}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                <ScoreRing score={o.session_score} size={84} label="session" />
                <View style={{ flex: 1 }}>
                  <Kicker>Skill · {o.skill_level}</Kicker>
                  <Display size={28} style={{ marginTop: 4 }}>{o.exercises.map((e) => e.name).join(', ') || 'Session'}</Display>
                </View>
              </View>
              <View style={styles.tiles}>
                <StatTile value={String(o.total_reps)} label="Reps" />
                <StatTile value={formatDuration(o.total_time_s)} label="Active time" />
                <StatTile value={String(o.exercise_count)} label="Exercises" />
              </View>
            </Card>
          </FadeIn>

          <SectionHeader title="Exercises" />
          <View style={{ gap: 10 }}>
            {o.exercises.map((e) => (
              <ExerciseCard key={e.exercise_id} e={e} uid={user.user_id} sid={sid} open={open === e.exercise_id} onToggle={() => setOpen(open === e.exercise_id ? null : e.exercise_id)} />
            ))}
          </View>
        </>
      )}
    </Screen>
  );
}

function ExerciseCard({ e, uid, sid, open, onToggle }: { e: OverviewExercise; uid: string; sid: string; open: boolean; onToggle: () => void }) {
  const planned = (e.measure === 'reps' ? `${e.planned.sets} × ${e.planned.reps_per_set ?? '?'} reps` : `${e.planned.sets} × ${e.planned.duration_seconds ?? '?'} s`)
    + (e.planned.weight_kg ? ` · ${e.planned.weight_kg} kg` : '');
  return (
    <View style={styles.card}>
      <PressScale onPress={onToggle} disabled={!e.has_data} scaleTo={0.99} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }} accessibilityLabel={`${e.name} report`}>
        <ScoreRing score={e.avg_form_score} size={54} />
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{e.name}</Text>
          <Text style={styles.muted}>
            Planned {planned}
            {e.has_data && e.actual ? ` · ${e.actual.reps_completed} counted in ${e.actual.sets_completed} set${e.actual.sets_completed === 1 ? '' : 's'}` : ''}
          </Text>
          {e.has_data && e.measure === 'reps' && e.plan_met !== undefined && (
            <Text style={[styles.muted, { color: e.plan_met ? colors.green : colors.coral }]}>
              {e.plan_met ? 'Plan met' : 'Plan not met'}
              {e.reps_not_counted ? ` · ${e.reps_not_counted} not counted` : ''}
            </Text>
          )}
        </View>
        {e.has_data && <Icon name={open ? 'chevron-up' : 'chevron-down'} size={22} color={colors.dim} />}
      </PressScale>
      {!e.has_data && <Text style={[styles.muted, { marginTop: 10 }]}>Not trained yet. Train this session in the camera coach; the report fills in here afterwards.</Text>}
      {e.has_data && e.quality && (
        <View style={styles.quality}>
          {([['good', colors.green], ['borderline', colors.gold], ['poor', colors.coral]] as const).map(([k, c]) => (
            <Text key={k} style={[styles.q, { color: c }]}>{e.quality![k]} {k}</Text>
          ))}
          {e.shallow_reps ? <Text style={[styles.q, { color: colors.dim }]}>{e.shallow_reps} shallow</Text> : null}
        </View>
      )}
      {open && <ReportBody uid={uid} sid={sid} exerciseId={e.exercise_id} />}
    </View>
  );
}

function ReportBody({ uid, sid, exerciseId }: { uid: string; sid: string; exerciseId: string }) {
  const r = useExerciseReport(uid, sid, exerciseId);
  return (
    <View style={{ marginTop: 12 }}>
      <RemoteStatus loading={r.loading} error={r.error} hasData={!!r.data} onRetry={r.reload} label="report" />
      {r.data && <Report r={r.data} />}
    </View>
  );
}

function Report({ r }: { r: ExerciseReport }) {
  const perSet = r.per_set.map((s) => s.avg_score);
  return (
    <View style={{ gap: 12 }}>
      {r.measure === 'reps' ? (
        <>
          <View style={styles.tiles}>
            <StatTile value={r.summary.best == null ? '—' : String(Math.round(r.summary.best))} label="Best rep" color={colors.green} />
            <StatTile value={r.summary.worst == null ? '—' : String(Math.round(r.summary.worst))} label="Worst rep" color={colors.coral} />
            <StatTile value={r.summary.avg_rep_time_s == null ? '—' : `${r.summary.avg_rep_time_s.toFixed(1)}s`} label="Avg rep" />
          </View>
          {r.summary.not_counted && (
            <View style={styles.tiles}>
              <StatTile value={String(r.summary.total_reps)} label="Counted" color={colors.green} />
              <StatTile value={String(r.summary.not_counted.shallow)} label="Too shallow" color={colors.gold} />
              <StatTile value={String(r.summary.not_counted.too_fast)} label="Too fast" color={colors.coral} />
            </View>
          )}
        </>
      ) : (
        <View style={styles.tiles}>
          <StatTile value={String(r.summary.counted_lifts)} label="Counted" color={colors.green} />
          <StatTile value={String(r.summary.shallow_lifts)} label="Shallow" color={colors.gold} />
          <StatTile value={String(r.summary.invalid_lifts)} label="Invalid" color={colors.coral} />
        </View>
      )}

      {perSet.length > 0 && (
        <View>
          <Text style={styles.label}>Form by set</Text>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginTop: 6 }}>
            <MiniBars values={perSet} color={colors.primary} height={60} barWidth={18} />
            <Text style={styles.muted}>{r.per_set.map((s) => `S${s.set} ${Math.round(s.avg_score)}`).join(' · ')}</Text>
          </View>
        </View>
      )}

      {r.measure === 'reps' && r.by_rule.length > 0 && (
        <View>
          <Text style={styles.label}>Where points went</Text>
          {r.by_rule.slice(0, 4).map((b) => (
            <View key={b.rule} style={{ marginTop: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={styles.rule}>{b.issue_name}</Text>
                <Text style={styles.muted}>{b.flagged_reps} reps · {Math.round(b.penalty_share * 100)}%</Text>
              </View>
              <ProgressBar progress={b.penalty_share} color={colors.coral} height={5} style={{ marginTop: 4 }} />
            </View>
          ))}
        </View>
      )}

      {r.measure === 'reps' &&
        r.coaching.map((c) => (
          <View key={c.rule} style={styles.coach}>
            <Icon name="whistle" size={16} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rule}>{c.issue_name}</Text>
              <Text style={styles.body}>{c.text}</Text>
              {c.fix ? <Text style={[styles.body, { color: colors.primary }]}>Fix: {c.fix}</Text> : null}
            </View>
          </View>
        ))}

      {r.insights.map((t, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
          <Icon name="lightbulb-on-outline" size={16} color={colors.gold} />
          <Text style={[styles.body, { flex: 1 }]}>{t}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', gap: 8, marginTop: 12 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12 },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  muted: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, flexShrink: 1 },
  quality: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 10 },
  q: { fontFamily: fonts.labelBold, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6 },
  label: { color: colors.dim, fontFamily: fonts.mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.8 },
  rule: { color: colors.text, fontFamily: fonts.semibold, fontSize: 13 },
  body: { color: colors.sub, fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, marginTop: 2 },
  coach: { flexDirection: 'row', gap: 8, backgroundColor: colors.bg, borderRadius: radius.md, padding: 10, borderWidth: 1, borderColor: colors.line },
});
