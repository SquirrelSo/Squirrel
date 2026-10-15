/**
 * One shared workout session, as the server sees it (Exercise). Nothing here decides on its own
 * that the partner joined, got ready or did a rep — those only arrive from the server (socket, or a
 * 2 s poll while it's down). Your own rep count is yours (you tap it) and is reported up with a
 * per-session `seq` that goes up on every tap and undo, so retries and undo are both safe.
 * Who earned XP for the race is the server's alone: it arrives once, in workout.session.completed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { sharedWorkoutApi, sharedWorkoutErrorCode, subscribeSession } from '@/api/sharedWorkout';
import type { SharedWorkoutCompleted } from '@/api/featureContracts';
import { applyCancelled, applyInvited, applyReps, clockOffset, mySeat, secondsUntil, theirSeat, type LinkState, type SessionUpdate, type SharedWorkoutSession } from '@/logic/sharedWorkout';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'lost';

const LOST_AFTER_MS = 15_000;
const REPORT_EVERY_MS = 500;

/** `enabled`: false until the signed-in token has loaded (a cold start from an invite link mustn't race it). */
export function useSharedWorkout(sessionId: string, enabled = true) {
  const [session, setSession] = useState<SharedWorkoutSession | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [conn, setConn] = useState<Connection>('connecting');
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [myReps, setMyReps] = useState(0);
  const [completed, setCompleted] = useState<SharedWorkoutCompleted | null>(null);
  const seq = useRef(0);
  const repsRef = useRef(0);
  const troubleSince = useRef<number | null>(null);

  const accept = useCallback((s: SharedWorkoutSession) => {
    setSession(s);
    setOffset(clockOffset(s));
    // Reopened mid-race: carry on from what the server already holds for you.
    const me = mySeat(s);
    if (me) {
      seq.current = Math.max(seq.current, me.seq);
      if (me.reps > repsRef.current && seq.current === me.seq) {
        repsRef.current = me.reps;
        setMyReps(me.reps);
      }
    }
  }, []);

  const trouble = useCallback(() => {
    troubleSince.current ??= Date.now();
    setConn(Date.now() - troubleSince.current > LOST_AFTER_MS ? 'lost' : 'reconnecting');
  }, []);
  const healthy = useCallback(() => {
    troubleSince.current = null;
    setConn('live');
  }, []);

  const load = useCallback(async () => {
    try {
      accept(await sharedWorkoutApi.get(sessionId));
      setLoadError(null);
      healthy();
    } catch (e) {
      setLoadError(e);
    }
  }, [accept, healthy, sessionId]);

  useEffect(() => {
    if (!enabled) return;
    let off = false;
    sharedWorkoutApi.get(sessionId).then(
      (x) => !off && accept(x),
      (e) => !off && setLoadError(e),
    );
    return () => {
      off = true;
    };
  }, [sessionId, accept, enabled]);

  // Live updates, once the session has loaded (so a capability that's off never opens a socket).
  const loaded = !!session;
  useEffect(() => {
    if (!loaded) return;
    const onState = (st: LinkState) => (st === 'trouble' ? trouble() : st === 'connecting' ? setConn('connecting') : healthy());
    const onUpdate = (u: SessionUpdate) => {
      if (u.kind === 'session') accept(u.session);
      else if (u.kind === 'reps') setSession((s) => (s ? applyReps(s, u.update) : s));
      else if (u.kind === 'invited') setSession((s) => (s ? applyInvited(s, u.update) : s));
      else if (u.kind === 'cancelled') setSession((s) => (s ? applyCancelled(s, u.update) : s));
      else if (u.update.session_id === sessionId) setCompleted(u.update);
    };
    return subscribeSession(sessionId, onUpdate, onState);
  }, [sessionId, loaded, accept, trouble, healthy]);

  // A 250 ms clock, read against the server's (offset from server_time).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // Rep reports: the latest total, at most every 500 ms, with the seq it was tapped at.
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const flush = useCallback(async () => {
    flushTimer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    const [reps, at] = [repsRef.current, seq.current];
    try {
      await sharedWorkoutApi.reportReps(sessionId, reps, at);
      healthy();
    } catch (e) {
      if (e instanceof ApiError && sharedWorkoutErrorCode(e) === 'not_racing') return; // over (or you finished/left): nothing to resend
      trouble();
      if (seq.current === at) dirty.current = true; // nothing newer since: send this one again next time
      flushTimer.current ??= setTimeout(() => void flush(), REPORT_EVERY_MS);
    }
  }, [sessionId, healthy, trouble]);
  useEffect(() => () => { if (flushTimer.current) clearTimeout(flushTimer.current); }, []);

  /** +1 for a rep, -1 for undo. Every change gets its own seq, undo included. */
  const tapRep = useCallback(
    (delta: 1 | -1) => {
      const next = Math.max(0, repsRef.current + delta);
      if (next === repsRef.current) return false;
      repsRef.current = next;
      seq.current += 1;
      setMyReps(next);
      dirty.current = true;
      flushTimer.current ??= setTimeout(() => void flush(), REPORT_EVERY_MS);
      return true;
    },
    [flush],
  );

  const act = useCallback(
    async (fn: () => Promise<SharedWorkoutSession>) => {
      const s = await fn();
      accept(s);
      return s;
    },
    [accept],
  );

  const serverNow = now + offset;
  return {
    session,
    loadError,
    reload: load,
    conn,
    serverNow,
    me: mySeat(session),
    partner: theirSeat(session),
    myReps,
    secondsToStart: session ? secondsUntil(session.starts_at, serverNow) : null,
    secondsLeft: session ? secondsUntil(session.ends_at, serverNow) : null,
    tapRep,
    setReady: (ready: boolean) => act(() => sharedWorkoutApi.setReady(sessionId, ready)),
    /** Your final count: sent now (not throttled), and it ends your race. */
    finish: () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      dirty.current = false;
      seq.current += 1;
      return act(() => sharedWorkoutApi.complete(sessionId, repsRef.current, seq.current));
    },
    leave: () => act(() => sharedWorkoutApi.leave(sessionId)),
    /** The settled race (who finished, who the server rewarded), when this screen saw it settle. */
    completed,
    /** Host, lobby: invite one of your Partner Hunt buddies by their Social profile id. */
    invite: (socialProfileId: string) => act(() => sharedWorkoutApi.invite(sessionId, socialProfileId)),
    /** Host, before the countdown: closes the lobby for everyone. */
    cancel: () => act(() => sharedWorkoutApi.cancel(sessionId)),
  };
}
