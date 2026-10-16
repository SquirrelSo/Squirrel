/* adapter.ts — the one live-pose → EngineState mapping still needed under the new flow.
   (deriveCue / deriveSymmetry / deriveCalibration were part of the old single-/ws contract and
   are gone: cues now come straight from /ws/train, and there is no calibration phase.) */

/* Tracking confidence during the ACTIVE phase, from live landmark visibility of the joints the
   rep counter gates on. Exercise-specific: squat gates on hips+knees; a bicep curl on
   shoulders+elbows+wrists. Drives the low-confidence hold-and-dim rule. */
const CONF_JOINTS: Record<string, number[]> = {
  squat: [23, 24, 25, 26],              // left/right hip, left/right knee
  bicep_curl: [11, 12, 13, 14, 15, 16], // shoulders, elbows, wrists
  high_knee: [11, 12, 23, 24, 25, 26, 27, 28], // shoulders, hips, knees, ankles
}

/* Exercises filmed from the SIDE cannot use the all-joints rule above: in a true profile view the
   far-side limbs are occluded, so MediaPipe reports them as low-confidence predictions and a
   min-across-both-sides reading would sit under CONF_FLOOR for the entire set — permanently
   dimming the HUD of a user who is positioned exactly right. The backend has the same problem and
   solves it by measuring whichever side the camera can actually see (kinematics.analysis_side), so
   confidence is scored the same way: the best single side, not the worst joint overall. */
const CONF_SIDE_GROUPS: Record<string, number[][]> = {
  // left / right: shoulder, elbow, wrist, hip, ankle — the chain push-up depth and body line read.
  pushup: [[11, 13, 15, 23, 27], [12, 14, 16, 24, 28]],
}

export function liveTrackingConfidence(
  landmarks: { visibility: number }[] | null,
  motion: string = 'squat',
): number {
  const groups = CONF_SIDE_GROUPS[motion]
  if (groups) {
    const needed = Math.max(...groups.flat())
    if (!landmarks || landmarks.length <= needed) return 0
    return Math.max(...groups.map((idx) => Math.min(...idx.map((i) => landmarks[i]?.visibility ?? 0))))
  }
  const idx = CONF_JOINTS[motion] ?? CONF_JOINTS.squat
  if (!landmarks || landmarks.length <= Math.max(...idx)) return 0
  const vis = idx.map((i) => landmarks[i]?.visibility ?? 0)
  return Math.min(...vis)
}
