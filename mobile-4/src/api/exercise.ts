/**
 * Exercise Mechanics backend — REST contract.
 *
 * Source of truth: Exercise_Mechanics--main/backend (FastAPI). Routes, from its routers:
 *   users/router.py     GET  /api/users/{id}                    → profile.json
 *                       PUT  /api/users/{id}/profile            → profile (coach details on the account)
 *                       GET  /api/users/{id}/skill              → { skill_level, configured }
 *                       POST /api/users/{id}/skill              → { skill_level, configured: true }
 *   workouts/router.py  GET  /api/exercises                     → { exercises: [{ id, view, status }] }
 *   sessions/router.py  POST /api/users/{id}/sessions           → 201 SessionCreated (one exercise per session)
 *   reports/router.py   GET  /api/users/{id}/progress           → ProgressData
 *                       GET  /api/users/{id}/activity/{year}    → { dates: ['YYYY-MM-DD'] }
 *                       GET  /api/users/{id}/sessions           → { sessions: SessionListItem[] }
 *                       GET  /api/users/{id}/sessions/{sid}/overview
 *                       GET  /api/users/{id}/sessions/{sid}/report
 *                       GET  /api/users/{id}/sessions/{sid}/exercises/{ex}/report
 * Response shapes match the backend's own client (frontend-react/src/flow/storage.ts).
 *
 * Not REST: live coaching runs over /ws/setup and /ws/train and streams 33 MediaPipe pose
 * landmarks per camera frame. The mobile app has no on-device pose model, so those sockets
 * are not used here (see README).
 *
 * Every /api/users/{id}/... route needs the signed-in account's own bearer token (401 without
 * it, 403 for anyone else's id). The id is the account's UUID from sign-in (src/auth/account.ts);
 * the shared client attaches the token and refreshes it when it expires.
 */
import { EXERCISE_API_URL } from '@/api/config';
import { api } from '@/api/client';
import { withRetry } from '@/api/endpoints';
import { deviceTimeZone } from '@/logic/localDay';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** PUT /api/users/{id}/profile body. Field names match the backend CoachProfile model one-to-one. */
export type CoachDetails = {
  gender: string; // female · male · non_binary · other · undisclosed
  height_cm: number; // 50–272
  weight_kg: number; // 20–400
  date_of_birth: string; // YYYY-MM-DD, 1900 to today
  mobile: string; // 3–32 chars
};
export type ExerciseUser = { user_id: string; first_name: string; last_name: string };
/** An account registered in the app has names and email; the coach details arrive with PUT …/profile. */
export type ExerciseProfile = Partial<CoachDetails> & { user_id: string; first_name: string; last_name: string; email: string; created_at: string };
export const hasCoachDetails = (p: ExerciseProfile | undefined): p is ExerciseProfile & CoachDetails =>
  !!p && typeof p.height_cm === 'number' && typeof p.weight_kg === 'number' && !!p.gender && !!p.date_of_birth;

export type SkillLevel = 'beginner' | 'intermediate' | 'advanced';
export const SKILL_LEVELS: SkillLevel[] = ['beginner', 'intermediate', 'advanced'];
export type SkillState = { skill_level: SkillLevel; configured: boolean };

export type ExerciseAvailability = { id: string; view: 'front' | 'side'; status: 'enabled' | 'planned' };

/** One exercise in POST /api/users/{id}/sessions. `value` is reps (measure 'reps') or seconds ('time'). */
export type SessionExerciseInput = {
  name: string; // 1–120
  slug: string; // ^[a-z0-9_]+$, must be an enabled catalog id
  variant?: 'single' | 'double';
  /** Optional: what the person lifts (kg per dumbbell). Recorded, not detected. */
  weight_kg?: number;
  body_part: string;
  training_tag: string;
  measure: 'reps' | 'time'; // must equal the exercise's movement type
  sets: number; // 1–10
  value: number; // reps 1–50, seconds 1–300
  rest_seconds: number; // 0–300
};
export type SessionTarget = { type: 'reps'; value: number } | { type: 'time'; value_ms: number };
export type CreatedSession = {
  session_id: string;
  exercise_id: string;
  exercise_name: string;
  variant: 'single' | 'double' | null;
  weight_kg?: number | null;
  sets: number;
  target: SessionTarget;
  rest_seconds: number;
};

export type SessionListItem = { session_id: string; date: string; day: string; start_time: string; exercise: string; reps_completed: number };

export type OverviewExercise = {
  exercise_id: string;
  name: string;
  body_part: string | null;
  training_tag: string | null;
  measure: 'reps' | 'time';
  has_data: boolean;
  avg_form_score: number | null;
  planned: { sets: number; reps_per_set?: number; total?: number; duration_seconds?: number; weight_kg?: number | null };
  actual?: { reps_completed: number; sets_completed: number };
  /* Counted (full-range, controlled) reps reached the plan. */
  plan_met?: boolean;
  shallow_reps?: number;
  /* Attempts that did not count: short of full range or too fast. */
  reps_not_counted?: number;
  quality?: { good: number; borderline: number; poor: number };
};
export type SessionOverview = {
  session_id: string;
  date: string;
  day: string;
  start_time: string;
  skill_level: string;
  session_score: number | null;
  total_reps: number;
  total_time_s?: number | null;
  exercise_count: number;
  exercises: OverviewExercise[];
};

export type ReportByRule = { rule: string; issue_name: string; penalty_share: number; flagged_reps: number; avg_score: number };
export type Coaching = { rule: string; issue_name: string; reps: number[]; fix: string; text: string };

export type RepExerciseReport = {
  session_id: string; date: string; day: string; start_time: string; skill_level: string; exercise: string;
  exercise_id: string; measure: 'reps'; body_part: string | null; training_tag: string | null;
  planned: { sets: number; reps_per_set: number; total: number; weight_kg?: number | null };
  actual: { reps_completed: number; sets_completed: number };
  depth_target?: number;
  summary: { avg_form_score: number | null; total_reps: number; good_reps?: number; not_counted?: { shallow: number; too_fast: number; other: number }; shallow_reps: number; best: number | null; worst: number | null; avg_rep_time_s: number | null; total_time_s: number | null };
  per_rep: { rep: number; set: number; score: number; shallow: boolean; rom: number | null; time_s: number | null }[];
  per_set: { set: number; avg_score: number; reps: number; time_s: number | null }[];
  by_rule: ReportByRule[];
  coaching: Coaching[];
  insights: string[];
};
export type TimedExerciseReport = {
  session_id: string; date: string; day: string; start_time: string; skill_level: string; exercise: string;
  exercise_id: string; measure: 'time'; body_part: string | null; training_tag: string | null;
  planned: { sets: number; duration_seconds: number; total_duration_seconds: number };
  actual: { sets_completed: number; counted_lifts: number; detected_cycles: number };
  summary: { avg_form_score: number | null; total_time_s: number | null; counted_lifts: number; full_lifts: number; shallow_lifts: number; invalid_lifts: number };
  per_set: { set: number; avg_score: number; counted_lifts: number; detected_cycles: number; time_s: number | null }[];
  insights: string[];
};
export type ExerciseReport = RepExerciseReport | TimedExerciseReport;

export type ProgressSession = { session_id: string; date: string; day: string; start_time: string; score: number | null; reps: number; exercises: (string | null)[] };
export type ExerciseProgress = {
  sessions: ProgressSession[]; // oldest → newest
  totals: { sessions: number; reps: number; with_data: number };
  avg_form: number | null;
  latest_score: number | null;
  delta: number | null;
  best: { score: number; date: string; session_id: string } | null;
  /** Current streak (consecutive local days ending today or yesterday). */
  streak_days: number;
  best_streak_days?: number;
  this_week: number;
  total_time_s?: number | null;
  insights: string[];
};

// ---------------------------------------------------------------------------
// Endpoints — same client, token and retry policy as the Run Module
// ---------------------------------------------------------------------------

const ex = <T>(path: string, init: { method?: string; body?: unknown } = {}) => api<T>(`/api${path}`, { ...init, base: EXERCISE_API_URL });
const u = (id: string) => `/users/${encodeURIComponent(id)}`;

export const exerciseApi = {
  getProfile: (userId: string) => withRetry(() => ex<ExerciseProfile>(u(userId))),
  /** Idempotent (PUT), so a lost response is safe to retry. */
  saveProfile: (userId: string, details: CoachDetails) => withRetry(() => ex<ExerciseProfile>(`${u(userId)}/profile`, { method: 'PUT', body: details })),
  getSkill: (userId: string) => withRetry(() => ex<SkillState>(`${u(userId)}/skill`)),
  setSkill: (userId: string, level: SkillLevel) => withRetry(() => ex<SkillState>(`${u(userId)}/skill`, { body: { skill_level: level } })),

  catalog: () => withRetry(() => ex<{ exercises: ExerciseAvailability[] }>('/exercises')).then((r) => r.exercises ?? []),

  // Non-idempotent creates are NOT retried: a lost response would mint a duplicate session.
  /** The backend accepts exactly one exercise per session (Prototype 1). */
  // The phone's time zone: the session's day and time follow it (history, streaks, XP day).
  createSession: (userId: string, exercise: SessionExerciseInput) =>
    ex<CreatedSession>(`${u(userId)}/sessions`, { body: { exercises: [exercise], timezone: deviceTimeZone() } }),

  sessions: (userId: string) => withRetry(() => ex<{ sessions: SessionListItem[] }>(`${u(userId)}/sessions`)).then((r) => r.sessions ?? []),
  overview: (userId: string, sessionId: string) => withRetry(() => ex<SessionOverview>(`${u(userId)}/sessions/${encodeURIComponent(sessionId)}/overview`)),
  sessionReport: (userId: string, sessionId: string) => withRetry(() => ex<ExerciseReport>(`${u(userId)}/sessions/${encodeURIComponent(sessionId)}/report`)),
  exerciseReport: (userId: string, sessionId: string, exerciseId: string) =>
    withRetry(() => ex<ExerciseReport>(`${u(userId)}/sessions/${encodeURIComponent(sessionId)}/exercises/${encodeURIComponent(exerciseId)}/report`)),
  progress: (userId: string) => withRetry(() => ex<ExerciseProgress>(`${u(userId)}/progress`)),
  activity: (userId: string, year: number) => withRetry(() => ex<{ dates: string[] }>(`${u(userId)}/activity/${year}`)).then((r) => r.dates ?? []),
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const formScoreColor = (s: number | null | undefined, c: { good: string; mid: string; poor: string; none: string }) =>
  s == null ? c.none : s >= 80 ? c.good : s >= 60 ? c.mid : c.poor;

export const formatDuration = (s: number | null | undefined) => {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
};
