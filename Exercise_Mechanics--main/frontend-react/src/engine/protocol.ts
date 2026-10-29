/* Runtime validation for every inbound V1 WebSocket envelope.
   Reducers receive only values that have passed this boundary. */

import type {
  WSCondition,
  WSError,
  WSRepResult,
  WSRepTrain,
  WSScoreCoverage,
  WSServerMessage,
  WSSetup,
  WSTrain,
} from '../types'
import { parseTimedTrainContract } from './timedContract'

type JsonRecord = Record<string, unknown>

const SETUP_PHASES = new Set(['precheck', 'collecting', 'validating', 'ready'])
const TRAIN_PHASES = new Set(['setup', 'descent', 'bottom', 'ascent', 'top', 'reset'])
const CONDITION_STATUSES = new Set(['passed', 'failed', 'unavailable'])
const CLASSIFICATIONS = new Set(['full_rom', 'shallow', 'invalid'])
const SCORE_QUALITIES = new Set(['reliable', 'low_confidence', 'not_scored'])
const SKELETON_COLORS = new Set(['green', 'red'])

export function parseServerMessage(value: unknown): WSServerMessage | null {
  const envelope = record(value)
  if (!envelope || envelope.v !== 1 || typeof envelope.type !== 'string') return null

  if (envelope.type === 'setup.status' || envelope.type === 'setup.ready') {
    const data = setup(envelope.data)
    if (!data) return null
    const isReady = envelope.type === 'setup.ready'
    if (isReady !== (data.phase === 'ready' && data.start && data.baseline_ready)) return null
    return { v: 1, type: envelope.type, data }
  }
  if (envelope.type === 'train.status') {
    const data = train(envelope.data)
    return data ? { v: 1, type: envelope.type, data } : null
  }
  if (envelope.type === 'setup.error' || envelope.type === 'train.error') {
    const data = socketError(envelope.data)
    return data ? { v: 1, type: envelope.type, data } : null
  }
  return null
}

function setup(value: unknown): WSSetup | null {
  const data = record(value)
  if (!data || !oneOf(data.phase, SETUP_PHASES)) return null
  const missing = stringArray(data.missing)
  const conditions = conditionArray(data.conditions)
  const failures = conditionArray(data.failures)
  const validationResults = conditionArray(data.validation_results)
  const dwell = record(data.dwell)
  const capture = record(data.capture)
  if (!missing || !conditions || !failures || !validationResults || !dwell || !capture) return null
  if (!nonnegative(dwell.held_ms) || !nonnegative(dwell.required_ms)) return null
  if (
    !nonnegative(capture.valid_ms)
    || !positive(capture.required_ms)
    || !unit(capture.progress)
    || !integer(capture.frames_collected)
    || !integer(capture.min_valid_samples)
    || !integer(capture.observed_frames)
    || !unit(capture.valid_coverage)
    || !nonnegative(capture.invalid_ms)
    || typeof capture.paused !== 'boolean'
  ) return null
  if (
    typeof data.baseline_candidate_ready !== 'boolean'
    || typeof data.baseline_ready !== 'boolean'
    || typeof data.start !== 'boolean'
  ) return null
  const parsedQuality = data.quality === null ? null : quality(data.quality)
  const parsedCue = data.cue === null ? null : cue(data.cue)
  if ((data.quality !== null && !parsedQuality) || (data.cue !== null && !parsedCue)) return null

  return {
    phase: data.phase as WSSetup['phase'],
    missing,
    conditions,
    failures,
    dwell: { held_ms: dwell.held_ms as number, required_ms: dwell.required_ms as number },
    capture: {
      valid_ms: capture.valid_ms as number,
      required_ms: capture.required_ms as number,
      progress: capture.progress as number,
      frames_collected: capture.frames_collected as number,
      min_valid_samples: capture.min_valid_samples as number,
      observed_frames: capture.observed_frames as number,
      valid_coverage: capture.valid_coverage as number,
      invalid_ms: capture.invalid_ms as number,
      paused: capture.paused,
    },
    quality: parsedQuality,
    validation_results: validationResults,
    baseline_candidate_ready: data.baseline_candidate_ready,
    baseline_ready: data.baseline_ready,
    start: data.start,
    cue: parsedCue,
  }
}

function train(value: unknown): WSTrain | null {
  const timed = parseTimedTrainContract(value)
  if (timed) return timed
  const data = record(value)
  if (!data || !oneOf(data.phase, TRAIN_PHASES)) return null
  const tracking = record(data.tracking)
  const counters = record(data.counters)
  const rom = record(data.rom)
  const set = record(data.set)
  const events = record(data.events)
  if (!tracking || !counters || !rom || !set || !events) return null

  const unavailableRules = stringArray(tracking.unavailable_rule_ids)
  const activeRules = stringArray(data.active_rule_ids)
  const issues = issueArray(data.issues)
  // Optional: only exercises with a measurement-invalidating rule (push-up's side_view_orientation)
  // send it, so an absent key is a valid empty list rather than a malformed frame.
  const invalidatedBy = tracking.invalidated_by === undefined ? [] : stringArray(tracking.invalidated_by)
  if (
    typeof tracking.available !== 'boolean'
    || !unavailableRules
    || !activeRules
    || !unique(activeRules)
    || !issues
    || !invalidatedBy
    || !unique(invalidatedBy)
    // An invalidating rule has to be one of the rules actually running, and a frame that names one
    // cannot simultaneously claim its measurements are usable. Both are backend invariants; a
    // stream that breaks either would have the HUD count reps it should be refusing to count.
    || invalidatedBy.some((id) => !activeRules.includes(id))
    || (invalidatedBy.length > 0 && tracking.available)
  ) return null

  const attempts = count(counters.attempts)
  const qualified = count(counters.qualified)
  const fullRom = count(counters.full_rom)
  const shallow = count(counters.shallow)
  const invalid = count(counters.invalid)
  if (
    attempts === null || qualified === null || fullRom === null || shallow === null || invalid === null
    || attempts !== qualified + invalid
    || qualified !== fullRom + shallow
  ) return null

  // Unified "current frame reached the ROM gate" flag: curl emits full_rom, squat emits full_depth.
  const atFullRom = rom.full_rom ?? rom.full_depth ?? null
  // Optional exercise-specific detail (absent -> null): squat hip_below_knee, curl per-arm fields.
  const hipBelowKnee = rom.hip_below_knee ?? null
  const leftRatio = rom.left_ratio ?? null
  const rightRatio = rom.right_ratio ?? null
  const leftPercent = rom.left_percent ?? null
  const rightPercent = rom.right_percent ?? null
  const leftFull = rom.left_full ?? null
  const rightFull = rom.right_full ?? null
  const weakerSide = rom.weaker_side ?? null
  if (
    typeof rom.available !== 'boolean'
    || !nullableFinite(rom.ratio)
    || !nullableRange(rom.percent, 0, 100)
    || !positive(rom.full_rom_gate)
    || !nullableBoolean(atFullRom)
    || !nullableBoolean(hipBelowKnee)
    || !nonnegative(rom.current_peak)
    || !nullableFinite(leftRatio)
    || !nullableFinite(rightRatio)
    || !nullableRange(leftPercent, 0, 100)
    || !nullableRange(rightPercent, 0, 100)
    || !nullableBoolean(leftFull)
    || !nullableBoolean(rightFull)
    || !(weakerSide === null || weakerSide === 'left' || weakerSide === 'right')
  ) return null
  if (rom.available !== (rom.ratio !== null && rom.percent !== null)) return null

  const targetReps = positiveInteger(set.target_reps)
  const completedReps = count(set.completed_reps)
  const remainingReps = count(set.remaining_reps)
  const scoredReps = count(set.scored_reps)
  if (
    targetReps === null || completedReps === null || remainingReps === null || scoredReps === null
    || typeof set.complete !== 'boolean'
    || !nullableRange(set.average_score, 0, 100)
    || completedReps !== qualified
    || remainingReps !== Math.max(0, targetReps - completedReps)
    || set.complete !== (completedReps >= targetReps)
    || scoredReps > completedReps
  ) return null

  const lastAttempt = data.last_attempt === null ? null : repResult(data.last_attempt)
  const lastRep = data.last_rep === null ? null : repResult(data.last_rep)
  const coverage = data.score_coverage === null ? null : scoreCoverage(data.score_coverage)
  const parsedCue = data.cue === null ? null : cue(data.cue)
  if (
    (data.last_attempt !== null && !lastAttempt)
    || (data.last_rep !== null && !lastRep)
    || (data.score_coverage !== null && !coverage)
    || (data.cue !== null && !parsedCue)
  ) return null
  if (lastRep && (!lastRep.qualified || lastRep.rep === null)) return null
  if ((lastRep === null) !== (coverage === null)) return null
  if (lastRep && lastRep.rep !== completedReps) return null
  if (lastRep && coverage && !sameCoverage(lastRep.score_coverage, coverage)) return null
  if (
    typeof events.attempt_completed !== 'boolean'
    || typeof events.rep_completed !== 'boolean'
    || typeof events.attempt_discarded !== 'boolean'
    || typeof events.rep_cycle_completed !== 'boolean'
    || typeof events.set_cycle_completed !== 'boolean'
    || (events.set_cycle_completed && !events.rep_cycle_completed)
    || (events.set_cycle_completed && !set.complete)
  ) return null

  return {
    tracking: { available: tracking.available, unavailable_rule_ids: unavailableRules, invalidated_by: invalidatedBy },
    phase: data.phase as WSRepTrain['phase'],
    counters: { attempts, qualified, full_rom: fullRom, shallow, invalid },
    rom: {
      available: rom.available,
      ratio: rom.ratio as number | null,
      percent: rom.percent as number | null,
      full_rom_gate: rom.full_rom_gate as number,
      full_rom: atFullRom as boolean | null,
      current_peak: rom.current_peak as number,
      rule_id: typeof rom.rule_id === 'string' && rom.rule_id ? rom.rule_id : 'range_of_motion',
      coaching: typeof rom.coaching === 'string' ? rom.coaching : '',
      hip_below_knee: hipBelowKnee as boolean | null,
      left_ratio: leftRatio as number | null,
      right_ratio: rightRatio as number | null,
      left_percent: leftPercent as number | null,
      right_percent: rightPercent as number | null,
      left_full: leftFull as boolean | null,
      right_full: rightFull as boolean | null,
      weaker_side: weakerSide as 'left' | 'right' | null,
    },
    active_rule_ids: activeRules,
    issues,
    cue: parsedCue,
    last_attempt: lastAttempt,
    last_rep: lastRep,
    set: {
      target_reps: targetReps,
      completed_reps: completedReps,
      remaining_reps: remainingReps,
      complete: set.complete,
      scored_reps: scoredReps,
      average_score: set.average_score as number | null,
    },
    score_coverage: coverage,
    events: {
      attempt_completed: events.attempt_completed,
      rep_completed: events.rep_completed,
      attempt_discarded: events.attempt_discarded,
      rep_cycle_completed: events.rep_cycle_completed,
      set_cycle_completed: events.set_cycle_completed,
    },
  }
}

function conditionArray(value: unknown): WSCondition[] | null {
  if (!Array.isArray(value)) return null
  const output = value.map(condition)
  return output.every((item): item is WSCondition => item !== null) ? output : null
}

function condition(value: unknown): WSCondition | null {
  const item = record(value)
  if (
    !item
    || !nonempty(item.template_id)
    || !oneOf(item.status, CONDITION_STATUSES)
    || !nullableString(item.reason_id)
    || !nullableString(item.cue)
  ) return null
  const measurements = record(item.measurements)
  if (!measurements) return null
  return {
    template_id: item.template_id,
    status: item.status as WSCondition['status'],
    reason_id: item.reason_id as string | null,
    cue: item.cue as string | null,
    measurements,
  }
}

function scoreCoverage(value: unknown): WSScoreCoverage | null {
  const item = record(value)
  if (!item) return null
  const active = stringArray(item.active_rule_ids)
  const available = stringArray(item.available_rule_ids)
  const unavailable = stringArray(item.unavailable_rule_ids)
  if (
    !active || !available || !unavailable
    || !unique(active) || !unique(available) || !unique(unavailable)
    || !unit(item.ratio) || typeof item.reliable !== 'boolean'
    || available.some((id) => !active.includes(id))
    || unavailable.some((id) => !active.includes(id))
    || available.some((id) => unavailable.includes(id))
    || available.length + unavailable.length !== active.length
  ) return null
  return {
    active_rule_ids: active,
    available_rule_ids: available,
    unavailable_rule_ids: unavailable,
    ratio: item.ratio,
    reliable: item.reliable,
  }
}

function repResult(value: unknown): WSRepResult | null {
  const item = record(value)
  if (!item) return null
  const coverage = scoreCoverage(item.score_coverage)
  if (
    !positiveInteger(item.attempt)
    || !nullablePositiveInteger(item.rep)
    || typeof item.qualified !== 'boolean'
    || !oneOf(item.classification, CLASSIFICATIONS)
    || !nonnegative(item.peak)
    || !nullableRange(item.score, 0, 100)
    || !nullableRange(item.time_score, 0, 100)
    || !nullableFinite(item.rom_factor)
    || !oneOf(item.quality, SCORE_QUALITIES)
    || !positiveInteger(item.scoring_config_version)
    || !coverage
  ) return null
  return {
    attempt: item.attempt as number,
    rep: item.rep as number | null,
    qualified: item.qualified,
    classification: item.classification as WSRepResult['classification'],
    peak: item.peak as number,
    score: item.score as number | null,
    time_score: item.time_score as number | null,
    rom_factor: item.rom_factor as number | null,
    quality: item.quality as WSRepResult['quality'],
    scoring_config_version: item.scoring_config_version as number,
    score_coverage: coverage,
  }
}

function quality(value: unknown): WSSetup['quality'] {
  const item = record(value)
  const deviations = item && record(item.joint_stddev_px)
  if (
    !item || !deviations
    || !integer(item.valid_samples) || !integer(item.observed_frames)
    || !unit(item.valid_coverage) || !nonnegative(item.valid_duration_ms)
    || !nonnegative(item.max_joint_stddev_px)
  ) return null
  const parsed: Record<string, { x: number; y: number }> = {}
  for (const [name, rawPoint] of Object.entries(deviations)) {
    const point = record(rawPoint)
    if (!point || !nonnegative(point.x) || !nonnegative(point.y)) return null
    parsed[name] = { x: point.x, y: point.y }
  }
  return {
    valid_samples: item.valid_samples,
    observed_frames: item.observed_frames,
    valid_coverage: item.valid_coverage,
    valid_duration_ms: item.valid_duration_ms,
    max_joint_stddev_px: item.max_joint_stddev_px,
    joint_stddev_px: parsed,
  }
}

function issueArray(value: unknown): WSRepTrain['issues'] | null {
  if (!Array.isArray(value)) return null
  const output: WSRepTrain['issues'] = []
  for (const raw of value) {
    const item = record(raw)
    if (
      !item
      || !nonempty(item.id)
      || !nonempty(item.label)
      || !nonempty(item.tier)
      || !nullableString(item.side)
      || !nullableString(item.state)
      || !(item.skeleton_color === null || oneOf(item.skeleton_color, SKELETON_COLORS))
    ) return null
    output.push({
      id: item.id,
      label: item.label,
      tier: item.tier,
      side: item.side as string | null,
      state: item.state as string | null,
      skeleton_color: item.skeleton_color as 'green' | 'red' | null,
    })
  }
  return output
}

function cue(value: unknown): { rule_id: string; text: string; coaching: string } | null {
  const item = record(value)
  return item && nonempty(item.rule_id) && nonempty(item.text)
    ? { rule_id: item.rule_id, text: item.text, coaching: typeof item.coaching === 'string' ? item.coaching : '' }
    : null
}

function socketError(value: unknown): WSError | null {
  const item = record(value)
  return item && nonempty(item.code) && nonempty(item.detail)
    ? { code: item.code, detail: item.detail }
    : null
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonnegative(value: unknown): value is number {
  return finite(value) && value >= 0
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0
}

function integer(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function count(value: unknown): number | null {
  return integer(value) ? value : null
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : null
}

function nullablePositiveInteger(value: unknown): boolean {
  return value === null || positiveInteger(value) !== null
}

function nullableFinite(value: unknown): boolean {
  return value === null || finite(value)
}

function nullableBoolean(value: unknown): boolean {
  return value === null || typeof value === 'boolean'
}

function range(value: unknown, minimum: number, maximum: number): value is number {
  return finite(value) && value >= minimum && value <= maximum
}

function nullableRange(value: unknown, minimum: number, maximum: number): boolean {
  return value === null || range(value, minimum, maximum)
}

function unit(value: unknown): value is number {
  return range(value, 0, 1)
}

function oneOf(value: unknown, values: Set<string>): value is string {
  return typeof value === 'string' && values.has(value)
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length
}

function sameCoverage(first: WSScoreCoverage, second: WSScoreCoverage): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}
