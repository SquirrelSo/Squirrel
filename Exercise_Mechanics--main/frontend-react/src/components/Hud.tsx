/* Hud.tsx — F3 HUD components: C8 Timer, C7 FormScore, C5 ROM, C6 RepBar, C4 Cue,
   C9 MetricsStrip, C12 PauseMenu. Ported in look from the prototype's components.jsx,
   rewired to the real EngineState. */
import type { EngineState, Severity } from '../types'
import type { EngineDispatch } from '../engine/useEngine'
import { Q, qColor, formBand, TYPE, Icon, L, Ring, fmtClock } from '../tokens'
import { isDimmed } from '../selectors'
import { REST_EXTEND_S } from '../config'

/* ---------- C8 Timer Ring (active elapsed) ----------
   elapsedSeconds comes from useSessionClock (the single source of truth, wall-clock and
   pause-aware) — NOT from EngineState. The reducer no longer tracks elapsed time (P0-A). */
export function TimerRing({ s, elapsedSeconds, size = 96 }: { s: EngineState; elapsedSeconds: number; size?: number }) {
  const timed = s.targetMeasure === 'time'
  const shownSeconds = timed ? s.remainingTime : elapsedSeconds
  const cyc = timed
    ? (s.targetDurationSeconds > 0 ? s.remainingTime / s.targetDurationSeconds : 0)
    : (elapsedSeconds % 60) / 60
  const modeLabel = s.isPaused ? 'Paused' : timed ? 'Remaining' : 'Active'
  const color = s.isPaused ? Q.dim : Q.green
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <Ring size={size} stroke={8} progress={cyc} color={color} dim={isDimmed(s)} glow>
        <div style={{ textAlign: 'center' }}>
          <div className="num" style={{ fontSize: size * 0.30, color: Q.neutral, ...TYPE.hero }}>
            {fmtClock(shownSeconds)}
          </div>
        </div>
      </Ring>
      <L style={{ fontSize: 10 }}>{modeLabel}</L>
    </div>
  )
}

/* ---------- C7 Form Score Meter (real per-rep score from the backend) ---------- */
export function FormScoreMeter({ s, size = 96 }: { s: EngineState; size?: number }) {
  const timedQuality = s.train && 'movement' in s.train ? s.train.last_lift_score?.quality ?? null : null
  const reliable = s.formScore !== null && (
    s.targetMeasure === 'time' ? timedQuality === 'reliable' : s.scoreCoverage?.reliable === true
  )
  const score = reliable ? Math.round(s.formScore as number) : null
  const dim = isDimmed(s) || !reliable
  const col = score === null ? Q.neutral : score >= 80 ? Q.green : score >= 65 ? Q.amber : Q.red
  const coverage = s.targetMeasure === 'time'
    ? timedQuality === 'low_confidence' ? 'low confidence' : timedQuality === 'unavailable' ? 'unavailable' : 'waiting'
    : s.scoreCoverage ? `${Math.round(s.scoreCoverage.ratio * 100)}% coverage` : 'waiting'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <Ring size={size} stroke={8} progress={(score ?? 0) / 100} color={col} dim={dim} glow={reliable}>
        <div style={{ textAlign: 'center' }}>
          <div className="num" style={{ fontSize: size * 0.38, color: dim ? Q.dim : Q.neutral, ...TYPE.hero }}>{score ?? '—'}</div>
        </div>
      </Ring>
      <L style={{ fontSize: 10 }}>Form Score · {reliable ? 'reliable' : coverage}</L>
    </div>
  )
}

/* ---------- C5b Per-arm ROM (double-arm exercises like curl) ----------
   One vertical bar per arm, each placed on its OWN side of the screen (left arm → left rail, right
   arm → right rail, matching the mirrored selfie video) for a clean left/right differentiator. The
   weaker arm — the one the backend uses to qualify the rep — is highlighted so a lagging side shows.
   The gate line comes from the backend's full_rom_gate. */
function ArmBar({ pct, gate, col }: { pct: number; gate: number; col: string }) {
  const HEIGHT = 240
  return (
    <div style={{ position: 'relative', width: 30, height: HEIGHT, borderRadius: 16, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: -5, right: -5, bottom: `${gate}%`, height: 2, background: 'rgba(255,255,255,0.55)' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${Math.max(0, Math.min(100, pct))}%`, background: `linear-gradient(180deg, ${col}, ${col}aa)`, transition: 'height .12s linear, background .35s' }} />
    </div>
  )
}

export function ArmRomMeter({ s, side }: { s: EngineState; side: 'left' | 'right' }) {
  if (!s.romArms) return null
  const dim = isDimmed(s)
  const pct = side === 'left' ? s.romArms.left : s.romArms.right
  const weaker = s.romArms.weaker === side
  const gate = s.train && 'rom' in s.train
    ? Math.round(s.train.rom.full_rom_gate * 100)
    : (s.currentExercise.targetROMThreshold || 85)
  const state = pct >= gate ? 'achieved' : pct >= gate * 0.8 ? 'near' : 'below'
  const col = state === 'achieved' ? Q.green : state === 'near' ? Q.amber : Q.red
  const align = side === 'left' ? 'flex-start' : 'flex-end'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align, gap: 10, opacity: dim ? 0.45 : 1, transition: 'opacity .35s' }}>
      <L style={{ fontSize: 10 }}>{side === 'left' ? 'Left' : 'Right'} arm ROM</L>
      <ArmBar pct={pct} gate={gate} col={col} />
      <div className="num" style={{ fontSize: 26, color: dim ? Q.dim : col, ...TYPE.hero }}>{dim ? '—' : `${Math.round(pct)}%`}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: col, height: 14 }}>
        {state === 'achieved' && Icon.check({ size: 13, stroke: col })}
        <span style={{ ...TYPE.caption, fontSize: 10, color: weaker ? col : 'var(--ink-faint)', fontWeight: weaker ? 700 : 400 }}>
          {weaker ? 'weaker · sets rep' : state === 'achieved' ? 'Full' : state === 'near' ? 'Near' : ''}
        </span>
      </div>
    </div>
  )
}

/* ---------- Per-leg knee-drive ROM (High Knee) ---------- */
export function LegRomMeter({ s, side }: { s: EngineState; side: 'left' | 'right' }) {
  if (!s.romLegs) return null
  const dim = isDimmed(s)
  const available = side === 'left' ? s.romLegs.leftAvailable : s.romLegs.rightAvailable
  const pct = side === 'left' ? s.romLegs.left : s.romLegs.right
  const gate = s.train && 'movement_type' in s.train.set
    ? Math.round(s.train.rom.full_rom_gate * 100)
    : (s.currentExercise.targetROMThreshold || 75)
  const state = pct >= gate ? 'achieved' : pct >= gate * 0.8 ? 'near' : 'below'
  const col = !available ? Q.dim : state === 'achieved' ? Q.green : state === 'near' ? Q.amber : Q.red
  const align = side === 'left' ? 'flex-start' : 'flex-end'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align, gap: 10, opacity: dim ? 0.45 : 1, transition: 'opacity .35s' }}>
      <L style={{ fontSize: 10 }}>{side === 'left' ? 'Left' : 'Right'} knee drive</L>
      <ArmBar pct={available ? pct : 0} gate={gate} col={col} />
      <div className="num" style={{ fontSize: 26, color: dim || !available ? Q.dim : col, ...TYPE.hero }}>
        {dim || !available ? '—' : `${Math.round(pct)}%`}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: col, height: 14 }}>
        {available && state === 'achieved' && Icon.check({ size: 13, stroke: col })}
        <span style={{ ...TYPE.caption, fontSize: 10, color: 'var(--ink-faint)' }}>
          {!available ? 'Tracking' : state === 'achieved' ? 'Full' : state === 'near' ? 'Near' : ''}
        </span>
      </div>
    </div>
  )
}

/* ---------- C5 ROM Meter (left rail vertical bar, single-signal exercises like squat) ---------- */
export function RomMeter({ s }: { s: EngineState }) {
  const dim = isDimmed(s)
  const rom = s.romPercentage || 0
  // Fill height tracks the UNROUNDED live depth (same depth_ratio source as rom, clamped to
  // 100) so the bar rises/falls smoothly instead of stepping in whole percents. The label keeps
  // the rounded `rom`. depth_ratio = (hip − baseline_hip)/(knee − baseline_hip): 0 standing → 1 at knee.
  const fillPct = Math.max(0, Math.min(100, s.poseDepth * 100))
  const peak = s.romPeak || 0
  const target = s.currentExercise.targetROMThreshold || 90
  const state = rom >= target ? 'achieved' : rom >= target * 0.8 ? 'near' : 'below'
  const col = state === 'achieved' ? Q.green : state === 'near' ? Q.amber : Q.red
  const HEIGHT = 240
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10, opacity: dim ? 0.45 : 1, transition: 'opacity .35s' }}>
      <L style={{ fontSize: 10 }}>{s.currentExercise.romLabel}</L>
      <div style={{ position: 'relative', width: 30, height: HEIGHT, borderRadius: 16, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: -5, right: -5, bottom: `${target}%`, height: 2, background: 'rgba(255,255,255,0.55)' }} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: `${peak}%`, height: 2, background: col, opacity: 0.6 }} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${fillPct}%`, background: `linear-gradient(180deg, ${col}, ${col}aa)`, transition: 'height .12s linear, background .35s' }} />
      </div>
      <div className="num" style={{ fontSize: 26, color: dim ? Q.dim : col, ...TYPE.hero }}>{dim ? '—' : `${rom}%`}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: col, height: 14 }}>
        {state === 'achieved' && Icon.check({ size: 13, stroke: col })}
        <span style={{ ...TYPE.caption, fontSize: 10, color: 'var(--ink-faint)' }}>
          {state === 'achieved' ? 'Target' : state === 'near' ? 'Near' : ''}
        </span>
      </div>
    </div>
  )
}

/* ---------- C6 Rep + Accuracy Bar ---------- */
export function RepBar({ s }: { s: EngineState }) {
  const dim = isDimmed(s)
  const ticks = s.repTicks
  const repInSet = s.currentRep
  const reliable = s.formScore !== null && s.scoreCoverage?.reliable === true
  const progressColor = reliable ? qColor(formBand(s.formScore as number)) : Q.neutral
  return (
    <div style={{ opacity: dim ? 0.5 : 1, transition: 'opacity .35s' }}>
      <L style={{ fontSize: 11 }}>Reps</L>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2 }}>
        <span className="num" style={{ fontSize: 64, color: progressColor, ...TYPE.hero, transition: 'color .3s' }}>{repInSet}</span>
        <span className="num" style={{ fontSize: 30, color: 'var(--ink-faint)', ...TYPE.hero }}>/ {s.targetReps}</span>
        {s.shallowCount > 0 && (
          <span style={{ ...TYPE.caption, fontSize: 13, color: Q.amber, marginLeft: 6 }}>+{s.shallowCount} shallow</span>
        )}
      </div>
      <div style={{ ...TYPE.caption, fontSize: 11, color: 'var(--ink-faint)', marginTop: -2 }}>
        {s.attemptCount} attempts · {s.fullRomCount} full · {s.invalidCount} invalid
      </div>
      <div style={{ display: 'flex', gap: 5, marginTop: 8, maxWidth: 360, flexWrap: 'wrap' }}>
        {ticks.map((t, i) => {
          const filled = t && t !== 'missed'
          const c = t === 'missed' ? 'transparent' : t ? qColor(t) : 'rgba(255,255,255,0.16)'
          return <div key={i} style={{
            width: 26, height: 8, borderRadius: 4,
            background: filled ? c : 'rgba(255,255,255,0.16)',
            border: t === 'missed' ? `1.5px dashed ${Q.red}88` : 'none',
            boxShadow: filled ? `0 0 8px ${c}66` : 'none',
            transition: 'background .3s, box-shadow .3s',
          }} />
        })}
      </div>
    </div>
  )
}

export function LiftBar({ s }: { s: EngineState }) {
  const dim = isDimmed(s)
  const timed = s.train && 'movement' in s.train ? s.train : null
  return (
    <div style={{ opacity: dim ? 0.5 : 1, transition: 'opacity .35s' }}>
      <L style={{ fontSize: 11 }}>Counted lifts</L>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
        <span className="num" style={{ fontSize: 64, color: Q.neutral, ...TYPE.hero }}>{s.currentRep}</span>
        {s.shallowCount > 0 && <span style={{ ...TYPE.caption, fontSize: 13, color: Q.amber }}>+{s.shallowCount} shallow</span>}
      </div>
      <div style={{ ...TYPE.caption, fontSize: 11, color: 'var(--ink-faint)' }}>
        {s.fullRomCount} full · {s.invalidCount} invalid
      </div>
      <div style={{ ...TYPE.caption, fontSize: 11, color: 'var(--ink-dim)', marginTop: 5 }}>
        Left {timed?.movement.left_lifts ?? 0} · Right {timed?.movement.right_lifts ?? 0}
      </div>
    </div>
  )
}

/* ---------- C4 Correction Cue (single, prioritized) ---------- */
export function CorrectionCue({ s }: { s: EngineState }) {
  const cue = s.cue
  if (!cue) return null
  const sev = cue.severity
  const col = sev === 'success' ? Q.green : sev === 'error' ? Q.red : sev === 'warning' ? Q.amber : Q.neutral
  const Ic = sev === 'success' ? Icon.check : sev === 'error' ? Icon.x : sev === 'warning' ? Icon.alert : Icon.info
  return (
    <div key={cue.text + sev} style={{
      animation: 'cueIn .28s ease both', display: 'inline-flex', alignItems: 'center', gap: 15,
      background: 'rgba(8,10,14,0.82)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      border: `1px solid ${col}66`, borderRadius: 17, padding: '16px 24px 16px 17px',
      boxShadow: `0 8px 28px rgba(0,0,0,0.45), inset 0 0 0 1px ${col}22`,
    }}>
      <span style={{ width: 38, height: 38, borderRadius: 11, background: col, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        {Ic({ size: 23, stroke: '#08090c', sw: 3 })}
      </span>
      <span>
        <span style={{ ...TYPE.body, fontSize: 24, color: Q.neutral, fontWeight: 600, display: 'block' }}>{cue.text}</span>
        {/* The cue text alone does not say what KIND of message it is. Mid-set, a user glancing at
            the pill needs to know in one beat whether they are being corrected, reassured, or told
            the system has lost them — the same text with a different intent calls for a different
            reaction. The sub-line is derived from severity, never authored per cue, so backend
            copy stays the single source of the instruction itself. */}
        <span style={{ ...TYPE.caption, fontSize: 13, color: col, display: 'block', marginTop: 2 }}>
          {cueKind(sev)}
        </span>
      </span>
    </div>
  )
}

function cueKind(severity: Severity): string {
  if (severity === 'success') return 'Good form'
  if (severity === 'neutral') return 'Tracking'
  return 'Adjust your form'
}

/* ---------- C9 Metrics HUD Strip (no Form/ROM here — no duplication) ---------- */
function MetricTile({ label, value, unit, state, dim }: {
  label: string; value: string; unit?: string
  state: 'normal' | 'good' | 'bad' | 'unavailable'; dim: boolean
}) {
  const col = state === 'bad' ? Q.red : state === 'good' ? Q.green : Q.neutral
  const unavailable = state === 'unavailable'
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, opacity: dim ? 0.45 : 1, transition: 'opacity .35s' }}>
      <L style={{ fontSize: 11 }}>{label}</L>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span className="num" style={{ fontSize: 34, color: unavailable ? 'var(--ink-faint)' : col, ...TYPE.hero }}>
          {unavailable ? '—' : value}
        </span>
        {!unavailable && unit && <span style={{ ...TYPE.caption, fontSize: 11, color: 'var(--ink-faint)' }}>{unit}</span>}
      </div>
      <span style={{ ...TYPE.caption, fontSize: 10, color: state === 'bad' ? Q.red : 'var(--ink-faint)' }}>
        {unavailable ? 'Unavailable' : state === 'bad' ? 'Too fast' : state === 'good' ? 'On pace' : ''}
      </span>
    </div>
  )
}
/* Bottom-right pair: Pace + Rep time, side by side (reps live in their own bottom-left card;
   symmetry removed). Rep time is the live per-rep timer; Pace is the last completed rep's total —
   distinct values, so they no longer read as duplicates. Parent fixes the width so they spread. */
export function SideMetrics({ s }: { s: EngineState }) {
  const dim = isDimmed(s)
  if (s.targetMeasure === 'time') {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <MetricTile label="Pace (now)" value={s.currentCadenceSpm?.toFixed(1) ?? '–'} unit="/min" state={s.currentCadenceSpm == null ? 'unavailable' : 'normal'} dim={dim} />
        <div style={{ width: 1, height: 48, background: 'rgba(255,255,255,0.12)', marginBottom: 8 }} />
        <MetricTile label="Avg pace" value={s.averageCadenceSpm?.toFixed(1) ?? '–'} unit="/min" state={s.averageCadenceSpm == null ? 'unavailable' : 'normal'} dim={dim} />
      </div>
    )
  }
  const ma = s.metricAvailability
  const pace = s.paceSecPerRep
  const paceState = !ma.pace ? 'unavailable' : s.tooFast ? 'bad' : 'normal'
  const repTimeState = !ma.repDuration ? 'unavailable' : 'normal'
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
      <MetricTile label="Pace" value={pace ? pace.toFixed(1) : '–'} unit="sec/rep" state={paceState} dim={dim} />
      <div style={{ width: 1, height: 48, background: 'rgba(255,255,255,0.12)', marginBottom: 8 }} />
      <MetricTile label="Rep time" value={s.repDuration ? s.repDuration.toFixed(1) : '–'} unit="sec" state={repTimeState} dim={dim} />
    </div>
  )
}

/* ---------- C2 compact brief (slim top-center card) ---------- */
export function ExerciseBriefCompact({ s }: { s: EngineState }) {
  const ex = s.currentExercise
  return (
    <div className="coach-exercise-brief">
      <div className="coach-exercise-brief__icon">
        {Icon.dumbbell({ size: 20 })}
      </div>
      <div>
        <div className="coach-exercise-brief__name">{ex.name}</div>
        <div className="coach-exercise-brief__meta">
          Set {s.currentSet} of {s.targetSets} · {s.targetMeasure === 'time' ? `${s.targetDurationSeconds}s` : `${s.targetReps} reps`}
        </div>
      </div>
    </div>
  )
}

/* ---------- Set-complete: rest between sets (multi-set) ---------- */
/* Shown when a set finishes and more sets remain. Running countdown + Extend / Skip.
   CoachApp owns the 1-Hz tick and auto-advances to the next set at zero. */
export function RestOverlay({ s, dispatch }: { s: EngineState; dispatch: EngineDispatch }) {
  if (s.setOutcome !== 'rest') return null
  const remaining = Math.max(0, s.restRemaining ?? 0)
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 50, background: 'rgba(4,5,7,0.62)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'grid', placeItems: 'center',
      animation: 'fadeIn .25s ease both',
    }}>
      <div style={{ animation: 'modalIn .25s ease both', width: 460, textAlign: 'center', background: 'rgba(14,16,21,0.96)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 20, padding: 32, boxShadow: '0 30px 80px rgba(0,0,0,0.6)' }}>
        <div style={{ ...TYPE.label, fontSize: 13, color: 'var(--ink-dim)' }}>
          Set {s.currentSet} of {s.targetSets} complete
        </div>
        <div style={{ ...TYPE.hero, fontSize: 26, color: Q.neutral, margin: '8px 0 18px' }}>Rest</div>
        <div className="num" style={{ ...TYPE.hero, fontSize: 88, color: '#9fb0ff', lineHeight: 1 }}>{fmtClock(remaining)}</div>
        <div style={{ ...TYPE.caption, fontSize: 14, color: 'var(--ink-dim)', margin: '12px 0 24px' }}>
          Next: Set {s.currentSet + 1} of {s.targetSets} · {s.targetMeasure === 'time' ? `${s.targetDurationSeconds}s` : `${s.targetReps} reps`}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <button onClick={() => dispatch({ type: 'EXTEND_REST', seconds: REST_EXTEND_S })} style={{
            padding: '14px', borderRadius: 13, background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.14)', color: Q.neutral, ...TYPE.body, fontSize: 16, fontWeight: 600,
          }}>
            +{REST_EXTEND_S}s
          </button>
          <button onClick={() => dispatch({ type: 'NEXT_SET' })} style={{
            padding: '14px', borderRadius: 13, background: Q.green, border: 'none', color: '#08090c',
            ...TYPE.body, fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
            {Icon.skip({ size: 16, stroke: '#08090c' })} Skip rest
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------- Set-complete: workout done (single / last set) ---------- */
/* Shown when the final set finishes. The only action is View Summary → F5. */
export function SetCompleteOverlay({ s, dispatch }: { s: EngineState; dispatch: EngineDispatch }) {
  if (s.setOutcome !== 'complete') return null
  const single = s.targetSets <= 1
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 50, background: 'rgba(4,5,7,0.62)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'grid', placeItems: 'center',
      animation: 'fadeIn .25s ease both',
    }}>
      <div style={{ animation: 'modalIn .25s ease both', width: 460, textAlign: 'center', background: 'rgba(14,16,21,0.96)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 20, padding: 32, boxShadow: '0 30px 80px rgba(0,0,0,0.6)' }}>
        <span style={{ width: 60, height: 60, borderRadius: 16, margin: '0 auto 14px', background: `${Q.green}1f`, border: `1px solid ${Q.green}66`, display: 'grid', placeItems: 'center' }}>
          {Icon.check({ size: 30, stroke: Q.green, sw: 3 })}
        </span>
        <div style={{ ...TYPE.label, fontSize: 13, color: 'var(--ink-dim)' }}>
          {single ? 'Set complete' : `All ${s.targetSets} sets complete`}
        </div>
        <div style={{ ...TYPE.hero, fontSize: 30, color: Q.neutral, margin: '6px 0 6px' }}>Completed</div>
        <div style={{ ...TYPE.caption, fontSize: 14, color: 'var(--ink-dim)', marginBottom: 24 }}>
          {s.targetMeasure === 'time'
            ? `${s.currentRep} lifts tracked in this ${s.targetDurationSeconds}-second set.`
            : `${s.currentRep} reps tracked across ${s.log.setReps.length || 1} set${(s.log.setReps.length || 1) > 1 ? 's' : ''}.`}
        </div>
        <button onClick={() => dispatch({ type: 'END' })} style={{
          width: '100%', padding: '15px', borderRadius: 13, border: 'none', background: Q.green, color: '#08090c',
          ...TYPE.body, fontSize: 17, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
        }}>
          View summary →
        </button>
      </div>
    </div>
  )
}

/* ---------- C12 Pause Menu ---------- */
export function PauseMenu({ s, dispatch }: { s: EngineState; dispatch: EngineDispatch }) {
  if (!s.isPaused) return null
  const ex = s.currentExercise
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 50, background: 'rgba(4,5,7,0.62)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'grid', placeItems: 'center',
      animation: 'fadeIn .25s ease both',
    }}>
      <div style={{ animation: 'modalIn .25s ease both', width: 440, background: 'rgba(14,16,21,0.96)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 20, padding: 28, boxShadow: '0 30px 80px rgba(0,0,0,0.6)' }}>
        {!s.pauseConfirmEnd ? (
          <>
            <div style={{ ...TYPE.label, fontSize: 13, color: 'var(--ink-dim)' }}>Workout paused</div>
            <div style={{ ...TYPE.hero, fontSize: 30, color: Q.neutral, margin: '6px 0 4px' }}>Paused</div>
            <div style={{ ...TYPE.caption, fontSize: 14, color: 'var(--ink-dim)', marginBottom: 20 }}>
              {ex.name} · {s.currentRep} {s.targetMeasure === 'time' ? 'lifts' : 'reps'} tracked
            </div>
            <button onClick={() => dispatch({ type: 'PAUSE', value: false })} style={{
              width: '100%', padding: '15px', borderRadius: 13, border: 'none', marginBottom: 10,
              background: Q.green, color: '#08090c', ...TYPE.body, fontSize: 17, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
            }}>
              {Icon.play({ size: 18, stroke: '#08090c' })} Resume
            </button>
            <button onClick={() => dispatch({ type: 'ASK_END' })} style={{
              width: '100%', marginTop: 0, padding: '13px', borderRadius: 13,
              background: 'transparent', border: `1px solid ${Q.red}55`, color: Q.red,
              ...TYPE.body, fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}>
              {Icon.power({ size: 17, stroke: Q.red })} End workout
            </button>
          </>
        ) : (
          <>
            <div style={{ ...TYPE.hero, fontSize: 26, color: Q.neutral, marginBottom: 8 }}>End workout?</div>
            <div style={{ ...TYPE.body, fontSize: 15, color: 'var(--ink-dim)', marginBottom: 22, lineHeight: 1.5 }}>
              Your summary will use the {s.currentRep} {s.targetMeasure === 'time' ? 'lifts' : 'reps'} tracked so far.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <button onClick={() => dispatch({ type: 'CANCEL_END' })} style={{
                padding: '14px', borderRadius: 13, background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.14)', color: Q.neutral, ...TYPE.body, fontSize: 16, fontWeight: 600,
              }}>
                Keep going
              </button>
              <button onClick={() => dispatch({ type: 'END' })} style={{
                padding: '14px', borderRadius: 13, background: Q.red, border: 'none', color: '#08090c', ...TYPE.body, fontSize: 16, fontWeight: 700,
              }}>
                End &amp; view summary
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
