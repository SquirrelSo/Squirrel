import type { Meetup, MeetupAction, PersonLite } from '@/api/campus/types';

/** Check-in window from the backend's timestamps (the server still enforces it). */
export const checkInOpen = (m: Meetup, now = Date.now()) => Date.parse(m.check_in_opens_at) <= now && Date.parse(m.check_in_closes_at) >= now;

/** Still open for answers: not cancelled, not over. (campus-service: a confirmed meetup past its start is completed.) */
export const meetupOpen = (m: Meetup) => m.status !== 'cancelled' && m.status !== 'completed';

/**
 * What you can do with this meetup, as campus-service allows it: the host cancels; an invited guest
 * accepts or declines; a guest who's going can leave; a guest who declined can accept again.
 */
export function meetupActions(m: Meetup): MeetupAction[] {
  if (!meetupOpen(m) || !m.my_role) return [];
  if (m.my_role === 'host') return ['cancel'];
  if (m.my_rsvp === 'invited') return ['accept', 'decline'];
  if (m.my_rsvp === 'accepted') return ['leave'];
  if (m.my_rsvp === 'declined') return ['accept'];
  return [];
}

/** How long Decline waits before it's sent: Undo inside this window means nothing was ever sent. */
export const DECLINE_UNDO_MS = 5_000;

export type InviteSource = 'shared' | 'nearby' | 'crew';
export type InviteCandidate = { person: PersonLite; why: string[]; sources: InviteSource[] };

/**
 * People you've crossed paths with, once each: shared zones first (most shared first, as given),
 * then Nearby, then your crews. Each says why they're there ("2 shared zones", "Nearby", "Night Owls").
 * Never you; nobody without an id.
 */
export function inviteCandidates(
  src: {
    shared?: { person: PersonLite; shared_zones_count: number }[];
    nearby?: PersonLite[];
    crews?: { name: string; members: PersonLite[] }[];
  },
  meId: string | null,
): InviteCandidate[] {
  const out = new Map<string, InviteCandidate>();
  const add = (p: PersonLite, source: InviteSource, why: string) => {
    if (!p?.user_id || p.user_id === meId) return;
    const c = out.get(p.user_id) ?? { person: p, why: [], sources: [] };
    if (!c.why.includes(why)) c.why.push(why);
    if (!c.sources.includes(source)) c.sources.push(source);
    out.set(p.user_id, c);
  };
  for (const s of src.shared ?? []) add(s.person, 'shared', s.shared_zones_count === 1 ? '1 shared zone' : `${s.shared_zones_count} shared zones`);
  for (const p of src.nearby ?? []) add(p, 'nearby', 'Nearby');
  for (const c of src.crews ?? []) for (const p of c.members) add(p, 'crew', c.name);
  return [...out.values()];
}
