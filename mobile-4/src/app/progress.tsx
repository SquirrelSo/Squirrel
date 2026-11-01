import { useEffect, useMemo, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { PROGRESS_READS_CONFIGURED, progressApi, progressReadsLive, type LifetimeProgress, type ProgressHistory, type WeeklyProgress, } from '@/api/progress';
import { campusApi } from '@/api/campus';
import { useRemote } from '@/api/useRemote';
import { xpApi } from '@/api/xp';
import { useAuth } from '@/auth/AuthProvider';
import { ErrorState, LoadingRows } from '@/components/campus/States';
import { AnimatedNumber, Button, Card, Display, EmptyState, FadeIn, Header, Icon, Kicker, PressScale, ProgressBar, Ring, Screen, Segmented, tap } from '@/components/ui';
import { liveHeatmap, liveStats, type Period, type Stat } from '@/logic/progressStats';
import { sourceRows } from '@/logic/xpHistory';
import { alpha, colors, fonts, radius } from '@/theme';

/**
 * YOUR PROGRESS: today → progress over time → performance → what to do next.
 * Every figure comes from the progress-service (daily goals, streak, XP, level, week-over-week,
 * history); level progress, XP this week / month and XP by source from the Run Module's
 * /v1/xp/stats, loaded on its own so the rest of the screen works while it isn't live. The campus rank is the Squirrels board's own `me` row (the board this row opens), so
 * the two never disagree. Not configured or signed out → a "not connected" / sign-in state.
 * There is no sample data: nothing here is invented.
 */

/** `campus`: your weekly rank (null = not on the board yet), or undefined when the board couldn't load. */
type LiveData = { lifetime: LifetimeProgress; weekly: WeeklyProgress; history: ProgressHistory; campus?: { rank: number | null } };
const loadLive = async (): Promise<LiveData> => {
  const [lifetime, weekly, history, campus] = await Promise.all([
    progressApi.lifetime(),
    progressApi.weekly(),
    progressApi.history(366),
    campusApi.squirrelBoard('weekly', 1).then((b) => ({ rank: b.me?.rank ?? null }), () => undefined),
  ]);
  return { lifetime, weekly, history, campus };
};

const PERIODS: Period[] = ['Day', 'Week', 'Month', 'Year'];
// No steps: nothing counts them (no pedometer or Health Connect, and nothing writes steps server-side),
// so a Steps tab would read 0 forever.
const METRICS = ['active', 'kcal', 'workouts'] as const;
type Metric = (typeof METRICS)[number];
const METRIC_LABEL: Record<Metric, string> = { active: 'Active', kcal: 'Calories', workouts: 'Workouts' };
/** Units of each series bucket (the Year series is stored in thousands / hours). */
const unit = (m: Metric, p: Period) =>
  m === 'kcal' ? (p === 'Year' ? 'k kcal' : 'kcal') : m === 'active' ? (p === 'Year' ? 'h' : 'min') : 'workouts';
const PREV: Record<Period, string> = { Day: 'yesterday', Week: 'last week', Month: 'last month', Year: 'last year' };
const HEAT = [alpha(colors.text, 0.06), alpha(colors.primary, 0.25), alpha(colors.primary, 0.45), alpha(colors.primary, 0.7), colors.primary];

export default function Progress() {
  const { mode } = useAuth();
  const live = progressReadsLive(mode);
  const remote = useRemote(live ? 'progress:screen' : null, loadLive);
  const L = live ? remote.data : undefined;
  const xp = useRemote(live ? 'xp:stats' : null, xpApi.stats);
  const X = live ? xp.data : undefined;
  const [period, setPeriod] = useState<Period>('Week');
  const [metric, setMetric] = useState<Metric>('active');

  // ---- TODAY: the server's daily goals
  const daily = L
    ? L.lifetime.today.goals.map((g) => ({ id: g.id, title: g.label, current: g.current, goal: g.target, xp: g.xp, icon: (g.id === 'steps' ? 'shoe-print' : g.id === 'active' ? 'timer-outline' : 'arm-flex') as React.ComponentProps<typeof Icon>['name'] }))
    : [];
  const done = daily.filter((m) => m.current >= m.goal);
  const goalPct = daily.length ? daily.reduce((s, m) => s + Math.min(1, m.current / m.goal), 0) / daily.length : 0;
  const xpLeft = daily.filter((m) => m.current < m.goal).reduce((s, m) => s + m.xp, 0);
  const xpToday = L ? L.lifetime.today.xp : 0;
  const streakDays = L ? L.lifetime.streak.current : 0;
  // Level: the server's level curve (/v1/xp/stats when it's live, else /v1/progress).
  const lvl = X
    ? { level: X.level, into: X.level_progress.into_level, span: Math.max(1, X.level_progress.into_level + X.level_progress.needed) }
    : L
    ? { level: L.lifetime.level.level, into: L.lifetime.level.currentXP - L.lifetime.level.xpForCurrentLevel, span: Math.max(1, L.lifetime.level.xpForNextLevel - L.lifetime.level.xpForCurrentLevel) }
    : { level: 1, into: 0, span: 1 };
  const level = lvl.level;

  // ---- PROGRESS: selected period + metric
  const allStats = useMemo(() => (L ? liveStats(L.weekly, L.history, L.lifetime.today.goals, L.lifetime.streak) : null), [L]);
  const heat = useMemo(() => (L ? liveHeatmap(L.history) : []), [L]);

  // ---- NEXT: the server's best open goal (steps have no in-app source, so they're never the CTA)
  const nextMission = [...daily].filter((m) => m.current < m.goal && m.id !== 'steps').sort((a, b) => b.xp - a.xp)[0];

  const header = <Header back title="Your Progress" />;
  if (!live) {
    return (
      <Screen tabBar={false}>
        {header}
        <EmptyState
          title={PROGRESS_READS_CONFIGURED ? 'Sign in to see your progress' : 'Progress isn’t connected'}
          body={PROGRESS_READS_CONFIGURED ? 'Your goals, streak, XP and history come from your account.' : 'Your progress comes from the Run Module, which isn’t connected to this build yet (EXPO_PUBLIC_API_URL).'}
          action={PROGRESS_READS_CONFIGURED ? 'Sign in' : undefined}
          onAction={PROGRESS_READS_CONFIGURED ? () => router.push('/sign-in') : undefined}
        />
      </Screen>
    );
  }
  if (!L || !allStats) {
    const unauthorized = remote.error != null && /token|sign in/i.test(remote.error);
    return (
      <Screen tabBar={false}>
        {header}
        {remote.error ? (
          <EmptyState
            title={unauthorized ? 'Sign in again' : "Couldn't load your progress"}
            body={unauthorized ? 'Your session expired. Sign in to see your progress.' : remote.error}
            action={unauthorized ? 'Sign in' : 'Try again'}
            onAction={unauthorized ? () => router.push('/sign-in') : remote.reload}
          />
        ) : (
          <Card style={{ marginTop: 8, opacity: 0.6 }}>
            <Text style={styles.label}>Syncing your progress…</Text>
            <ProgressBar progress={0} height={8} style={{ marginTop: 10 }} />
          </Card>
        )}
      </Screen>
    );
  }

  const periodStats = allStats[period];
  const stat = periodStats.find((s) => s.id === metric)!;
  const streak = periodStats.find((s) => s.id === 'streak')!;
  const activeDays = L.weekly.activeDays;
  const campusRank = L.campus?.rank ?? null;
  const rankText = campusRank ? `#${campusRank} this week` : L.campus ? 'Unranked' : '–';

  return (
    <Screen tabBar={false}>
      {header}

      {/* ================= TODAY ================= */}
      <Kicker style={{ marginTop: 2 }}>Today</Kicker>
      <FadeIn>
        <Card glow={colors.primary} style={{ marginTop: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TweenRing progress={goalPct} />
            <View style={{ flex: 1, marginLeft: 16 }}>
              <Text style={styles.label}>Today&apos;s XP</Text>
              <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
                <Text style={styles.plus}>+</Text>
                <AnimatedNumber value={xpToday} style={styles.heroNum} />
                <Text style={styles.heroUnit}> XP</Text>
              </View>
              <Text style={styles.sub}>
                {done.length}/{daily.length} goals done · <Text style={{ color: colors.primary }}>{xpLeft} XP</Text> still up for grabs
              </Text>
            </View>
          </View>
          <View style={styles.todayRow}>
            <Mini value={`${done.length}/${daily.length}`} label="Activities" />
            <Mini value={`${xpLeft}`} label="XP left" />
            <Mini value={`${L.weekly.activeDays}/7`} label="Active days" />
            <Mini value={`${streakDays}d`} label="Streak" accent />
          </View>
          {/* XP progression */}
          <View style={{ marginTop: 14 }}>
            <View style={styles.lvlRow}>
              <Text style={styles.lvl}>LV {level}</Text>
              <Text style={styles.sub}>
                {lvl.into.toLocaleString('en-IN')} / {lvl.span.toLocaleString('en-IN')} XP · {(lvl.span - lvl.into).toLocaleString('en-IN')} to LV {level + 1}
              </Text>
            </View>
            <ProgressBar progress={lvl.into / lvl.span} color={colors.primary} color2={colors.gold} height={8} style={{ marginTop: 6 }} />
          </View>
        </Card>
      </FadeIn>

      {/* ================= XP ================= */}
      <Kicker style={{ marginTop: 26 }}>XP</Kicker>
      {X ? (
        <Card style={{ marginTop: 8 }}>
          <View style={[styles.todayRow, { marginTop: 0 }]}>
            <Mini value={X.today.toLocaleString('en-IN')} label="Today" />
            <Mini value={X.week.toLocaleString('en-IN')} label="This week" />
            <Mini value={X.month.toLocaleString('en-IN')} label="This month" />
          </View>
          <View style={{ marginTop: 12 }}>
            {sourceRows(X.by_source).map((r) => (
              <View key={r.source} style={[styles.perfRow, styles.divider]}>
                <Text style={styles.perfLabel}>{r.label}</Text>
                <Text style={styles.perfValue}>{r.xp.toLocaleString('en-IN')} XP</Text>
              </View>
            ))}
            <PressScale onPress={() => router.push('/xp-history')} style={[styles.perfRow, styles.divider]} scaleTo={0.99} accessibilityLabel="XP history">
              <Icon name="history" size={18} color={colors.dim} />
              <Text style={styles.perfLabel}>XP history</Text>
              <Text style={styles.sub}>{X.total.toLocaleString('en-IN')} XP total</Text>
              <Icon name="chevron-right" size={18} color={colors.dim} />
            </PressScale>
          </View>
        </Card>
      ) : xp.error ? (
        <ErrorState cause={xp.cause} onRetry={xp.reload} compact feature="XP stats" />
      ) : (
        <LoadingRows rows={1} height={96} style={{ marginTop: 8 }} />
      )}

      {/* ================= PROGRESS ================= */}
      <Kicker style={{ marginTop: 26 }}>Progress</Kicker>
      <Segmented items={PERIODS} value={period} onChange={setPeriod} style={{ marginTop: 8 }} />
      <View style={styles.chips}>
        {METRICS.map((m) => (
          <Pressable key={m} onPress={() => { tap(); setMetric(m); }} style={[styles.chip, metric === m && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: metric === m }}>
            <Text style={[styles.chipText, metric === m && { color: colors.onPrimary }]}>{METRIC_LABEL[m]}</Text>
          </Pressable>
        ))}
      </View>
      <FadeIn key={`${period}-${metric}`}>
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.label}>{stat.label} this {period.toLowerCase()}</Text>
              <Text style={styles.big}>
                {stat.value}
                {stat.unit ? <Text style={styles.bigUnit}> {stat.unit}</Text> : null}
              </Text>
            </View>
            {stat.delta && <Delta text={stat.delta} vs={PREV[period]} />}
          </View>
          {stat.progress != null && (
            <View style={{ marginTop: 8 }}>
              <ProgressBar progress={stat.progress} color={colors.primary} height={6} />
              <Text style={[styles.sub, { marginTop: 4 }]}>
                {Math.round(stat.progress * 100)}% of goal · {Math.max(0, 100 - Math.round(stat.progress * 100))}% to go
              </Text>
            </View>
          )}
          <Bars stat={stat} unitLabel={unit(metric, period)} />
        </Card>
      </FadeIn>

      {/* Consistency + streak */}
      <Card style={{ marginTop: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name="fire" size={22} color={colors.orange} />
            <Text style={styles.streak}>{streakDays}-day streak</Text>
          </View>
          <Text style={styles.sub}>Active {activeDays}/7 days this week</Text>
        </View>
        <View style={{ gap: 5, marginTop: 12 }}>
          {heat.map((row, r) => (
            <View key={r} style={{ flexDirection: 'row', gap: 5 }}>
              {row.map((v, c) => (
                <View key={c} style={[styles.cell, { backgroundColor: HEAT[v] }, r === heat.length - 1 && { borderWidth: 1, borderColor: alpha(colors.primary, 0.35) }]} />
              ))}
            </View>
          ))}
        </View>
        <View style={[styles.axis, { marginTop: 6 }]}>
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
            <Text key={i} style={[styles.axisLbl, { flex: 1 }]}>{d}</Text>
          ))}
        </View>
        <Text style={[styles.sub, { marginTop: 6 }]}>{streak.delta ? `${streak.label}: ${streak.value} · ${streak.delta}` : `${streak.label}: ${streak.value}`}</Text>
      </Card>

      {/* ================= YOUR PERFORMANCE ================= */}
      <Kicker style={{ marginTop: 26 }}>Your performance</Kicker>
      <Card style={{ marginTop: 8, paddingVertical: 4 }}>
        {periodStats
          .filter((s): s is Stat & { id: Metric } => (METRICS as readonly string[]).includes(s.id))
          .map((s, i) => (
            <Pressable key={s.id} onPress={() => { tap(); setMetric(s.id); }} style={[styles.perfRow, i > 0 && styles.divider]} accessibilityLabel={`${s.label} ${s.value}`}>
              <Icon name={s.icon} size={18} color={colors.dim} />
              <Text style={styles.perfLabel}>{s.label}</Text>
              <Text style={styles.perfValue}>{s.value}</Text>
              <View style={{ width: 86, alignItems: 'flex-end' }}>{s.delta ? <Delta text={s.delta} compact /> : <Text style={styles.sub}>—</Text>}</View>
            </Pressable>
          ))}
        <PressScale onPress={() => router.push('/leaderboard')} style={[styles.perfRow, styles.divider]} scaleTo={0.99} accessibilityLabel="Campus leaderboard">
          <Icon name="trophy-outline" size={18} color={colors.gold} />
          <Text style={styles.perfLabel}>Campus XP rank</Text>
          <Text style={styles.perfValue}>{rankText}</Text>
          <Icon name="chevron-right" size={18} color={colors.dim} style={{ width: 86, textAlign: 'right' }} />
        </PressScale>
      </Card>

      {/* ================= NEXT ================= */}
      <Kicker style={{ marginTop: 26 }}>Next</Kicker>
      <Card glow={colors.primary} style={{ marginTop: 8 }}>
        {nextMission ? (
          <NextAction icon={nextMission.icon} title={nextMission.title} sub={`+${nextMission.xp} XP when you finish · counted by the server`} cta="Start exercise" onPress={() => router.push('/exercise/select')} />
        ) : daily.length > 0 ? (
          <NextAction icon="check-decagram" title="Today's goals are done" sub="Rest up, or go for a run. New goals arrive at midnight." cta="Start a run" onPress={() => router.push('/run')} />
        ) : (
          <NextAction icon="run-fast" title="Go for a run" sub="Runs and workouts count towards your XP and streak." cta="Start a run" onPress={() => router.push('/run')} />
        )}
      </Card>
    </Screen>
  );
}

/** Goal ring that fills up on mount / when the value changes. */
function TweenRing({ progress }: { progress: number }) {
  const [v] = useState(() => new Animated.Value(0));
  const [p, setP] = useState(0);
  useEffect(() => {
    const id = v.addListener(({ value }) => setP(value));
    Animated.timing(v, { toValue: progress, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    return () => v.removeListener(id);
  }, [progress, v]);
  return (
    <Ring progress={p} size={104} stroke={10} color={colors.primary} color2={colors.gold}>
      <Text style={styles.ringPct}>{Math.round(p * 100)}%</Text>
      <Text style={styles.ringLbl}>daily goal</Text>
    </Ring>
  );
}

function Mini({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <View style={styles.mini}>
      <Text style={[styles.miniValue, accent && { color: colors.orange }]} numberOfLines={1}>{value}</Text>
      <Text style={styles.miniLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function Delta({ text, vs, compact }: { text: string; vs?: string; compact?: boolean }) {
  const down = text.trim().startsWith('-') || text.trim().startsWith('−');
  const numeric = /^[+\-−]/.test(text.trim());
  const c = !numeric ? colors.dim : down ? colors.coral : colors.green;
  return (
    <View style={{ alignItems: 'flex-end' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
        {numeric && <Icon name={down ? 'arrow-down' : 'arrow-up'} size={compact ? 13 : 15} color={c} />}
        <Text style={[compact ? styles.deltaSm : styles.delta, { color: numeric ? colors.text : colors.dim }]} numberOfLines={1}>{text.replace(/^[+\-−]/, '')}</Text>
      </View>
      {vs && <Text style={styles.deltaVs}>vs {vs}</Text>}
    </View>
  );
}

/** Single-series bar chart; tap a bar to read its value. */
function Bars({ stat, unitLabel }: { stat: Stat; unitLabel: string }) {
  const values = stat.series.values;
  const lastReal = values.reduce((acc, v, i) => (v > 0 ? i : acc), values.length - 1);
  // The chart remounts when the period or metric changes, so this resets to the latest bucket.
  const [sel, setSel] = useState(lastReal);
  const max = useMemo(() => Math.max(1, ...values), [values]);
  const H = 110;
  return (
    <View style={{ marginTop: 16 }}>
      <View style={styles.tipRow}>
        <Text style={styles.tip}>
          {stat.series.labels[sel]} · <Text style={{ color: colors.text }}>{values[sel].toLocaleString('en-IN')}</Text> {unitLabel}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: H, gap: 4, borderBottomWidth: 1, borderBottomColor: colors.line }}>
        {values.map((v, i) => (
          <Pressable
            key={i}
            onPress={() => { tap(); setSel(i); }}
            style={{ flex: 1, height: H, justifyContent: 'flex-end', alignItems: 'center' }}
            accessibilityLabel={`${stat.series.labels[i]}: ${v} ${unitLabel}`}
            hitSlop={4}>
            <View
              style={{
                width: '68%',
                maxWidth: 22,
                height: Math.max(v > 0 ? 3 : 0, (v / max) * (H - 6)),
                borderTopLeftRadius: 4,
                borderTopRightRadius: 4,
                backgroundColor: i === sel ? colors.primary : alpha(colors.primary, 0.38),
              }}
            />
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 4, marginTop: 6 }}>
        {stat.series.labels.map((l, i) => (
          <Text key={i} style={[styles.axisLbl, { flex: 1 }, i === sel && { color: colors.text }]}>{l}</Text>
        ))}
      </View>
    </View>
  );
}

function NextAction({ icon, title, sub, cta, onPress }: { icon: React.ComponentProps<typeof Icon>['name']; title: string; sub: string; cta: string; onPress: () => void }) {
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={styles.nextIcon}>
          <Icon name={icon} size={24} color={colors.onPrimary} />
        </View>
        <View style={{ flex: 1 }}>
          <Display size={24} numberOfLines={1}>{title}</Display>
          <Text style={styles.sub}>{sub}</Text>
        </View>
      </View>
      <Button label={cta} icon="arrow-right" size="md" onPress={onPress} style={{ marginTop: 14 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.dim, fontFamily: fonts.label, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  sub: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  plus: { color: colors.primary, fontFamily: fonts.display, fontSize: 30 },
  heroNum: { color: colors.text, fontFamily: fonts.display, fontSize: 44, lineHeight: 52 },
  heroUnit: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 18 },
  ringPct: { color: colors.text, fontFamily: fonts.display, fontSize: 26 },
  ringLbl: { color: colors.dim, fontFamily: fonts.medium, fontSize: 10, marginTop: -2 },
  todayRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
  mini: { flex: 1, backgroundColor: colors.cardHi, borderRadius: radius.md, paddingVertical: 9, alignItems: 'center' },
  miniValue: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 18 },
  miniLabel: { color: colors.dim, fontFamily: fonts.label, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' },
  lvlRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  lvl: { color: colors.gold, fontFamily: fonts.labelBold, fontSize: 15, letterSpacing: 1 },
  chips: { flexDirection: 'row', gap: 8, marginTop: 10, marginBottom: 10 },
  chip: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.sub, fontFamily: fonts.label, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase' },
  big: { color: colors.text, fontFamily: fonts.display, fontSize: 34 },
  bigUnit: { color: colors.dim, fontFamily: fonts.label, fontSize: 14 },
  delta: { fontFamily: fonts.labelBold, fontSize: 16 },
  deltaSm: { fontFamily: fonts.labelBold, fontSize: 13 },
  deltaVs: { color: colors.dim, fontFamily: fonts.regular, fontSize: 10 },
  tipRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 6 },
  tip: { color: colors.dim, fontFamily: fonts.label, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase' },
  axis: { flexDirection: 'row', justifyContent: 'space-between' },
  axisLbl: { color: colors.mute, fontFamily: fonts.semibold, fontSize: 10, textAlign: 'center' },
  streak: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  cell: { flex: 1, aspectRatio: 1.6, borderRadius: 5 },
  perfRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  perfLabel: { flex: 1, color: colors.sub, fontFamily: fonts.medium, fontSize: 14 },
  perfValue: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 16 },
  milestone: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12 },
  msTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: 14 },
  msPct: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 14 },
  rewardIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  nextIcon: { width: 48, height: 48, borderRadius: 14, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  alsoRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line },
});
