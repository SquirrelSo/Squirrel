/* CoachApp.tsx — the pose-coach stage for the NEW backend flow.

   Per set: SETUP (F2, /ws/setup: combined gate → capture → START) → WORKOUT (F3,
   /ws/train: taxonomy + scoring) → REST → next set → … → F5 summary. Camera + pose + the
   F2/F3/F5 views inside the shared Stage. The setup flow is server-driven; this component
   just runs the camera, streams frames, and renders whatever phase the engine is in. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useEngine } from './engine/useEngine'
import { usePose } from './pose/usePose'
import { useSessionClock } from './useSessionClock'
import type { EngineDispatch } from './engine/useEngine'
import type { Landmark, WorkoutConfig } from './types'
import { F2_Gate, F3_Active, F5_Summary } from './frames/Frames'
import { CameraVideo } from './components/Skeleton'
import { Stage } from './Stage'

// Kept so App's <Coach purpose="session"/> and the stub keep their prop; there is only one
// purpose now (calibration was removed).
export type CoachPurpose = 'session'

export default function CoachApp(
  { userId, onExit, autoStartCamera = false, sessionId, workout }:
  { userId?: string; purpose?: CoachPurpose; onExit: () => void; autoStartCamera?: boolean; sessionId?: string; workout?: WorkoutConfig },
) {
  const { state, dispatch, send } = useEngine(userId, sessionId, workout?.exerciseId, workout?.variant)
  const [cameraStarted, setCameraStarted] = useState(autoStartCamera)

  // Real per-session targets (sets / reps / rest) from the Solo cart → engine, once.
  useEffect(() => { if (workout) dispatch({ type: 'SET_WORKOUT_CONFIG', config: workout }) }, [workout, dispatch])

  // Between-sets rest countdown: tick each second; at 0 auto-advance to the next set (→ F2 setup).
  useEffect(() => {
    if (state.setOutcome !== 'rest') return
    if (state.restRemaining != null && state.restRemaining <= 0) { dispatch({ type: 'NEXT_SET' }); return }
    const id = setTimeout(() => dispatch({ type: 'REST_TICK' }), 1000)
    return () => clearTimeout(id)
  }, [state.setOutcome, state.restRemaining, dispatch])

  // Session clock: the single source of truth for the F3 elapsed timer.
  const clock = useSessionClock({ running: state.view === 'F3', paused: state.isPaused })
  const getElapsedRef = useRef(clock.getElapsedSeconds)
  useEffect(() => { getElapsedRef.current = clock.getElapsedSeconds }, [clock.getElapsedSeconds])

  // Wall clock for the whole workout: the session clock resets each set, so this captures the
  // first-set start and measures total time to finish all sets. Cleared once the recap is shown.
  const workoutStartRef = useRef<number | null>(null)
  useEffect(() => {
    if (state.view === 'F3' && workoutStartRef.current === null) workoutStartRef.current = performance.now()
    else if (state.view === 'F5') workoutStartRef.current = null
  }, [state.view])

  const dispatchWithClock = useCallback<EngineDispatch>((action) => {
    if (action.type === 'END') {
      const total = workoutStartRef.current != null ? (performance.now() - workoutStartRef.current) / 1000 : getElapsedRef.current()
      dispatch({ ...action, elapsedTime: getElapsedRef.current(), totalTime: total })
    } else dispatch(action)
  }, [dispatch])

  const onFrame = useCallback((landmarks: Landmark[]) => dispatch({ type: 'LANDMARKS', landmarks }), [dispatch])

  // Camera runs on F2 + F3 (not F5). Transmit: F2 (setup) always — the server needs frames to
  // evaluate the combined gate and capture the baseline; F3 when live.
  const poseActive = cameraStarted && state.view !== 'F5'
  const sendActive = state.view === 'F2' || (state.view === 'F3' && !state.isPaused && !state.setOutcome)

  const { videoRef, modelStatus, cameraStatus, permission, errorMsg, retryCamera, lighting } = usePose({
    onFrame, send, poseActive, sendActive, paused: state.isPaused,
  })

  useEffect(() => { dispatch({ type: 'SET_PERMISSION', value: permission }) }, [permission, dispatch])

  const poseError = (cameraStatus === 'error' || modelStatus === 'error') ? (errorMsg || 'Camera unavailable') : null
  const startCamera = useCallback(() => setCameraStarted(true), [])
  const onRetryCamera = useCallback(() => { setCameraStarted(true); retryCamera() }, [retryCamera])

  // The summary is a tall, scrollable document, so it renders as its own full-viewport page
  // OUTSIDE the fixed 1280×720 immersive board (which would center-clip its top and bottom).
  if (state.view === 'F5') {
    return <F5_Summary s={state} dispatch={dispatchWithClock} onExit={onExit} />
  }

  // Exit chip on F2 only; F3 has its own in the HUD cluster, F5 owns its own in the recap.
  const showExit = state.view === 'F2'

  return (
    <>
      <Stage immersive>
        <div className="coach-v2">
          {/* Single persistent <video> behind every camera-using view. */}
          <div style={{ position: 'absolute', inset: 0 }}>
            <CameraVideo videoRef={videoRef} />
          </div>

          {state.view === 'F2' && (
            <F2_Gate
              s={state}
              cameraStarted={cameraStarted && !poseError}
              onStartCamera={startCamera}
              onRetryCamera={onRetryCamera}
              poseError={poseError}
            />
          )}
          {state.view === 'F3' && <F3_Active s={state} dispatch={dispatchWithClock} elapsedSeconds={clock.elapsedSeconds} onExit={onExit} />}

          {/* Too dark even after low-light enhancement: say so instead of silently missing reps. */}
          {lighting === 'too_dark' && cameraStarted && !poseError && (
            <div className="coach-v2__lighting" role="status" aria-live="polite" style={{
              position: 'absolute', top: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 40,
              padding: '10px 18px', borderRadius: 12, background: 'rgba(8,10,14,0.88)',
              border: '1px solid rgba(255,184,0,0.5)', color: '#fff', fontSize: 15, fontWeight: 600,
              pointerEvents: 'none',
            }}>
              It&apos;s too dark for the camera — turn on a light or face a window.
            </div>
          )}

          {showExit && (
            <button type="button" onClick={onExit} className="coach-v2__exit">
              ← Exit
            </button>
          )}
        </div>
      </Stage>

      {/* Portrait-phone guard: the coach HUD is a landscape 1280×720 layout, and the camera
          needs landscape to frame a full body. Pure-CSS visibility via @media (orientation:
          portrait) and (pointer: coarse) — it sits OUTSIDE the transform-scaled Stage board so
          position:fixed anchors to the viewport. Camera/engine keep running behind it. */}
      <div className="coach-rotate" role="status" aria-live="polite">
        <svg className="coach-rotate__icon" width="64" height="64" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="8" y="2" width="8" height="20" rx="2" />
          <path d="M2 9a10 10 0 0 1 6-6" />
          <path d="M4.5 4.5 2 3m0 0 1.5 2.5M2 3l3 .5" />
        </svg>
        <div className="coach-rotate__title">Rotate your phone</div>
        <p className="coach-rotate__body">The camera needs landscape to frame your full body.</p>
      </div>
    </>
  )
}
