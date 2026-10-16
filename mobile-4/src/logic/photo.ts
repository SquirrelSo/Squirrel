/**
 * What a completed photo upload means for the screen. Pure, so it's unit-tested without the app.
 *
 * Social has no moderation step and sends no verdict: stored (`ready`) with no `moderation` field
 * means usable now, never "waiting for a check" that will not come. A verdict, if one is ever
 * sent, decides. Nothing is polled (Social has no GET /v1/media/{id}).
 */
export type StoredPhoto = { status: 'pending' | 'ready'; moderation?: 'pending' | 'approved' | 'rejected' | null };

export function photoOutcome(m: StoredPhoto): 'usable' | 'rejected' | 'checking' {
  if (m.moderation === 'rejected') return 'rejected';
  if (m.status !== 'ready' || m.moderation === 'pending') return 'checking';
  return 'usable';
}
