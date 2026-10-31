/**
 * App-wide client state. It holds NO sample content: no seeded people, posts, crews, missions,
 * coins or XP. Everything shown about you or anyone else comes from a backend:
 *   - XP / level: the progress-service (when configured and signed in), or the Run Module's
 *     total after a run (`syncServerXp`). Until a server has answered, they're `null` and the UI
 *     says so instead of showing a number.
 *   - Runs: the Run Module (run.tsx); exercise sessions: the Exercise service + progress-service.
 * What stays here is genuinely local: toasts, your avatar look, the exercise session in progress
 * and what you finished on this phone today.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState as RNAppState } from 'react-native';
import { progressApi, progressReadsLive } from '@/api/progress';
import { useAuth } from '@/auth/AuthProvider';
import { exerciseXp, runXp, type XpLine } from '@/logic/xp';
import type { Verdict } from '@/logic/track';
import type { AvatarLook } from '@/types';

export const XP_PER_LEVEL = 2000;

/** A neutral starting look for your own avatar (your setting, edited in Avatar). Not a person. */
export const DEFAULT_LOOK: AvatarLook = {
  body: 'female',
  skin: '#C98A5E',
  hair: 'short',
  hairColor: '#1A1116',
  top: 'hoodie',
  topColor: '#16101E',
  bottom: 'joggers',
  bottomColor: '#1B1524',
  shoeColor: '#FFFFFF',
  accessory: 'none',
};

/** `action`: one button (e.g. Undo); such a toast stays `ms` long (default 2.6 s). */
export type ToastOpts = { action?: { label: string; onPress: () => void }; ms?: number };
export type ToastMsg = { id: number; text: string; icon?: string; color?: string } & ToastOpts;

/** You, as far as this phone knows. The name/id are the signed-in account's, never invented. */
export type Me = { id: string; name: string | null; look: AvatarLook };

type AppState = {
  me: Me;
  look: AvatarLook;
  setLook: (l: AvatarLook) => void;
  // progression — null until a server has reported it
  xp: number | null;
  level: number | null;
  levelXp: number | null;
  /** XP earned today, per the progress-service (null when it isn't connected). */
  xpToday: number | null;
  // runs (Run Module)
  finishRun: (run: FinishRunInput) => FinishRunResult;
  /** Replace the XP total with the server's (Run Module GET /v1/users/me/xp). */
  /** The server's XP total; `gained` (when the server reported it) adds to today's XP. */
  syncServerXp: (total: number, gained?: number) => void;
  // exercise
  /** The exercise session in progress (one at a time), or null. */
  activeExercise: ActiveExercise | null;
  beginExercise: (a: Omit<ActiveExercise, 'startedAt'>) => boolean;
  endExercise: () => void;
  /** Record a finished exercise: today's activity, and report it to the progress-service. */
  completeExercise: (c: CompletedExercise) => { xp: number; lines: XpLine[]; leveledUp: boolean };
  exerciseToday: { sessions: number; minutes: number; kcal: number };
  // feedback
  toasts: ToastMsg[];
  toast: (text: string, icon?: string, color?: string, opts?: ToastOpts) => void;
  dismissToast: (id: number) => void;
};

export type ActiveExercise = { key: string; sessionId?: string; startedAt: number };
export type CompletedExercise = { key: string; slug: string; reps: number; timedSeconds: number; activeSeconds: number; kcal: number };

export type FinishRunInput = { km: number; minutes: number; verdict: Verdict; districtId?: string; serverXp?: number; serverLines?: XpLine[] };
export type FinishRunResult = { xp: number; lines: XpLine[]; capped: boolean; leveledUp: boolean };

const Ctx = createContext<AppState | null>(null);

const levelOf = (xp: number) => Math.floor(xp / XP_PER_LEVEL) + 1;

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const { mode, userId, email } = useAuth();
  const [look, setLook] = useState<AvatarLook>(DEFAULT_LOOK);
  // XP as last reported by a server; only exposed while signed in (signed out → null).
  const [serverXp, setXp] = useState<number | null>(null);
  const xpRef = useRef<number | null>(null);
  const [serverXpToday, setXpToday] = useState<number | null>(null);
  const [runXpToday, setRunXpToday] = useState(0);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastId = useRef(0);
  const [activeExercise, setActiveExercise] = useState<ActiveExercise | null>(null);
  const activeExerciseRef = useRef<ActiveExercise | null>(null);
  const [exerciseToday, setExerciseToday] = useState({ sessions: 0, minutes: 0, kcal: 0 });

  const setServerXp = useCallback((total: number) => {
    xpRef.current = total;
    setXp(total);
  }, []);

  const toast = useCallback((text: string, icon?: string, color?: string, opts?: ToastOpts) => {
    const id = ++toastId.current;
    const ms = opts?.ms ?? 2600;
    setToasts((t) => [...t.slice(-2), { id, text, icon, color, ...opts, ms }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  // ---- XP from the Run Module (GET /v1/xp), the XP authority, whenever it's configured and we're signed in:
  // read on sign-in, on foreground and after each workout, so nothing here is client-decided.
  const live = progressReadsLive(mode);
  const syncProgress = useCallback(async () => {
    try {
      const x = await progressApi.xp();
      setServerXp(x.totalXp);
      setXpToday(x.today);
    } catch {
      // offline or signed out: try again on the next trigger
    }
  }, [setServerXp]);
  useEffect(() => {
    if (!live) return;
    const first = setTimeout(syncProgress, 0);
    const sub = RNAppState.addEventListener('change', (st) => st === 'active' && void syncProgress());
    return () => {
      clearTimeout(first);
      sub.remove();
    };
  }, [live, syncProgress]);

  /** A level-up is only ever reported against a real server total (and only while signed in). */
  const crossesLevel = (gain: number) => {
    const before = mode === 'live' ? xpRef.current : null;
    if (before == null || gain <= 0) return false;
    return levelOf(before + gain) > levelOf(before);
  };

  const finishRun = useCallback(
    ({ km, verdict, serverXp, serverLines }: FinishRunInput): FinishRunResult => {
      if (verdict === 'rejected') return { xp: 0, lines: [{ label: 'Run rejected — no XP', xp: 0 }], capped: false, leveledUp: false };
      // Without the server's award, this is the Run Module's own estimate for THIS run (shown on
      // the summary). It never seeds a total: the total only ever comes from a server.
      const local = runXp(km, false, runXpToday);
      const gain = serverXp ?? local.total;
      const lines = serverLines ?? local.lines;
      setRunXpToday((x) => x + gain);
      const leveledUp = serverXp != null && crossesLevel(serverXp);
      if (serverXp != null && xpRef.current != null) setServerXp(xpRef.current + serverXp);
      return { xp: gain, lines, capped: local.capped && serverXp == null, leveledUp };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- crossesLevel only reads refs + mode
    [runXpToday, setServerXp, mode],
  );

  const name = mode === 'live' ? (email ? email.split('@')[0] : null) : null;
  // Signed out, the previous account's numbers are never shown.
  const xp = mode === 'live' ? serverXp : null;
  const xpToday = mode === 'live' ? serverXpToday : null;
  const value: AppState = {
    me: { id: userId ?? 'me', name, look },
    look,
    setLook,
    xp,
    level: xp == null ? null : levelOf(xp),
    levelXp: xp == null ? null : xp % XP_PER_LEVEL,
    xpToday,
    finishRun,
    syncServerXp: useCallback(
      (total: number, gained?: number) => {
        setServerXp(total);
        if (gained && gained > 0) setXpToday((t) => (t ?? 0) + gained);
      },
      [setServerXp],
    ),
    activeExercise,
    beginExercise: useCallback((a: Omit<ActiveExercise, 'startedAt'>) => {
      // Guard against duplicate sessions (double taps, two screens): first one wins.
      if (activeExerciseRef.current) return false;
      const active = { ...a, startedAt: Date.now() };
      activeExerciseRef.current = active;
      setActiveExercise(active);
      return true;
    }, []),
    endExercise: useCallback(() => {
      activeExerciseRef.current = null;
      setActiveExercise(null);
    }, []),
    completeExercise: useCallback(
      (c: CompletedExercise) => {
        const minutes = Math.max(1, Math.round(c.activeSeconds / 60));
        setExerciseToday((t) => ({ sessions: t.sessions + 1, minutes: t.minutes + minutes, kcal: t.kcal + c.kcal }));
        // The estimate for this session's summary. Nothing is reported from here: the camera workout
        // already reached the server through Exercise's own session row, which decides the real XP.
        const x = exerciseXp(c.reps, c.timedSeconds);
        if (live) void syncProgress();
        return { xp: x.total, lines: x.lines, leveledUp: false };
      },
      [live, syncProgress],
    ),
    exerciseToday,
    toasts,
    toast,
    dismissToast,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside <AppStateProvider>');
  return ctx;
}
