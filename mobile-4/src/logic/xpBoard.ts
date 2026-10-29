/**
 * The XP board's rows, from whichever owner serves the window (WI-09):
 *   daily / weekly  Social's GET /v1/leaderboards/xp: the Run Module's own numbers, with each person's
 *                   Social profile (name, avatar, hostel), so rows are named and open the profile.
 *   monthly         the Run Module's GET /v1/leaderboard/xp: login subs only, so other people stay
 *                   "Squirrel" (no names invented) and rows aren't tappable (a sub is not a profile id).
 * Pure, so it's unit-tested. Every rank and XP figure is the server's.
 */
import type { XpLeaderboard, XpLeaderboardWindow } from '@/api/featureContracts';

export type XpBoardPerson = { user_id: string; display_name: string; avatar_url: string | null };
export type XpBoardRow = { key: string; rank: number; xp: number; me: boolean; person: XpBoardPerson | null; hostel: string | null };
export type XpBoardView = { window: XpLeaderboardWindow; day: string; rows: XpBoardRow[]; meRow: XpBoardRow | null; totalRanked: number | null };

/** The fields of Social's XpBoard (api/community.ts) this needs. */
export type SocialXpBoardLike = {
  window: 'daily' | 'weekly';
  day: string;
  available: boolean;
  entries: SocialXpEntryLike[];
  me: SocialXpEntryLike | null;
};
type SocialXpEntryLike = { rank: number; xp: number; hostel: string | null; is_me: boolean; user: { id: string; display_name: string; avatar_url: string | null } };

/** Social names the daily and weekly boards only; monthly has no named source. */
export const namedWindow = (w: XpLeaderboardWindow): w is 'daily' | 'weekly' => w === 'daily' || w === 'weekly';

const socialRow = (e: SocialXpEntryLike): XpBoardRow => ({
  key: e.user.id,
  rank: e.rank,
  xp: e.xp,
  me: e.is_me,
  person: { user_id: e.user.id, display_name: e.user.display_name, avatar_url: e.user.avatar_url },
  hostel: e.hostel,
});

export function fromSocialBoard(b: SocialXpBoardLike): XpBoardView {
  const rows = b.entries.map(socialRow);
  const me = b.me ? socialRow(b.me) : null;
  return { window: b.window, day: b.day, rows, meRow: me && !rows.some((r) => r.me) ? me : null, totalRanked: null };
}

export function fromRunBoard(b: XpLeaderboard): XpBoardView {
  const meId = b.me?.user_id;
  const row = (e: XpLeaderboard['entries'][number]): XpBoardRow => ({ key: e.user_id, rank: e.rank, xp: e.xp, me: e.user_id === meId, person: null, hostel: null });
  const rows = b.entries.map(row);
  return { window: b.window, day: b.day, rows, meRow: b.me && !rows.some((r) => r.me) ? row(b.me) : null, totalRanked: b.total_ranked };
}

export const xpBoardSpan = (w: XpLeaderboardWindow) => (w === 'daily' ? 'today' : w === 'weekly' ? 'in the last 7 days' : 'this month');
