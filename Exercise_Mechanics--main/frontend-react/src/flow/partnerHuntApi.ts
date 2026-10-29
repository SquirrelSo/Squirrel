/* partnerHunt.ts — Partner Hunt's API client and the pure logic behind its screen.

   Kept free of React so the decisions that matter (which state to show, what counts as valid
   preferences) are unit-tested in node. The vocabularies mirror backend/partners/policy.py; the
   backend validates every value, so a drift shows up as a 422, never as silently wrong data. */

export type Activity =
  | 'running' | 'walking' | 'cycling' | 'strength_training' | 'home_workout' | 'yoga' | 'hiit' | 'sports'
export type WorkoutTime = 'early_morning' | 'morning' | 'afternoon' | 'evening' | 'night'
export type MeetMode = 'in_person' | 'remote' | 'either'
export type PartnerGender = 'female' | 'male' | 'non_binary'

export const ACTIVITY_OPTIONS: { value: Activity; label: string }[] = [
  { value: 'running', label: 'Running' },
  { value: 'walking', label: 'Walking' },
  { value: 'cycling', label: 'Cycling' },
  { value: 'strength_training', label: 'Strength training' },
  { value: 'home_workout', label: 'Home workouts' },
  { value: 'yoga', label: 'Yoga' },
  { value: 'hiit', label: 'HIIT' },
  { value: 'sports', label: 'Sports' },
]

export const TIME_OPTIONS: { value: WorkoutTime; label: string }[] = [
  { value: 'early_morning', label: 'Early morning' },
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
  { value: 'night', label: 'Night' },
]

export const MODE_OPTIONS: { value: MeetMode; label: string }[] = [
  { value: 'in_person', label: 'In person' },
  { value: 'remote', label: 'Remote' },
  { value: 'either', label: 'Either' },
]

export const GENDER_OPTIONS: { value: PartnerGender; label: string }[] = [
  { value: 'female', label: 'Women' },
  { value: 'male', label: 'Men' },
  { value: 'non_binary', label: 'Non-binary people' },
]

export const MIN_PARTNER_AGE = 18
export const MAX_PARTNER_AGE = 99

export type PartnerPreferences = {
  visible: boolean
  activities: Activity[]
  mode: MeetMode
  city: string | null
  preferred_times: WorkoutTime[]
  partner_genders: PartnerGender[] // empty = anyone
  partner_age_min: number
  partner_age_max: number
}

export type PartnerStatus = {
  min_xp: number
  xp: { available: boolean; xp: number | null; updated_at: string | null }
  unlocked: boolean
  age_eligible: boolean
  fitness_level: string
  preferences: PartnerPreferences | null
  ready: boolean
}

export type PartnerMatch = {
  user_id: string
  display_name: string
  age_band: string
  fitness_level: string
  shared_activities: Activity[]
  shared_times: WorkoutTime[]
  meet: ('in_person' | 'remote')[]
  city: string | null
  score: number
  reasons: string[]
}

export const DEFAULT_PREFERENCES: PartnerPreferences = {
  visible: true,
  activities: [],
  mode: 'either',
  city: '',
  preferred_times: [],
  partner_genders: [],
  partner_age_min: MIN_PARTNER_AGE,
  partner_age_max: 45,
}

/* ── which screen to show ──────────────────────────────────────────────────────────────────────
   Checked in the same order the backend checks board access, so the screen never offers a board
   the server is about to refuse. "Could not check your XP" and "not enough XP yet" are separate
   states on purpose: the first is not the user's to fix, the second is. */
export type PartnerView =
  | { kind: 'age_restricted' }
  | { kind: 'xp_unavailable' }
  | { kind: 'locked'; xp: number; minXp: number; remaining: number; progress: number }
  | { kind: 'setup' }
  | { kind: 'board' }

export function partnerView(status: PartnerStatus): PartnerView {
  if (!status.age_eligible) return { kind: 'age_restricted' }
  if (!status.xp.available || status.xp.xp === null) return { kind: 'xp_unavailable' }
  if (!status.unlocked) {
    const xp = status.xp.xp
    const minXp = status.min_xp
    return {
      kind: 'locked',
      xp,
      minXp,
      remaining: Math.max(0, minXp - xp),
      progress: minXp > 0 ? Math.max(0, Math.min(1, xp / minXp)) : 1,
    }
  }
  if (!status.preferences || !status.preferences.visible) return { kind: 'setup' }
  return { kind: 'board' }
}

/* ── client-side validation, mirroring the backend's ───────────────────────────────────────────
   Only to explain problems before a round trip; the server stays the authority. */
export type PreferenceErrors = Partial<Record<'activities' | 'preferred_times' | 'city' | 'age', string>>

export function preferenceErrors(p: PartnerPreferences): PreferenceErrors {
  const errors: PreferenceErrors = {}
  if (p.activities.length === 0) errors.activities = 'Pick at least one activity.'
  if (p.preferred_times.length === 0) errors.preferred_times = 'Pick at least one time.'
  if (p.mode !== 'remote' && !(p.city ?? '').trim()) errors.city = 'Add your city to meet in person.'
  const { partner_age_min: lo, partner_age_max: hi } = p
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < MIN_PARTNER_AGE || hi > MAX_PARTNER_AGE) {
    errors.age = `Ages must be between ${MIN_PARTNER_AGE} and ${MAX_PARTNER_AGE}.`
  } else if (lo > hi) {
    errors.age = 'The minimum age cannot be above the maximum.'
  }
  return errors
}

/* What is actually sent: a remote-only user sends no city, matching the backend's data
   minimisation, so a location never leaves the device when it is not needed. */
export function preferencesPayload(p: PartnerPreferences): PartnerPreferences {
  return { ...p, city: p.mode === 'remote' ? null : (p.city ?? '').trim() }
}

export function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/* ── API ─────────────────────────────────────────────────────────────────────────────────────── */

/* Every Partner Hunt error carries the backend's machine-readable code, so the screen reacts to
   what went wrong (e.g. xp_locked) rather than parsing message text. */
export class PartnerHuntApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'PartnerHuntApiError'
    this.status = status
    this.code = code
  }
}

const base = (userId: string) => `/api/users/${encodeURIComponent(userId)}/partner-hunt`

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (res.ok) return res.json() as Promise<T>
  let code = 'http_error'
  let message = `Request failed (${res.status})`
  try {
    const payload = await res.json() as { detail?: unknown }
    const detail = payload.detail
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const d = detail as { code?: unknown; message?: unknown }
      if (typeof d.code === 'string') code = d.code
      if (typeof d.message === 'string') message = d.message
    } else if (Array.isArray(detail)) {
      // FastAPI request validation (422): a list of field errors.
      code = 'invalid'
      const first = detail[0] as { msg?: unknown } | undefined
      if (first && typeof first.msg === 'string') message = first.msg
    } else if (typeof detail === 'string') {
      message = detail
    }
  } catch { /* keep the status-based message */ }
  throw new PartnerHuntApiError(res.status, code, message)
}

export function fetchPartnerStatus(userId: string): Promise<PartnerStatus> {
  return call<PartnerStatus>(base(userId))
}

export function savePartnerPreferences(userId: string, prefs: PartnerPreferences): Promise<PartnerPreferences> {
  return call<PartnerPreferences>(`${base(userId)}/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preferencesPayload(prefs)),
  })
}

export async function fetchPartnerMatches(userId: string): Promise<PartnerMatch[]> {
  const body = await call<{ min_xp: number; matches: PartnerMatch[] }>(`${base(userId)}/matches`)
  return body.matches
}

export function blockPartner(userId: string, blockedUserId: string): Promise<{ blocked_user_id: string }> {
  return call(`${base(userId)}/blocks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: blockedUserId }),
  })
}
