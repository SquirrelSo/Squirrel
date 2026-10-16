/* Copied from Exercise_Mechanics--main/frontend-react/src/types.ts (the V1 WebSocket part only).
   The browser coach and this app must read the coaching stream identically: keep in sync. */
/* ===== Backend WebSocket message shapes ===== */

export type WSConditionStatus = 'passed' | 'failed' | 'unavailable'

export interface WSCondition {
  template_id: string
  status: WSConditionStatus
  reason_id: string | null
  cue: string | null
  measurements: Record<string, unknown>
}

export interface WSCue {
  rule_id: string
  text: string
  coaching: string
}

export interface WSScoreCoverage {
  active_rule_ids: string[]
  available_rule_ids: string[]
  unavailable_rule_ids: string[]
  ratio: number
  reliable: boolean
}

export interface WSRepResult {
  attempt: number
  rep: number | null
  qualified: boolean
  classification: 'full_rom' | 'shallow' | 'invalid'
  /* Why an invalid attempt did not count; null when it counted (or from an older server). */
  reason: 'below_min_peak' | 'too_fast' | 'shallow' | null
  peak: number
  score: number | null
  time_score: number | null
  rom_factor: number | null
  quality: 'reliable' | 'low_confidence' | 'not_scored'
  scoring_config_version: number
  score_coverage: WSScoreCoverage
}

/* /ws/setup — combined gate → valid capture → validation → ready. */
export interface WSSetup {
  phase: 'precheck' | 'collecting' | 'validating' | 'ready'
  missing: string[]
  conditions: WSCondition[]
  failures: WSCondition[]
  dwell: { held_ms: number; required_ms: number }
  capture: {
    valid_ms: number
    required_ms: number
    progress: number
    frames_collected: number
    min_valid_samples: number
    observed_frames: number
    valid_coverage: number
    invalid_ms: number
    paused: boolean
  }
  quality: {
    valid_samples: number
    observed_frames: number
    valid_coverage: number
    valid_duration_ms: number
    max_joint_stddev_px: number
    joint_stddev_px: Record<string, { x: number; y: number }>
  } | null
  validation_results: WSCondition[]
  baseline_candidate_ready: boolean
  baseline_ready: boolean
  start: boolean
  cue: WSCue | null
}

/* /ws/train — backend-authoritative movement, taxonomy, scoring and coverage. */
export interface WSRepTrain {
  /* `available` is the single "are these measurements trustworthy" flag. It goes false for two
     very different reasons, and `invalidated_by` separates them: empty means the joints could not
     be read (occlusion, user out of frame); non-empty names the rules that CAN read the body but
     declare the reading meaningless — a push-up filmed front-on is the case this exists for. The
     distinction is the difference between "hold still" and "turn side-on", so the HUD must not
     collapse them. Exercises with no such rule always send an empty list. */
  tracking: { available: boolean; unavailable_rule_ids: string[]; invalidated_by: string[] }
  /* Movement phases are exercise-defined: squat descends first (descent/bottom/ascent), curl
     ascends first (ascent/top/descent). setup + reset are the shared lifecycle phases. */
  phase: 'setup' | 'descent' | 'bottom' | 'ascent' | 'top' | 'reset'
  counters: {
    attempts: number
    qualified: number
    full_rom: number
    shallow: number
    invalid: number
    /* Rep-shaped attempts the counting policy rejected (within `invalid`): short of full range,
       or too fast. Zero from an older server. */
    not_counted: { shallow: number; too_fast: number }
  }
  /* Exercise-agnostic range-of-motion. The common core (ratio/percent/gate/peak/rule_id/coaching)
     is identical across exercises; `full_rom` is the unified "current frame reached the ROM gate"
     flag. Per-arm fields are present for double-arm exercises (curl); `hip_below_knee` for squat. */
  rom: {
    available: boolean
    ratio: number | null
    percent: number | null
    full_rom_gate: number
    full_rom: boolean | null
    current_peak: number
    rule_id: string
    coaching: string
    hip_below_knee?: boolean | null
    left_ratio?: number | null
    right_ratio?: number | null
    left_percent?: number | null
    right_percent?: number | null
    left_full?: boolean | null
    right_full?: boolean | null
    weaker_side?: 'left' | 'right' | null
  }
  active_rule_ids: string[]
  issues: {
    id: string
    label: string
    tier: string
    side: string | null
    state: string | null
    skeleton_color: 'green' | 'red' | null
  }[]
  cue: WSCue | null
  last_attempt: WSRepResult | null
  last_rep: WSRepResult | null
  set: {
    target_reps: number
    completed_reps: number
    remaining_reps: number
    complete: boolean
    scored_reps: number
    average_score: number | null
  }
  score_coverage: WSScoreCoverage | null
  events: {
    attempt_completed: boolean
    rep_completed: boolean
    attempt_discarded: boolean
    rep_cycle_completed: boolean
    set_cycle_completed: boolean
  }
}

export type WSTimedTrain = import('./timedContract').WSTimedTrainContract
export type WSTrain = WSRepTrain | WSTimedTrain

export interface WSError {
  code: string
  detail: string
}

export type WSServerMessage =
  | { v: 1; type: 'setup.status' | 'setup.ready'; data: WSSetup }
  | { v: 1; type: 'train.status'; data: WSTrain }
  | { v: 1; type: 'setup.error' | 'train.error'; data: WSError }

