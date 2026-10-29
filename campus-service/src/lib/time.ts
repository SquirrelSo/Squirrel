export const nowIso = () => new Date().toISOString();
export const addHours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);
export const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
export const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
export const isFuture = (iso: string | null | undefined) => !!iso && Date.parse(iso) > Date.now();

/** Start of the leaderboard window, in UTC. 'daily' = today, 'weekly' = last 7 days, 'alltime' = epoch. */
export function periodStart(period: 'daily' | 'weekly' | 'alltime'): Date {
  const now = new Date();
  if (period === 'alltime') return new Date(0);
  if (period === 'daily') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(now.getTime() - 7 * 86_400_000);
}
