import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { ApiError, setApiToken, setTokenRefresher } from '@/api/client';
import { setCampusEmail } from '@/api/campus/social';
import { communityApi } from '@/api/community';
import { API_CONFIGURED, AUTH_CONFIGURED, CAMPUS_API_CONFIGURED, EXERCISE_API_CONFIGURED, SOCIAL_API_CONFIGURED } from '@/api/config';
import { exerciseApi, type ExerciseUser } from '@/api/exercise';
import { invalidateRemote } from '@/api/useRemote';
import { profileApi } from '@/api/social';
import { accountApi, type TokenPair } from '@/auth/account';
import { jwtEmailVerified, jwtSubject } from '@/auth/jwt';
import { unregisterPush, usePushNotifications } from '@/notifications/push';
import { resetTerritories } from '@/state/territoryStore';
import { looksLikeEmail, normalizeIndianMobile, splitFullName } from '@/logic/accessSignup';

/** Some backend that authenticates the bearer token is configured. */
const BEARER_BACKEND = API_CONFIGURED || CAMPUS_API_CONFIGURED || EXERCISE_API_CONFIGURED || SOCIAL_API_CONFIGURED;

const NO_ACCOUNT_SERVER = 'No account server is configured. Set EXPO_PUBLIC_EXERCISE_API_URL, or explore the demo.';

export { isAcademicEmail } from '@/logic/accessSignup';
/**
 * Authentication. One Squirrel Social account (Exercise backend, /api/auth) signs in to every
 * backend: the Run Module and the Social service accept the same bearer token, and the Exercise
 * backend serves /api/users/{id}/... only to that account.
 *  - Email code: POST /api/auth/email/start sends a 6-digit code to a .ac.in address, and
 *    /api/auth/email/verify exchanges it for tokens. A new address becomes an account (it needs a
 *    first name); there is no password.
 *  - Password sign-in stays for accounts made with one (older builds), under "Other options".
 *  - A developer can paste a hand-issued token, or use demo mode.
 * Tokens live in SecureStore (localStorage on web). The 15-minute access token is refreshed
 * automatically (api/client.ts) with the stored single-use refresh token.
 */
type Mode = 'loading' | 'signed-out' | 'demo' | 'live';

export type Name = { first_name: string; last_name: string };

type AuthState = {
  mode: Mode;
  email: string | null;
  /** Signed-in user's id (JWT `sub`, a UUID), when live. */
  userId: string | null;
  /**
   * The account has proved its email (the token's `ev` claim). Access-code accounts start without
   * it and get it the first time they sign in with an emailed code. False when signed out.
   */
  emailVerified: boolean;
  apiConfigured: boolean;
  authConfigured: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  /**
   * Email-code sign-in: request sends a code, verify exchanges it for tokens (and marks the email
   * verified, so a signed-in access-code account can verify in place).
   * `newAccount`: the address has no account yet, so verify needs a name. There is no simulated code.
   */
  requestEmailCode: (email: string) => Promise<{ newAccount?: boolean }>;
  /** `invite`: a friend's invite code, claimed on a new account (best effort). */
  verifyEmailCode: (email: string, code: string, name?: Name, invite?: string) => Promise<{ newAccount: boolean }>;
  signUpWithAccessCode: (details: { email: string; full_name: string; phone: string; access_code: string }) => Promise<void>;
  signInWithToken: (token: string) => Promise<void>;
  continueDemo: () => void;
  signOut: () => Promise<void>;
  /** The email last used to sign in on this device (kept after sign-out, to pre-fill the form). */
  lastEmail: string | null;
  /** Why the user was signed out, when it wasn't their choice (shown on the sign-in screen). */
  notice: string | null;
  clearNotice: () => void;
  /** The signed-in account as the form coach sees it (null when signed out or not configured). */
  exerciseUser: ExerciseUser | null;
};

const KEY = 'squirrel.auth.token';
const REFRESH_KEY = 'squirrel.auth.refresh';
const EMAIL_KEY = 'squirrel.auth.email';
const NAME_KEY = 'squirrel.auth.name';
/** Not cleared on sign-out: only pre-fills the email field next time. */
const LAST_EMAIL_KEY = 'squirrel.auth.last-email';
/** Pre-account builds stored a bare coach id here, which anyone could link. Removed on launch. */
const LEGACY_EXERCISE_KEY = 'squirrel.exercise.user';

const store = {
  get: async (k: string) => (Platform.OS === 'web' ? globalThis.localStorage?.getItem(k) ?? null : SecureStore.getItemAsync(k)),
  set: async (k: string, v: string) => (Platform.OS === 'web' ? globalThis.localStorage?.setItem(k, v) : SecureStore.setItemAsync(k, v)),
  del: async (k: string) => (Platform.OS === 'web' ? globalThis.localStorage?.removeItem(k) : SecureStore.deleteItemAsync(k)),
};

const parseName = (raw: string | null): Name | null => {
  try {
    const n = raw ? (JSON.parse(raw) as Partial<Name>) : null;
    return n && typeof n.first_name === 'string' && typeof n.last_name === 'string' ? { first_name: n.first_name, last_name: n.last_name } : null;
  } catch {
    return null;
  }
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode>('loading');
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [name, setName] = useState<Name | null>(null);
  const [lastEmail, setLastEmail] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshToken = useRef<string | null>(null);
  const subject = useRef<string | null>(null);

  /** Never show one account's cached data (profile, crews, notifications…) to another. A refresh keeps it. */
  const forgetCachedData = useCallback((sub: string | null) => {
    if (sub === subject.current) return;
    subject.current = sub;
    invalidateRemote('');
    resetTerritories();
  }, []);

  const clear = useCallback(async () => {
    await Promise.all([KEY, REFRESH_KEY, EMAIL_KEY, NAME_KEY].map(store.del));
    refreshToken.current = null;
    forgetCachedData(null);
    setApiToken(null);
    setUserId(null);
    setEmailVerified(false);
    setEmail(null);
    setName(null);
  }, [forgetCachedData]);

  const applyAccess = useCallback(
    (access: string) => {
      const sub = jwtSubject(access);
      forgetCachedData(sub);
      setApiToken(access);
      setUserId(sub);
      setEmailVerified(jwtEmailVerified(access));
    },
    [forgetCachedData],
  );

  /** Persist a fresh pair from sign-in or refresh. */
  const savePair = useCallback(
    async (pair: TokenPair) => {
      refreshToken.current = pair.refresh_token;
      await Promise.all([store.set(KEY, pair.access_token), store.set(REFRESH_KEY, pair.refresh_token)]);
      applyAccess(pair.access_token);
    },
    [applyAccess],
  );

  // One refresher for the whole app. Only a refresh token the server rejects (401) ends the
  // session; no connection, a rate limit (429) or a server error leaves the user signed in, and
  // the next request simply tries again.
  useEffect(() => {
    setTokenRefresher(async () => {
      const current = refreshToken.current;
      if (!current) return null;
      try {
        const pair = await accountApi.refresh(current);
        await savePair(pair);
        return pair.access_token;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          await clear();
          setMode('signed-out');
          setNotice('Your session ended. Please sign in again.');
          router.replace('/sign-in');
        }
        return null;
      }
    });
    return () => setTokenRefresher(null);
  }, [savePair, clear]);

  useEffect(() => {
    (async () => {
      try {
        store.del(LEGACY_EXERCISE_KEY).catch(() => undefined);
        const [t, r, e, n, last] = await Promise.all([store.get(KEY), store.get(REFRESH_KEY), store.get(EMAIL_KEY), store.get(NAME_KEY), store.get(LAST_EMAIL_KEY)]);
        setLastEmail(last);
        if (t && BEARER_BACKEND) {
          refreshToken.current = r;
          applyAccess(t);
          setEmail(e);
          setName(parseName(n));
          setMode('live');
        } else setMode('signed-out');
      } catch {
        setMode('signed-out');
      }
    })();
  }, [applyAccess]);

  const rememberName = useCallback(async (n: Name) => {
    setName(n);
    await store.set(NAME_KEY, JSON.stringify(n));
  }, []);

  const rememberEmail = useCallback(async (em: string) => {
    await Promise.all([store.set(EMAIL_KEY, em), store.set(LAST_EMAIL_KEY, em)]);
    setEmail(em);
    setLastEmail(em);
    setNotice(null);
  }, []);

  /** The name for greetings; the account works without it if the profile can't be read now. */
  const loadName = useCallback(
    async (id: string) => {
      if (!EXERCISE_API_CONFIGURED) return;
      const p = await exerciseApi.getProfile(id).catch(() => null);
      if (p) await rememberName({ first_name: p.first_name, last_name: p.last_name });
    },
    [rememberName],
  );

  const signIn = useCallback(
    async (em: string, password: string) => {
      if (!AUTH_CONFIGURED) throw new Error(NO_ACCOUNT_SERVER);
      const pair = await accountApi.login(em.trim(), password);
      await savePair(pair);
      await rememberEmail(em.trim());
      await loadName(pair.user_id);
      setMode('live');
    },
    [savePair, rememberEmail, loadName],
  );

  // Any address: an existing account (an access-code one too) gets a code whatever its domain, and
  // the server refuses new addresses outside the campus allow-list with its own message.
  const requestEmailCode = useCallback(async (em: string) => {
    if (!looksLikeEmail(em)) throw new Error('Enter your email address.');
    if (AUTH_CONFIGURED) {
      const r = await accountApi.emailStart(em.trim());
      return { newAccount: r.newAccount };
    }
    throw new Error('No account service is connected yet, so sign-in codes can’t be sent. Look around without signing in for now.');
  }, []);

  const verifyEmailCode = useCallback(
    async (em: string, code: string, newName?: Name, invite?: string) => {
      if (AUTH_CONFIGURED) {
        const pair = await accountApi.emailVerify(em.trim(), code.trim(), newName);
        await savePair(pair);
        await rememberEmail(em.trim());
        if (pair.new_account && newName) {
          await rememberName(newName);
          // The Social profile starts as "New Squirrel": give it the name just entered (best effort).
          if (SOCIAL_API_CONFIGURED) {
            const displayName = `${newName.first_name} ${newName.last_name}`.trim().slice(0, 40);
            const named = displayName ? profileApi.update({ display_name: displayName }).catch(() => undefined) : Promise.resolve();
            // A friend's invite code counts for them once this account exists, after the name is set
            // so their "joined with your invite" names this person. A failure is ignored (the
            // Invite screen takes it later).
            if (invite?.trim()) await named.then(() => communityApi.claimReferral(invite)).catch(() => undefined);
            else await named;
          }
        } else await loadName(pair.user_id);
        setMode('live');
        return { newAccount: pair.new_account };
      }
      throw new Error('No account service is connected yet.');
    },
    [savePair, rememberEmail, rememberName, loadName],
  );

  const signUpWithAccessCode = useCallback(async (details: { email: string; full_name: string; phone: string; access_code: string }) => {
    if (!AUTH_CONFIGURED) throw new Error(NO_ACCOUNT_SERVER);
    const email = details.email.trim();
    const full_name = details.full_name.trim().replace(/\s+/g, ' ');
    const pair = await accountApi.accessCodeSignup({ email, full_name, phone: normalizeIndianMobile(details.phone) ?? details.phone.trim(), access_code: details.access_code });
    await savePair(pair);
    await rememberEmail(email);
    await rememberName(splitFullName(full_name));
    setMode('live');
  }, [savePair, rememberEmail, rememberName]);

  const signInWithToken = useCallback(
    async (t: string) => {
      await store.set(KEY, t);
      refreshToken.current = null;
      applyAccess(t);
      setMode('live');
    },
    [applyAccess],
  );

  const signOut = useCallback(async () => {
    await unregisterPush(); // while the token still signs the request
    await clear();
    setMode('signed-out');
  }, [clear]);

  const exerciseUser = useMemo<ExerciseUser | null>(
    () => (mode === 'live' && userId ? { user_id: userId, first_name: name?.first_name ?? '', last_name: name?.last_name ?? '' } : null),
    [mode, userId, name],
  );

  useEffect(() => setCampusEmail(email), [email]);

  usePushNotifications(mode === 'live');

  return (
    <Ctx.Provider
      value={{
        mode,
        email,
        userId,
        emailVerified,
        apiConfigured: BEARER_BACKEND,
        authConfigured: AUTH_CONFIGURED,
        signIn,
        requestEmailCode,
        verifyEmailCode,
        signUpWithAccessCode,
        signInWithToken,
        continueDemo: () => setMode('demo'),
        signOut,
        lastEmail,
        notice,
        clearNotice: () => setNotice(null),
        exerciseUser,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used inside <AuthProvider>');
  return c;
}
