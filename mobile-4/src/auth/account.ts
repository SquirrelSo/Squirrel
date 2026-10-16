/**
 * Squirrel Social accounts (Exercise backend, /api/auth). One sign-in serves both backends: the
 * access token is a JWT signed with the secret the Run Module also verifies with, and its `sub`
 * is the account's UUID, which is also the Exercise user id.
 *
 *   POST /api/auth/email/start  { email }                          → 202 { new_account } · 403 not an allowed college address
 *   POST /api/auth/email/verify { email, code, first_name? , last_name? } → TokenPair & { new_account } · 400 bad code
 *                                                                    · 422 a new address without a name
 *   POST /api/auth/email-code { email }                                         → 202 · 403 not an allowed college address
 *   POST /api/auth/register { email, code, password (≥ 8), first_name, last_name } → 201 TokenPair · 409 email taken · 400 bad code
 *   POST /api/auth/login    { email, password }                              → TokenPair · 401
 *   POST /api/auth/refresh  { refresh_token }                                → TokenPair · 401 (single-use, rotates)
 */
import { ApiError, api } from '@/api/client';
import { AUTH_URL } from '@/api/config';
import { classifySignupError, emailStartRefused } from '@/logic/accessSignup';

export type TokenPair = {
  user_id: string;
  token_type: 'bearer';
  access_token: string;
  access_token_expires_at: number;
  refresh_token: string;
  refresh_token_expires_at: number;
};

/** `code`: the 6-digit code emailed by `emailCode` (sign-up is open to .ac.in college addresses). */
export type NewAccount = { email: string; password: string; first_name: string; last_name: string; code: string };

const auth = (path: string, body: unknown) => api<TokenPair>(`/api/auth${path}`, { body, base: AUTH_URL, anonymous: true });

/** Friendly wording for the sign-in screen; anything else keeps the server's own message. */
function explain(e: unknown, fallback: string): never {
  if (e instanceof ApiError) {
    if (e.status === 401) throw new Error('Wrong email or password.');
    if (e.status === 409) throw new Error('An account with this email already exists. Sign in instead.');
    if (e.status === 403) throw new Error(e.message || 'Use your college email (ending in .ac.in).');
    if (e.status === 0) throw new Error("Can't reach the server. Check your connection and try again.");
    throw new Error(e.message || fallback);
  }
  throw e instanceof Error ? e : new Error(fallback);
}

export type CodeSignIn = TokenPair & { new_account: boolean };

export const accountApi = {
  /** Emails a 6-digit code to sign in (or join: `newAccount` says the address has no account yet). */
  emailStart: (email: string) =>
    api<{ sent: boolean; expires_in_s: number; new_account: boolean }>('/api/auth/email/start', { body: { email }, base: AUTH_URL, anonymous: true })
      .then((r) => ({ expiresInS: r.expires_in_s, newAccount: r.new_account }))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) throw emailStartRefused(email, e.message);
        return explain(e, 'Could not send the code.');
      }),
  /** The code for tokens. A new address needs `name` (first name at least). */
  emailVerify: (email: string, code: string, name?: { first_name: string; last_name: string }) =>
    api<CodeSignIn>('/api/auth/email/verify', { body: { email, code, ...(name ?? {}) }, base: AUTH_URL, anonymous: true }).catch((e) => {
      if (e instanceof ApiError && e.status === 400) throw new Error('That code didn’t work. Check it, or ask for a new one.');
      return explain(e, 'Sign-in failed.');
    }),
  /**
   * Separate non-campus registration; all four fields are required by the Exercise backend.
   * Failures are SignupErrors that name the field to fix, so the form can return to that step.
   */
  accessCodeSignup: (details: { email: string; full_name: string; phone: string; access_code: string }) =>
    api<TokenPair>('/api/auth/signup/access-code', { body: details, base: AUTH_URL, anonymous: true }).catch((e) => {
      if (e instanceof ApiError) throw classifySignupError(e.status, e.body, e.message);
      throw e instanceof Error ? e : new Error('Sign-up failed. Try again in a moment.');
    }),
  login: (email: string, password: string) => auth('/login', { email, password }).catch((e) => explain(e, 'Sign-in failed.')),
  register: (account: NewAccount) => auth('/register', account).catch((e) => explain(e, 'Could not create the account.')),
  /** Emails a 6-digit sign-up code; resolves to how long it works (seconds). */
  emailCode: (email: string) =>
    api<{ sent: boolean; expires_in_s: number }>('/api/auth/email-code', { body: { email }, base: AUTH_URL, anonymous: true })
      .then((r) => r.expires_in_s)
      .catch((e) => explain(e, 'Could not send the code.')),
  /** No friendly wording: a failed refresh just means "sign in again". */
  refresh: (refreshToken: string) => auth('/refresh', { refresh_token: refreshToken }),
};
