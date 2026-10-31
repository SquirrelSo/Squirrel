/* storage.ts — the "local cache" half of the onboarding flow.
   localStorage holds only the lightweight identity (who is this) so a returning
   user is greeted with "Welcome back" instead of re-onboarding. The full profile
   AND the calibration baseline live on disk, written by the backend under
   data/users/{user_id}/ (a browser cannot write to the local drive itself). */

export type CachedUser = {
  user_id: string
  first_name: string
  last_name: string
}

/* The onboarding form payload. Field names match the backend UserProfile model
   (POST /api/users) one-to-one. */
export type OnboardingForm = {
  first_name: string
  last_name: string
  gender: string
  height_cm: number
  weight_kg: number
  date_of_birth: string // ISO YYYY-MM-DD
  mobile: string
  email: string
}

const KEY = 'fitsync_user'         // the active identity (the default-selected profile)
const ROSTER_KEY = 'fitsync_users' // every profile created/used on this device

export function loadUser(): CachedUser | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const u = JSON.parse(raw) as Partial<CachedUser>
    if (u && u.user_id && u.first_name) return u as CachedUser
    return null
  } catch {
    return null // corrupt/unavailable storage → treat as a fresh visitor
  }
}

/* Every profile known on this device — what the returning-user dropdown offers.
   Always includes the active user (covers identities cached before the roster
   existed), deduped by user_id, most-recently-active first. */
export function loadUsers(): CachedUser[] {
  let list: CachedUser[] = []
  try {
    const raw = localStorage.getItem(ROSTER_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<CachedUser>[]) : []
    list = parsed.filter((u): u is CachedUser => !!(u && u.user_id && u.first_name))
  } catch { /* corrupt roster → fall back to just the active user */ }
  const active = loadUser()
  if (active && !list.some((u) => u.user_id === active.user_id)) list.unshift(active)
  const seen = new Set<string>()
  return list.filter((u) => (seen.has(u.user_id) ? false : (seen.add(u.user_id), true)))
}

function writeRoster(list: CachedUser[]): void {
  try { localStorage.setItem(ROSTER_KEY, JSON.stringify(list)) } catch { /* non-fatal */ }
}

/* Make `u` the active identity AND record it in the device roster, so the user is
   the default selection next load and can be picked again from the dropdown. */
export function saveUser(u: CachedUser): void {
  try { localStorage.setItem(KEY, JSON.stringify(u)) } catch { /* private mode / quota — non-fatal */ }
  writeRoster([u, ...loadUsers().filter((x) => x.user_id !== u.user_id)])
}

/* Switch the active profile to an already-known user — no re-onboarding, no delete. */
export const setActiveUser = saveUser

/* Forget the *active* identity only — the roster (and every other profile) survive.
   This is "log out", NOT "delete this person from the device". */
export function clearUser(): void {
  try { localStorage.removeItem(KEY) } catch { /* non-fatal */ }
}

export type SkillLevel = 'beginner' | 'intermediate' | 'advanced'

/* The full saved profile as returned by GET /api/users/{id} (profile.json). */
export type UserProfile = OnboardingForm & { user_id: string; created_at: string }

/* Skill level source of truth is server-side (users/{id}/skill.json), set on the Home
   Skill card. We also mirror it into localStorage (per user) so other screens — e.g. the
   Exercise Library cards — can reflect it instantly, before/without a round-trip. */
const SKILL_KEY = (userId: string) => `fitsync_skill_${userId}`
const isSkill = (v: unknown): v is SkillLevel => v === 'beginner' || v === 'intermediate' || v === 'advanced'

export function loadCachedSkill(userId: string): SkillLevel | null {
  try { const v = localStorage.getItem(SKILL_KEY(userId)); return isSkill(v) ? v : null } catch { return null }
}
export function saveCachedSkill(userId: string, level: SkillLevel): void {
  try { localStorage.setItem(SKILL_KEY(userId), level) } catch { /* private mode / quota — non-fatal */ }
}

export async function fetchSkill(userId: string): Promise<SkillLevel> {
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/skill`)
  if (!res.ok) return loadCachedSkill(userId) ?? 'beginner'
  const data = await res.json() as { skill_level?: SkillLevel }
  const level = data.skill_level ?? 'beginner'
  saveCachedSkill(userId, level) // keep the web cache in sync with the drive file
  return level
}

/* Skill level + whether it's been EXPLICITLY set (skill.json exists). `configured` lets the
   dashboard distinguish a saved 'beginner' from the fallback shown to a brand-new profile, so
   an unset profile shows "Update" rather than a misleading "Updated". Only caches when the
   level is actually persisted (an unconfigured default must not overwrite a real cached value). */
export async function fetchSkillState(userId: string): Promise<{ level: SkillLevel; configured: boolean }> {
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(userId)}/skill`)
    if (!res.ok) return { level: loadCachedSkill(userId) ?? 'beginner', configured: false }
    const data = await res.json() as { skill_level?: SkillLevel; configured?: boolean }
    const level = data.skill_level ?? 'beginner'
    const configured = !!data.configured
    if (configured) saveCachedSkill(userId, level)
    return { level, configured }
  } catch {
    return { level: loadCachedSkill(userId) ?? 'beginner', configured: false }
  }
}

export async function updateSkill(userId: string, level: SkillLevel): Promise<void> {
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/skill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skill_level: level }),
  })
  if (!res.ok) throw new Error(`Could not update skill (${res.status})`)
  saveCachedSkill(userId, level) // update skill.json (above) AND the web local storage
}

/* One exercise in a started session. `value` is reps (measure 'reps') or seconds
   (measure 'time'). Field names match the backend SessionExercise model. */
export type SessionExercise = {
  name: string
  slug: string           // canonical backend exercise slug (variant-independent, e.g. "bicep_curl")
  variant?: 'single' | 'double'
  body_part: string
  training_tag: string
  measure: 'reps' | 'time'
  sets: number
  value: number
  rest_seconds: number   // rest interval between sets
}

export type RepSessionTarget = { type: 'reps'; value: number }
export type TimedSessionTarget = { type: 'time'; value_ms: number }
export type SessionTarget = RepSessionTarget | TimedSessionTarget

export type CreatedSession = {
  session_id: string
  exercise_id: string
  exercise_name: string
  variant: 'single' | 'double' | null
  sets: number
  target: SessionTarget
  rest_seconds: number
}

export type ExerciseAvailability = {
  id: string
  view: 'front' | 'side'
  status: 'enabled' | 'planned'
}

export async function fetchExerciseCatalog(): Promise<ExerciseAvailability[]> {
  const res = await fetch('/api/exercises')
  if (!res.ok) throw new Error(`Could not load exercise catalog (${res.status})`)
  const payload = await res.json() as { exercises?: ExerciseAvailability[] }
  return payload.exercises ?? []
}

/* ── Session report (Analytics & Insights) ── */
export type SessionListItem = {
  session_id: string; date: string; day: string; start_time: string; exercise: string; reps_completed: number
}
export type ReportByRule = { rule: string; issue_name: string; penalty_share: number; flagged_reps: number; avg_score: number }

/* Per-exercise summary card on the session overview (report landing page). */
export type OverviewExercise = {
  exercise_id: string
  name: string
  body_part: string | null
  training_tag: string | null
  measure: 'reps' | 'time'
  has_data: boolean
  avg_form_score: number | null
  planned: { sets: number; reps_per_set?: number; total?: number; duration_seconds?: number }
  actual?: { reps_completed: number; sets_completed: number }
  shallow_reps?: number
  quality?: { good: number; borderline: number; poor: number }
}
export type SessionOverview = {
  session_id: string; date: string; day: string; start_time: string; skill_level: string
  session_score: number | null
  total_reps: number
  total_time_s?: number | null   // summed active rep time across the whole session
  exercise_count: number
  exercises: OverviewExercise[]
}

export type RepSessionReport = {
  session_id: string; date: string; day: string; start_time: string; skill_level: string; exercise: string
  exercise_id: string; measure: 'reps'; body_part: string | null; training_tag: string | null
  planned: { sets: number; reps_per_set: number; total: number }
  actual: { reps_completed: number; sets_completed: number }
  depth_target?: number   // full-rep depth gate as a % (the ROM chart's target line)
  summary: { avg_form_score: number | null; total_reps: number; shallow_reps: number; best: number | null; worst: number | null; avg_rep_time_s: number | null; total_time_s: number | null }
  per_rep: { rep: number; set: number; score: number; shallow: boolean; rom: number | null; rule_phase: Record<string, Record<string, number>>; time_s: number | null }[]
  per_set: { set: number; avg_score: number; reps: number; time_s: number | null }[]
  by_rule: ReportByRule[]                               // over all reps (the "All sets" view)
  rule_phase: Record<string, Record<string, number>>
  coaching: { rule: string; issue_name: string; reps: number[]; fix: string; text: string }[]  // ≤2 recurring-issue bullets (all reps)
  sets: { set: number; by_rule: ReportByRule[]; rule_phase: Record<string, Record<string, number>>
    coaching: { rule: string; issue_name: string; reps: number[]; fix: string; text: string }[] }[]  // + per-set coaching
  insights: string[]
}

export type TimedSessionReport = {
  session_id: string; date: string; day: string; start_time: string; skill_level: string; exercise: string
  exercise_id: string; measure: 'time'; body_part: string | null; training_tag: string | null
  planned: { sets: number; duration_seconds: number; total_duration_seconds: number }
  actual: { sets_completed: number; counted_lifts: number; detected_cycles: number }
  summary: { avg_form_score: number | null; total_time_s: number | null; counted_lifts: number; full_lifts: number; shallow_lifts: number; invalid_lifts: number }
  per_set: { set: number; avg_score: number; counted_lifts: number; detected_cycles: number; time_s: number | null }[]
  insights: string[]
}

export type SessionReport = RepSessionReport | TimedSessionReport

/* ── Cross-session progress (Analytics landing / Trends) ── */
export type ProgressSession = {
  session_id: string; date: string; day: string; start_time: string
  score: number | null; reps: number; exercises: (string | null)[]
}
export type ProgressData = {
  sessions: ProgressSession[]   // chronological (oldest → newest)
  totals: { sessions: number; reps: number; with_data: number }
  avg_form: number | null
  latest_score: number | null
  delta: number | null          // latest vs previous scored session
  best: { score: number; date: string; session_id: string } | null
  streak_days: number
  this_week: number
  total_time_s?: number | null   // summed active training time across all sessions (backend-provided)
  insights: string[]
}
export async function fetchProgress(userId: string): Promise<ProgressData> {
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/progress`)
  if (!res.ok) throw new Error(`Could not load progress (${res.status})`)
  return res.json() as Promise<ProgressData>
}

/* Distinct trained-on dates (YYYY-MM-DD) for a year — feeds the Home dashboard's activity heatmap. */
export async function fetchActivity(userId: string, year: number): Promise<string[]> {
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/activity/${year}`)
  if (!res.ok) return []
  const data = await res.json() as { dates?: string[] }
  return data.dates ?? []
}

export async function fetchSessions(userId: string): Promise<SessionListItem[]> {
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/sessions`)
  if (!res.ok) return []
  const data = await res.json() as { sessions?: SessionListItem[] }
  return data.sessions ?? []
}

export async function fetchSessionReport(userId: string, sessionId: string): Promise<SessionReport> {
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/report`)
  if (!res.ok) throw new Error(`Could not load report (${res.status})`)
  return res.json() as Promise<SessionReport>
}

/* Session overview — header + one summary card per exercise (report landing page). */
export async function fetchSessionOverview(userId: string, sessionId: string): Promise<SessionOverview> {
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/overview`)
  if (!res.ok) throw new Error(`Could not load session (${res.status})`)
  return res.json() as Promise<SessionOverview>
}

/* Detailed analytics for one exercise within a session (the drill-down page). */
export async function fetchExerciseReport(userId: string, sessionId: string, exerciseId: string): Promise<SessionReport> {
  const res = await fetch(
    `/api/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/exercises/${encodeURIComponent(exerciseId)}/report`,
  )
  if (!res.ok) throw new Error(`Could not load exercise report (${res.status})`)
  return res.json() as Promise<SessionReport>
}

/* Create the persisted session that setup/training require. Skill level is not sent — the
   backend reads it from skill.json and returns the normalized one-exercise P1 plan. */
/* Carries the HTTP status alongside the message so a caller can distinguish "this identity no
   longer exists on the server" (404) from a transport or server failure, and recover instead of
   showing the user a dead end. Extends Error, so existing `error instanceof Error` handling and
   `.message` reads are unaffected. */
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function saveSession(userId: string, exercises: SessionExercise[]): Promise<CreatedSession> {
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exercises }),
  })
  if (!res.ok) {
    let detail = ''
    try {
      const payload = await res.json() as { detail?: unknown }
      if (typeof payload.detail === 'string') detail = payload.detail
    } catch { /* fall through to the stable status message */ }
    throw new ApiError(res.status, detail || `Could not create session (${res.status})`)
  }
  return res.json() as Promise<CreatedSession>
}

/* Fetch a user's saved profile (height, weight, …) for the dashboard. */
export async function fetchProfile(userId: string): Promise<UserProfile> {
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}`)
  if (!res.ok) throw new Error(`Could not load profile (${res.status})`)
  return res.json() as Promise<UserProfile>
}

/* POST the profile to the backend, which mints the unique id, creates the
   user's directory and writes profile.json. Returns the cached identity. */
export async function createUser(form: OnboardingForm): Promise<CachedUser> {
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(form),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = JSON.stringify(await res.json()) } catch { /* ignore */ }
    throw new Error(`Could not create profile (${res.status}). ${detail}`)
  }
  return res.json() as Promise<CachedUser>
}
