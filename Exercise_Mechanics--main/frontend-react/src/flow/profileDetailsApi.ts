/* Sign-up page 2 — the optional questions (fitness, activities, physique, habits) asked after the
   account exists. Option values mirror backend/profiles/vocab.py; the backend rejects anything else.
   Physique and habits are only sent together with a consent grant — ticking the consent box is what
   allows them to be saved at all. */

export type FitnessLevel = 'beginner' | 'intermediate' | 'advanced'
export type Option = { value: string; label: string }

// Which wording of the privacy notice the user agreed to; bump it when that wording changes.
export const POLICY_VERSION = '2026-09'

export const FITNESS_LEVEL_OPTIONS: { value: FitnessLevel; label: string }[] = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' },
]
export const ACTIVITY_LEVEL_OPTIONS: Option[] = [
  { value: 'sedentary', label: 'Mostly sitting' },
  { value: 'light', label: 'Lightly active' },
  { value: 'moderate', label: 'Moderately active' },
  { value: 'active', label: 'Active' },
  { value: 'very_active', label: 'Very active' },
]
export const GOAL_OPTIONS: Option[] = [
  { value: 'lose_fat', label: 'Lose fat' },
  { value: 'build_muscle', label: 'Build muscle' },
  { value: 'endurance', label: 'Build endurance' },
  { value: 'mobility', label: 'Improve mobility' },
  { value: 'general_health', label: 'General health' },
]
export const ACTIVITY_OPTIONS: Option[] = [
  { value: 'running', label: 'Running' },
  { value: 'walking', label: 'Walking' },
  { value: 'cycling', label: 'Cycling' },
  { value: 'swimming', label: 'Swimming' },
  { value: 'hiit', label: 'HIIT' },
  { value: 'dance', label: 'Dance' },
  { value: 'strength_training', label: 'Strength training' },
  { value: 'home_workout', label: 'Home workout' },
  { value: 'yoga', label: 'Yoga' },
  { value: 'pilates', label: 'Pilates' },
  { value: 'sports', label: 'Sports' },
  { value: 'squat', label: 'Squats' },
  { value: 'pushup', label: 'Push-ups' },
  { value: 'bicep_curl', label: 'Bicep curls' },
  { value: 'high_knee', label: 'High knees' },
]
export const BODY_TYPE_OPTIONS: Option[] = [
  { value: 'slim', label: 'Slim' },
  { value: 'average', label: 'Average' },
  { value: 'athletic', label: 'Athletic' },
  { value: 'muscular', label: 'Muscular' },
  { value: 'heavier', label: 'Heavier' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
]
export const WORKOUT_TIME_OPTIONS: Option[] = [
  { value: 'early_morning', label: 'Early morning' },
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
  { value: 'night', label: 'Night' },
]
export const DIET_OPTIONS: Option[] = [
  { value: 'vegetarian', label: 'Vegetarian' },
  { value: 'vegan', label: 'Vegan' },
  { value: 'eggetarian', label: 'Eggetarian' },
  { value: 'non_vegetarian', label: 'Non-vegetarian' },
  { value: 'other', label: 'Other' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
]
export const SMOKING_OPTIONS: Option[] = [
  { value: 'never', label: 'Never' },
  { value: 'former', label: 'Used to' },
  { value: 'occasional', label: 'Occasionally' },
  { value: 'regular', label: 'Regularly' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
]
export const ALCOHOL_OPTIONS: Option[] = [
  { value: 'never', label: 'Never' },
  { value: 'occasional', label: 'Occasionally' },
  { value: 'regular', label: 'Regularly' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
]

/* The form's working state. '' means "not answered"; number fields stay text until submit. */
export type DetailsDraft = {
  fitnessLevel: FitnessLevel | null
  activityLevel: string
  primaryGoal: string
  activities: string[]
  physiqueConsent: boolean
  bodyType: string
  habitsConsent: boolean
  workoutTimes: string[]
  workoutsPerWeek: string
  sleepHours: string
  diet: string
  smoking: string
  alcohol: string
}

export const EMPTY_DETAILS: DetailsDraft = {
  fitnessLevel: null, activityLevel: '', primaryGoal: '', activities: [],
  physiqueConsent: false, bodyType: '',
  habitsConsent: false, workoutTimes: [], workoutsPerWeek: '', sleepHours: '', diet: '', smoking: '', alcohol: '',
}

export type DetailsErrors = Partial<Record<'fitness' | 'physique' | 'habits' | 'workoutsPerWeek' | 'sleepHours', string>>

function numberIn(raw: string, min: number, max: number, integer: boolean): number | null {
  if (raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) return Number.NaN
  return n
}

function habitsAnswered(d: DetailsDraft): boolean {
  return d.workoutTimes.length > 0 || d.workoutsPerWeek.trim() !== '' || d.sleepHours.trim() !== ''
    || d.diet !== '' || d.smoking !== '' || d.alcohol !== ''
}

export function detailsErrors(d: DetailsDraft): DetailsErrors {
  const e: DetailsErrors = {}
  if (!d.fitnessLevel && (d.activityLevel || d.primaryGoal)) e.fitness = 'Pick your fitness level too.'
  if (d.physiqueConsent && !d.bodyType) e.physique = 'Pick a body type, or untick to skip.'
  if (d.habitsConsent) {
    if (!habitsAnswered(d)) e.habits = 'Answer at least one, or untick to skip.'
    if (Number.isNaN(numberIn(d.workoutsPerWeek, 0, 14, true))) e.workoutsPerWeek = 'A whole number from 0 to 14.'
    if (Number.isNaN(numberIn(d.sleepHours, 0, 16, false))) e.sleepHours = 'Between 0 and 16 hours.'
  }
  return e
}

export type ConsentDecision = { category: 'physique' | 'habits'; granted: boolean; policy_version: string }
export type DetailsPayload = {
  fitness?: { fitness_level: FitnessLevel; activity_level: string | null; primary_goal: string | null }
  activities?: { activity: string }[]
  physique?: { body_type: string }
  habits?: {
    preferred_workout_times: string[]; workouts_per_week_goal: number | null; avg_sleep_hours: number | null
    diet: string | null; smoking: string | null; alcohol: string | null
  }
  consents?: ConsentDecision[]
}

/* The request body for the answers given, or null when nothing was answered (nothing to send).
   Call only once detailsErrors() is empty. An unticked consent box sends nothing for that section. */
export function detailsPayload(d: DetailsDraft): DetailsPayload | null {
  const p: DetailsPayload = {}
  const consents: ConsentDecision[] = []
  if (d.fitnessLevel) {
    p.fitness = { fitness_level: d.fitnessLevel, activity_level: d.activityLevel || null, primary_goal: d.primaryGoal || null }
  }
  if (d.activities.length) p.activities = d.activities.map((activity) => ({ activity }))
  if (d.physiqueConsent && d.bodyType) {
    consents.push({ category: 'physique', granted: true, policy_version: POLICY_VERSION })
    p.physique = { body_type: d.bodyType }
  }
  if (d.habitsConsent && habitsAnswered(d)) {
    consents.push({ category: 'habits', granted: true, policy_version: POLICY_VERSION })
    p.habits = {
      preferred_workout_times: d.workoutTimes,
      workouts_per_week_goal: numberIn(d.workoutsPerWeek, 0, 14, true),
      avg_sleep_hours: numberIn(d.sleepHours, 0, 16, false),
      diet: d.diet || null, smoking: d.smoking || null, alcohol: d.alcohol || null,
    }
  }
  if (consents.length) p.consents = consents
  return Object.keys(p).length ? p : null
}

export function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

export async function saveSignUpDetails(userId: string, payload: DetailsPayload): Promise<void> {
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/details`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (res.ok) return
  let message = 'Your answers could not be saved. Please try again.'
  try {
    const body = await res.json() as { detail?: unknown }
    const detail = body.detail
    if (detail && typeof detail === 'object' && !Array.isArray(detail) && typeof (detail as { message?: unknown }).message === 'string') {
      message = (detail as { message: string }).message
    } else if (res.status === 422) {
      message = "Some answers weren't accepted. Please check them and try again."
    }
  } catch { /* keep the generic message */ }
  throw new Error(message)
}
