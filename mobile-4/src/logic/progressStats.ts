/**
 * progress-service data → the `Stat` / heatmap shapes Your Progress already renders.
 * Pure functions; every number comes from the server (nothing is estimated here).
 */
import type { DailyGoal, DayRow, ProgressHistory, Streak, WeeklyProgress } from '@/api/progress';
import type { IconName } from '@/data/icons';
import { colors } from '@/theme';

export type Period = 'Day' | 'Week' | 'Month' | 'Year';
export type StatSeries = { labels: string[]; values: number[] };
export type Stat = {
  id: 'steps' | 'active' | 'kcal' | 'workouts' | 'streak';
  label: string;
  value: string;
  unit?: string;
  icon: IconName;
  color: string;
  /** 0..1 progress towards the period goal, when there is one. */
  progress?: number;
  delta?: string;
  series: StatSeries;
};

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

type Totals = { steps: number; active: number; kcal: number; workouts: number };
const ZERO: Totals = { steps: 0, active: 0, kcal: 0, workouts: 0 };
const add = (t: Totals, d: DayRow): Totals => ({ steps: t.steps + d.steps, active: t.active + d.activeMinutes, kcal: t.kcal + d.calories, workouts: t.workouts + d.workouts });
const sum = (days: DayRow[]) => days.reduce(add, ZERO);

const n = (v: number) => Math.round(v).toLocaleString('en-IN');
export const fmtMinutes = (m: number) => {
  const r = Math.round(m);
  return r < 60 ? `${r}m` : `${Math.floor(r / 60)}h ${r % 60}m`;
};
const dow = (iso: string) => DOW[new Date(`${iso}T00:00:00Z`).getUTCDay()];

/** "+12%" / "−8%" against the previous period; undefined when there is nothing to compare with. */
const pct = (cur: number, prev: number) => {
  if (prev <= 0) return undefined;
  const p = Math.round(((cur - prev) / prev) * 100);
  return `${p >= 0 ? '+' : '−'}${Math.abs(p)}%`;
};
const diffMin = (cur: number, prev: number) => {
  if (prev <= 0 && cur <= 0) return undefined;
  const d = Math.round(cur - prev);
  return `${d >= 0 ? '+' : '−'}${fmtMinutes(Math.abs(d))}`;
};
const diffCount = (cur: number, prev: number) => (prev <= 0 && cur <= 0 ? undefined : `${cur - prev >= 0 ? '+' : '−'}${Math.abs(cur - prev)}`);

type Goals = { steps: number; active: number; workouts: number };
export const goalTargets = (goals: DailyGoal[]): Goals => ({
  steps: goals.find((g) => g.id === 'steps')?.target ?? 0,
  active: goals.find((g) => g.id === 'active')?.target ?? 0,
  workouts: goals.find((g) => g.id === 'workout')?.target ?? 0,
});

function build(cur: Totals, prev: Totals | null, days: number, goals: Goals | null, labels: string[], series: Totals[], streak: Streak, streakSeries: number[], scaleYear = false): Stat[] {
  const prog = (v: number, g: number) => (goals && g > 0 ? Math.min(1, v / (g * days)) : undefined);
  const s = (k: keyof Totals, f = 1) => series.map((t) => Math.round((t[k] / f) * 10) / 10);
  return [
    {
      id: 'steps', label: 'Steps', value: n(cur.steps), unit: goals && goals.steps ? `/ ${n(goals.steps * days)}` : undefined, icon: 'shoe-print', color: colors.green,
      progress: prog(cur.steps, goals?.steps ?? 0), delta: prev ? pct(cur.steps, prev.steps) : undefined, series: { labels, values: s('steps', scaleYear ? 1000 : 1) },
    },
    {
      id: 'active', label: 'Active Time', value: fmtMinutes(cur.active), icon: 'timer-outline', color: colors.blue,
      progress: prog(cur.active, goals?.active ?? 0), delta: prev ? diffMin(cur.active, prev.active) : undefined, series: { labels, values: s('active', scaleYear ? 60 : 1) },
    },
    {
      id: 'kcal', label: 'Calories', value: n(cur.kcal), unit: 'kcal', icon: 'fire', color: colors.secondary,
      delta: prev ? pct(cur.kcal, prev.kcal) : undefined, series: { labels, values: s('kcal', scaleYear ? 1000 : 1) },
    },
    {
      id: 'workouts', label: 'Workouts', value: goals && goals.workouts ? `${cur.workouts} / ${goals.workouts * days}` : `${cur.workouts}`, icon: 'arm-flex', color: colors.primary,
      progress: prog(cur.workouts, goals?.workouts ?? 0), delta: prev ? diffCount(cur.workouts, prev.workouts) : undefined, series: { labels, values: s('workouts') },
    },
    {
      id: 'streak', label: 'Streak', value: `${streak.current} day${streak.current === 1 ? '' : 's'}`, icon: 'fire-circle', color: colors.purple,
      delta: streak.longest > 0 ? (streak.current >= streak.longest ? 'Personal best' : `Best: ${streak.longest}`) : undefined, series: { labels: streakSeries.map((_, i) => labels[i] ?? ''), values: streakSeries },
    },
  ];
}

/** Stats for every period from /v1/progress/weekly + /v1/progress/history (a year, ending today). */
export function liveStats(weekly: WeeklyProgress, history: ProgressHistory, goals: DailyGoal[], streak: Streak): Record<Period, Stat[]> {
  const days = history.days; // oldest → today
  const g = goalTargets(goals);
  const last = (k: number, offset = 0) => days.slice(Math.max(0, days.length - k - offset), days.length - offset);
  const qualifying = (d: DayRow) => (d.goalsCompleted > 0 ? 1 : 0);

  // Day: today vs yesterday; the chart is the last 7 days.
  const week7 = last(7);
  const today = days[days.length - 1];
  const yesterday = days[days.length - 2];
  const dayStats = build(add(ZERO, today), yesterday ? add(ZERO, yesterday) : null, 1, g, week7.map((d) => dow(d.date)), week7.map((d) => add(ZERO, d)), streak, week7.map(qualifying));

  // Week: this calendar week (Mon–Sun) vs last week, from the server's weekly comparison.
  const wk = (t: WeeklyProgress | WeeklyProgress['previous']): Totals => ({ steps: t.steps, active: t.activeMinutes, kcal: t.calories, workouts: t.workouts });
  const weekStats = build(wk(weekly), wk(weekly.previous), 7, g, weekly.days.map((d) => dow(d.date)), weekly.days.map((d) => add(ZERO, d)), streak, weekly.days.map(qualifying));

  // Month: the last 28 days in four weekly buckets vs the 28 before.
  const m = last(28);
  const buckets = [0, 1, 2, 3].map((i) => sum(m.slice(i * 7, i * 7 + 7)));
  const monthStats = build(sum(m), sum(last(28, 28)), 28, g, ['W1', 'W2', 'W3', 'W4'], buckets, streak, buckets.map((b) => (b.workouts > 0 ? 1 : 0)));

  // Year: this calendar year by month (series in thousands / hours, as the chart labels say).
  const year = today.date.slice(0, 4);
  const inYear = days.filter((d) => d.date.startsWith(year));
  const months = MONTHS.map((_, i) => sum(inYear.filter((d) => Number(d.date.slice(5, 7)) === i + 1)));
  const yearStats = build(sum(inYear), null, inYear.length, null, MONTHS, months, streak, months.map((t) => t.workouts), true);

  return { Day: dayStats, Week: weekStats, Month: monthStats, Year: yearStats };
}

/** 5 weeks × 7 days (Mon–Sun) of intensity 0..4 from goals completed per day; future days are 0. */
export function liveHeatmap(history: ProgressHistory): number[][] {
  const byDate = new Map(history.days.map((d) => [d.date, d]));
  const todayIso = history.to;
  const t = new Date(`${todayIso}T00:00:00Z`);
  const mondayOffset = (t.getUTCDay() + 6) % 7;
  const start = new Date(t.getTime() - (mondayOffset + 28) * 86400000);
  return Array.from({ length: 5 }, (_, r) =>
    Array.from({ length: 7 }, (_, c) => {
      const iso = new Date(start.getTime() + (r * 7 + c) * 86400000).toISOString().slice(0, 10);
      const d = byDate.get(iso);
      if (!d || iso > todayIso) return 0;
      const active = d.workouts > 0 || d.activeMinutes > 0 || d.steps > 0;
      return active ? Math.min(4, 1 + d.goalsCompleted) : 0;
    }),
  );
}
