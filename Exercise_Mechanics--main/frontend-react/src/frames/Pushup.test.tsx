/* Push-up front-end wiring. Push-up is the first SIDE-ON exercise in the catalog, and that one
   difference is what these tests are about: everything here would pass trivially for a squat and
   fails loudly if push-up is treated as just another standing exercise. */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { initialState, foldTrain } from '../engine/useEngine'
import { liveTrackingConfidence } from '../engine/adapter'
import { parseServerMessage } from '../engine/protocol'
import { isDimmed } from '../selectors'
import { PUSHUP } from '../engine/dummy'
import type { EngineState, WSRepTrain, WSSetup, Landmark } from '../types'
import { F2_Gate, F3_Active } from './Frames'

function pushupState(): EngineState {
  return {
    ...initialState(),
    currentExercise: { ...PUSHUP, targetReps: 8 },
    targetReps: 8,
    repTicks: Array(8).fill(null),
  }
}

/* Mid-set: two reps already counted. The blocked frame below reports the same counters, so the
   stream guard sees a continuation rather than a jump. */
function liveState(): EngineState {
  return {
    ...pushupState(),
    view: 'F3',
    currentRep: 2,
    attemptCount: 2,
    fullRomCount: 2,
  }
}

function setupData(): WSSetup {
  return {
    phase: 'precheck',
    missing: [],
    conditions: [
      { template_id: 'plank_ready', status: 'failed', reason_id: null, cue: null, measurements: {} },
      { template_id: 'side_view_orientation', status: 'passed', reason_id: null, cue: null, measurements: {} },
    ],
    failures: [{ template_id: 'plank_ready', status: 'failed', reason_id: null, cue: null, measurements: {} }],
    dwell: { held_ms: 400, required_ms: 2000 },
    capture: {
      valid_ms: 0, required_ms: 3000, progress: 0, frames_collected: 0,
      min_valid_samples: 45, observed_frames: 0, valid_coverage: 0, invalid_ms: 0, paused: false,
    },
    quality: null,
    validation_results: [],
    baseline_candidate_ready: false,
    baseline_ready: false,
    start: false,
    cue: null,
  }
}

function gate(state: EngineState): string {
  return renderToStaticMarkup(
    <F2_Gate s={state} cameraStarted onStartCamera={() => undefined} onRetryCamera={() => undefined} poseError={null} />,
  )
}

function live(state: EngineState): string {
  return renderToStaticMarkup(
    <F3_Active s={state} dispatch={() => undefined} elapsedSeconds={12} onExit={() => undefined} />,
  )
}

/* A live frame the backend produced while the user was front-on: every joint readable, but
   side_view_orientation has declared the measurement meaningless, so tracking is unavailable and
   the rep machine is paused. */
function blockedFrame(): Record<string, unknown> {
  return {
    tracking: { available: false, unavailable_rule_ids: [], invalidated_by: ['side_view_orientation'] },
    phase: 'setup',
    counters: { attempts: 2, qualified: 2, full_rom: 2, shallow: 0, invalid: 0 },
    rom: {
      available: false, ratio: null, percent: null, full_rom_gate: 0.9, full_depth: null,
      current_peak: 0, rule_id: 'pushup_depth', coaching: 'Lower until your elbows bend to about 90 degrees.',
    },
    active_rule_ids: ['body_line', 'pushup_depth', 'side_view_orientation'],
    issues: [],
    cue: { rule_id: 'side_view_orientation', text: 'Turn side-on to the camera.', coaching: '' },
    last_attempt: null,
    last_rep: null,
    set: { target_reps: 8, completed_reps: 2, remaining_reps: 6, complete: false, scored_reps: 0, average_score: null },
    score_coverage: null,
    events: {
      attempt_completed: false, rep_completed: false, attempt_discarded: false,
      rep_cycle_completed: false, set_cycle_completed: false,
    },
  }
}

function envelope(raw: Record<string, unknown>) {
  return { v: 1, type: 'train.status', data: raw }
}

function parsedTrain(raw: Record<string, unknown>): WSRepTrain {
  const parsed = parseServerMessage(envelope(raw))
  if (!parsed || parsed.type !== 'train.status') throw new Error('frame did not parse as a train status')
  const data = parsed.data
  if ('movement_type' in data.set) throw new Error('parsed as the timed contract, not the rep contract')
  return data as WSRepTrain
}

describe('push-up setup guidance', () => {
  it('coaches a side-on camera and a plank, never a standing start position', () => {
    const html = gate({ ...pushupState(), setup: setupData() })
    expect(html).toContain('Get into the top of a push-up')
    expect(html).toContain('Push-ups are measured from the side')
    // The squat copy must not leak into a push-up setup screen.
    expect(html).not.toContain('feet shoulder-width apart')
    expect(html).not.toContain('Every setup check must remain valid together')
  })

  it('names the push-up pre-check conditions instead of showing raw rule ids', () => {
    const html = gate({ ...pushupState(), setup: setupData() })
    expect(html).toContain('Plank position')
    expect(html).toContain('Camera angle')
    expect(html).not.toContain('side view orientation')
  })

  it('tells a user who is out of frame to move the camera to their side', () => {
    const html = gate({ ...pushupState(), setup: { ...setupData(), missing: ['left_ankle'] } })
    expect(html).toContain('Place the camera at your side')
    expect(html).not.toContain('Step back so your whole body fits')
  })
})

describe('measurement invalidated by camera angle', () => {
  it('parses invalidated_by and keeps it separate from unreadable joints', () => {
    const data = parsedTrain(blockedFrame())
    expect(data.tracking.invalidated_by).toEqual(['side_view_orientation'])
    expect(data.tracking.unavailable_rule_ids).toEqual([])
  })

  it('defaults invalidated_by to empty for exercises that send no such rule', () => {
    const raw = blockedFrame()
    raw.tracking = { available: false, unavailable_rule_ids: ['pushup_depth'] }
    expect(parsedTrain(raw).tracking.invalidated_by).toEqual([])
  })

  it('rejects a frame that invalidates a rule it is not running', () => {
    const raw = blockedFrame()
    raw.tracking = { available: false, unavailable_rule_ids: [], invalidated_by: ['not_a_rule'] }
    expect(parseServerMessage(envelope(raw))).toBeNull()
  })

  it('rejects a frame claiming measurements are usable while naming an invalidating rule', () => {
    const raw = blockedFrame()
    raw.tracking = { available: true, unavailable_rule_ids: [], invalidated_by: ['side_view_orientation'] }
    expect(parseServerMessage(envelope(raw))).toBeNull()
  })

  it('shows the backend cue rather than the generic "hold still", and holds the counters', () => {
    const before = { ...liveState(), romPercentage: 64 }
    const after = foldTrain(before, parsedTrain(blockedFrame()))
    expect(after.cue?.text).toBe('Turn side-on to the camera.')
    expect(after.cue?.severity).toBe('error')
    expect(after.measurementBlockedBy).toEqual(['side_view_orientation'])
    // Held, not zeroed — the reps already earned stay earned.
    expect(after.currentRep).toBe(2)
    expect(after.romPercentage).toBe(64)
  })

  it('still says "hold still" when tracking is lost for ordinary reasons', () => {
    const raw = blockedFrame()
    raw.tracking = { available: false, unavailable_rule_ids: ['pushup_depth'], invalidated_by: [] }
    raw.cue = null
    const after = foldTrain(liveState(), parsedTrain(raw))
    expect(after.cue?.text).toBe('Hold still for tracking')
    expect(after.measurementBlockedBy).toEqual([])
  })

  it('dims the HUD, because the numbers on screen are frozen', () => {
    const blocked = foldTrain({ ...liveState(), trackingConfidence: 0.99 }, parsedTrain(blockedFrame()))
    // Confidence is high — landmark visibility is not the reason, so only the new rule can dim it.
    expect(blocked.trackingConfidence).toBe(0.99)
    expect(isDimmed(blocked)).toBe(true)
  })

  it('renders one unambiguous banner: turn, and reps are not counting', () => {
    const blocked = foldTrain({ ...liveState(), trackingConfidence: 0.2 }, parsedTrain(blockedFrame()))
    const html = live(blocked)
    expect(html).toContain('Turn side-on to the camera.')
    expect(html).toContain('no reps are being counted')
    // Low confidence would normally raise the recovery banner; its "hold still" contradicts the
    // instruction above, so exactly one of the two may be on screen.
    expect(html).not.toContain('Hold still for a moment')
  })

  it('clears the block as soon as a measurable frame arrives', () => {
    const raw = blockedFrame()
    raw.tracking = { available: true, unavailable_rule_ids: [], invalidated_by: [] }
    raw.rom = {
      available: true, ratio: 0.42, percent: 42, full_rom_gate: 0.9, full_depth: false,
      current_peak: 0.42, rule_id: 'pushup_depth', coaching: 'Lower until your elbows bend to about 90 degrees.',
    }
    raw.cue = null
    const blocked = foldTrain(liveState(), parsedTrain(blockedFrame()))
    const recovered = foldTrain(blocked, parsedTrain(raw))
    expect(recovered.measurementBlockedBy).toEqual([])
    expect(recovered.romPercentage).toBe(42)
    expect(isDimmed({ ...recovered, trackingConfidence: 0.99 })).toBe(false)
  })
})

describe('correction cue', () => {
  it('labels what kind of message the pill is, so it reads in one glance', () => {
    const base = liveState()
    const warn = live({ ...base, cue: { text: 'Keep your hips in line.', severity: 'warning', joint: 'trunk', side: null } })
    expect(warn).toContain('Keep your hips in line.')
    expect(warn).toContain('Adjust your form')

    const good = live({ ...base, cue: { text: 'Full depth.', severity: 'success', joint: null, side: null } })
    expect(good).toContain('Good form')
    expect(good).not.toContain('Adjust your form')
  })
})

describe('tracking confidence in a profile view', () => {
  function body(near: number, far: number): Landmark[] {
    // 33 BlazePose landmarks; odd indices are the left side, even the right.
    return Array.from({ length: 33 }, (_, i) => ({
      x: 0, y: 0, z: 0, visibility: i % 2 === 1 ? near : far,
    }))
  }

  it('reads the visible side, so a correct side-on push-up is not dimmed as "low confidence"', () => {
    // Exactly the situation the exercise REQUIRES: near side crisp, far side occluded.
    const profile = body(0.95, 0.12)
    expect(liveTrackingConfidence(profile, 'pushup')).toBeCloseTo(0.95)
    // The squat rule (worst joint across both sides) would have called this a tracking failure.
    expect(liveTrackingConfidence(profile, 'squat')).toBeCloseTo(0.12)
  })

  it('still reports low confidence when neither side is readable', () => {
    expect(liveTrackingConfidence(body(0.2, 0.1), 'pushup')).toBeCloseTo(0.2)
    expect(liveTrackingConfidence(null, 'pushup')).toBe(0)
    expect(liveTrackingConfidence([{ visibility: 1 }], 'pushup')).toBe(0)
  })
})
