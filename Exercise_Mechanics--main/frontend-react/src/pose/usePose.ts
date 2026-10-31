/* usePose.ts — MediaPipe PoseLandmarker: camera + 33 landmarks + per-frame keypoint send.
   Ported from the original FitSync vanilla-JS MediaPipe wiring (model URLs, landmark
   names, rounding, visibility gating) so the backend receives the { t_ms, keypoints } frames it
   already expects. Keypoints are in a canonical pixel space (long side 1280, see
   frameGeometry.ts): identical to before on a 1280×720 camera, resolution-independent elsewhere.

   The hook is data-source-only: it surfaces live landmarks via onFrame and pushes keypoints
   through the provided send() each frame. It does not render.

   ── MIRRORING CONTRACT (P1-H) — do not "fix" the apparent asymmetry ──────────────────────
   The displayed video is CSS-mirrored (scaleX(-1)) and the drawn skeleton mirrors x via
   (1 − lm.x) for a natural selfie view (see Skeleton.tsx). The keypoints sent to the backend
   below are deliberately RAW / UN-mirrored: the backend's knee-valgus and bilateral-symmetry
   rules depend on MediaPipe's raw left/right coordinates. Mirroring the sent keypoints to
   "match" the display would silently break those rules. Keep sendKeypoints un-mirrored. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import type { Landmark } from '../types'
import { PoseFilter } from './oneEuro'
// Model variant (lite/full/heavy) + delegate (GPU/CPU) are selectable for benchmarking
// via ?model= / ?delegate= or localStorage — see poseModel.ts. Drop-in: identical output.
import { resolvePoseModelConfig, benchEnabled, wasmFilesFor } from './poseModel'
// Resolution-independent keypoint space (see frameGeometry.ts) + phone-friendly camera acquisition.
import { toCanonicalKeypoints, type Keypoint } from './frameGeometry'
import { acquireCameraStream, isPortraitViewport } from './camera'
// Low-light preprocessing (denoise + gain on dark frames only) — see lowLight.ts for the evidence.
import { LowLightPreprocessor, type LightingState } from './lowLight'

// ── PoseLandmarker singleton (load once, reuse for every inference) ───────────────────────
// The lite model + WASM are fetched and the GPU landmarker is created exactly ONCE per page
// session, then shared across every coach mount (calibrate → session → recalibrate). Without
// this the model re-downloaded and re-initialised on each mount. The in-flight promise dedupes
// concurrent/duplicate callers (incl. StrictMode's double-invoke); a failed load clears the
// promise so a later mount can retry. The singleton is intentionally never closed — it lives
// for the whole session. detectForVideo only needs monotonically-increasing timestamps, and
// performance.now() stays monotonic across mounts, so reuse is safe.
let landmarkerSingleton: PoseLandmarker | null = null
let landmarkerPromise: Promise<PoseLandmarker> | null = null

function getPoseLandmarker(): Promise<PoseLandmarker> {
  if (landmarkerSingleton) return Promise.resolve(landmarkerSingleton)
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const cfg = resolvePoseModelConfig()
      // WASM comes from the installed @mediapipe/tasks-vision package (same release as the JS
      // API), picking the no-SIMD build on browsers without WASM SIMD (older Android WebViews).
      const simd = await FilesetResolver.isSimdSupported()
      const vision = wasmFilesFor(simd)
      const build = (delegate: 'GPU' | 'CPU') => PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: cfg.modelUrl, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      })
      let lm: PoseLandmarker
      try {
        lm = await build(cfg.delegate)
        console.info(`[pose] model='${cfg.complexity}' delegate='${cfg.delegate}' wasm='${simd ? 'simd' : 'nosimd'}'`)
      } catch (e) {
        // Automatic fallback: a device without working WebGL (no/blocked GPU) would
        // otherwise fail to start. Retry on CPU (WASM) so pose still runs. Only
        // meaningful when we attempted GPU — a CPU attempt that fails is fatal.
        if (cfg.delegate !== 'GPU') throw e
        console.warn(`[pose] GPU delegate failed, falling back to CPU:`, e)
        lm = await build('CPU')
        console.info(`[pose] model='${cfg.complexity}' delegate='CPU' (GPU fallback)`)
      }
      landmarkerSingleton = lm
      return lm
    })()
    landmarkerPromise.catch(() => { landmarkerPromise = null }) // allow retry on failure
  }
  return landmarkerPromise
}

// z is MediaPipe's depth estimate (roughly the same normalized scale as x; smaller =
// closer to camera). Saved to disk for the per-frame keypoint record; NOT used by the
// frontal-plane rules (the backend ignores z in analysis — see the no-z constraint).
export type { Keypoint }
export type FrameMessage = { t_ms: number; keypoints: Record<string, Keypoint> }

// P1-I: model and camera lifecycles are SEPARATE state, not one shared `status`.
export type ModelStatus = 'loading' | 'ready' | 'error'
export type CameraStatus = 'idle' | 'running' | 'error'
export type CameraPermission = 'required' | 'granted' | 'denied'

interface UsePoseArgs {
  /** Called every detected frame with the primary pose's landmarks (or [] on dropout). */
  onFrame: (landmarks: Landmark[]) => void
  /** Send the keypoint message to the backend (the WS sender). */
  send: (msg: FrameMessage) => void
  /** Run the camera + detection loop (P0-C: false on F5 so detection stops, saving CPU). */
  poseActive: boolean
  /** Transmit keypoints to the backend (P0-C: false while paused / off-active so the FSM
   *  doesn't accumulate invisible reps). Detection can run while transmission is gated. */
  sendActive: boolean
  /** True while the workout is paused — drives the logical analysis clock (see below). */
  paused: boolean
}

/** Map a getUserMedia DOMException to actionable recovery copy (P1-E1). */
function cameraErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  switch (name) {
    case 'NotAllowedError':
      return 'Camera access denied — click the lock icon in your browser to allow it.'
    case 'NotFoundError':
      return 'No camera found — plug in a webcam and refresh.'
    case 'NotReadableError':
      return 'Camera is in use by another app — close it and try again.'
    default:
      return e instanceof Error ? e.message : 'Camera unavailable'
  }
}

export function usePose({ onFrame, send, poseActive, sendActive, paused }: UsePoseArgs) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const lastVideoTimeRef = useRef(-1)
  const rafRef = useRef<number | null>(null)

  // Already-loaded singleton → start 'ready' (no loading flash on remount/recalibrate).
  const [modelStatus, setModelStatus] = useState<ModelStatus>(landmarkerSingleton ? 'ready' : 'loading')
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle')
  const [permission, setPermission] = useState<CameraPermission>('required')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0) // bump to re-attempt camera acquisition
  // Scene lighting as seen by the detector: 'low' = being enhanced, 'too_dark' = ask for light.
  const [lighting, setLighting] = useState<LightingState>('ok')

  // keep latest callbacks / flags without restarting the detection loop
  const onFrameRef = useRef(onFrame); onFrameRef.current = onFrame
  const sendRef = useRef(send); sendRef.current = send
  const sendActiveRef = useRef(sendActive); sendActiveRef.current = sendActive

  // ── Logical analysis clock (P0-C) ────────────────────────────────────────────────────
  // The backend uses our outgoing t_ms for tempo / turnaround / 10s stale-phase logic. If we
  // simply stop sending during a pause and resume with raw performance.now(), the next t_ms
  // jumps by the whole paused duration and can trip the stale reset / phantom rep-credit.
  // So outgoing t_ms = performance.now() − (accumulated paused duration). These refs live at
  // hook scope, so the offset PERSISTS across camera-effect re-runs AND WebSocket reconnects.
  const pausedAccumMsRef = useRef(0)
  const pauseStartMsRef = useRef<number | null>(null)
  useEffect(() => {
    if (paused) {
      if (pauseStartMsRef.current == null) pauseStartMsRef.current = performance.now()
    } else if (pauseStartMsRef.current != null) {
      pausedAccumMsRef.current += performance.now() - pauseStartMsRef.current
      pauseStartMsRef.current = null
    }
  }, [paused])
  const logicalNow = useCallback((): number => {
    const live = pauseStartMsRef.current != null ? performance.now() - pauseStartMsRef.current : 0
    return performance.now() - pausedAccumMsRef.current - live
  }, [])

  const retryCamera = useCallback(() => {
    setErrorMsg(null)
    setCameraStatus('idle')
    setRetryNonce((n) => n + 1)
  }, [])

  // ── Attach the shared model on mount ──────────────────────────────────────────────────
  // Reuses the module-level singleton (loaded once for the whole session). On unmount we only
  // detach our ref — the singleton is NOT closed, so the next mount reuses the same instance
  // with no reload. If the model is already loaded, getPoseLandmarker resolves immediately.
  useEffect(() => {
    let cancelled = false
    getPoseLandmarker()
      .then((lm) => {
        if (cancelled) return
        landmarkerRef.current = lm
        setModelStatus('ready')
      })
      .catch((e) => {
        if (cancelled) return
        setModelStatus('error')
        setErrorMsg(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      landmarkerRef.current = null // detach only; the singleton lives on for reuse
    }
  }, [])

  // ── Camera + detection loop (P0-C / P1-I) ─────────────────────────────────────────────
  // Gate on poseActive && modelStatus==='ready'. Depends on modelStatus so the model
  // finishing AFTER the user clicked Start correctly kicks off the camera — but it does NOT
  // depend on cameraStatus (which it sets), so it no longer self-retriggers a teardown.
  useEffect(() => {
    if (!poseActive || modelStatus !== 'ready') return
    let stream: MediaStream | null = null
    let stopped = false

    const sendKeypoints = (landmarks: Landmark[] | null, video: HTMLVideoElement) => {
      if (!sendActiveRef.current) return // P0-C: detection runs, transmission gated
      let keypoints: Record<string, Keypoint> = {}
      if (landmarks) {
        // RAW / un-mirrored on purpose — see the MIRRORING CONTRACT note at top. Mapped to the
        // canonical (resolution-independent) pixel space the backend thresholds are defined in.
        const canonical = toCanonicalKeypoints(landmarks, video.videoWidth, video.videoHeight)
        if (!canonical) return // video size not known yet — never send a collapsed pose
        keypoints = canonical
      }
      sendRef.current({ t_ms: logicalNow(), keypoints })
    }

    // One Euro filter bank — smooths the raw landmarks once, feeding BOTH the skeleton render
    // and the keypoints sent to the backend (single jitter-filtered signal; the backend depth
    // EMA was removed to avoid double-smoothing). Persists across frames; reset on dropout.
    const poseFilter = new PoseFilter()

    // Dark frames from weak cameras are denoised + brightened before detection (same geometry).
    const lowLight = new LowLightPreprocessor()
    let lastLighting: LightingState = 'ok'

    // Opt-in profiler (?posebench=1): rolling avg/max of detectForVideo, flushed every ~2s.
    const bench = benchEnabled()
    let benchSum = 0, benchMax = 0, benchN = 0, benchFlush = performance.now()

    const loop = () => {
      const video = videoRef.current
      const lm = landmarkerRef.current
      if (video && lm && video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime
        const t0 = bench ? performance.now() : 0
        const now = performance.now()
        const result = lm.detectForVideo(lowLight.source(video, now), now)
        const lightingNow = lowLight.policy.lighting
        if (lightingNow !== lastLighting) { lastLighting = lightingNow; setLighting(lightingNow) }
        if (bench) {
          const dt = performance.now() - t0
          benchSum += dt; benchN += 1; if (dt > benchMax) benchMax = dt
          if (performance.now() - benchFlush > 2000) {
            console.info(`[posebench] detectForVideo avg=${(benchSum / benchN).toFixed(1)}ms max=${benchMax.toFixed(1)}ms n=${benchN} (~${(1000 / (benchSum / benchN)).toFixed(0)} fps ceiling)`)
            benchSum = 0; benchMax = 0; benchN = 0; benchFlush = performance.now()
          }
        }
        if (!result.landmarks || result.landmarks.length === 0) {
          poseFilter.reset()   // drop filter state so a tracking gap doesn't carry stale values
          onFrameRef.current([])
          sendKeypoints(null, video)
        } else {
          // Smooth once (One Euro), then use the SAME smoothed landmarks for the overlay + backend.
          const landmarks = poseFilter.filter(result.landmarks[0] as Landmark[], logicalNow())
          onFrameRef.current(landmarks)
          sendKeypoints(landmarks, video)
        }
      }
      if (!stopped) rafRef.current = requestAnimationFrame(loop)
    }

    ;(async () => {
      try {
        // Idempotent double-invoke guard (P1-I): if a live stream is already attached, reuse it.
        const existing = videoRef.current?.srcObject as MediaStream | null
        if (existing && existing.active) {
          setCameraStatus('running')
          setPermission('granted')
          rafRef.current = requestAnimationFrame(loop)
          return
        }
        stream = await acquireCameraStream(
          (c) => navigator.mediaDevices.getUserMedia(c),
          isPortraitViewport(),
        )
        const settings = stream.getVideoTracks()[0]?.getSettings?.()
        if (settings) console.info(`[camera] ${settings.width}x${settings.height} @${settings.frameRate ?? '?'}fps`)
        const video = videoRef.current
        if (!video || stopped) {
          // Resolve-after-cleanup (P1-I): stop the just-acquired stream so it doesn't leak.
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        video.srcObject = stream
        await video.play()
        setCameraStatus('running')
        setPermission('granted')
        rafRef.current = requestAnimationFrame(loop)
      } catch (e) {
        if (stopped) return
        setCameraStatus('error')
        setErrorMsg(cameraErrorMessage(e))
        if (e instanceof DOMException && e.name === 'NotAllowedError') setPermission('denied')
      }
    })()

    return () => {
      stopped = true
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
      if (stream) stream.getTracks().forEach((t) => t.stop())
      const video = videoRef.current
      if (video && video.srcObject) video.srcObject = null
      lastVideoTimeRef.current = -1
    }
  }, [poseActive, modelStatus, retryNonce, logicalNow])

  return { videoRef, modelStatus, cameraStatus, permission, errorMsg, retryCamera, lighting }
}
