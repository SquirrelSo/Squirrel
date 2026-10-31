/* lowLight.ts — low-light preprocessing so pose detection still works on very poor cameras.

   Cheap phone cameras in ordinary indoor light produce dark, noisy, heavily compressed frames,
   and the pose detector stops finding the person long before a human would. Measured with the
   real MediaPipe lite model on a degraded squat image (320 px long side, JPEG q=0.4):

       mean frame luma      raw frames usable      after this preprocessing
            ~17                   5/8                     8/8
            ~12                   0/8                     8/8
             ~9                   0/8                     7/8
         45 – 155                 8/8                     8/8 (not applied)

   "Usable" = every rule-critical joint at visibility ≥ 0.5, i.e. the UNCHANGED backend
   confidence floor. The preprocessing is a 1 px blur (suppresses sensor noise, which a plain
   brightness boost would amplify — brightening alone measured WORSE) followed by a brightness gain
   toward mid-grey. It only changes pixel intensities: geometry, frame size and therefore landmark
   coordinates are untouched, and the model still has to find the person under its own
   confidence gates. Nothing is inferred or invented when it cannot.

   It is applied only to DARK frames (hysteresis on a smoothed mean luma), because on bright but
   tiny frames the blur measurably costs accuracy. Both canvas operations are GPU-composited
   filters, and brightness is sampled from a 32×32 thumbnail a few times a second, so the
   per-frame cost stays small on low-end phones.

   Overrides for field testing: ?lowlight=off | on (force), else auto. */

/** Enhance when the smoothed mean luma drops below ENTER, stop once it rises above EXIT. */
export const LOWLIGHT_ENTER_LUMA = 30
export const LOWLIGHT_EXIT_LUMA = 38
/** Below this even enhanced frames rarely hold the confidence floor — ask for more light. */
export const TOO_DARK_LUMA = 7
/** Brightness gain aims the frame's mean luma at this level, capped at MAX_GAIN. */
export const TARGET_LUMA = 110
export const MAX_GAIN = 8
/** How often brightness is re-sampled, and the smoothing of successive samples. */
export const SAMPLE_INTERVAL_MS = 250
const SMOOTHING = 0.35

export type LightingState = 'ok' | 'low' | 'too_dark'
export type LowLightMode = 'auto' | 'on' | 'off'

export function resolveLowLightMode(): LowLightMode {
  try {
    const q = new URLSearchParams(location.search).get('lowlight')?.toLowerCase()
    if (q === 'on' || q === 'off') return q
  } catch { /* SSR / private mode */ }
  return 'auto'
}

/** Mean Rec.601 luma of RGBA pixel data. */
export function meanLuma(rgba: ArrayLike<number>): number {
  let sum = 0
  let n = 0
  for (let i = 0; i + 2 < rgba.length; i += 4) {
    sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
    n += 1
  }
  return n ? sum / n : 0
}

/** Brightness gain that lifts `luma` toward TARGET_LUMA; never darkens, never above MAX_GAIN. */
export function gainFor(luma: number): number {
  return Math.min(MAX_GAIN, Math.max(1, TARGET_LUMA / Math.max(luma, 1)))
}

/** Pure decision state: smoothed luma → whether to enhance, with which gain, and a user hint. */
export class LowLightPolicy {
  private smoothed: number | null = null
  private enhancing = false
  private readonly mode: LowLightMode

  constructor(mode: LowLightMode = 'auto') {
    this.mode = mode
  }

  update(luma: number): void {
    if (!Number.isFinite(luma)) return
    this.smoothed = this.smoothed == null ? luma : this.smoothed + SMOOTHING * (luma - this.smoothed)
    if (this.enhancing && this.smoothed > LOWLIGHT_EXIT_LUMA) this.enhancing = false
    else if (!this.enhancing && this.smoothed < LOWLIGHT_ENTER_LUMA) this.enhancing = true
  }

  get luma(): number | null { return this.smoothed }

  get active(): boolean {
    if (this.mode === 'on') return true
    if (this.mode === 'off') return false
    return this.enhancing
  }

  get gain(): number { return this.smoothed == null ? 1 : gainFor(this.smoothed) }

  get lighting(): LightingState {
    if (this.smoothed == null) return 'ok'
    if (this.smoothed < TOO_DARK_LUMA) return 'too_dark'
    return this.smoothed < LOWLIGHT_ENTER_LUMA ? 'low' : 'ok'
  }

  reset(): void {
    this.smoothed = null
    this.enhancing = false
  }
}

/** Canvas layer: samples brightness and, when the policy says so, returns an enhanced frame of
 *  the SAME size for the detector. Falls back to the raw video if canvases are unavailable. */
export class LowLightPreprocessor {
  readonly policy: LowLightPolicy
  private probe: HTMLCanvasElement | null = null
  private probeCtx: CanvasRenderingContext2D | null = null
  private out: HTMLCanvasElement | null = null
  private outCtx: CanvasRenderingContext2D | null = null
  private lastSampleMs = -Infinity
  private broken = false

  constructor(mode: LowLightMode = resolveLowLightMode()) {
    this.policy = new LowLightPolicy(mode)
  }

  /** The image to run pose detection on for this frame. */
  source(video: HTMLVideoElement, nowMs: number): HTMLVideoElement | HTMLCanvasElement {
    if (this.broken || typeof document === 'undefined') return video
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return video
    try {
      if (nowMs - this.lastSampleMs >= SAMPLE_INTERVAL_MS) {
        this.lastSampleMs = nowMs
        this.policy.update(this.sample(video))
      }
      if (!this.policy.active) return video
      if (!this.out) {
        this.out = document.createElement('canvas')
        this.outCtx = this.out.getContext('2d')
      }
      if (!this.outCtx) throw new Error('2d context unavailable')
      if (this.out.width !== w || this.out.height !== h) { this.out.width = w; this.out.height = h }
      this.outCtx.filter = `blur(1px) brightness(${this.policy.gain.toFixed(3)})`
      this.outCtx.drawImage(video, 0, 0, w, h)
      this.outCtx.filter = 'none'
      return this.out
    } catch (e) {
      // Never let preprocessing take pose detection down: disable it and use the raw frames.
      console.warn('[lowlight] disabled, using raw frames:', e)
      this.broken = true
      return video
    }
  }

  private sample(video: HTMLVideoElement): number {
    if (!this.probe) {
      this.probe = document.createElement('canvas')
      this.probe.width = 32
      this.probe.height = 32
      this.probeCtx = this.probe.getContext('2d', { willReadFrequently: true })
    }
    if (!this.probeCtx) throw new Error('2d context unavailable')
    this.probeCtx.drawImage(video, 0, 0, 32, 32)
    return meanLuma(this.probeCtx.getImageData(0, 0, 32, 32).data)
  }

  reset(): void {
    this.policy.reset()
    this.lastSampleMs = -Infinity
  }
}
