/**
 * Partner Hunt data, keyed by the signed-in Exercise user (useAuth().userId). Requests stay null until
 * the auth token has loaded, so a cold start from a notification never races it.
 */
import { invalidateRemote, useRemote } from '@/api/useRemote';
import { PARTNER_HUNT_CONFIGURED, partnerHuntApi, type BoardCard, type PartnerRequests, type PartnerStatus } from '@/api/partnerHunt';
import { useAuth } from '@/auth/AuthProvider';
import { rememberCards } from '@/state/partnerCards';

export function usePartnerHuntUser() {
  const { mode, userId } = useAuth();
  const live = PARTNER_HUNT_CONFIGURED && mode === 'live' && !!userId;
  return { live, userId: live ? userId! : null, signedOut: mode === 'signed-out' || mode === 'demo', configured: PARTNER_HUNT_CONFIGURED };
}

export function usePartnerStatus() {
  const { userId } = usePartnerHuntUser();
  return useRemote<PartnerStatus>(userId ? `ph:status:${userId}` : null, () => partnerHuntApi.status(userId!));
}

export function usePartnerMatches() {
  const { userId } = usePartnerHuntUser();
  return useRemote<BoardCard[]>(userId ? `ph:matches:${userId}` : null, async () => {
    const r = await partnerHuntApi.matches(userId!);
    rememberCards(r.matches);
    return r.matches;
  });
}

export function usePartnerRequests() {
  const { userId } = usePartnerHuntUser();
  return useRemote<PartnerRequests>(userId ? `ph:requests:${userId}` : null, async () => {
    const r = await partnerHuntApi.requests(userId!);
    rememberCards([...r.incoming.map((x) => x.person), ...r.outgoing.map((x) => x.person), ...r.connections.map((x) => x.person)]);
    return r;
  });
}

/** After any change: everything Partner Hunt shows is re-read. */
export const invalidatePartnerHunt = () => invalidateRemote('ph:');
