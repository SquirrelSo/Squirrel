import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Mascot } from '@/art/Mascot';
import { EXERCISE_API_CONFIGURED } from '@/api/config';
import { exerciseApi, formatDuration, SKILL_LEVELS, type ExerciseAvailability, type SkillLevel } from '@/api/exercise';
import { RemoteStatus, ScoreRing, StatTile, scoreColor } from '@/components/ExerciseParts';
import { Card, EmptyState, FadeIn, Header, Icon, IconButton, Kicker, PressScale, Screen, SectionHeader, Segmented, Tag } from '@/components/ui';
import { EXERCISE_LIBRARY, type LibraryExercise } from '@/data/exercises';
import { invalidateExercise, useExerciseCatalog, useExerciseProgress, useExerciseSessions, useExerciseSkill, useExerciseUser, useReloadOnFocus } from '@/hooks/useExercise';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';

const SKILL_LABELS: Record<SkillLevel, string> = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };

/** FORM COACH — Exercise Mechanics hub: skill, progress, library, session history. */
export default function ExerciseHub() {
  const user = useExerciseUser();

  if (!EXERCISE_API_CONFIGURED) {
    return (
      <Screen tabBar={false}>
        <Header back title="Form Coach" />
        <EmptyState
          art={<Mascot pose="lift" size={130} />}
          title="Coach not connected"
          body="Form coaching needs the Exercise Mechanics backend. Set EXPO_PUBLIC_EXERCISE_API_URL in mobile/.env and restart the app."
        />
      </Screen>
    );
  }
  if (!user) {
    return (
      <Screen tabBar={false}>
        <Header back title="Form Coach" />
        <EmptyState
          art={<Mascot pose="lift" size={130} animated />}
          title="Set up your coach profile"
          body="The coach scores every rep for depth, range and posture. It needs your height and weight to do that, so start with a quick profile."
          action="Create profile"
          onAction={() => router.push('/exercise/profile')}
        />
      </Screen>
    );
  }
  return <Hub uid={user.user_id} name={`${user.first_name} ${user.last_name}`} />;
}

function Hub({ uid, name }: { uid: string; name: string }) {
  const { toast } = useApp();
  const skill = useExerciseSkill(uid);
  const progress = useExerciseProgress(uid);
  const sessions = useExerciseSessions(uid);
  const catalog = useExerciseCatalog();
  const [pendingSkill, setPendingSkill] = useState<SkillLevel | null>(null);
  useReloadOnFocus(progress.reload, sessions.reload);

  const level = pendingSkill ?? skill.data?.skill_level ?? 'beginner';
  const changeSkill = async (next: SkillLevel) => {
    setPendingSkill(next); // optimistic
    try {
      await exerciseApi.setSkill(uid, next);
      skill.reload();
      toast(`Skill set to ${SKILL_LABELS[next]}`, 'check-circle', colors.green);
    } catch (e) {
      toast(`Couldn't save skill: ${e instanceof Error ? e.message : 'error'}`, 'alert-circle-outline', colors.coral);
    } finally {
      setPendingSkill(null);
    }
  };

  const p = progress.data;
  const byId = new Map((catalog.data ?? []).map((c) => [c.id, c] as const));

  return (
    <Screen tabBar={false}>
      <Header back title="Form Coach" subtitle={name} right={<IconButton icon="account-circle-outline" onPress={() => router.push('/exercise/profile')} label="Coach profile" />} />

      {/* Skill level */}
      <Kicker style={{ marginTop: 4 }}>Skill level{skill.data && !skill.data.configured ? ' · not set yet' : ''}</Kicker>
      <Segmented items={SKILL_LEVELS} labels={SKILL_LABELS} value={level} onChange={(v) => v !== level && changeSkill(v)} />
      <RemoteStatus loading={skill.loading} error={skill.error} hasData={!!skill.data} onRetry={skill.reload} label="skill level" />

      {/* Progress */}
      <SectionHeader kicker="01 — Progress" title="Your form" />
      <RemoteStatus loading={progress.loading} error={progress.error} hasData={!!p} onRetry={progress.reload} label="progress" />
      {p && p.totals.sessions === 0 && (
        <Card>
          <Text style={styles.muted}>No sessions yet. Pick an exercise below to plan your first one.</Text>
        </Card>
      )}
      {p && p.totals.sessions > 0 && (
        <FadeIn>
          <Card glow={scoreColor(p.avg_form)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <ScoreRing score={p.avg_form} label="avg form" />
              <View style={{ flex: 1 }}>
                {p.latest_score == null ? (
                  <Text style={styles.bigSub}>Not scored yet. Train a session in the camera coach to get form scores.</Text>
                ) : (
                  <Text style={styles.big}>
                    {Math.round(p.latest_score)}
                    <Text style={styles.bigSub}> latest</Text>
                  </Text>
                )}
                {p.delta != null && (
                  <Text style={[styles.delta, { color: p.delta >= 0 ? colors.green : colors.coral }]}>
                    {p.delta >= 0 ? '▲' : '▼'} {Math.abs(Math.round(p.delta))} vs previous session
                  </Text>
                )}
                {p.best && <Text style={styles.muted}>Best {Math.round(p.best.score)} · {p.best.date}</Text>}
              </View>
            </View>
            <View style={styles.tiles}>
              <StatTile value={String(p.totals.sessions)} label="Sessions" />
              <StatTile value={String(p.totals.reps)} label="Reps" />
              <StatTile value={`${p.streak_days}d`} label="Streak" color={colors.orange} />
              <StatTile value={String(p.this_week)} label="Week" color={colors.primary} />
            </View>
            {p.total_time_s ? <Text style={[styles.muted, { marginTop: 8 }]}>Active training time {formatDuration(p.total_time_s)}</Text> : null}
            {p.insights[0] && (
              <View style={styles.insight}>
                <Icon name="lightbulb-on-outline" size={16} color={colors.gold} />
                <Text style={styles.insightText}>{p.insights[0]}</Text>
              </View>
            )}
          </Card>
        </FadeIn>
      )}

      {/* Library */}
      <SectionHeader kicker="02 — Library" title="Plan a session" />
      <RemoteStatus loading={catalog.loading} error={catalog.error} hasData={!!catalog.data} onRetry={catalog.reload} label="exercises" />
      {catalog.data && (
        <View style={{ gap: 10 }}>
          {EXERCISE_LIBRARY.map((e, i) => (
            <FadeIn key={e.key} index={i}>
              <LibraryRow ex={e} avail={byId.get(e.slug)} />
            </FadeIn>
          ))}
        </View>
      )}

      {/* History */}
      <SectionHeader kicker="03 — History" title="Sessions" />
      <RemoteStatus loading={sessions.loading} error={sessions.error} hasData={!!sessions.data} onRetry={sessions.reload} label="sessions" />
      {sessions.data && sessions.data.length === 0 && <Text style={styles.muted}>Your planned and trained sessions will show up here.</Text>}
      <View style={{ gap: 8 }}>
        {sessions.data?.map((s) => (
          <PressScale key={s.session_id} onPress={() => router.push({ pathname: '/exercise/session/[id]', params: { id: s.session_id } })} style={styles.row} scaleTo={0.98}>
            <View style={styles.rowIcon}>
              <Icon name="arm-flex" size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>{s.exercise || 'Session'}</Text>
              <Text style={styles.muted}>{s.day} {s.date} · {s.start_time}</Text>
            </View>
            <Text style={styles.rowStat}>{s.reps_completed}<Text style={styles.muted}> reps</Text></Text>
            <Icon name="chevron-right" size={20} color={colors.dim} />
          </PressScale>
        ))}
      </View>
      <Refresh onPress={() => { invalidateExercise(uid); progress.reload(); sessions.reload(); skill.reload(); catalog.reload(); }} />
    </Screen>
  );
}

function LibraryRow({ ex, avail }: { ex: LibraryExercise; avail?: ExerciseAvailability }) {
  const enabled = avail?.status === 'enabled';
  const state = !avail ? 'Not in catalog' : enabled ? `${ex.measure === 'reps' ? 'Reps' : 'Timed'} · ${avail.view} view` : 'Coming soon';
  return (
    <PressScale
      disabled={!enabled}
      onPress={() => router.push({ pathname: '/exercise/plan/[key]', params: { key: ex.key } })}
      style={[styles.row, !enabled && { opacity: 0.55 }]}
      scaleTo={0.98}
      accessibilityLabel={`${ex.name}, ${state}`}>
      <View style={[styles.rowIcon, enabled && { backgroundColor: alpha(colors.primary, 0.1) }]}>
        <Icon name={ex.icon} size={22} color={enabled ? colors.primary : colors.dim} />
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>{ex.name}</Text>
        <Text style={styles.muted} numberOfLines={1}>{ex.bodyPart.includes(ex.tag) ? ex.bodyPart : `${ex.bodyPart} · ${ex.tag}`}</Text>
      </View>
      <Tag label={state} color={enabled ? colors.primary : colors.dim} />
    </PressScale>
  );
}

function Refresh({ onPress }: { onPress: () => void }) {
  return (
    <PressScale onPress={onPress} style={styles.refresh} accessibilityLabel="Refresh coach data">
      <Icon name="refresh" size={16} color={colors.dim} />
      <Text style={styles.muted}>Refresh from server</Text>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12 },
  big: { color: colors.text, fontFamily: fonts.display, fontSize: 34 },
  bigSub: { color: colors.dim, fontFamily: fonts.label, fontSize: 14 },
  delta: { fontFamily: fonts.labelBold, fontSize: 13, marginTop: 2 },
  tiles: { flexDirection: 'row', gap: 8, marginTop: 14 },
  insight: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'flex-start' },
  insightText: { flex: 1, color: colors.sub, fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 10, gap: 6 },
  rowIcon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardHi },
  rowTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: 14 },
  rowStat: { color: colors.text, fontFamily: fonts.display, fontSize: 18, marginRight: 4 },
  refresh: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 20, paddingVertical: 10 },
});
