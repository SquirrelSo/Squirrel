/**
 * What the run summary says about a Run Module result (GET /v1/runs/:id).
 *
 * A route that doesn't enclose ground is still a valid activity: it finalises (or is flagged) with
 * distance, time and XP, and `territory_reason` says why no ground was claimed. Only `rejected`
 * is a failed activity, explained by `rejection.reason` through the caller's own mapping.
 */
export type TerritoryReason = 'not_closed' | 'no_faces' | 'below_minimum_area' | (string & {});

const NO_TERRITORY_TEXT: Record<string, string> = {
  not_closed: "Your loop didn't close, so no ground was claimed. Finish near where you started to claim it.",
  no_faces: "Your route didn't enclose any ground, so none was claimed.",
  below_minimum_area: 'Your loop was too small to claim ground. Go a bit wider next time.',
};

/** Why a recorded activity claimed no ground, or null when there's nothing to explain. */
export function territoryReasonText(reason: TerritoryReason | null | undefined): string | null {
  if (!reason) return null;
  return NO_TERRITORY_TEXT[reason] ?? 'No ground was claimed this time.';
}

/**
 * The reason line under the verdict for a non-rejected outcome. Rejections are worded by the
 * caller (rejection reasons have their own mapping).
 */
export function recordedRunReason(outcome: 'accepted' | 'flagged' | 'processing', reason: TerritoryReason | null | undefined): string {
  if (outcome === 'processing') return 'Uploaded. The server is still finishing it.';
  const noGround = territoryReasonText(reason);
  if (outcome === 'flagged') return noGround ? `Flagged for review. ${noGround}` : 'Flagged for review.';
  return noGround ? `Recorded. ${noGround}` : 'Verified by the server.';
}
