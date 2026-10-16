/* frameGeometry.ts — map MediaPipe's normalized landmarks into the keypoint space the backend
   analyses, independently of the camera's native resolution.

   The backend's geometric thresholds are expressed in pixels (baseline stability
   `max_joint_stddev_px`, `min_baseline_span_px`, `min_shoulder_px`, `min_upper_arm_px`, …) and were
   tuned on the 1280×720 stream we request. Android camera pipelines routinely ignore that request
   and deliver 640×480, 480×640 (portrait), 960×540 … Sending `lm.x * videoWidth` then made every
   pixel threshold mean a different fraction of the body on every phone: a 640-wide camera needed
   the user twice as large in frame to pass the same size floors.

   Keypoints are therefore sent in a CANONICAL space: the frame's long side is scaled to
   CANONICAL_LONG_SIDE_PX with one uniform factor (aspect ratio preserved, so every angle and ratio
   the rules compute is unchanged). A 1280×720 camera maps 1:1 — identical to the previous
   behaviour and to every existing baseline/capture — and a lower-resolution camera gets the same
   units instead of silently stricter or looser thresholds. This does NOT loosen any gate: it makes
   the configured values mean the same thing on every device. */
import type { Landmark } from '../types'
import { LANDMARK_NAMES } from './landmarks'

/** Long side of the reference stream the pixel thresholds were tuned on (1280×720). */
export const CANONICAL_LONG_SIDE_PX = 1280

export type Keypoint = { x: number; y: number; z: number; v: number }

/** Uniform scale from native video pixels to canonical pixels; null until the video has a size. */
export function canonicalScale(videoWidth: number, videoHeight: number): number | null {
  if (!(videoWidth > 0) || !(videoHeight > 0)) return null
  return CANONICAL_LONG_SIDE_PX / Math.max(videoWidth, videoHeight)
}

/** Canonical keypoints for one pose. Returns null when the video size is not known yet (sending
 *  zeros would look like a real, collapsed pose to the backend). RAW / un-mirrored on purpose. */
export function toCanonicalKeypoints(
  landmarks: readonly Landmark[],
  videoWidth: number,
  videoHeight: number,
): Record<string, Keypoint> | null {
  const scale = canonicalScale(videoWidth, videoHeight)
  if (scale == null) return null
  const w = videoWidth * scale
  const h = videoHeight * scale
  const keypoints: Record<string, Keypoint> = {}
  landmarks.forEach((lm, i) => {
    const name = LANDMARK_NAMES[i]
    if (!name) return
    keypoints[name] = {
      x: Math.round(lm.x * w),
      y: Math.round(lm.y * h),
      // z uses MediaPipe's x-scale convention, so it is scaled by the (canonical) width too.
      z: Math.round((lm.z ?? 0) * w),
      v: Number((lm.visibility ?? 1.0).toFixed(3)),
    }
  })
  return keypoints
}
