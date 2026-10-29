/* types.ts — The validated UI↔backend V1 contract and the state rendered by the coach. */

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

export type WSTimedTrain = import('./engine/timedContract').WSTimedTrainContract
export type WSTrain = WSRepTrain | WSTimedTrain

export interface WSError {
  code: string
  detail: string
}

export type WSServerMessage =
  | { v: 1; type: 'setup.status' | 'setup.ready'; data: WSSetup }
  | { v: 1; type: 'train.status'; data: WSTrain }
  | { v: 1; type: 'setup.error' | 'train.error'; data: WSError }

/* Kept for the HUD side-metrics types (tempo/pace are not populated by the new backend yet). */
export interface WSTempo {
  descent_s: number | null
  bottom_s: number | null
  ascent_s: number | null
  total_s: number | null
  status: 'idle' | 'in_progress' | 'complete'
}
export interface WSPace {
  reps_per_min: number | null
  sample_size: number
  status: 'idle' | 'estimating' | 'ready'
}

/* ===== Live pose (from MediaPipe, client-side) ===== */

export interface Landmark { x: number; y: number; z: number; visibility: number }

/* ===== The contract state the UI renders ===== */

// F2 setup (combined gate → capture → START) · F3 active workout · F5 summary
export type View = 'F2' | 'F3' | 'F5'

export type Severity = 'success' | 'error' | 'warning' | 'neutral' | null
/* skeleton joint group key the cue flags */
export type FlaggedJoint = 'knees' | 'legs' | 'shins' | 'trunk' | 'hips' | 'ankles' | 'shoulders' | 'elbows' | 'wrists' | null
/* Which side of the body a fault was attributed to. Only groups with a genuinely one-sided fault
   use it — a shrug and a lateral lean are read across the body, so they stay side-agnostic. */
export type FlaggedSide = 'left' | 'right' | 'both' | null

export interface CorrectionCue {
  text: string
  severity: Severity
  joint: FlaggedJoint
  side: FlaggedSide
}

export type RepTick = 'good' | 'amber' | 'poor' | 'missed' | null

export interface ExerciseConfig {
  id: string
  name: string
  motion: 'squat' | 'bicep_curl' | 'high_knee' | 'pushup'
  targetReps: number
  targetSets: number
  trackedJoints: string[]
  trainedMuscles: string[]
  targetTempo: string
  targetROMThreshold: number
  /* What the left-rail ROM meter calls this exercise's range signal. "Range of motion" reads
     right for a squat's depth; a push-up's signal is elbow flexion, so it says "Depth" instead. */
  romLabel: string
}

/* The real per-session targets, threaded from the Solo cart into the live engine
   (replaces the static dummy.ts SQUAT targets). One live exercise today (squat). */
export interface WorkoutConfig {
  exerciseId: string    // canonical backend slug (drives keypoints/precheck fetch + engine)
  exerciseName: string
  variant?: 'single' | 'double'   // curl single/double hand; ignored by squat
  sets: number
  measure: 'reps' | 'time'
  reps: number                 // zero for timed work
  durationSeconds: number      // zero for repetition work
  restSeconds: number   // rest interval between sets
}

export interface WorkoutSummary {
  measure: 'reps' | 'time'
  ended: boolean
  completedReps: number
  averageFormScore: number | null
  averagePace: string
  romConsistency: number
  bestSet: number
  mainCorrectionTheme: string
  weeklyWorkoutCount: number
  qualityCounts: { good: number; amber: number; poor: number; unscored: number }
  countedLifts: number
  fullLifts: number
  shallowLifts: number
  invalidLifts: number
  leftLifts: number
  rightLifts: number
  completedSets: number
  hasData: boolean
}

export interface EngineState {
  view: View
  autoAdvanceEnabled: boolean

  /* session / config — targetSets/targetReps/restSeconds come from the real workout
     config (SET_WORKOUT_CONFIG); currentExercise keeps the static squat descriptor. */
  currentExercise: ExerciseConfig
  currentSet: number
  targetSets: number
  targetMeasure: 'reps' | 'time'
  targetReps: number          // reps per set
  targetDurationSeconds: number
  restSeconds: number         // configured rest interval between sets
  setOutcome: 'rest' | 'complete' | null  // set finished: rest before next set | last set done
  restRemaining: number | null            // seconds left on the rest countdown (null off-rest)
  setupNotice: { text: string; status: 'balanced' | 'asymmetric' } | null

  /* camera */
  cameraPermissionStatus: 'granted' | 'required' | 'denied'

  /* live tracking */
  trackingStatus: 'searching' | 'partial' | 'low' | 'locked' | 'active' | 'lost' | 'disconnected'
  visibleBodyStatus: 'none' | 'partial' | 'full'
  trackingConfidence: number
  jointConfidence: number
  scoreConfidence: number
  poseVisible: boolean
  poseLandmarks: Landmark[] | null

  /* live rep / movement */
  phase: WSRepTrain['phase'] | 'active' | 'complete'
  attemptCount: number
  currentRep: number
  fullRomCount: number
  shallowCount: number
  invalidCount: number
  repTicks: RepTick[]
  poseDepth: number              // 0 standing .. 1 hip-at-knee (drives ROM/skeleton)
  romPercentage: number
  romPeak: number
  // Per-arm ROM for double-arm exercises (curl); null for single-signal exercises (squat). The
  // `weaker` side is the one the backend uses to drive rep qualification.
  romArms: { left: number; right: number; weaker: 'left' | 'right' } | null
  // Per-leg ROM for cyclic timed work. Availability stays side-specific so one occluded knee does
  // not turn the other side into a fabricated zero.
  romLegs: { left: number; right: number; leftAvailable: boolean; rightAvailable: boolean } | null
  currentJointAngle: number      // dummy interim
  formScore: number | null       // latest completed rep/lift score; never the cumulative set score
  scoreCoverage: WSScoreCoverage | null
  symmetryScore: number          // derived from symmetry rules
  paceSecPerRep: number | null
  repDuration: number | null
  tempo: WSTempo | null
  tempoHistory: WSTempo[]
  pace: WSPace | null
  currentCadenceSpm: number | null
  averageCadenceSpm: number | null
  metricAvailability: { pace: boolean; repDuration: boolean; symmetry: boolean }
  tooFast: boolean
  lowRom: boolean

  /* Rule ids that can see the body but declare the measurement meaningless (push-up's
     side_view_orientation is the only one today). Non-empty means the rep machine is PAUSED by a
     camera/setup problem the user can fix — distinct from tracking simply being lost, which leaves
     this empty. The HUD says so explicitly, because silently not counting reps is the worst
     possible failure mode for a live coach. */
  measurementBlockedBy: string[]

  /* correction cue (single, prioritized) */
  cue: CorrectionCue | null
  flaggedJoint: FlaggedJoint
  flaggedSide: FlaggedSide
  correctionSeverity: Severity

  /* timer */
  elapsedTime: number             // active seconds of the CURRENT set (resets each set)
  remainingTime: number           // backend-authoritative seconds remaining for timed work
  workoutTotalSeconds: number     // wall-clock time from the first set start to workout end
  timerMode: 'active' | 'paused' | 'completed'

  /* edge flags */
  disconnected: boolean
  socketError: WSError | null

  /* pause */
  isPaused: boolean
  pauseConfirmEnd: boolean

  /* Setup phase (view==='F2'), fully driven by validated `/ws/setup` V1 messages. */
  prep: 'precheck' | 'capture' | 'validating' | 'start'
  setup: WSSetup | null
  baselineReady: boolean

  /* Workout phase (view==='F3'), driven by /ws/train (raw latest frame). */
  train: WSTrain | null

  /* summary accumulation + derived */
  log: {
    reps: { q: RepTick; rom: number; pace: number | null }[]
    formScores: number[]
    corrections: Record<string, { count: number; message: string; label?: string }>
    setReps: { good: number; total: number }[]
    timedSets: {
      counted: number; full: number; shallow: number; invalid: number
      left: number; right: number; score: number | null
      asymmetry: import('./engine/timedContract').WSTimedAsymmetryMonitor
    }[]
  }
  /* Fault cues seen so far in the in-progress rep, banked into log.corrections when it closes. */
  pendingRepFaults: Record<string, string>
  workoutSummary: WorkoutSummary | null
}
