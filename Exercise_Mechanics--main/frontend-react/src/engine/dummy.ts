/* dummy.ts — Static placeholders for fields the FitSync backend does not (yet) emit.
   Every value here is interim. As the backend grows these sources, replace the
   corresponding value with the real field. Each is marked `// TODO(backend): ...`. */
import type { ExerciseConfig } from '../types'

// TODO(backend): exercise plan / per-exercise config should come from a GET /workout
// endpoint (handoff Milestone D). The pipeline is single-set squat-only today, so this
// is one static squat config. targetROMThreshold is the depth_ratio% the ROM meter calls
// "achieved"; targetReps is a display target only (the backend counts reps unbounded).
export const SQUAT: ExerciseConfig = {
  id: 'squat',
  name: 'Squat',
  motion: 'squat',
  targetReps: 8,
  targetSets: 1,
  trackedJoints: ['Hips', 'Knees', 'Ankles', 'Trunk'],
  trainedMuscles: ['Quads', 'Glutes', 'Core'],
  targetTempo: '3s down · 1s up',
  targetROMThreshold: 90,
  romLabel: 'Range of motion',
}

// TODO(backend): serve this as an exercise descriptor (GET /api/exercises/{slug}). For the
// foundation it's a static curl config. ROM here is elbow-flexion %; the backend gate ratio
// (bicep_curl.yaml, beginner 0.85) maps to ~85% "achieved". Single vs double share this
// descriptor (the display name comes from the cart); variant only changes the backend gauges.
export const BICEP_CURL: ExerciseConfig = {
  id: 'bicep_curl',
  name: 'Bicep Curl',
  motion: 'bicep_curl',
  targetReps: 10,
  targetSets: 1,
  trackedJoints: ['Shoulders', 'Elbows', 'Wrists'],
  trainedMuscles: ['Biceps', 'Forearms'],
  targetTempo: '2s up · 2s down',
  targetROMThreshold: 85,
  romLabel: 'Range of motion',
}

export const HIGH_KNEE: ExerciseConfig = {
  id: 'high_knee',
  name: 'High Knees',
  motion: 'high_knee',
  targetReps: 0,
  targetSets: 1,
  trackedJoints: ['Shoulders', 'Hips', 'Knees', 'Ankles'],
  trainedMuscles: ['Hip flexors', 'Quads', 'Core'],
  targetTempo: 'Controlled alternating rhythm',
  targetROMThreshold: 75,
  romLabel: 'Knee drive',
}

// TODO(backend): same as the others — a static descriptor until GET /api/exercises/{slug} exists.
// Push-up is the one SIDE-ON exercise in the catalog: the backend's pushup catalog entry carries
// `view: side` and side_view_orientation refuses a front-on camera, so every piece of copy hanging
// off this descriptor has to coach a profile view, not a face-on one. targetROMThreshold mirrors
// pushup/configs/templates.yaml `full_rom_gate: 0.90` — the elbow-flexion fraction of the captured
// plank baseline that counts as a full-depth rep.
export const PUSHUP: ExerciseConfig = {
  id: 'pushup',
  name: 'Push-up',
  motion: 'pushup',
  targetReps: 10,
  targetSets: 1,
  trackedJoints: ['Shoulders', 'Elbows', 'Wrists', 'Hips', 'Ankles'],
  trainedMuscles: ['Chest', 'Triceps', 'Shoulders', 'Core'],
  targetTempo: '2s down · 1s up',
  targetROMThreshold: 90,
  // The signal is elbow flexion measured against the plank baseline, so "Depth" is what the
  // number on the rail actually means.
  romLabel: 'Depth',
}

// Exercise descriptor registry, keyed by the canonical backend slug. SET_WORKOUT_CONFIG picks
// the base config from here (falling back to the current one) so the live HUD shows the right
// tracked joints / muscles / ROM target for whichever exercise the cart launched.
export const EXERCISES: Record<string, ExerciseConfig> = {
  squat: SQUAT,
  bicep_curl: BICEP_CURL,
  high_knee: HIGH_KNEE,
  pushup: PUSHUP,
}

// TODO(backend): weekly workout count comes from a sessions store (persistence layer).
// Static until that exists.
export const WEEKLY_WORKOUT_COUNT = 3

// TODO(backend): currentJointAngle (knee flexion in degrees). Not computed by the
// pipeline; the ROM meter shows depth% instead. Kept as a neutral standing value.
export const DEFAULT_JOINT_ANGLE = 178
