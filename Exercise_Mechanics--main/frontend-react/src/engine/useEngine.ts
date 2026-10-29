/* useEngine.ts — reducer + validated V1 WebSocket client.

   Two channels, exactly one active at a time based on the view:
     F2 (setup)   → /ws/setup   combined gate → capture → START
     F3 (workout) → /ws/train   authoritative taxonomy, score and coverage

   Per set: F2 → F3 → rest → next set (F2) → … → F5 summary. The setup flow is fully
   SERVER-driven (the orchestrator streams the phase); the frontend just renders it and sends
   frames. `EngineState` (what the HUD reads) is unchanged — only how it's populated changed. */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type {
  EngineState, WSSetup, WSTrain, WSTimedTrain, RepTick, WorkoutSummary, WorkoutConfig, Landmark, CorrectionCue, FlaggedJoint, FlaggedSide, Severity,
} from '../types'
import { formBand } from '../tokens'
import { liveTrackingConfidence } from './adapter'
import { parseServerMessage } from './protocol'
import { SQUAT, EXERCISES, WEEKLY_WORKOUT_COUNT, DEFAULT_JOINT_ANGLE } from './dummy'
import {
  CONF_FLOOR,
  MAX_REP_COUNT,
  MAX_REP_INCREMENT,
  START_SPLASH_MS,
  WS_BACKPRESSURE_CAP,
  WS_RECONNECT_MS,
  WS_WARN_THROTTLE_MS,
} from '../config'

export function initialState(): EngineState {
  return {
    view: 'F2',
    autoAdvanceEnabled: true,
    currentExercise: SQUAT,
    currentSet: 1,
    targetSets: SQUAT.targetSets,
    targetMeasure: 'reps',
    targetReps: SQUAT.targetReps,
    targetDurationSeconds: 0,
    restSeconds: 60,
    setOutcome: null,
    restRemaining: null,
    setupNotice: null,

    cameraPermissionStatus: 'required',

    trackingStatus: 'searching',
    visibleBodyStatus: 'none',
    trackingConfidence: 0,
    jointConfidence: 0,
    scoreConfidence: 0,
    poseVisible: false,
    poseLandmarks: null,

    phase: 'setup',
    attemptCount: 0,
    currentRep: 0,
    fullRomCount: 0,
    shallowCount: 0,
    invalidCount: 0,
    repTicks: Array(SQUAT.targetReps).fill(null),
    poseDepth: 0,
    romPercentage: 0,
    romPeak: 0,
    measurementBlockedBy: [],
    romArms: null,
    romLegs: null,
    currentJointAngle: DEFAULT_JOINT_ANGLE,
    formScore: null,
    scoreCoverage: null,
    symmetryScore: 96,
    paceSecPerRep: null,
    repDuration: null,
    tempo: null,
    tempoHistory: [],
    pace: null,
    currentCadenceSpm: null,
    averageCadenceSpm: null,
    metricAvailability: { pace: false, repDuration: false, symmetry: false },
    tooFast: false,
    lowRom: false,

    cue: null,
    flaggedJoint: null,
    flaggedSide: null,
    correctionSeverity: null,

    elapsedTime: 0,
    remainingTime: 0,
    workoutTotalSeconds: 0,
    timerMode: 'active',

    disconnected: false,
    socketError: null,
    isPaused: false,
    pauseConfirmEnd: false,

    prep: 'precheck',
    setup: null,
    baselineReady: false,
    train: null,

    log: { reps: [], formScores: [], corrections: {}, setReps: [], timedSets: [] },
    pendingRepFaults: {},
    workoutSummary: null,
  }
}

type Action =
  | { type: 'RESET' }
  | { type: 'SET_PERMISSION'; value: EngineState['cameraPermissionStatus'] }
  | { type: 'WS_OPEN' }
  | { type: 'WS_CLOSE' }
  | { type: 'WS_ERROR'; code: string; detail: string }
  | { type: 'WS_SETUP'; data: WSSetup }
  | { type: 'WS_TRAIN'; data: WSTrain }
  | { type: 'START_COMPLETE' }
  | { type: 'LANDMARKS'; landmarks: Landmark[] }
  | { type: 'PAUSE'; value: boolean }
  | { type: 'ASK_END' }
  | { type: 'CANCEL_END' }
  | { type: 'END'; elapsedTime?: number; totalTime?: number }
  | { type: 'SET_WORKOUT_CONFIG'; config: WorkoutConfig }
  | { type: 'NEXT_SET' }
  | { type: 'REST_TICK' }
  | { type: 'EXTEND_REST'; seconds: number }

function buildSummary(s: EngineState, ended: boolean): WorkoutSummary {
  if (s.targetMeasure === 'time') {
    const sets = s.log.timedSets
    const scores = sets.map((set) => set.score).filter((score): score is number => score !== null)
    const total = (field: 'counted' | 'full' | 'shallow' | 'invalid' | 'left' | 'right') => (
      sets.reduce((sum, set) => sum + set[field], 0)
    )
    return {
      measure: 'time',
      ended,
      completedReps: total('counted'),
      averageFormScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null,
      averagePace: '—',
      romConsistency: 0,
      bestSet: sets.length ? Math.max(...sets.map((set) => set.full)) : 0,
      mainCorrectionTheme: total('shallow') ? 'Lift each knee higher' : 'Great form overall',
      weeklyWorkoutCount: WEEKLY_WORKOUT_COUNT,
      qualityCounts: { good: 0, amber: 0, poor: 0, unscored: 0 },
      countedLifts: total('counted'),
      fullLifts: total('full'),
      shallowLifts: total('shallow'),
      invalidLifts: total('invalid'),
      leftLifts: total('left'),
      rightLifts: total('right'),
      completedSets: sets.length,
      hasData: sets.length > 0,
    }
  }
  const reps = s.log.reps
  const total = reps.length
  const avgForm = s.log.formScores.length
    ? Math.round(s.log.formScores.reduce((x, y) => x + y, 0) / s.log.formScores.length) : null
  const roms = reps.map((r) => r.rom).filter(Boolean)
  const romMean = roms.length ? roms.reduce((x, y) => x + y, 0) / roms.length : 0
  const romVar = roms.length ? Math.sqrt(roms.reduce((x, y) => x + (y - romMean) ** 2, 0) / roms.length) : 0
  const romConsistency = roms.length ? Math.max(0, Math.round(100 - romVar)) : 0
  const bestSet = s.log.setReps.length ? Math.max(...s.log.setReps.map((x) => x.good)) : 0
  const corr = s.log.corrections
  const mainTheme = Object.keys(corr).length
    ? Object.entries(corr).sort((a, b) => b[1].count - a[1].count)[0][0] : 'Great form overall'
  return {
    measure: 'reps',
    ended,
    completedReps: total,
    averageFormScore: avgForm,
    averagePace: '—',
    romConsistency,
    bestSet,
    mainCorrectionTheme: mainTheme,
    weeklyWorkoutCount: WEEKLY_WORKOUT_COUNT,
    qualityCounts: {
      good: reps.filter((r) => r.q === 'good').length,
      amber: reps.filter((r) => r.q === 'amber').length,
      poor: reps.filter((r) => r.q === 'poor').length,
      unscored: reps.filter((r) => r.q === null).length,
    },
    countedLifts: 0,
    fullLifts: 0,
    shallowLifts: 0,
    invalidLifts: 0,
    leftLifts: 0,
    rightLifts: 0,
    completedSets: s.log.setReps.length,
    hasData: total > 0,
  }
}

/** Duration shown by the completed-workout recap.
 *
 * Timed sets are closed only when the backend reaches their configured duration, so their
 * completed count and configured target are authoritative. The browser wall clock starts at a
 * different UI lifecycle boundary and can include render/socket delay or the time spent on the
 * set-complete overlay; it is therefore only a fallback for repetition workouts.
 */
export function completedWorkoutDurationSeconds(
  state: EngineState,
  browserWallClockSeconds: number,
): number {
  return state.targetMeasure === 'time'
    ? state.log.timedSets.length * state.targetDurationSeconds
    : browserWallClockSeconds
}

function reducer(state: EngineState, action: Action): EngineState {
  switch (action.type) {
    case 'RESET':
      return initialState()

    case 'SET_PERMISSION':
      return { ...state, cameraPermissionStatus: action.value }

    case 'WS_OPEN':
      return state.view === 'F2'
        ? { ...state, disconnected: false, socketError: null, setup: null, prep: 'precheck', baselineReady: false }
        : { ...state, disconnected: false, socketError: null }

    case 'WS_CLOSE':
      return { ...state, disconnected: true }

    case 'WS_ERROR':
      return { ...state, socketError: { code: action.code, detail: action.detail } }

    case 'LANDMARKS': {
      const next: Partial<EngineState> = { poseLandmarks: action.landmarks.length ? action.landmarks : null }
      if (state.view === 'F3' && !state.isPaused) {
        next.trackingConfidence = liveTrackingConfidence(action.landmarks, state.currentExercise.motion)
      }
      return { ...state, ...next }
    }

    case 'SET_WORKOUT_CONFIG': {
      const { sets, reps, restSeconds, exerciseName, exerciseId, measure, durationSeconds } = action.config
      const base = EXERCISES[exerciseId] ?? state.currentExercise
      return {
        ...state,
        targetSets: sets,
        targetMeasure: measure,
        targetReps: reps,
        targetDurationSeconds: durationSeconds,
        remainingTime: measure === 'time' ? durationSeconds : 0,
        restSeconds,
        currentExercise: { ...base, id: exerciseId || base.id, name: exerciseName || base.name, targetSets: sets, targetReps: reps },
        repTicks: Array(reps).fill(null),
      }
    }

    case 'WS_SETUP':
      return foldSetup(state, action.data)

    case 'WS_TRAIN':
      return foldTrain(state, action.data)

    case 'START_COMPLETE':
      if (state.view !== 'F2' || !state.baselineReady || !state.setup?.start) return state
      return {
        ...state,
        view: 'F3',
        trackingStatus: 'active',
        timerMode: 'active',
        elapsedTime: 0,
        setOutcome: null,
        setupNotice: null,
        prep: 'precheck',
        correctionSeverity: null,
        flaggedJoint: null,
        flaggedSide: null,
        cue: null,
        attemptCount: 0,
        currentRep: 0,
        fullRomCount: 0,
        shallowCount: 0,
        invalidCount: 0,
        romPeak: 0,
        romArms: null,
        romLegs: null,
        measurementBlockedBy: [],
        formScore: null,
        scoreCoverage: null,
        scoreConfidence: 0,
        repTicks: Array(state.targetReps).fill(null),
        train: null,
        remainingTime: state.targetMeasure === 'time' ? state.targetDurationSeconds : 0,
        currentCadenceSpm: null,
        averageCadenceSpm: null,
      }

    case 'NEXT_SET':
      // Rest finished → start the next set: back to F2 (setup) for the new set. The setup WS
      // reconnects with the new set_no (see the hook). The cumulative log is preserved.
      if (state.setOutcome !== 'rest') return state
      return {
        ...state, view: 'F2', currentSet: state.currentSet + 1, setOutcome: null, restRemaining: null,
        prep: 'precheck', setup: null, baselineReady: false, train: null,
        correctionSeverity: null, flaggedJoint: null, flaggedSide: null, cue: null, trackingStatus: 'searching',
        attemptCount: 0, currentRep: 0, fullRomCount: 0, shallowCount: 0, invalidCount: 0,
        romPeak: 0, formScore: null, scoreCoverage: null, scoreConfidence: 0,
        romLegs: null, measurementBlockedBy: [], remainingTime: state.targetMeasure === 'time' ? state.targetDurationSeconds : 0,
        currentCadenceSpm: null, averageCadenceSpm: null,
        repTicks: Array(state.targetReps).fill(null), pendingRepFaults: {}, socketError: null, disconnected: false,
      }

    case 'REST_TICK':
      return state.restRemaining == null ? state : { ...state, restRemaining: Math.max(0, state.restRemaining - 1) }
    case 'EXTEND_REST':
      return state.restRemaining == null ? state : { ...state, restRemaining: state.restRemaining + action.seconds }

    case 'PAUSE':
      return { ...state, isPaused: action.value, timerMode: action.value ? 'paused' : 'active', pauseConfirmEnd: false }
    case 'ASK_END':
      return { ...state, pauseConfirmEnd: true }
    case 'CANCEL_END':
      return { ...state, pauseConfirmEnd: false }
    case 'END':
      return {
        ...state, view: 'F5', isPaused: false, pauseConfirmEnd: false, timerMode: 'completed',
        elapsedTime: action.elapsedTime ?? state.elapsedTime,
        workoutTotalSeconds: completedWorkoutDurationSeconds(
          state,
          action.totalTime ?? state.workoutTotalSeconds,
        ),
        cue: null, flaggedJoint: null, flaggedSide: null, correctionSeverity: null, workoutSummary: buildSummary(state, true),
      }

    default:
      return state
  }
}

/* Fold only runtime-validated setup data. START remains visible for a deterministic beat before
   START_COMPLETE opens the training socket. */
export function foldSetup(state: EngineState, d: WSSetup): EngineState {
  if (state.view !== 'F2') return state

  const prep: EngineState['prep'] =
    d.phase === 'ready' ? 'start'
      : d.phase === 'validating' ? 'validating'
        : d.phase === 'collecting' ? 'capture'
          : 'precheck'
  const failure = d.failures[0] ?? null
  const stanceCondition = d.conditions.find((condition) => condition.template_id === 'stance_width')
  const stanceColor = stanceCondition?.measurements.skeleton_color
  const correctionSeverity = failure || d.missing.length
    ? severityFromSkeletonColor(stanceColor) ?? 'error'
    : d.phase === 'precheck'
      ? severityFromSkeletonColor(stanceColor) ?? 'success'
      : null
  return {
    ...state,
    setup: d,
    prep,
    baselineReady: d.baseline_ready,
    correctionSeverity,
    flaggedJoint: failureJoint(failure?.template_id, d.missing),
    flaggedSide: null,
    socketError: null,
  }
}

/* Fold backend-authoritative counters and reliable per-rep scores. */
export function foldTrain(state: EngineState, d: WSTrain): EngineState {
  if (state.view !== 'F3' || state.isPaused || state.setOutcome) return state

  if (isTimedTrain(d)) {
    if (
      state.targetMeasure !== 'time'
      || d.set.target_duration_ms !== state.targetDurationSeconds * 1000
      || d.movement.detected_cycles < state.attemptCount
      || d.movement.counted_lifts < state.currentRep
      || d.movement.full_lifts < state.fullRomCount
      || d.movement.shallow_lifts < state.shallowCount
      || d.movement.invalid_lifts < state.invalidCount
    ) {
      return {
        ...state,
        socketError: {
          code: 'INVALID_TIMED_STREAM',
          detail: 'Timed movement counters or duration were inconsistent with the current set.',
        },
      }
    }

    const setOutcome = d.events.set_completed && state.setOutcome == null
      ? (state.currentSet < state.targetSets ? 'rest' : 'complete')
      : state.setOutcome
    const clampPct = (value: number | null) => Math.max(0, Math.min(100, value ?? 0))
    const romLegs: EngineState['romLegs'] = {
      left: clampPct(d.rom.left_percent),
      right: clampPct(d.rom.right_percent),
      leftAvailable: d.rom.left_available,
      rightAvailable: d.rom.right_available,
    }
    const availableValues = [
      d.rom.left_available ? d.rom.left_percent : null,
      d.rom.right_available ? d.rom.right_percent : null,
    ].filter((value): value is number => value !== null)
    const liveRom = availableValues.length ? Math.max(...availableValues) : state.romPercentage
    const timedCueIssue = d.cue
      ? d.issues.find((issue) => issue.id === d.cue?.rule_id)
      : undefined
    const cue: CorrectionCue | null = !d.tracking.available
      ? { text: 'Hold still for tracking', severity: 'neutral', joint: null, side: null }
      : d.cue
        ? {
          text: d.cue.text,
          // High Knee movement issues are published only after backend confirmation and are
          // always rendered as red faults. Coaching-only cues (for example shallow ROM) do not
          // color the skeleton, so there is no amber fallback or guessed body side.
          severity: timedCueIssue ? 'error' : 'neutral',
          joint: timedCueIssue ? cueJoint(d.cue.rule_id) : null,
          side: timedCueIssue ? flaggedSideOf(timedCueIssue.side) : null,
        }
        : null
    const asymmetry = d.monitors.left_right_asymmetry
    const completedSetupNotice = d.events.set_completed
      && asymmetry.status !== 'insufficient'
      && asymmetry.feedback
      ? { text: asymmetry.feedback, status: asymmetry.status }
      : null

    let log = state.log
    // Bank confirmed movement faults (knee tracking, lateral lean) across the timed set so the
    // recap can list them as focus areas, the same way rep exercises accumulate per-rep faults.
    // Shallow ROM is intentionally excluded here — it is already surfaced by the full/shallow lift
    // counts. Count frames-active as a persistence proxy for ranking; the hint text comes from the
    // fault's coaching, captured whenever it is the active (cued) fault.
    if (d.issues.length) {
      const corrections = { ...log.corrections }
      for (const issue of d.issues) {
        const previous = corrections[issue.id]
        const cuedCoaching = d.cue?.rule_id === issue.id ? d.cue?.coaching : ''
        corrections[issue.id] = {
          count: (previous?.count ?? 0) + 1,
          message: cuedCoaching || previous?.message || '',
          label: issue.label,
        }
      }
      log = { ...log, corrections }
    }
    if (d.events.set_completed) {
      log = {
        ...log,
        timedSets: [...log.timedSets, {
          counted: d.movement.counted_lifts,
          full: d.movement.full_lifts,
          shallow: d.movement.shallow_lifts,
          invalid: d.movement.invalid_lifts,
          left: d.movement.left_lifts,
          right: d.movement.right_lifts,
          score: d.score.score,
          asymmetry,
        }],
      }
    }
    return {
      ...state,
      train: d,
      phase: d.set.complete ? 'complete' : 'active',
      attemptCount: d.movement.detected_cycles,
      currentRep: d.movement.counted_lifts,
      fullRomCount: d.movement.full_lifts,
      shallowCount: d.movement.shallow_lifts,
      invalidCount: d.movement.invalid_lifts,
      elapsedTime: Math.floor(d.set.elapsed_ms / 1000),
      remainingTime: Math.ceil(d.set.remaining_ms / 1000),
      trackingStatus: d.tracking.available ? 'active' : 'low',
      romPercentage: liveRom,
      poseDepth: liveRom / 100,
      romPeak: Math.max(
        state.romPeak,
        (d.rom.left_current_peak ?? 0) * 100,
        (d.rom.right_current_peak ?? 0) * 100,
      ),
      romArms: null,
      romLegs,
      currentCadenceSpm: d.movement.current_cadence_spm,
      averageCadenceSpm: d.movement.average_cadence_spm,
      // Timed-set `score` remains cumulative for persistence and reports. The HUD mirrors the
      // repetition exercises and shows only the latest completed lift score.
      formScore: d.last_lift_score ? d.last_lift_score.score : state.formScore,
      scoreCoverage: null,
      scoreConfidence: d.last_lift_score?.quality === 'reliable' ? 1 : 0,
      lowRom: d.events.lift_cycles.some((event) => event.classification === 'shallow'),
      cue,
      flaggedJoint: cue?.joint ?? null,
      flaggedSide: cue?.side ?? null,
      correctionSeverity: cue?.severity ?? null,
      setOutcome,
      restRemaining: setOutcome === 'rest' ? state.restSeconds : null,
      setupNotice: d.events.set_completed ? completedSetupNotice : state.setupNotice,
      log,
      socketError: null,
    }
  }

  const rep = d.set.completed_reps
  const countersRegressed =
    rep < state.currentRep
    || d.counters.attempts < state.attemptCount
    || d.counters.full_rom < state.fullRomCount
    || d.counters.shallow < state.shallowCount
    || d.counters.invalid < state.invalidCount
  if (
    d.set.target_reps !== state.targetReps
    || rep > MAX_REP_COUNT
    || rep - state.currentRep > MAX_REP_INCREMENT
    || countersRegressed
  ) {
    return {
      ...state,
      socketError: {
        code: 'INVALID_COUNTER_STREAM',
        detail: 'Training counters were inconsistent with the current set.',
      },
    }
  }

  if (!d.tracking.available) {
    // Measurements are held either way (never zero, never jump), but WHY they are held decides what
    // the user is told. `invalidated_by` non-empty means the body is perfectly visible and a rule
    // has declared the reading meaningless — a push-up filmed front-on. That user is not going to
    // be helped by "hold still": they need to be told to turn, and told that reps have stopped
    // counting until they do. The backend already wrote that cue, so it is used verbatim rather
    // than replaced with the generic one.
    const blocked = d.tracking.invalidated_by.length > 0
    const backendCue: CorrectionCue | null = blocked && d.cue
      ? { text: d.cue.text, severity: 'error', joint: cueJoint(d.cue.rule_id), side: null }
      : null
    const heldCue = state.cue && state.cue.severity === 'neutral' ? state.cue : null
    return {
      ...state, train: d, trackingStatus: 'low', socketError: null,
      measurementBlockedBy: d.tracking.invalidated_by,
      cue: backendCue
        ?? (blocked ? null : heldCue ?? { text: 'Hold still for tracking', severity: 'neutral', joint: null, side: null }),
      correctionSeverity: blocked ? 'error' : 'neutral',
      flaggedJoint: backendCue?.joint ?? null,
      flaggedSide: null,
    }
  }

  const romPercentage = Math.max(0, Math.min(100, d.rom.percent ?? state.romPercentage))
  const romPeak = Math.max(state.romPeak, romPercentage)
  // Per-arm ROM is present only for double-arm exercises (curl); null passes through for squat.
  const clampPct = (value: number) => Math.max(0, Math.min(100, value))
  const romArms: EngineState['romArms'] =
    typeof d.rom.left_percent === 'number'
      && typeof d.rom.right_percent === 'number'
      && (d.rom.weaker_side === 'left' || d.rom.weaker_side === 'right')
      ? { left: clampPct(d.rom.left_percent), right: clampPct(d.rom.right_percent), weaker: d.rom.weaker_side }
      : null
  const cueIssue = d.cue ? d.issues.find((issue) => issue.id === d.cue?.rule_id) : undefined
  const cue: CorrectionCue | null = d.cue
    ? {
      text: d.cue.text,
      severity: 'warning',
      joint: cueJoint(d.cue.rule_id),
      side: flaggedSideOf(cueIssue?.side),
    }
    : null
  const correctionSeverity = cue
    ? severityFromSkeletonColor(cueIssue?.skeleton_color) ?? 'warning'
    : null

  // Faults are attributed to the rep they occur in: accumulate the active fault cue across the
  // rep's frames, then bank them when the rep closes. Sampling only the completion frame would
  // miss mid-rep faults like knee valgus, which clear before the rep finishes.
  let pendingRepFaults = state.pendingRepFaults
  if (d.cue && d.cue.rule_id !== d.rom.rule_id) {
    pendingRepFaults = { ...pendingRepFaults, [d.cue.rule_id]: d.cue.coaching || d.cue.text }
  }

  // A tick exists only when the newly qualified rep carries reliable backend coverage.
  let repTicks = state.repTicks
  let log = state.log
  let formScore = state.formScore
  const newReps = Math.max(0, rep - state.currentRep)
  if (newReps > 0) {
    const completed = d.last_rep
    if (!completed || completed.rep !== rep || completed.score === null) {
      return {
        ...state,
        socketError: {
          code: 'INVALID_REP_STREAM',
          detail: 'A qualified rep arrived without its backend score record.',
        },
      }
    }
    formScore = completed.score
    const q: RepTick = completed.score_coverage.reliable ? formBand(completed.score) : null
    repTicks = repTicks.slice()
    log = { ...log, reps: [...log.reps], formScores: [...log.formScores], corrections: { ...log.corrections } }
    const idx = rep - 1
    if (idx >= 0 && idx < repTicks.length) repTicks[idx] = q
    else if (idx >= 0) repTicks.push(q)
    log.reps.push({ q, rom: Math.max(0, Math.min(100, completed.peak * 100)), pace: null })
    if (q) log.formScores.push(completed.score)
    // Corrections carry the backend's own coaching copy so the summary stays exercise-agnostic —
    // no fault text or rule identity is authored in the frontend. Shallow reps are attributed to
    // the ROM rule the backend names (d.rom.rule_id); other faults use their live cue's rule.
    if (completed.classification === 'shallow') {
      const romId = d.rom.rule_id
      const prev = log.corrections[romId]
      log.corrections[romId] = { count: (prev?.count ?? 0) + 1, message: d.rom.coaching || prev?.message || '' }
    }
    // Bank every fault seen during this rep (once each), then reset for the next rep.
    for (const [ruleId, message] of Object.entries(pendingRepFaults)) {
      const prev = log.corrections[ruleId]
      log.corrections[ruleId] = { count: (prev?.count ?? 0) + 1, message }
    }
    pendingRepFaults = {}
  }

  // The final score arrives at attempt completion; rest waits for the reset-cycle completion event.
  let setOutcome: EngineState['setOutcome'] = state.setOutcome
  let restRemaining = state.restRemaining
  if (d.events.set_cycle_completed && state.setOutcome == null) {
    setOutcome = state.currentSet < state.targetSets ? 'rest' : 'complete'
    restRemaining = setOutcome === 'rest' ? state.restSeconds : null
    const good = repTicks.filter((t) => t === 'good').length
    log = { ...log, setReps: [...log.setReps, { good, total: state.targetReps }] }
  }

  return {
    ...state, train: d, trackingStatus: 'active', phase: d.phase, measurementBlockedBy: [],
    attemptCount: d.counters.attempts, currentRep: rep, fullRomCount: d.counters.full_rom,
    shallowCount: d.counters.shallow, invalidCount: d.counters.invalid,
    poseDepth: Math.max(0, Math.min(1, d.rom.ratio ?? state.poseDepth)),
    romPercentage, romPeak, romArms,
    lowRom: d.events.rep_completed && d.last_rep?.classification === 'shallow',
    formScore, scoreCoverage: d.score_coverage,
    scoreConfidence: d.score_coverage?.ratio ?? 0,
    cue, flaggedJoint: cue?.joint ?? null, flaggedSide: cue?.side ?? null, correctionSeverity,
    setOutcome, restRemaining, repTicks, log, pendingRepFaults, socketError: null,
  }
}

function isTimedTrain(value: WSTrain): value is WSTimedTrain {
  return 'movement_type' in value.set
}

/* Which skeleton group a rule's cue highlights. Keyed by BACKEND rule id, so every new backend rule
   needs an entry here or its cue renders with no recoloured joints — the fault is announced but not
   located. Unmapped rules fall through to null deliberately: a wrong highlight is worse than none. */
/* The backend attributes one-sided faults to 'left' | 'right' | 'both'. Anything else — including a
   rule that reports no side — is treated as null, and the skeleton falls back to its side-agnostic
   highlight rather than guessing a side. */
function flaggedSideOf(side: string | null | undefined): FlaggedSide {
  return side === 'left' || side === 'right' || side === 'both' ? side : null
}

function cueJoint(ruleId: string): FlaggedJoint {
  if (ruleId === 'stance_width') return 'ankles'
  if (ruleId === 'knee_valgus') return 'knees'
  if (ruleId === 'knee_tracking_corridor') return 'legs'
  if (ruleId === 'depth') return 'hips'
  if (ruleId === 'lateral_torso_lean') return 'trunk'
  if (ruleId === 'elbow_flare_corridor') return 'elbows'
  if (ruleId === 'shoulder_elevation') return 'shoulders'
  if (ruleId === 'curl_rom') return 'wrists'
  if (ruleId === 'knee_drive_rom') return 'knees'
  // Push-up. `side_view_orientation` is deliberately absent: a camera at the wrong angle is not a
  // fault located anywhere on the body, and reddening a limb for it would blame the user's form
  // for the operator's mistake.
  if (ruleId === 'pushup_depth') return 'elbows'
  if (ruleId === 'body_line' || ruleId === 'plank_ready') return 'trunk'
  return null
}

function severityFromSkeletonColor(color: unknown): Severity {
  if (color === 'red') return 'error'
  if (color === 'green') return 'success'
  return null
}

function failureJoint(templateId: string | undefined, missing: string[]): FlaggedJoint {
  if (missing.some((name) => name.includes('ankle'))) return 'ankles'
  if (missing.some((name) => name.includes('knee'))) return 'knees'
  if (missing.some((name) => name.includes('hip'))) return 'hips'
  if (missing.some((name) => name.includes('elbow'))) return 'elbows'
  if (missing.some((name) => name.includes('shoulder'))) return 'shoulders'
  if (templateId === 'standing_posture') return 'knees'
  if (templateId === 'setup_readiness') return 'shins'
  return cueJoint(templateId ?? '')
}

/* ---- The hook: reducer + a single WebSocket that targets /ws/setup (F2) or /ws/train (F3) ---- */
export function useEngine(userId?: string, sessionId?: string, exerciseId?: string, variant?: string) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const warningAtRef = useRef(0)

  // The active endpoint is a pure function of the view; reconnect when it or the set changes.
  const endpoint = state.view === 'F2' ? 'setup' : state.view === 'F3' ? 'train' : null
  const setNo = state.currentSet

  useEffect(() => {
    if (!endpoint) {
      wsRef.current?.close()
      wsRef.current = null
      return
    }
    if (!userId || !sessionId || !exerciseId) {
      dispatch({ type: 'WS_ERROR', code: 'SESSION_REQUIRED', detail: 'A persisted workout session is required.' })
      return
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const params = new URLSearchParams({ exercise: exerciseId, set_no: String(setNo) })
    params.set('user_id', userId)
    params.set('session_id', sessionId)
    if (variant) params.set('variant', variant)
    const ws = new WebSocket(`${proto}://${location.host}/ws/${endpoint}?${params.toString()}`)
    wsRef.current = ws
    let intentionalClose = false
    let reconnectTimer: number | undefined

    ws.onopen = () => { if (ws === wsRef.current) dispatch({ type: 'WS_OPEN' }) }
    ws.onclose = (event) => {
      if (ws !== wsRef.current) return
      wsRef.current = null
      dispatch({ type: 'WS_CLOSE' })
      if (!intentionalClose && event.code !== 1008) {
        reconnectTimer = window.setTimeout(
          () => setConnectionAttempt((attempt) => attempt + 1),
          WS_RECONNECT_MS,
        )
      }
    }
    ws.onmessage = (e) => {
      if (ws !== wsRef.current) return
      let parsed: unknown
      try { parsed = JSON.parse(e.data) } catch { parsed = null }
      const message = parseServerMessage(parsed)
      if (!message) {
        const now = Date.now()
        if (now - warningAtRef.current >= WS_WARN_THROTTLE_MS) {
          warningAtRef.current = now
          console.warn('Ignored malformed WebSocket message')
        }
        dispatch({ type: 'WS_ERROR', code: 'INVALID_SERVER_MESSAGE', detail: 'The coaching stream sent an invalid message.' })
        return
      }
      if (message.type === 'setup.status' || message.type === 'setup.ready') {
        dispatch({ type: 'WS_SETUP', data: message.data })
      } else if (message.type === 'train.status') {
        dispatch({ type: 'WS_TRAIN', data: message.data })
      } else if (message.type === 'setup.error' || message.type === 'train.error') {
        dispatch({ type: 'WS_ERROR', code: message.data.code, detail: message.data.detail })
      }
    }

    return () => {
      intentionalClose = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      if (wsRef.current === ws) wsRef.current = null
      ws.close()
    }
  }, [endpoint, setNo, userId, sessionId, exerciseId, variant, connectionAttempt])

  useEffect(() => {
    if (state.view !== 'F2' || state.prep !== 'start' || !state.baselineReady) return
    const timer = window.setTimeout(() => dispatch({ type: 'START_COMPLETE' }), START_SPLASH_MS)
    return () => window.clearTimeout(timer)
  }, [state.view, state.prep, state.baselineReady])

  const send = useCallback((msg: { t_ms: number; keypoints: Record<string, { x: number; y: number; z: number; v: number }> }) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > WS_BACKPRESSURE_CAP) return
    ws.send(JSON.stringify(msg))
  }, [])

  return { state, dispatch, send }
}

export type EngineDispatch = ReturnType<typeof useEngine>['dispatch']
export { CONF_FLOOR }
