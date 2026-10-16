import { describe, expect, it } from 'vitest'

import type { WSRepTrain, WSSetup } from '../types'
import { foldSetup, foldTrain, initialState } from './useEngine'
import { parseServerMessage } from './protocol'

function setupData(phase: WSSetup['phase'] = 'precheck'): WSSetup {
  return {
    phase,
    missing: [],
    conditions: [
      {
        template_id: 'standing_posture',
        status: 'passed',
        reason_id: null,
        cue: null,
        measurements: { left_knee_angle_deg: 175 },
      },
      {
        template_id: 'stance_width',
        status: 'passed',
        reason_id: null,
        cue: null,
        measurements: { ratio: 1, state: 'safe', skeleton_color: 'green' },
      },
    ],
    failures: [],
    dwell: { held_ms: 900, required_ms: 2000 },
    capture: {
      valid_ms: 0,
      required_ms: 3000,
      progress: 0,
      frames_collected: 0,
      min_valid_samples: 45,
      observed_frames: 0,
      valid_coverage: 0,
      invalid_ms: 0,
      paused: false,
    },
    quality: null,
    validation_results: [],
    baseline_candidate_ready: false,
    baseline_ready: false,
    start: false,
    cue: null,
  }
}

const reliableCoverage = {
  active_rule_ids: ['depth', 'stance_width'],
  available_rule_ids: ['depth', 'stance_width'],
  unavailable_rule_ids: [],
  ratio: 1,
  reliable: true,
}

function trainData(): WSRepTrain {
  return {
    tracking: { available: true, unavailable_rule_ids: [], invalidated_by: [] },
    phase: 'reset',
    counters: { attempts: 1, qualified: 1, full_rom: 1, shallow: 0, invalid: 0 },
    rom: {
      available: true,
      ratio: 0.05,
      percent: 5,
      full_rom_gate: 0.85,
      full_rom: false,
      hip_below_knee: false,
      current_peak: 0,
      rule_id: 'depth',
      coaching: 'Sit down until your hips reach the top of your knees.',
    },
    active_rule_ids: ['depth', 'stance_width'],
    issues: [],
    cue: null,
    last_attempt: {
      attempt: 1,
      rep: 1,
      qualified: true,
      classification: 'full_rom',
      peak: 0.95,
      score: 100,
      time_score: 100,
      rom_factor: 1,
      quality: 'reliable',
      scoring_config_version: 1,
      score_coverage: reliableCoverage,
    },
    last_rep: {
      attempt: 1,
      rep: 1,
      qualified: true,
      classification: 'full_rom',
      peak: 0.95,
      score: 100,
      time_score: 100,
      rom_factor: 1,
      quality: 'reliable',
      scoring_config_version: 1,
      score_coverage: reliableCoverage,
    },
    set: {
      target_reps: 3,
      completed_reps: 1,
      remaining_reps: 2,
      complete: false,
      scored_reps: 1,
      average_score: 100,
    },
    score_coverage: reliableCoverage,
    events: {
      attempt_completed: true,
      rep_completed: true,
      attempt_discarded: false,
      rep_cycle_completed: false,
      set_cycle_completed: false,
    },
  }
}

describe('V1 WebSocket parser', () => {
  it('accepts a complete setup status and rejects an unversioned payload', () => {
    const data = setupData()
    expect(parseServerMessage({ v: 1, type: 'setup.status', data })).toEqual({
      v: 1,
      type: 'setup.status',
      data,
    })
    expect(parseServerMessage({ setup: data })).toBeNull()
  })

  it('requires ready, persisted baseline and START to agree', () => {
    const ready = {
      ...setupData('ready'),
      baseline_candidate_ready: true,
      baseline_ready: true,
      start: true,
    }
    expect(parseServerMessage({ v: 1, type: 'setup.ready', data: ready })).not.toBeNull()
    expect(parseServerMessage({ v: 1, type: 'setup.status', data: ready })).toBeNull()
  })

  it('accepts authoritative taxonomy and rejects contradictory counters', () => {
    const data = trainData()
    expect(parseServerMessage({ v: 1, type: 'train.status', data })).not.toBeNull()
    const broken = structuredClone(data)
    broken.counters.qualified = 2
    expect(parseServerMessage({ v: 1, type: 'train.status', data: broken })).toBeNull()
  })

  it('accepts configured live stance state and skeleton color', () => {
    const data = trainData()
    data.issues = [{
      id: 'stance_width',
      label: 'Stance too narrow / too wide',
      tier: 'low',
      side: 'narrow',
      state: 'not_ok',
      skeleton_color: 'red',
    }]
    data.cue = { rule_id: 'stance_width', text: 'Stand shoulder-width with stable feet.', coaching: '' }

    expect(parseServerMessage({ v: 1, type: 'train.status', data })).not.toBeNull()
  })

  it('validates stable backend errors', () => {
    expect(parseServerMessage({
      v: 1,
      type: 'train.error',
      data: { code: 'BASELINE_NOT_READY', detail: 'baseline missing' },
    })).not.toBeNull()
    expect(parseServerMessage({ v: 1, type: 'train.error', data: { code: '', detail: 3 } })).toBeNull()
  })
})

describe('V1 reducer folding', () => {
  it('renders combined setup progress and keeps ready in F2 for START', () => {
    const precheck = foldSetup(initialState(), setupData())
    expect(precheck.prep).toBe('precheck')
    expect(precheck.view).toBe('F2')

    const readyData = {
      ...setupData('ready'),
      baseline_candidate_ready: true,
      baseline_ready: true,
      start: true,
    }
    const ready = foldSetup(precheck, readyData)
    expect(ready.prep).toBe('start')
    expect(ready.view).toBe('F2')
    expect(ready.baselineReady).toBe(true)
  })

  it('maps a High Knee setup-readiness failure to both knee-to-ankle connections', () => {
    const data = setupData()
    const failure = {
      template_id: 'setup_readiness',
      status: 'failed' as const,
      reason_id: 'knees_not_extended',
      cue: 'Face the camera, stand tall, and keep both feet down.',
      measurements: {},
    }
    data.conditions = [failure]
    data.failures = [failure]

    const next = foldSetup(initialState(), data)
    expect(next.correctionSeverity).toBe('error')
    expect(next.flaggedJoint).toBe('shins')
    expect(next.flaggedSide).toBeNull()
  })

  it('uses only the reliable backend score for the rep tick and summary log', () => {
    const state = { ...initialState(), view: 'F3' as const, targetReps: 3 }
    const next = foldTrain(state, trainData())

    expect(next.currentRep).toBe(1)
    expect(next.attemptCount).toBe(1)
    expect(next.fullRomCount).toBe(1)
    expect(next.formScore).toBe(100)
    expect(next.repTicks[0]).toBe('good')
    expect(next.log.formScores).toEqual([100])
  })

  it('uses the template-owned stance color for the live skeleton', () => {
    const data = trainData()
    data.issues = [{
      id: 'stance_width',
      label: 'Stance too narrow / too wide',
      tier: 'low',
      side: 'narrow',
      state: 'not_ok',
      skeleton_color: 'red',
    }]
    data.cue = { rule_id: 'stance_width', text: 'Stand shoulder-width with stable feet.', coaching: '' }

    const next = foldTrain({ ...initialState(), view: 'F3', targetReps: 3 }, data)
    expect(next.correctionSeverity).toBe('error')
    expect(next.flaggedJoint).toBe('ankles')
  })

  it('maps a deferred short-curl cue to the wrists without requiring an active issue', () => {
    const data = trainData()
    data.active_rule_ids = ['curl_rom']
    data.issues = []
    data.rom = {
      ...data.rom,
      rule_id: 'curl_rom',
      full_rom_gate: 0.75,
      ratio: 0.3,
      percent: 30,
    }
    data.cue = {
      rule_id: 'curl_rom',
      text: 'Curl all the way up with control.',
      coaching: '',
    }

    const next = foldTrain({ ...initialState(), view: 'F3', targetReps: 3 }, data)
    expect(next.correctionSeverity).toBe('warning')
    expect(next.flaggedJoint).toBe('wrists')
  })

  it('maps an elbow-flare cue to the elbows', () => {
    const data = trainData()
    data.active_rule_ids = ['elbow_flare_corridor', 'curl_rom']
    data.issues = [{
      id: 'elbow_flare_corridor',
      label: 'Elbow flare',
      tier: 'high',
      side: 'left',
      state: 'not_ok',
      skeleton_color: 'red',
    }]
    data.cue = {
      rule_id: 'elbow_flare_corridor',
      text: 'Keep your elbows close to your sides.',
      coaching: '',
    }

    const next = foldTrain({ ...initialState(), view: 'F3', targetReps: 3 }, data)
    expect(next.correctionSeverity).toBe('error')
    expect(next.flaggedJoint).toBe('elbows')
  })

  it('maps a curl lateral-lean cue to the trunk', () => {
    const data = trainData()
    data.active_rule_ids = ['lateral_torso_lean', 'curl_rom']
    data.issues = [{
      id: 'lateral_torso_lean',
      label: 'Lateral torso lean',
      tier: 'high',
      side: 'left',
      state: 'not_ok',
      skeleton_color: 'red',
    }]
    data.cue = {
      rule_id: 'lateral_torso_lean',
      text: 'Keep your torso upright and centered.',
      coaching: '',
    }

    const next = foldTrain({ ...initialState(), view: 'F3', targetReps: 3 }, data)
    expect(next.correctionSeverity).toBe('error')
    expect(next.flaggedJoint).toBe('trunk')
  })

  it('keeps incomplete-coverage scores unavailable instead of green', () => {
    const data = trainData()
    const lowCoverage = {
      active_rule_ids: ['depth', 'stance_width'],
      available_rule_ids: ['depth'],
      unavailable_rule_ids: ['stance_width'],
      ratio: 0.5,
      reliable: false,
    }
    data.last_attempt = { ...data.last_attempt!, quality: 'low_confidence', score_coverage: lowCoverage }
    data.last_rep = { ...data.last_rep!, quality: 'low_confidence', score_coverage: lowCoverage }
    data.score_coverage = lowCoverage

    const next = foldTrain({ ...initialState(), view: 'F3', targetReps: 3 }, data)
    expect(next.formScore).toBe(100)
    expect(next.scoreCoverage?.reliable).toBe(false)
    expect(next.repTicks[0]).toBeNull()
    expect(next.log.formScores).toEqual([])
  })

  it('folds invalid attempts without creating phantom reps or ticks', () => {
    const data = trainData()
    data.counters = { attempts: 1, qualified: 0, full_rom: 0, shallow: 0, invalid: 1 }
    data.last_attempt = {
      ...data.last_attempt!,
      rep: null,
      qualified: false,
      classification: 'invalid',
      score: null,
      time_score: null,
      rom_factor: null,
      quality: 'not_scored',
    }
    data.last_rep = null
    data.set = { ...data.set, completed_reps: 0, remaining_reps: 3, scored_reps: 0, average_score: null }
    data.score_coverage = null

    const next = foldTrain({ ...initialState(), view: 'F3', targetReps: 3 }, data)
    expect(next.invalidCount).toBe(1)
    expect(next.currentRep).toBe(0)
    expect(next.repTicks.every((tick) => tick === null)).toBe(true)
    expect(next.log.reps).toEqual([])
  })

  it('rejects counter regressions without mutating displayed reps', () => {
    const state = {
      ...initialState(),
      view: 'F3' as const,
      targetReps: 3,
      currentRep: 1,
      attemptCount: 1,
      fullRomCount: 1,
    }
    const data = trainData()
    data.counters = { attempts: 0, qualified: 0, full_rom: 0, shallow: 0, invalid: 0 }
    data.last_attempt = null
    data.last_rep = null
    data.set = { ...data.set, completed_reps: 0, remaining_reps: 3, scored_reps: 0, average_score: null }
    data.score_coverage = null

    const next = foldTrain(state, data)
    expect(next.currentRep).toBe(1)
    expect(next.socketError?.code).toBe('INVALID_COUNTER_STREAM')
  })

  it('waits for final reset completion before entering set-complete state', () => {
    const state = {
      ...initialState(),
      view: 'F3' as const,
      targetSets: 1,
      targetReps: 3,
      currentRep: 2,
      attemptCount: 2,
      fullRomCount: 2,
    }
    const scored = trainData()
    scored.counters = { attempts: 3, qualified: 3, full_rom: 3, shallow: 0, invalid: 0 }
    scored.last_attempt = { ...scored.last_attempt!, attempt: 3, rep: 3 }
    scored.last_rep = { ...scored.last_rep!, attempt: 3, rep: 3 }
    scored.set = {
      target_reps: 3,
      completed_reps: 3,
      remaining_reps: 0,
      complete: true,
      scored_reps: 3,
      average_score: 100,
    }

    const duringReset = foldTrain(state, scored)
    expect(duringReset.currentRep).toBe(3)
    expect(duringReset.setOutcome).toBeNull()

    const resetFinished = {
      ...scored,
      phase: 'setup' as const,
      events: {
        attempt_completed: false,
        rep_completed: false,
        attempt_discarded: false,
        rep_cycle_completed: true,
        set_cycle_completed: true,
      },
    }
    const complete = foldTrain(duringReset, resetFinished)
    expect(complete.setOutcome).toBe('complete')
  })

  it('accepts the double-arm curl shape: top phase and per-arm ROM', () => {
    const data = structuredClone(trainData()) as unknown as Record<string, unknown>
    data.phase = 'top'
    data.active_rule_ids = ['curl_rom']
    data.rom = {
      available: true,
      ratio: 0.4,
      percent: 40,
      full_rom_gate: 0.75,
      full_rom: false,
      current_peak: 0.4,
      left_ratio: 0.8,
      right_ratio: 0.4,
      left_percent: 80,
      right_percent: 40,
      left_full: false,
      right_full: false,
      weaker_side: 'right',
      rule_id: 'curl_rom',
      coaching: 'Curl all the way up with control.',
    }
    const parsed = parseServerMessage({ v: 1, type: 'train.status', data })
    expect(parsed).not.toBeNull()
    const rom = (parsed as { data: WSRepTrain }).data.rom
    expect(rom.full_rom).toBe(false)
    expect(rom.weaker_side).toBe('right')
    expect(rom.left_ratio).toBe(0.8)
  })

  it('still accepts the legacy squat full_depth field', () => {
    const data = structuredClone(trainData()) as unknown as Record<string, unknown>
    const rom = data.rom as Record<string, unknown>
    delete rom.full_rom
    rom.full_depth = true  // legacy squat field name
    const parsed = parseServerMessage({ v: 1, type: 'train.status', data })
    expect(parsed).not.toBeNull()
    expect((parsed as { data: WSRepTrain }).data.rom.full_rom).toBe(true)
  })
})
