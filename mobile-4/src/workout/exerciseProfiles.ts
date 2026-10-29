/**
 * Camera requirements per exercise, in one place: which joints must be in the picture for the
 * coach to work, which are only nice to have, and how the body is oriented.
 *
 * `essential` mirrors each exercise's server setup (Exercise_Mechanics--main/backend/workouts/
 * <slug>/configs/setup.yaml `keypoints`): the server starts a set only when every one of them is
 * tracked at visibility ≥ 0.5, so the app asks the person to adjust exactly when the server would
 * refuse, and never otherwise. Rep counting (thresholds, hysteresis, timings) is configured per
 * exercise on the server (configs/fsm.yaml, templates.yaml); nothing here counts reps.
 *
 * Adding an exercise: add its profile here and its configs on the server.
 */

// MediaPipe Pose landmark indices (coach.ts LANDMARK_NAMES).
export const J = {
  nose: 0,
  leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28,
} as const;

export type ExerciseProfile = {
  /** Upright (the torso should look vertical) or a plank (horizontal). */
  posture: 'standing' | 'plank';
  /** Coached from the front, or with the side to the camera. */
  view: 'front' | 'side';
  /** Must be tracked and inside the picture before the set can start. */
  essential: readonly number[];
  /** 'either': the essential joints are needed on ONE side only (side-on: the far side is hidden
   *  behind the near one), mirroring setup.yaml `either_side`. Default 'both'. */
  sides?: 'both' | 'either';
  /** Tracked when visible, never required. */
  optional: readonly number[];
  /** What to do while getting ready, before tracking starts. */
  getReady: string;
};

const SHOULDERS = [J.leftShoulder, J.rightShoulder];
const ARMS = [J.leftElbow, J.rightElbow, J.leftWrist, J.rightWrist];
const HIPS = [J.leftHip, J.rightHip];
const KNEES = [J.leftKnee, J.rightKnee];
const ANKLES = [J.leftAnkle, J.rightAnkle];

const STAND = 'Stand facing the phone with your whole body in view, stand tall and hold still. Tracking starts automatically.';

export const EXERCISE_PROFILES: Record<string, ExerciseProfile> = {
  squat: { posture: 'standing', view: 'front', essential: [J.nose, ...SHOULDERS, ...HIPS, ...KNEES, ...ANKLES], optional: ARMS, getReady: STAND },
  bicep_curl: { posture: 'standing', view: 'front', essential: [...SHOULDERS, ...ARMS, ...HIPS, ...ANKLES], optional: [J.nose, ...KNEES], getReady: STAND },
  high_knee: { posture: 'standing', view: 'front', essential: [...SHOULDERS, ...HIPS, ...KNEES, ...ANKLES], optional: [J.nose, ...ARMS], getReady: STAND },
  pushup: {
    posture: 'plank', view: 'side', sides: 'either',
    essential: [...SHOULDERS, ...ARMS, ...HIPS, ...ANKLES], optional: [J.nose, ...KNEES],
    getReady: 'Phone on the floor, side-on to you, your whole body from hands to feet in view. Get into the top of a push-up with straight arms and hold still.',
  },
};

/** Whole body, standing: for an exercise the app does not know yet. */
const DEFAULT_PROFILE: ExerciseProfile = { posture: 'standing', view: 'front', essential: [...SHOULDERS, ...HIPS, ...KNEES, ...ANKLES], optional: [J.nose, ...ARMS], getReady: STAND };

export const exerciseProfile = (slug: string): ExerciseProfile => EXERCISE_PROFILES[slug] ?? DEFAULT_PROFILE;

/** The get-ready instruction for a planned exercise: curls name the dumbbells (the camera cannot
 *  see a weight, so it is asked for) and the planned arms. */
export function getReadyText(slug: string, variant?: 'single' | 'double'): string {
  if (slug === 'bicep_curl') {
    const arms = variant === 'single' ? ' Curl one arm at a time.' : variant === 'double' ? ' Curl both arms together.' : '';
    return `Grab your dumbbells. Stand facing the phone with your whole body in view, arms hanging, and hold still.${arms}`;
  }
  return exerciseProfile(slug).getReady;
}
