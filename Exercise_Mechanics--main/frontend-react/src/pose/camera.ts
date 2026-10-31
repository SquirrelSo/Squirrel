/* camera.ts — getUserMedia constraints that behave on ordinary Android phones, not only webcams.

   The previous request was a landscape 1280×720 `ideal` with no other hints. On phones held
   upright that asks for 16:9 LANDSCAPE from a portrait-oriented sensor, and Chrome satisfies an
   aspect-ratio ideal by CROPPING (resizeMode 'crop-and-scale'): the field of view narrows and the
   user has to back away unusually far to get ankles and head in frame. We now:

     • match the requested orientation to the screen (portrait → 720×1280 ideal),
     • prefer the camera's native, uncropped modes (resizeMode 'none', as an ideal — browsers
       that don't know it ignore it),
     • ask for ~30 fps (ideal, never a hard min — in low light phones legitimately drop to 15 fps
       for exposure, and a hard floor would fail acquisition outright),
     • and, if a device rejects the tuned request (OverconstrainedError / odd drivers), fall back
       to the plain front camera instead of showing no camera at all.

   The pose model resizes the person crop to its own input size, so a native lower resolution is
   fine; keypoints are mapped to a resolution-independent space in frameGeometry.ts. */

export function isPortraitViewport(): boolean {
  try {
    if (typeof window.matchMedia === 'function') return window.matchMedia('(orientation: portrait)').matches
    return window.innerHeight > window.innerWidth
  } catch {
    return false
  }
}

/** Ordered constraint attempts: tuned first, then progressively plainer fallbacks. */
export function cameraConstraintAttempts(portrait: boolean): MediaStreamConstraints[] {
  const long = 1280
  const short = 720
  const tuned = {
    facingMode: 'user',
    width: { ideal: portrait ? short : long },
    height: { ideal: portrait ? long : short },
    frameRate: { ideal: 30 },
    resizeMode: { ideal: 'none' },
  } as MediaTrackConstraints
  return [
    { video: tuned, audio: false },
    { video: { facingMode: 'user' }, audio: false },
    { video: true, audio: false },
  ]
}

/** Errors that mean "these constraints / this mode don't work here" — worth a plainer retry.
 *  Permission and no-device errors are final and must surface to the user unchanged. */
export function isRetryableCameraError(e: unknown): boolean {
  const name = e instanceof DOMException || e instanceof Error ? e.name : ''
  return name === 'OverconstrainedError' || name === 'NotReadableError' || name === 'AbortError' || name === 'TypeError'
}

/** Acquire the front camera, falling back through plainer constraints on device quirks. */
export async function acquireCameraStream(
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>,
  portrait: boolean,
): Promise<MediaStream> {
  let lastError: unknown = null
  for (const constraints of cameraConstraintAttempts(portrait)) {
    try {
      return await getUserMedia(constraints)
    } catch (e) {
      lastError = e
      if (!isRetryableCameraError(e)) throw e
    }
  }
  throw lastError
}
