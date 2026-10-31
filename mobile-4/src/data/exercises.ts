import type { IconName } from '@/data/icons';
import type { SceneKind } from '@/types';

/**
 * Exercise library presentation. The backend catalog (GET /api/exercises) only returns
 * { id, view, status }, so names, body parts and training tags live client-side, exactly as in
 * the backend's own web client (frontend-react/src/flow/SoloWorkspace.tsx). `slug` is the
 * backend catalog id; availability ALWAYS comes from the server, never from this file.
 */
export type Measure = 'reps' | 'time';

export type LibraryExercise = {
  key: string;
  slug: string;
  variant?: 'single' | 'double';
  name: string;
  bodyPart: string;
  tag: string;
  measure: Measure;
  icon: IconName;
  scene: SceneKind;
  blurb: string;
  /** Metabolic equivalent, for the calorie estimate (Compendium of Physical Activities). */
  met: number;
};

export const EXERCISE_LIBRARY: LibraryExercise[] = [
  { key: 'squat', slug: 'squat', name: 'Squat', bodyPart: 'Lower Body', tag: 'Strength', measure: 'reps', icon: 'human-handsdown', scene: 'hiit', blurb: 'Depth, knee tracking and torso lean, scored every rep.', met: 5 },
  { key: 'bicep_curl_single', slug: 'bicep_curl', variant: 'single', name: 'Single Arm Bicep Curl', bodyPart: 'Upper Body', tag: 'Strength', measure: 'reps', icon: 'arm-flex', scene: 'hiit', blurb: 'Full range, elbows pinned, no shoulder shrug.', met: 3.5 },
  { key: 'bicep_curl_double', slug: 'bicep_curl', variant: 'double', name: 'Double Arm Bicep Curl', bodyPart: 'Upper Body', tag: 'Strength', measure: 'reps', icon: 'arm-flex-outline', scene: 'hiit', blurb: 'Both arms, matched tempo and range.', met: 3.5 },
  // Coached from the SIDE (the catalog says view: side); same entry as the backend's web coach.
  { key: 'pushup', slug: 'pushup', name: 'Push-up', bodyPart: 'Upper Body', tag: 'Strength', measure: 'reps', icon: 'weight-lifter', scene: 'hiit', blurb: 'Elbow depth and a straight body line, coached side-on.', met: 3.8 },
  { key: 'high_knee', slug: 'high_knee', name: 'High Knees', bodyPart: 'Full Body · Cardio · Core', tag: 'HIIT', measure: 'time', icon: 'run-fast', scene: 'hiit', blurb: 'Timed set: knee drive height, pace and left/right balance.', met: 8 },
  // Backend catalog slug is `lunge` (the web client's `lunges` key would 422 once enabled).
  { key: 'lunge', slug: 'lunge', name: 'Lunges', bodyPart: 'Lower Body', tag: 'Strength', measure: 'reps', icon: 'walk', scene: 'hiit', blurb: 'Coming soon on the coach.', met: 4 },
  { key: 'plank', slug: 'plank', name: 'Plank', bodyPart: 'Full Body · Cardio · Core', tag: 'Core', measure: 'time', icon: 'human-male', scene: 'yoga', blurb: 'Coming soon on the coach.', met: 3.3 },
];

export const exerciseByKey = (key: string) => EXERCISE_LIBRARY.find((e) => e.key === key);

/** Plan defaults + bounds, matching the backend's SessionExercise validation. */
export const PLAN_BOUNDS = {
  sets: { value: 3, min: 1, max: 10, step: 1 },
  reps: { value: 12, min: 1, max: 50, step: 1 },
  time: { value: 30, min: 5, max: 300, step: 5 },
  rest: { value: 60, min: 0, max: 300, step: 15 },
} as const;

/** Rough calorie estimate for a plan: MET × 3.5 × kg / 200 per minute of work (weight defaults to 65 kg). */
export const estimateKcal = (ex: LibraryExercise, workSeconds: number, kg = 65) => Math.round(((ex.met * 3.5 * kg) / 200) * (workSeconds / 60));

/** Seconds of work in a plan: reps are paced at ~3 s each. */
export const workSeconds = (ex: LibraryExercise, sets: number, value: number) => sets * (ex.measure === 'reps' ? value * 3 : value);
