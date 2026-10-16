/* Copied unchanged from Exercise_Mechanics--main/frontend-react/src/engine/timedContract.ts. Keep in sync. */
/* Runtime-validated timed-movement branch of the V1 WebSocket contract. */

export type TimedLiftClassification = 'invalid' | 'shallow' | 'full_rom'

export type WSTimedLiftCycle = {
  lift_id: number
  side: 'left' | 'right'
  classification: TimedLiftClassification
  peak_progress: number
  started_t_ms: number
  completed_t_ms: number
}

export type WSTimedLiftScore = {
  lift_id: number
  side: 'left' | 'right'
  classification: 'shallow' | 'full_rom'
  score: number | null
  rom_factor: number | null
  form_factor: number | null
  penalty: number | null
  quality: 'not_performed' | 'unavailable' | 'low_confidence' | 'reliable'
}

export type WSTimedAsymmetryMonitor = {
  status: 'insufficient' | 'balanced' | 'asymmetric'
  has_asymmetry: boolean | null
  left_samples: number
  right_samples: number
  left_median_travel: number | null
  right_median_travel: number | null
  travel_gap: number | null
  max_travel_gap: number
  lower_side: 'left' | 'right' | null
  feedback: string | null
}

export type WSTimedCoreContract = {
  set: {
    movement_type: 'time'
    target_duration_ms: number
    elapsed_ms: number
    remaining_ms: number
    complete: boolean
  }
  movement: {
    detected_cycles: number
    counted_lifts: number
    full_lifts: number
    shallow_lifts: number
    invalid_lifts: number
    left_lifts: number
    right_lifts: number
  }
  events: {
    lift_cycles: WSTimedLiftCycle[]
    set_completed: boolean
  }
}

export type WSTimedTrainContract = WSTimedCoreContract & {
  tracking: {
    available: boolean
    left_available: boolean
    right_available: boolean
    unavailable_rule_ids: string[]
  }
  phase: 'active' | 'complete'
  movement: WSTimedCoreContract['movement'] & {
    current_cadence_spm: number | null
    average_cadence_spm: number | null
    peak_cadence_spm: number | null
    alternation_breaks: number
    last_counted_side: 'left' | 'right' | null
    left_phase: string
    right_phase: string
    left_current_peak: number | null
    right_current_peak: number | null
  }
  rom: {
    rule_id: string
    full_rom_gate: number
    left_available: boolean
    right_available: boolean
    left_progress_raw: number | null
    right_progress_raw: number | null
    left_progress_display: number | null
    right_progress_display: number | null
    left_percent: number | null
    right_percent: number | null
    left_full_rom: boolean | null
    right_full_rom: boolean | null
    left_current_peak: number | null
    right_current_peak: number | null
    coaching: string
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
  cue: { rule_id: string; text: string; coaching: string } | null
  score: {
    score: number | null
    rom_factor: number | null
    form_factor: number | null
    penalty: number | null
    quality: 'not_performed' | 'unavailable' | 'low_confidence' | 'reliable'
  }
  last_lift_score: WSTimedLiftScore | null
  monitors: {
    left_right_asymmetry: WSTimedAsymmetryMonitor
  }
  score_coverage: {
    tracking_invalid_cycles: number
    penalty_rule_ids: string[]
    available_penalty_rule_ids: string[]
    unavailable_penalty_rule_ids: string[]
    reliable: boolean
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function positiveInteger(value: unknown): value is number {
  return nonnegativeInteger(value) && value > 0
}

function nonnegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function liftCycle(value: unknown): WSTimedLiftCycle | null {
  const item = record(value)
  if (!item) return null
  if (
    !positiveInteger(item.lift_id)
    || !(item.side === 'left' || item.side === 'right')
    || !(item.classification === 'invalid' || item.classification === 'shallow' || item.classification === 'full_rom')
    || !nonnegativeFinite(item.peak_progress)
    || !nonnegativeFinite(item.started_t_ms)
    || !nonnegativeFinite(item.completed_t_ms)
    || item.completed_t_ms < item.started_t_ms
  ) return null
  return {
    lift_id: item.lift_id,
    side: item.side,
    classification: item.classification,
    peak_progress: item.peak_progress,
    started_t_ms: item.started_t_ms,
    completed_t_ms: item.completed_t_ms,
  }
}

function liftScore(value: unknown): WSTimedLiftScore | null {
  const item = record(value)
  if (
    !item
    || !positiveInteger(item.lift_id)
    || !(item.side === 'left' || item.side === 'right')
    || !(item.classification === 'shallow' || item.classification === 'full_rom')
    || !nullableRange(item.score, 0, 100)
    || !nullableUnit(item.rom_factor)
    || !nullableUnit(item.form_factor)
    || !nullableUnit(item.penalty)
    || !(item.quality === 'not_performed' || item.quality === 'unavailable' || item.quality === 'low_confidence' || item.quality === 'reliable')
  ) return null
  return {
    lift_id: item.lift_id,
    side: item.side,
    classification: item.classification,
    score: item.score as number | null,
    rom_factor: item.rom_factor as number | null,
    form_factor: item.form_factor as number | null,
    penalty: item.penalty as number | null,
    quality: item.quality,
  }
}

function asymmetryMonitor(value: unknown): WSTimedAsymmetryMonitor | null {
  const item = record(value)
  if (
    !item
    || !(item.status === 'insufficient' || item.status === 'balanced' || item.status === 'asymmetric')
    || !(item.has_asymmetry === null || typeof item.has_asymmetry === 'boolean')
    || !nonnegativeInteger(item.left_samples)
    || !nonnegativeInteger(item.right_samples)
    || !nullableNonnegative(item.left_median_travel)
    || !nullableNonnegative(item.right_median_travel)
    || !nullableNonnegative(item.travel_gap)
    || !nonnegativeFinite(item.max_travel_gap) || item.max_travel_gap <= 0 || item.max_travel_gap > 1
    || !(item.lower_side === null || item.lower_side === 'left' || item.lower_side === 'right')
    || !(item.feedback === null || typeof item.feedback === 'string')
  ) return null
  if (
    (item.status === 'insufficient' && (item.has_asymmetry !== null || item.travel_gap !== null || item.feedback !== null))
    || (item.status === 'balanced' && (item.has_asymmetry !== false || item.travel_gap === null || item.lower_side !== null || !item.feedback))
    || (item.status === 'asymmetric' && (item.has_asymmetry !== true || item.travel_gap === null || item.lower_side === null || !item.feedback))
  ) return null
  return {
    status: item.status,
    has_asymmetry: item.has_asymmetry,
    left_samples: item.left_samples,
    right_samples: item.right_samples,
    left_median_travel: item.left_median_travel as number | null,
    right_median_travel: item.right_median_travel as number | null,
    travel_gap: item.travel_gap as number | null,
    max_travel_gap: item.max_travel_gap,
    lower_side: item.lower_side,
    feedback: item.feedback,
  }
}

export function parseTimedCoreContract(value: unknown): WSTimedCoreContract | null {
  const data = record(value)
  const set = record(data?.set)
  const movement = record(data?.movement)
  const events = record(data?.events)
  if (!set || !movement || !events) return null

  if (
    set.movement_type !== 'time'
    || !positiveInteger(set.target_duration_ms)
    || !nonnegativeFinite(set.elapsed_ms)
    || set.elapsed_ms > set.target_duration_ms
    || !nonnegativeFinite(set.remaining_ms)
    || Math.abs(set.remaining_ms - (set.target_duration_ms - set.elapsed_ms)) > 1e-6
    || typeof set.complete !== 'boolean'
    || set.complete !== (set.elapsed_ms === set.target_duration_ms)
  ) return null

  const detectedCycles = movement.detected_cycles
  const countedLifts = movement.counted_lifts
  const fullLifts = movement.full_lifts
  const shallowLifts = movement.shallow_lifts
  const invalidLifts = movement.invalid_lifts
  const leftLifts = movement.left_lifts
  const rightLifts = movement.right_lifts
  if (
    !nonnegativeInteger(detectedCycles)
    || !nonnegativeInteger(countedLifts)
    || !nonnegativeInteger(fullLifts)
    || !nonnegativeInteger(shallowLifts)
    || !nonnegativeInteger(invalidLifts)
    || !nonnegativeInteger(leftLifts)
    || !nonnegativeInteger(rightLifts)
    || detectedCycles !== countedLifts + invalidLifts
    || countedLifts !== fullLifts + shallowLifts
    || countedLifts !== leftLifts + rightLifts
  ) return null

  if (!Array.isArray(events.lift_cycles) || typeof events.set_completed !== 'boolean') return null
  const cycles = events.lift_cycles.map(liftCycle)
  if (cycles.some((cycle) => cycle === null)) return null
  const parsedCycles = cycles as WSTimedLiftCycle[]
  const ids = parsedCycles.map((cycle) => cycle.lift_id)
  if (new Set(ids).size !== ids.length || (events.set_completed && !set.complete)) return null

  return {
    set: {
      movement_type: 'time',
      target_duration_ms: set.target_duration_ms,
      elapsed_ms: set.elapsed_ms,
      remaining_ms: set.remaining_ms,
      complete: set.complete,
    },
    movement: {
      detected_cycles: detectedCycles,
      counted_lifts: countedLifts,
      full_lifts: fullLifts,
      shallow_lifts: shallowLifts,
      invalid_lifts: invalidLifts,
      left_lifts: leftLifts,
      right_lifts: rightLifts,
    },
    events: {
      lift_cycles: parsedCycles,
      set_completed: events.set_completed,
    },
  }
}

/* The Phase 1 core above stays reusable for future timed exercises. The live branch additionally
   requires the coaching fields High Knee renders; accepting a core-only status here would turn
   missing ROM/tracking data into a plausible-looking zero in the UI. */
export function parseTimedTrainContract(value: unknown): WSTimedTrainContract | null {
  const core = parseTimedCoreContract(value)
  const data = record(value)
  const tracking = record(data?.tracking)
  const movement = record(data?.movement)
  const rom = record(data?.rom)
  const score = record(data?.score)
  const lastLiftScore = data?.last_lift_score === null
    ? null
    : liftScore(data?.last_lift_score)
  const coverage = record(data?.score_coverage)
  const monitors = record(data?.monitors)
  const leftRightAsymmetry = asymmetryMonitor(monitors?.left_right_asymmetry)
  if (!core || !data || !tracking || !movement || !rom || !score || !coverage || !monitors || !leftRightAsymmetry) return null
  if (data.last_lift_score !== null && lastLiftScore === null) return null

  const unavailableRules = stringArray(tracking.unavailable_rule_ids)
  if (
    typeof tracking.available !== 'boolean'
    || typeof tracking.left_available !== 'boolean'
    || typeof tracking.right_available !== 'boolean'
    || tracking.available !== (tracking.left_available || tracking.right_available)
    || !unavailableRules
    || !(data.phase === 'active' || data.phase === 'complete')
    || (data.phase === 'complete') !== core.set.complete
  ) return null

  const cadenceFields = [
    movement.current_cadence_spm,
    movement.average_cadence_spm,
    movement.peak_cadence_spm,
  ]
  if (
    cadenceFields.some((item) => !nullableNonnegative(item))
    || !nonnegativeInteger(movement.alternation_breaks)
    || !(movement.last_counted_side === null || movement.last_counted_side === 'left' || movement.last_counted_side === 'right')
    || typeof movement.left_phase !== 'string' || !movement.left_phase
    || typeof movement.right_phase !== 'string' || !movement.right_phase
    || !nullableNonnegative(movement.left_current_peak)
    || !nullableNonnegative(movement.right_current_peak)
  ) return null

  const leftAvailable = rom.left_available
  const rightAvailable = rom.right_available
  if (
    typeof rom.rule_id !== 'string' || !rom.rule_id
    || !nonnegativeFinite(rom.full_rom_gate) || rom.full_rom_gate <= 0
    || typeof leftAvailable !== 'boolean' || typeof rightAvailable !== 'boolean'
    || leftAvailable !== tracking.left_available || rightAvailable !== tracking.right_available
    || !nullableFinite(rom.left_progress_raw) || !nullableFinite(rom.right_progress_raw)
    || !nullableUnit(rom.left_progress_display) || !nullableUnit(rom.right_progress_display)
    || !nullableRange(rom.left_percent, 0, 100) || !nullableRange(rom.right_percent, 0, 100)
    || !nullableBoolean(rom.left_full_rom) || !nullableBoolean(rom.right_full_rom)
    || !nullableNonnegative(rom.left_current_peak) || !nullableNonnegative(rom.right_current_peak)
    || typeof rom.coaching !== 'string'
  ) return null
  if (
    leftAvailable !== (rom.left_progress_raw !== null && rom.left_progress_display !== null && rom.left_percent !== null)
    || rightAvailable !== (rom.right_progress_raw !== null && rom.right_progress_display !== null && rom.right_percent !== null)
  ) return null

  const activeRuleIds = stringArray(data.active_rule_ids)
  const issues = issueArray(data.issues)
  const cue = data.cue === null ? null : cueValue(data.cue)
  const penaltyRules = stringArray(coverage.penalty_rule_ids)
  const availablePenaltyRules = stringArray(coverage.available_penalty_rule_ids)
  const unavailablePenaltyRules = stringArray(coverage.unavailable_penalty_rule_ids)
  if (
    !activeRuleIds || new Set(activeRuleIds).size !== activeRuleIds.length
    || !activeRuleIds.includes(rom.rule_id)
    || !issues || (data.cue !== null && cue === null)
    || !nullableRange(score.score, 0, 100)
    || !nullableUnit(score.rom_factor) || !nullableUnit(score.form_factor) || !nullableUnit(score.penalty)
    || !(score.quality === 'not_performed' || score.quality === 'unavailable' || score.quality === 'low_confidence' || score.quality === 'reliable')
    || !nonnegativeInteger(coverage.tracking_invalid_cycles)
    || !penaltyRules || !availablePenaltyRules || !unavailablePenaltyRules
    || typeof coverage.reliable !== 'boolean'
  ) return null

  return {
    ...core,
    tracking: {
      available: tracking.available,
      left_available: tracking.left_available,
      right_available: tracking.right_available,
      unavailable_rule_ids: unavailableRules,
    },
    phase: data.phase,
    movement: {
      ...core.movement,
      current_cadence_spm: movement.current_cadence_spm as number | null,
      average_cadence_spm: movement.average_cadence_spm as number | null,
      peak_cadence_spm: movement.peak_cadence_spm as number | null,
      alternation_breaks: movement.alternation_breaks,
      last_counted_side: movement.last_counted_side,
      left_phase: movement.left_phase,
      right_phase: movement.right_phase,
      left_current_peak: movement.left_current_peak as number | null,
      right_current_peak: movement.right_current_peak as number | null,
    },
    rom: {
      rule_id: rom.rule_id,
      full_rom_gate: rom.full_rom_gate,
      left_available: leftAvailable,
      right_available: rightAvailable,
      left_progress_raw: rom.left_progress_raw as number | null,
      right_progress_raw: rom.right_progress_raw as number | null,
      left_progress_display: rom.left_progress_display as number | null,
      right_progress_display: rom.right_progress_display as number | null,
      left_percent: rom.left_percent as number | null,
      right_percent: rom.right_percent as number | null,
      left_full_rom: rom.left_full_rom as boolean | null,
      right_full_rom: rom.right_full_rom as boolean | null,
      left_current_peak: rom.left_current_peak as number | null,
      right_current_peak: rom.right_current_peak as number | null,
      coaching: rom.coaching,
    },
    active_rule_ids: activeRuleIds,
    issues,
    cue,
    score: {
      score: score.score as number | null,
      rom_factor: score.rom_factor as number | null,
      form_factor: score.form_factor as number | null,
      penalty: score.penalty as number | null,
      quality: score.quality,
    },
    last_lift_score: lastLiftScore,
    monitors: {
      left_right_asymmetry: leftRightAsymmetry,
    },
    score_coverage: {
      tracking_invalid_cycles: coverage.tracking_invalid_cycles,
      penalty_rule_ids: penaltyRules,
      available_penalty_rule_ids: availablePenaltyRules,
      unavailable_penalty_rule_ids: unavailablePenaltyRules,
      reliable: coverage.reliable,
    },
  }
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

function nullableFinite(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function nullableNonnegative(value: unknown): value is number | null {
  return value === null || nonnegativeFinite(value)
}

function nullableUnit(value: unknown): value is number | null {
  return value === null || (nonnegativeFinite(value) && value <= 1)
}

function nullableRange(value: unknown, low: number, high: number): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high)
}

function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function cueValue(value: unknown): WSTimedTrainContract['cue'] {
  const item = record(value)
  if (!item || typeof item.rule_id !== 'string' || !item.rule_id || typeof item.text !== 'string' || typeof item.coaching !== 'string') return null
  return { rule_id: item.rule_id, text: item.text, coaching: item.coaching }
}

function issueArray(value: unknown): WSTimedTrainContract['issues'] | null {
  if (!Array.isArray(value)) return null
  const output: WSTimedTrainContract['issues'] = []
  for (const valueItem of value) {
    const item = record(valueItem)
    if (
      !item || typeof item.id !== 'string' || !item.id
      || typeof item.label !== 'string' || typeof item.tier !== 'string'
      || !(item.side === null || typeof item.side === 'string')
      || !(item.state === null || typeof item.state === 'string')
      || !(item.skeleton_color === null || item.skeleton_color === 'green' || item.skeleton_color === 'red')
    ) return null
    output.push({
      id: item.id,
      label: item.label,
      tier: item.tier,
      side: item.side,
      state: item.state,
      skeleton_color: item.skeleton_color,
    })
  }
  return output
}
