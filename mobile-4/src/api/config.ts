/**
 * Backend configuration. Set these in `mobile-4/.env` (see .env.example):
 *   EXPO_PUBLIC_API_URL           Run Module backend (runs, territory tiles, XP, leaderboards, challenges)
 *   EXPO_PUBLIC_EXERCISE_API_URL  Exercise Mechanics backend (FastAPI, routes under /api)
 *   EXPO_PUBLIC_AUTH_URL          Where accounts live. Defaults to the Exercise backend, whose /api/auth
 *                                 issues the token every backend accepts (email code sign-in).
 *   EXPO_PUBLIC_SOCIAL_API_URL    Social service (profiles, crews, events, notifications… under /v1).
 *                                 The campus screens run on it (api/campus/http.ts adapts the routes).
 *   EXPO_PUBLIC_CAMPUS_API_URL    Only for a separate campus backend with the full contract; defaults to
 *                                 the Social service.
 *   EXPO_PUBLIC_CAMPUS_SERVICE_URL campus-service (routes under /v1): the map world — zones, territory,
 *                                 activities → zones, presence, Active now, heatmap, shared zones. With the
 *                                 Social service, those go here and everything else stays on Social
 *                                 (api/campus/hybrid.ts). Empty: the app behaves exactly as without it.
 *   EXPO_PUBLIC_REALTIME_URL      optional WebSocket for live updates (the backend's /v1/config can also provide it)
 * Only public URLs belong here. Never put server secrets or API keys in EXPO_PUBLIC_* variables.
 * With a URL unset, the screens that need that backend say so (Not connected / not live yet) — there
 * is no demo mode and no seed data.
 */
const trim = (v: string | undefined) => (v ?? '').replace(/\/$/, '');

export const API_URL = trim(process.env.EXPO_PUBLIC_API_URL);
export const API_CONFIGURED = API_URL.length > 0;
export const EXERCISE_API_URL = trim(process.env.EXPO_PUBLIC_EXERCISE_API_URL);
export const EXERCISE_API_CONFIGURED = EXERCISE_API_URL.length > 0;
export const AUTH_URL = trim(process.env.EXPO_PUBLIC_AUTH_URL) || EXERCISE_API_URL;
export const AUTH_CONFIGURED = AUTH_URL.length > 0;
export const SOCIAL_API_URL = trim(process.env.EXPO_PUBLIC_SOCIAL_API_URL);
export const SOCIAL_API_CONFIGURED = SOCIAL_API_URL.length > 0;
const RAW_CAMPUS_URL = trim(process.env.EXPO_PUBLIC_CAMPUS_API_URL);
/** Campus social backend: a dedicated one if configured, else the Social service. */
export const CAMPUS_API_URL = RAW_CAMPUS_URL || SOCIAL_API_URL;
export const CAMPUS_API_CONFIGURED = CAMPUS_API_URL.length > 0;
/** True when the campus contract is served by the Social service through the adapter in api/campus/http.ts. */
export const CAMPUS_ON_SOCIAL = !RAW_CAMPUS_URL && SOCIAL_API_CONFIGURED;
/** A dedicated full-contract campus backend (EXPO_PUBLIC_CAMPUS_API_URL) is configured. */
export const DEDICATED_CAMPUS_API = RAW_CAMPUS_URL.length > 0;
/** campus-service base URL (no trailing slash; the app appends the /v1 paths itself, like the others). */
export const CAMPUS_SERVICE_URL = trim(process.env.EXPO_PUBLIC_CAMPUS_SERVICE_URL);
export const CAMPUS_SERVICE_CONFIGURED = CAMPUS_SERVICE_URL.length > 0;
export const REALTIME_URL = trim(process.env.EXPO_PUBLIC_REALTIME_URL);

/** Optional: one folder serving MediaPipe's vision_bundle.mjs, wasm/ and pose_landmarker_lite.task.
 *  Unset: jsDelivr and Google's model storage, as the browser coach uses. */
export const POSE_ASSETS_URL = trim(process.env.EXPO_PUBLIC_POSE_ASSETS_URL);

/** Development only: the live-workout debug overlay and [FRAME]/[POSE]/[EXERCISE] logs
 *  (EXPO_PUBLIC_POSE_DEBUG=1 at build time). Never set it for a production build. */
export const POSE_DEBUG = process.env.EXPO_PUBLIC_POSE_DEBUG === '1';
