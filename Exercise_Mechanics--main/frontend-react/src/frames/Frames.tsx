/* Frames.tsx — V1 combined setup/capture/START, active workout and summary views. */
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import type { EngineState } from '../types'
import type { EngineDispatch } from '../engine/useEngine'
import { Q, TYPE, Icon, L } from '../tokens'
import { SkeletonOverlay } from '../components/Skeleton'
import {
  TimerRing, FormScoreMeter, RomMeter, ArmRomMeter, LegRomMeter, RepBar, LiftBar, CorrectionCue,
  SideMetrics, ExerciseBriefCompact, PauseMenu, RestOverlay, SetCompleteOverlay,
} from '../components/Hud'
import { isDimmed } from '../selectors'
import { CONF_FLOOR } from '../config'

/* ============ F2 · Combined setup gate → capture → START ============ */

// Collapse the 33 raw landmark names into a few human body-part groups for the prompt
// (no one wants to read "left_foot_index"). Order matters: feet/knees/hips are matched
// before the arms catch-all so "foot_index" reads as feet, not hands.
function friendlyGroups(missing: string[]): string[] {
  const groups: string[] = []
  const add = (g: string) => { if (!groups.includes(g)) groups.push(g) }
  for (const n of missing) {
    if (/nose|eye|ear|mouth/.test(n)) add('head')
    else if (/shoulder/.test(n)) add('shoulders')
    else if (/hip/.test(n)) add('hips')
    else if (/knee/.test(n)) add('knees')
    else if (/ankle|heel|foot/.test(n)) add('ankles & feet')
    else add('arms & hands') // elbow / wrist / pinky / index / thumb
  }
  return groups
}

/* Setup copy is exercise-shaped, not generic. "Stand tall, feet shoulder-width apart" is actively
   misleading to someone about to do a push-up, and the one instruction a push-up user MUST get up
   front — point the camera at your side — has no equivalent in any standing exercise. Keyed by the
   engine's motion so a new exercise either supplies its own copy or falls back to the neutral
   standing text rather than silently inheriting squat instructions. */
type SetupCopy = { frame: string; start: string; footnote: string }

const SETUP_COPY: Record<string, SetupCopy> = {
  pushup: {
    frame: 'Place the camera at your side, a few steps back, so your whole body fits from head to feet.',
    start: 'Get into the top of a push-up: arms straight, body in one line from shoulders to ankles.',
    footnote: 'Push-ups are measured from the side. Facing the camera pauses tracking.',
  },
}

const DEFAULT_SETUP_COPY: SetupCopy = {
  frame: 'Step back so your whole body fits in the frame.',
  start: 'Stand tall with your feet shoulder-width apart.',
  footnote: 'Every setup check must remain valid together.',
}

function setupCopy(s: EngineState): SetupCopy {
  return SETUP_COPY[s.currentExercise.motion] ?? DEFAULT_SETUP_COPY
}

function GatePrompt({ s, missing }: { s: EngineState; missing: string[] }) {
  const ready = missing.length === 0
  const groups = friendlyGroups(missing)
  return (
    <div className="coach-guide">
      <span className="coach-guide__kicker">Get ready</span>
      <div className="coach-guide__title" style={{ color: ready ? Q.green : Q.neutral }}>
        {ready ? "You're in frame" : 'Full body not visible'}
      </div>
      <div className="coach-guide__body">
        {ready ? 'Hold steady — starting your set…' : setupCopy(s).frame}
      </div>

      {!ready && groups.length > 0 && (
        <div className="coach-guide__chips">
          {groups.map((g) => (
            <span key={g} className="coach-guide__chip">{g}</span>
          ))}
        </div>
      )}

      <div className="coach-guide__foot">
        Your set starts automatically once your whole body is in view.
      </div>
    </div>
  )
}

function conditionName(templateId: string): string {
  if (templateId === 'standing_posture') return 'Standing posture'
  if (templateId === 'stance_width') return 'Stance width'
  if (templateId === 'setup_readiness') return 'High Knee position'
  // Push-up. Without these two the panel shows the raw rule ids ("plank ready", "side view
  // orientation"), which read as diagnostics rather than as something the user can act on.
  if (templateId === 'plank_ready') return 'Plank position'
  if (templateId === 'side_view_orientation') return 'Camera angle'
  return templateId.replaceAll('_', ' ')
}

function ProgressBar({ progress, color = Q.green }: { progress: number; color?: string }) {
  const value = Math.max(0, Math.min(1, progress))
  return (
    <div className="coach-guide__progress">
      <div style={{ width: `${value * 100}%`, height: '100%', background: color, transition: 'width .15s linear' }} />
    </div>
  )
}

/* Bottom-center frosted cue — the same treatment as the live-workout CorrectionCue, reused so
   an active setup-template cue reads clearly over the feed instead of buried in the side panel. */
function SetupCueHud({ text }: { text: string }) {
  return (
    <div style={{ position: 'absolute', left: '50%', bottom: '14%', transform: 'translateX(-50%)', zIndex: 20, maxWidth: 660 }}>
      <div style={{
        animation: 'cueIn .28s ease both', display: 'inline-flex', alignItems: 'center', gap: 15,
        background: 'rgba(8,10,14,0.82)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        border: `1px solid ${Q.amber}66`, borderRadius: 17, padding: '16px 24px 16px 17px',
        boxShadow: `0 8px 28px rgba(0,0,0,0.45), inset 0 0 0 1px ${Q.amber}22`,
      }}>
        <span style={{ width: 38, height: 38, borderRadius: 11, background: Q.amber, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          {Icon.alert({ size: 23, stroke: '#08090c', sw: 3 })}
        </span>
        <span style={{ ...TYPE.body, fontSize: 24, color: Q.neutral, fontWeight: 600 }}>{text}</span>
      </div>
    </div>
  )
}

/* Previous-set travel feedback is intentionally separate from setup validation. It is neutral,
   never changes the skeleton, does not pause the setup gate, and disappears after one second. */
function SetupTravelNotice({ notice }: { notice: EngineState['setupNotice'] }) {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setVisible(false), 1000)
    return () => window.clearTimeout(timeout)
  }, [notice])
  if (!notice || !visible) return null
  return (
    <div style={{
      position: 'absolute', left: '50%', top: '9%', transform: 'translateX(-50%)', zIndex: 60,
      maxWidth: 680, padding: '13px 20px', borderRadius: 14, textAlign: 'center',
      background: 'rgba(8,10,14,0.88)', border: '1px solid rgba(255,255,255,0.22)',
      boxShadow: '0 10px 32px rgba(0,0,0,0.42)', animation: 'cueIn .2s ease both',
      ...TYPE.body, fontSize: 19, color: Q.neutral, fontWeight: 600,
    }} role="status" aria-live="polite">
      {notice.text}
    </div>
  )
}

/* Every configured condition is shown together; the backend owns pass/fail and dwell. */
function PreCheckPrompt({ s }: { s: EngineState }) {
  const setup = s.setup
  const failures = setup?.failures ?? []
  const ok = !!setup && failures.length === 0 && setup.missing.length === 0
  const cue = setup?.cue?.text ?? failures.find((item) => item.cue)?.cue ?? null
  const dwell = setup?.dwell ?? { held_ms: 0, required_ms: 1 }
  const progress = dwell.required_ms > 0 ? dwell.held_ms / dwell.required_ms : 1
  // Only an active template cue pops into the bottom HUD; the panel keeps its generic ok/fallback
  // copy (which are not template cues), so the cue is never shown in both places at once.
  const templateCue = ok ? null : cue
  const bodyText = ok
    ? 'Keep every check green until capture begins.'
    : (templateCue ? null : setupCopy(s).start)
  return (
    <>
      <div className="coach-guide">
        <span className="coach-guide__kicker">Setup check</span>
        <div className="coach-guide__title" style={{ color: ok ? Q.green : Q.neutral }}>
          {ok ? 'Position locked — hold' : 'Find your start position'}
        </div>
        {bodyText && (
          <div className="coach-guide__body" style={{ color: ok ? 'var(--ink-dim)' : Q.amber }}>
            {bodyText}
          </div>
        )}
        <div className="coach-guide__conditions">
          {(setup?.conditions ?? []).map((condition) => {
            const passed = condition.status === 'passed'
            const color = passed ? Q.green : condition.status === 'unavailable' ? Q.dim : Q.amber
            return (
              <div key={condition.template_id} className="coach-guide__condition">
                <span className="coach-guide__condition-name">
                  {conditionName(condition.template_id)}
                </span>
                <span className="coach-guide__condition-state" style={{ color }}>
                  {passed ? Icon.check({ size: 13, stroke: color }) : Icon.alert({ size: 13, stroke: color })}
                  {passed ? 'Ready' : condition.status === 'unavailable' ? 'Not visible' : 'Adjust'}
                </span>
              </div>
            )
          })}
        </div>
        <ProgressBar progress={progress} color={ok ? Q.green : Q.amber} />
        <div className="coach-guide__meta">
          Hold {Math.round(dwell.held_ms / 100) / 10}s of {Math.round(dwell.required_ms / 100) / 10}s
        </div>
      <div className="coach-guide__foot">
          {setupCopy(s).footnote}
        </div>
      </div>
      {templateCue && <SetupCueHud text={templateCue} />}
    </>
  )
}

function CapturePrompt({ s }: { s: EngineState }) {
  const capture = s.setup?.capture
  const paused = capture?.paused ?? false
  const failure = s.setup?.failures[0]
  const progress = capture?.progress ?? 0
  return (
    <div className="coach-guide">
      <span className="coach-guide__kicker">Baseline capture</span>
      <div className="coach-guide__number" style={{ color: paused ? Q.amber : Q.neutral }}>
        {Math.round(progress * 100)}%
      </div>
      <div style={{ width: '100%', height: 10, borderRadius: 999, background: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
        <div style={{
          width: `${Math.max(0, Math.min(100, Math.round(progress * 100)))}%`, height: '100%', borderRadius: 999,
          background: paused
            ? 'linear-gradient(90deg, #B77400, #FFB02E)'
            : 'linear-gradient(90deg, #1F9D63, #3ECF8E 55%, #6EE7B0)',
          boxShadow: paused ? 'none' : '0 0 12px rgba(62,207,142,0.45)',
          transition: 'width .2s linear',
        }} />
      </div>
      <div className="coach-guide__title coach-guide__title--small" style={{ color: paused ? Q.amber : Q.green }}>
        {paused ? 'Capture paused' : 'Hold your position'}
      </div>
      {paused && (
        <div className="coach-guide__body" style={{ color: Q.amber }}>
          {failure?.cue ?? 'Return to the accepted setup position to continue.'}
        </div>
      )}
    </div>
  )
}

function ValidatingPrompt() {
  return (
    <div className="coach-center-state">
      <div className="coach-center-state__inner">
        <span className="coach-guide__kicker">Baseline captured</span>
        <div className="coach-center-state__title">Validating…</div>
      </div>
    </div>
  )
}

function StartOverlay() {
  return (
    <div className="coach-center-state">
      <div className="coach-start">START</div>
    </div>
  )
}

function ConnectionPrompt({ s }: { s: EngineState }) {
  const message = s.socketError?.detail ?? 'The setup connection was interrupted. Reconnecting…'
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 45, background: 'rgba(4,5,7,.72)' }}>
      <div style={{ width: 460, textAlign: 'center' }}>
        <div style={{ ...TYPE.hero, fontSize: 34, color: Q.red }}>Setup connection unavailable</div>
        <div style={{ ...TYPE.body, fontSize: 16, color: 'var(--ink-dim)', lineHeight: 1.5, marginTop: 14 }}>{message}</div>
        <div style={{ ...TYPE.caption, fontSize: 12, color: 'var(--ink-faint)', marginTop: 12 }}>No setup progress is credited while disconnected.</div>
      </div>
    </div>
  )
}

function WaitingPrompt() {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 35, pointerEvents: 'none' }}>
      <div style={{ textAlign: 'center' }}>
        <L style={{ fontSize: 12 }}>Preparing setup</L>
        <div style={{ ...TYPE.hero, fontSize: 42, color: Q.neutral, marginTop: 10 }}>Connecting…</div>
      </div>
    </div>
  )
}

function CameraStartGate({ onStart, onRetry, error }: { onStart: () => void; onRetry: () => void; error: string | null }) {
  return (
    <div className="coach-camera-gate">
      <div className="coach-camera-gate__inner">
        <div className="coach-camera-gate__icon" style={{ color: error ? Q.red : Q.neutral, borderColor: error ? Q.red + '66' : undefined }}>
          {Icon.camera({ size: 30, stroke: error ? Q.red : Q.neutral })}
        </div>
        <div className="coach-camera-gate__title">
          {error ? 'Camera access blocked' : 'Camera access needed'}
        </div>
        <div className="coach-camera-gate__body">
          {error
            ? error
            : 'We use your camera to track your form. Nothing is recorded or stored — only abstract joint positions leave your device.'}
        </div>
        <button onClick={error ? onRetry : onStart} className="coach-camera-gate__button">
          {Icon.play({ size: 16, stroke: '#0D0E10' })} {error ? 'Try again' : 'Start camera'}
        </button>
      </div>
    </div>
  )
}

/* The server owns every transition; this view only renders validated setup state. */
export function F2_Gate({
  s, cameraStarted, onStartCamera, onRetryCamera, poseError,
}: {
  s: EngineState
  cameraStarted: boolean
  onStartCamera: () => void
  onRetryCamera: () => void
  poseError: string | null
}) {
  const missing = s.setup?.missing ?? []
  const prompt = missing.length > 0
    ? <GatePrompt s={s} missing={missing} />
    : <PreCheckPrompt s={s} />

  return (
    <div className="coach-setup-screen">
      {cameraStarted && <SkeletonOverlay s={s} solid />}
      {!cameraStarted || poseError
        ? <CameraStartGate onStart={onStartCamera} onRetry={onRetryCamera} error={poseError} />
        : s.disconnected || s.socketError
          ? <ConnectionPrompt s={s} />
          : !s.setup
            ? <WaitingPrompt />
          : s.prep === 'start'
            ? <StartOverlay />
            : s.prep === 'validating'
              ? <ValidatingPrompt />
              : s.prep === 'capture'
                ? <CapturePrompt s={s} />
                : prompt}
      <SetupTravelNotice notice={s.setupNotice} />
    </div>
  )
}

/* ============ F3 · Active Workout (Section E zones) ============ */

/* The backend has stopped measuring even though it can see the user perfectly well — today that
   means a push-up being filmed from the front. This is its own banner rather than a line in
   RecoveryBanner because the two say opposite things: RecoveryBanner asks the user to hold still
   until tracking recovers, while this one needs them to MOVE, and needs to be explicit that reps
   have stopped counting in the meantime. The instruction text is the backend's own rule cue, so
   the wording stays owned by whichever rule did the invalidating. */
function MeasurementBlockedBanner({ s }: { s: EngineState }) {
  if (s.measurementBlockedBy.length === 0) return null
  const instruction = s.cue?.text ?? 'Turn side-on to the camera to resume tracking.'
  const noun = s.targetMeasure === 'time' ? 'lifts' : 'reps'
  return (
    <div style={{
      position: 'absolute', top: '42%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 32,
      display: 'flex', alignItems: 'center', gap: 16, padding: '18px 26px', borderRadius: 18,
      maxWidth: 620, background: 'rgba(8,10,14,0.92)', border: `1px solid ${Q.red}77`,
      animation: 'cueIn .3s ease both', boxShadow: `0 14px 44px rgba(0,0,0,0.55), inset 0 0 0 1px ${Q.red}22`,
    }} role="status" aria-live="assertive">
      <span style={{ width: 40, height: 40, borderRadius: 12, background: Q.red, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        {Icon.camera({ size: 23, stroke: '#08090c', sw: 2.4 })}
      </span>
      <span>
        <span style={{ ...TYPE.body, fontSize: 21, color: Q.neutral, fontWeight: 700, display: 'block' }}>
          {instruction}
        </span>
        <span style={{ ...TYPE.caption, fontSize: 13, color: Q.red, display: 'block', marginTop: 3 }}>
          Measurement paused — no {noun} are being counted.
        </span>
      </span>
    </div>
  )
}

function RecoveryBanner({ s }: { s: EngineState }) {
  let msg: string | null = null
  let icon = Icon.frame
  let sev: 'amber' | 'error' = 'amber'
  // A dropped WebSocket is a connection failure, not a camera or zero-rep signal.
  if (s.socketError) { msg = s.socketError.detail; icon = Icon.alert; sev = 'error' }
  else if (s.disconnected) { msg = `Connection lost — no ${s.targetMeasure === 'time' ? 'lifts' : 'reps'} are being credited. Reconnecting…`; icon = Icon.frame; sev = 'error' }
  // Not while measurement is blocked: MeasurementBlockedBanner owns that case and occupies the same
  // spot, and "hold still" directly contradicts the "turn side-on" it is showing.
  else if (s.measurementBlockedBy.length > 0) { msg = null }
  else if (s.trackingConfidence < CONF_FLOOR) { msg = 'Hold still for a moment while we reconnect tracking.'; icon = Icon.frame }
  if (!msg) return null
  const col = sev === 'error' ? Q.red : Q.amber
  return (
    <div style={{
      position: 'absolute', top: '42%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 30,
      display: 'flex', alignItems: 'center', gap: 14, padding: '16px 24px', borderRadius: 16,
      background: 'rgba(8,10,14,0.9)', border: `1px solid ${col}66`, animation: 'cueIn .3s ease both',
      boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
    }}>
      <span style={{ width: 36, height: 36, borderRadius: 10, background: col, display: 'grid', placeItems: 'center' }}>
        {icon({ size: 20, stroke: '#08090c' })}
      </span>
      <span style={{ ...TYPE.body, fontSize: 19, color: Q.neutral, fontWeight: 600 }}>{msg}</span>
    </div>
  )
}

// Shared icon-button chip (Exit / Pause) on the F3 HUD — 40×40, frosted, identical look.
const ICON_BTN: CSSProperties = {
  width: 40, height: 40, borderRadius: 999,
  background: 'rgba(13,14,16,0.64)', border: '1px solid rgba(255,255,255,0.19)',
  display: 'grid', placeItems: 'center', color: Q.neutral, cursor: 'pointer',
  backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
}

export function F3_Active({
  s, dispatch, elapsedSeconds, onExit,
}: {
  s: EngineState; dispatch: EngineDispatch; elapsedSeconds: number; onExit: () => void
}) {
  const dim = isDimmed(s)
  return (
    // fs-hud-bright lifts the HUD's dim/faint text tones (scoped CSS-var override) so the
    // overlay reads clearly over the live camera feed.
    <div className="fs-hud-bright coach-live-screen">
      <div style={{ position: 'absolute', inset: 0, opacity: dim ? 0.55 : 1, transition: 'opacity .35s' }}>
        <SkeletonOverlay s={s} />
      </div>

      {/* Edge scrims — a very subtle black gradient on the left & right edges so the HUD
          widgets stay legible against a bright/busy camera background. Behind the widgets. */}
      <div className="coach-live-screen__scrim" />

      <RecoveryBanner s={s} />
      <MeasurementBlockedBanner s={s} />

      {/* Top-left cluster: Timer ring | Exit/Pause (stacked, same column) | Exercise info.
          Exit + Pause are identical icon-only 40×40 chips; the global Exit chip is hidden on
          F3 (CoachApp) so the session's exit lives here, vertically inline with Pause. */}
      <div className="coach-live-screen__top-left">
        <TimerRing s={s} elapsedSeconds={elapsedSeconds} size={76} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={onExit} title="Exit" aria-label="Exit" style={ICON_BTN}>
            {Icon.arrowL({ size: 18, stroke: Q.neutral })}
          </button>
          {s.targetMeasure === 'reps' && (
            <button onClick={() => dispatch({ type: 'PAUSE', value: true })} title="Pause" aria-label="Pause" style={ICON_BTN}>
              {Icon.pause({ size: 18, stroke: Q.neutral })}
            </button>
          )}
        </div>
        <ExerciseBriefCompact s={s} />
      </div>

      {/* Top-right: C7 Form score — untouched, stays in the corner on its own. */}
      <div style={{ position: 'absolute', top: 22, right: 28, zIndex: 10 }}>
        <FormScoreMeter s={s} size={76} />
      </div>

      {/* Left rail: single-signal ROM (squat) OR the left-arm ROM for double-arm exercises (curl).
          left:40 matches the Reps card below so the labels share the same starting x. */}
      <div style={{ position: 'absolute', left: 40, top: '50%', transform: 'translateY(-50%)', zIndex: 10 }}>
        {s.romLegs
          ? <LegRomMeter s={s} side="left" />
          : s.romArms ? <ArmRomMeter s={s} side="left" /> : <RomMeter s={s} />}
      </div>

      {/* Right rail: right-arm ROM for double-arm exercises — placed opposite the left arm so each
          hand's bar sits on its own side of the mirrored view. */}
      {s.romArms && (
        <div style={{ position: 'absolute', right: 40, top: '50%', transform: 'translateY(-50%)', zIndex: 10 }}>
          <ArmRomMeter s={s} side="right" />
        </div>
      )}
      {s.romLegs && (
        <div style={{ position: 'absolute', right: 40, top: '50%', transform: 'translateY(-50%)', zIndex: 10 }}>
          <LegRomMeter s={s} side="right" />
        </div>
      )}

      {/* Bottom-left: C6 rep card — back to its original spot under the ROM rail */}
      <div style={{ position: 'absolute', left: 40, bottom: 104, zIndex: 15 }}>
        {s.targetMeasure === 'time' ? <LiftBar s={s} /> : <RepBar s={s} />}
      </div>

      {/* Bottom-right: Pace + Rep time, side by side on the bottom band */}
      <div style={{ position: 'absolute', right: 40, bottom: 104, zIndex: 15, width: 300 }}><SideMetrics s={s} /></div>

      {/* Bottom-center: C4 correction cue, dropped low into the freed bottom row */}
      <div style={{ position: 'absolute', left: '50%', bottom: '14%', transform: 'translateX(-50%)', zIndex: 20, maxWidth: 660 }}>
        <CorrectionCue s={s} />
      </div>

      {/* C12 pause overlay */}
      <PauseMenu s={s} dispatch={dispatch} />

      {/* Set-complete overlays: rest countdown (more sets) or workout-done (last/only set) */}
      <RestOverlay s={s} dispatch={dispatch} />
      <SetCompleteOverlay s={s} dispatch={dispatch} />
      {/* START is confirmed in F2 only after validated persistence, so F3 opens directly live. */}
    </div>
  )
}

/* ============ F5 · Set recap ============ */
function verdictFor(score: number | null): string {
  if (score == null) return 'Set complete.'
  if (score >= 85) return 'Strong set.'
  if (score >= 70) return 'Solid work.'
  if (score >= 55) return 'Good effort.'
  return 'Keep at it.'
}
function scoreBand(score: number | null): string {
  if (score == null) return Q.dim
  return score >= 80 ? Q.green : score >= 65 ? Q.amber : Q.red
}

// A correction id ("knee_valgus", "range_of_motion") → a readable fault name. The coaching copy
// itself is authored per exercise in the backend templates and travels with each cue, so nothing
// exercise-specific is hardcoded here.
function humanize(key: string): string {
  const s = key.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}
function formatTime(totalSeconds: number): string {
  const secs = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/* Average-form gauge with a load sweep + count-up; both are skipped under reduced-motion. */
function ScoreGauge({ score }: { score: number | null }) {
  const R = 86
  const CIRC = 2 * Math.PI * R
  const target = score ?? 0
  const arcRef = useRef<SVGCircleElement>(null)
  // Reduced-motion viewers start already at the final value (no count-up), which also keeps
  // us from calling setState synchronously inside the effect.
  const [shown, setShown] = useState(() =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ? target : 0,
  )
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const arc = arcRef.current
    if (score == null) { if (arc) arc.style.strokeDashoffset = String(CIRC); return }
    const end = CIRC * (1 - target / 100)
    if (reduce) { if (arc) arc.style.strokeDashoffset = String(end); return }
    if (arc) {
      arc.style.strokeDashoffset = String(CIRC)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (arcRef.current) arcRef.current.style.strokeDashoffset = String(end)
      }))
    }
    let raf = 0
    let start: number | null = null
    const tick = (t: number) => {
      if (start == null) start = t
      const p = Math.min(1, Math.max(0, (t - start - 150) / 1100))
      setShown(Math.round((1 - Math.pow(1 - p, 3)) * target))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [score, target, CIRC])
  const col = scoreBand(score)
  return (
    <div className="coach-recap__gauge">
      <svg viewBox="0 0 200 200" aria-hidden>
        <circle className="coach-recap__gauge-track" cx="100" cy="100" r={R} />
        <circle
          ref={arcRef}
          className="coach-recap__gauge-fill"
          cx="100" cy="100" r={R}
          style={{ stroke: col, strokeDasharray: CIRC, strokeDashoffset: CIRC, filter: `drop-shadow(0 0 7px ${col}88)` }}
        />
      </svg>
      <div className="coach-recap__gauge-center">
        <div className="coach-recap__score" style={{ color: score == null ? Q.dim : Q.neutral }}>{score == null ? '—' : shown}</div>
        <div className="coach-recap__gauge-unit">/ 100</div>
        <div className="coach-recap__gauge-cap">Avg form</div>
      </div>
    </div>
  )
}

export function F5_Summary({ s, dispatch, onExit }: { s: EngineState; dispatch: EngineDispatch; onExit: () => void }) {
  const sum = s.workoutSummary
  const restart = () => dispatch({ type: 'RESET' })

  if (!sum || !sum.hasData) {
    return (
      <div className="coach-recap">
        <div className="coach-recap__page">
          <div className="coach-recap__eyebrow"><i />Workout ended</div>
          <h1 className="coach-recap__title" style={{ marginTop: 16 }}>No reps this time.</h1>
          <p className="coach-recap__sub" style={{ marginBottom: 30 }}>
            We didn't detect any completed reps this session. Reposition your camera so your full body is in frame,
            and your reps will track automatically next time.
          </p>
          <div className="coach-recap__cta">
            <button type="button" className="coach-recap__btn coach-recap__btn--primary" onClick={restart}>Start again</button>
            <button type="button" className="coach-recap__btn coach-recap__btn--ghost" onClick={onExit}>Exit</button>
          </div>
        </div>
      </div>
    )
  }

  if (sum.measure === 'time') {
    const latestAsymmetry = s.log.timedSets.at(-1)?.asymmetry
    // Movement faults flagged during the set, ranked by persistence — same focus-area treatment
    // as the rep exercises. Backend labels are used when present, falling back to the rule id.
    const timedIssues = Object.entries(s.log.corrections)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 2)
      .map(([key, v]) => ({ key, label: v.label ?? humanize(key), message: v.message }))
    const timedClean = timedIssues.length === 0
    return (
      <div className="coach-recap">
        <div className="coach-recap__page">
          <header className="coach-recap__top">
            <div className="coach-recap__eyebrow"><i />Timed workout complete</div>
            <div className="coach-recap__chip">{s.currentExercise.name} · {sum.completedSets} {sum.completedSets === 1 ? 'set' : 'sets'}</div>
          </header>

          <section className="coach-recap__hero">
            <ScoreGauge score={sum.averageFormScore} />
            <div className="coach-recap__reveal" style={{ animationDelay: '.1s' }}>
              <h1 className="coach-recap__title">{verdictFor(sum.averageFormScore)}</h1>
              <p className="coach-recap__sub">{sum.countedLifts} knee lifts counted this set.</p>
            </div>
          </section>

          <section className="coach-recap__grid coach-recap__reveal" style={{ animationDelay: '.2s' }}>
            <div className="coach-recap__tile">
              <span className="coach-recap__label">Sets</span>
              <div className="coach-recap__tile-val"><span className="coach-recap__tile-num">{sum.completedSets}</span><span className="coach-recap__tile-unit">/ {s.targetSets}</span></div>
              <span className="coach-recap__tile-foot">timed sets completed</span>
            </div>
            <div className="coach-recap__tile">
              <span className="coach-recap__label">Counted lifts</span>
              <div className="coach-recap__tile-val"><span className="coach-recap__tile-num">{sum.countedLifts}</span></div>
              <span className="coach-recap__tile-foot">{sum.fullLifts} full · {sum.shallowLifts} shallow</span>
            </div>
            <div className="coach-recap__tile">
              <span className="coach-recap__label">Left / right</span>
              <div className="coach-recap__tile-val"><span className="coach-recap__tile-num">{sum.leftLifts}</span><span className="coach-recap__tile-unit"> / {sum.rightLifts}</span></div>
              <span className="coach-recap__tile-foot">counted by side</span>
            </div>
            <div className="coach-recap__tile">
              <span className="coach-recap__label">Invalid cycles</span>
              <div className="coach-recap__tile-val"><span className="coach-recap__tile-num">{sum.invalidLifts}</span></div>
              <span className="coach-recap__tile-foot">detected but not counted</span>
            </div>
            <div className="coach-recap__tile">
              <span className="coach-recap__label">Total time</span>
              <div className="coach-recap__tile-val"><span className="coach-recap__tile-num">{formatTime(s.workoutTotalSeconds)}</span></div>
              <span className="coach-recap__tile-foot">workout duration</span>
            </div>
            {latestAsymmetry && latestAsymmetry.status !== 'insufficient' && (
              <div className="coach-recap__tile">
                <span className="coach-recap__label">Knee travel</span>
                <div className="coach-recap__tile-val">
                  <span className="coach-recap__tile-num" style={{ fontSize: 25 }}>
                    {latestAsymmetry.status === 'balanced'
                      ? 'Balanced'
                      : `${latestAsymmetry.lower_side === 'left' ? 'Left' : 'Right'} lower`}
                  </span>
                </div>
                <span className="coach-recap__tile-foot">left vs right knee travel</span>
              </div>
            )}
          </section>

          {timedClean ? (
            <section className="coach-recap__focus coach-recap__focus--clean coach-recap__reveal" style={{ animationDelay: '.34s' }}>
              <div className="coach-recap__focus-icon">{Icon.check({ size: 24, stroke: '#06180F', sw: 3 })}</div>
              <div>
                <span className="coach-recap__label">Great work</span>
                <div className="coach-recap__focus-theme">No form faults this set</div>
                <div className="coach-recap__focus-hint">Your knee drives stayed clean the whole way through — keep doing exactly this.</div>
              </div>
            </section>
          ) : (
            <section className="coach-recap__reveal" style={{ animationDelay: '.34s', marginBottom: 'clamp(28px, 4vw, 40px)' }}>
              <span className="coach-recap__label" style={{ display: 'block', marginBottom: 12 }}>
                {timedIssues.length > 1 ? 'Focus areas' : 'Focus area'}
              </span>
              <div className="coach-recap__focus-list">
                {timedIssues.map((issue, i) => (
                  <div key={issue.key} className="coach-recap__focus">
                    <div className="coach-recap__focus-icon">{i + 1}</div>
                    <div>
                      <div className="coach-recap__focus-theme">{issue.label}</div>
                      <div className="coach-recap__focus-hint">{issue.message}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <footer className="coach-recap__cta coach-recap__reveal" style={{ animationDelay: '.3s' }}>
            <button type="button" className="coach-recap__btn coach-recap__btn--ghost" onClick={onExit}>Exit</button>
          </footer>
        </div>
      </div>
    )
  }

  const q = sum.qualityCounts
  const setCount = s.log.setReps.length || 1
  const completedSets = s.log.setReps.length
  const definedReps = s.targetSets * s.targetReps
  // Top faults, ranked by how many reps they showed up on (their persistence). Cap at two.
  const issues = Object.entries(s.log.corrections)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 2)
    .map(([key, v]) => ({ key, count: v.count, label: humanize(key), message: v.message }))
  const clean = issues.length === 0

  return (
    <div className="coach-recap">
      <div className="coach-recap__page">
        <header className="coach-recap__top">
          <div className="coach-recap__eyebrow"><i />Set complete</div>
          <div className="coach-recap__chip">{s.currentExercise.name} · {setCount} {setCount === 1 ? 'set' : 'sets'}</div>
        </header>

        <section className="coach-recap__hero">
          <ScoreGauge score={sum.averageFormScore} />
          <div className="coach-recap__reveal" style={{ animationDelay: '.1s' }}>
            <h1 className="coach-recap__title">{verdictFor(sum.averageFormScore)}</h1>
          </div>
        </section>

        <section className="coach-recap__reps coach-recap__reveal" style={{ animationDelay: '.2s' }}>
          <div className="coach-recap__reps-head">
            <span className="coach-recap__label">Rep quality · {sum.completedReps} {sum.completedReps === 1 ? 'rep' : 'reps'}</span>
            <div className="coach-recap__legend">
              <span className="coach-recap__legend-item"><span className="coach-recap__legend-sw" style={{ background: Q.green }} />{q.good} good</span>
              <span className="coach-recap__legend-item"><span className="coach-recap__legend-sw" style={{ background: Q.amber }} />{q.amber} fair</span>
              <span className="coach-recap__legend-item"><span className="coach-recap__legend-sw" style={{ background: Q.red }} />{q.poor} flagged</span>
              {q.unscored > 0 && (
                <span className="coach-recap__legend-item"><span className="coach-recap__legend-sw" style={{ background: Q.dim }} />{q.unscored} low coverage</span>
              )}
            </div>
          </div>
          <div className="coach-recap__stacked">
            {([['good', Q.green], ['amber', Q.amber], ['poor', Q.red], ['unscored', Q.dim]] as const).map(([k, col]) => {
              const n = q[k]
              if (!n) return null
              return <div key={k} style={{ flex: n, background: col }} />
            })}
          </div>
        </section>

        <section className="coach-recap__grid coach-recap__reveal" style={{ animationDelay: '.28s' }}>
          <div className="coach-recap__tile">
            <span className="coach-recap__label">Sets</span>
            <div className="coach-recap__tile-val"><span className="coach-recap__tile-num">{completedSets}</span><span className="coach-recap__tile-unit">/ {s.targetSets}</span></div>
            <span className="coach-recap__tile-foot">completed of planned</span>
          </div>
          <div className="coach-recap__tile">
            <span className="coach-recap__label">Reps</span>
            <div className="coach-recap__tile-val"><span className="coach-recap__tile-num">{sum.completedReps}</span><span className="coach-recap__tile-unit">/ {definedReps}</span></div>
            <span className="coach-recap__tile-foot">completed of planned</span>
          </div>
          <div className="coach-recap__tile">
            <span className="coach-recap__label">Total time</span>
            <div className="coach-recap__tile-val"><span className="coach-recap__tile-num">{formatTime(s.workoutTotalSeconds)}</span></div>
            <span className="coach-recap__tile-foot">to finish the workout</span>
          </div>
          <div className="coach-recap__tile">
            <span className="coach-recap__label">ROM consistency</span>
            <div className="coach-recap__tile-val"><span className="coach-recap__tile-num">{sum.romConsistency}</span><span className="coach-recap__tile-unit">%</span></div>
            <span className="coach-recap__tile-foot">how steady your depth was</span>
          </div>
          <div className="coach-recap__tile">
            <span className="coach-recap__label">Best set</span>
            <div className="coach-recap__tile-val"><span className="coach-recap__tile-num" style={{ color: Q.green }}>{sum.bestSet}</span></div>
            <span className="coach-recap__tile-foot">good reps in a set</span>
          </div>
        </section>

        {clean ? (
          <section className="coach-recap__focus coach-recap__focus--clean coach-recap__reveal" style={{ animationDelay: '.34s' }}>
            <div className="coach-recap__focus-icon">{Icon.check({ size: 24, stroke: '#06180F', sw: 3 })}</div>
            <div>
              <span className="coach-recap__label">Great work</span>
              <div className="coach-recap__focus-theme">No major faults this set</div>
              <div className="coach-recap__focus-hint">Your reps stayed clean the whole way through — keep doing exactly this.</div>
            </div>
          </section>
        ) : (
          <section className="coach-recap__reveal" style={{ animationDelay: '.34s', marginBottom: 'clamp(28px, 4vw, 40px)' }}>
            <span className="coach-recap__label" style={{ display: 'block', marginBottom: 12 }}>
              {issues.length > 1 ? 'Focus areas' : 'Focus area'}
            </span>
            <div className="coach-recap__focus-list">
              {issues.map((issue, i) => (
                <div key={issue.key} className="coach-recap__focus">
                  <div className="coach-recap__focus-icon">{i + 1}</div>
                  <div>
                    <div className="coach-recap__focus-theme">{issue.label}</div>
                    <div className="coach-recap__focus-hint">{issue.message}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <footer className="coach-recap__cta coach-recap__reveal" style={{ animationDelay: '.4s' }}>
          <button type="button" className="coach-recap__btn coach-recap__btn--primary" onClick={restart}>Start again</button>
          <button type="button" className="coach-recap__btn coach-recap__btn--ghost" onClick={onExit}>Exit</button>
        </footer>
      </div>
    </div>
  )
}
