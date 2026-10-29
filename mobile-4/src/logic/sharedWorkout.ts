/**
 * Workout with Partner — the rules the screens follow, from Exercise's contract
 * (/api/workout-sessions, the "Shared Workout API" page). Pure, so it's unit-tested without the app.
 *
 * The server decides the phase from timestamps (lobby · expired · countdown · racing · finished) and
 * says which seat is yours (`you`). Between updates the app may tick the phase over itself from
 * those same timestamps and `server_time`; it never decides anything the server hasn't sent.
 */
import type { PersonLite } from '@/api/campus/types';
import type { SharedWorkoutCompleted } from '@/api/featureContracts';

export type SessionPhase = 'lobby' | 'expired' | 'countdown' | 'racing' | 'finished';
export type Seat = 'host' | 'partner';
export const RACE_DURATIONS_S = [60, 180, 300] as const;
export type RaceDuration = (typeof RACE_DURATIONS_S)[number];

export type WorkoutParticipant = {
  user: PersonLite;
  role: Seat;
  ready: boolean;
  /** Socket open, or a request from them in the last 10 s. */
  connected: boolean;
  /** Their latest accepted running total, and the seq it came with. */
  reps: number;
  seq: number;
  /** When they tapped Finish, or ends_at once time ran out. */
  finished_at: string | null;
  left_at: string | null;
  /** "closed": the lobby was closed for both (never says why). "cancelled": the host called it off. */
  left_reason: 'left' | 'disconnected' | 'closed' | 'cancelled' | null;
  /** Once settled: whether the server awarded this player the finish XP. null before; older servers omit it. */
  rewarded?: boolean | null;
};

/** The host's invitation to one of their Partner Hunt buddies. `user.user_id` is their Social profile id. */
export type WorkoutInvite = { user: PersonLite; status: 'invited' | 'declined'; invited_at: string };

export type SharedWorkoutSession = {
  session_id: string;
  invite_code: string;
  /** Opens the app at /workout/join/{code}. */
  invite_url: string;
  exercise: { key: string; name: string };
  duration_s: number;
  phase: SessionPhase;
  /** Your seat, or null for a preview by someone not in it (or after leaving a lobby). */
  you: Seat | null;
  host: WorkoutParticipant;
  partner: WorkoutParticipant | null;
  created_at: string;
  expires_at: string;
  starts_at: string | null;
  ends_at: string | null;
  /** "hand_tapped" for now. XP is for finishing, not per rep (see SHARED_RACE_XP). */
  rep_source: string;
  /** Only the players see these; an invite preview gets []. Older servers leave it out. */
  invites?: WorkoutInvite[];
  /** Set once the server has settled the race (who earned XP: each seat's `rewarded`, and workout.session.completed). */
  completed_at?: string | null;
  /** Count down against this, never the phone's clock. */
  server_time: string;
};

export type RepsUpdate = { session_id: string; user_id: string; reps: number; seq: number; at: string };

export const mySeat = (s: SharedWorkoutSession | null): WorkoutParticipant | null => (s?.you ? s[s.you] : null);
export const theirSeat = (s: SharedWorkoutSession | null): WorkoutParticipant | null => (s?.you === 'host' ? s.partner : s?.you === 'partner' ? s.host : null);

/** Milliseconds to add to the phone's clock to read the server's (from `server_time`). */
export const clockOffset = (s: SharedWorkoutSession, phoneNow = Date.now()) => Date.parse(s.server_time) - phoneNow;

/** The server's phase, ticked over locally at starts_at / ends_at / expires_at until its update lands. */
export function livePhase(s: SharedWorkoutSession, serverNow: number): SessionPhase {
  const at = (t: string | null) => (t ? Date.parse(t) : null);
  const starts = at(s.starts_at);
  const ends = at(s.ends_at);
  if (s.phase === 'lobby') return serverNow >= Date.parse(s.expires_at) ? 'expired' : 'lobby';
  if (s.phase === 'countdown' || s.phase === 'racing') {
    if (ends != null && serverNow >= ends) return 'finished';
    if (starts != null && serverNow >= starts) return 'racing';
    return 'countdown';
  }
  return s.phase;
}

/** What the session screen shows. */
export type ScreenPhase =
  | 'waiting' // lobby, nobody else in it yet: share the invite (also after the host left and you took over)
  | 'lobby' // both in: ready up
  | 'countdown'
  | 'racing'
  | 'you_finished' // you're done; your partner is still racing
  | 'you_left' // you left a started race
  | 'result' // the race is over
  | 'closed' // finished before it ever started (closed for both, no reason given)
  | 'cancelled' // the host cancelled the lobby before the countdown
  | 'expired'
  | 'removed'; // you left the lobby and someone else is still in it: it's no longer yours

export function screenPhase(s: SharedWorkoutSession, serverNow: number): ScreenPhase {
  if (!s.you) return 'removed';
  const phase = livePhase(s, serverNow);
  const me = mySeat(s)!;
  if (phase === 'expired') return 'expired';
  if (phase === 'lobby') return s.partner ? 'lobby' : 'waiting';
  if (phase === 'finished') return s.starts_at ? (me.left_at ? 'you_left' : 'result') : me.left_reason === 'cancelled' ? 'cancelled' : 'closed';
  if (me.left_at) return 'you_left';
  if (me.finished_at) return 'you_finished';
  return phase;
}

/** Your partner dropped out mid-race: they stopped, you keep going. */
export const partnerLeftMidRace = (s: SharedWorkoutSession) => !!s.starts_at && !!theirSeat(s)?.left_at;

export const secondsUntil = (iso: string | null, serverNow: number) => (iso ? Math.max(0, Math.ceil((Date.parse(iso) - serverNow) / 1000)) : null);

/** "2:05" */
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
export const durationLabel = (s: number) => `${s / 60} min`;

export type RaceResult = { mine: number; theirs: number | null; outcome: 'won' | 'lost' | 'draw' | 'solo' };

/** Whoever has more reps when time runs out wins. Your count is the larger of what you tapped and what the server holds. */
export function raceResult(s: SharedWorkoutSession, myTapped = 0): RaceResult {
  const mine = Math.max(myTapped, mySeat(s)?.reps ?? 0);
  const them = theirSeat(s);
  if (!them) return { mine, theirs: null, outcome: 'solo' };
  return { mine, theirs: them.reps, outcome: mine > them.reps ? 'won' : mine < them.reps ? 'lost' : 'draw' };
}

/** A rep event for one seat: kept only when it's newer than what we hold (the server's seq rule). */
export function applyReps(s: SharedWorkoutSession, u: RepsUpdate): SharedWorkoutSession {
  if (u.session_id !== s.session_id) return s;
  const patch = (p: WorkoutParticipant | null) => (p && p.user.user_id === u.user_id && u.seq > p.seq ? { ...p, reps: u.reps, seq: u.seq } : p);
  return { ...s, host: patch(s.host)!, partner: patch(s.partner) };
}

/** The host can cancel (and invite) only before the countdown: the lobby, with or without a partner. */
export const canCancel = (s: SharedWorkoutSession, serverNow: number) => s.you === 'host' && !s.starts_at && livePhase(s, serverNow) === 'lobby';

/** Where one buddy stands with this session's invitations: not asked yet, waiting, or said no. */
export const inviteStatus = (s: SharedWorkoutSession, socialProfileId: string): WorkoutInvite['status'] | null =>
  (s.invites ?? []).find((i) => i.user.user_id.toLowerCase() === socialProfileId.toLowerCase())?.status ?? null;

/** At most this many invitations wait at once (the server's MAX_PENDING_INVITES; 429 beyond it). */
export const MAX_PENDING_INVITES = 3;
export const pendingInvites = (s: SharedWorkoutSession) => (s.invites ?? []).filter((i) => i.status === 'invited').length;

/** What a refused invite means (POST …/{id}/invite). Each code its own sentence; anything else, the server's. */
export function inviteRefusal(code: string | null, message: string): string {
  switch (code) {
    case 'not_a_buddy':
      return 'You can only invite your Partner Hunt connections.';
    case 'too_many_invites':
      return `Up to ${MAX_PENDING_INVITES} invitations can wait at once. Wait for an answer first.`;
    case 'session_full':
      return 'Someone has already joined.';
    case 'not_in_lobby':
      return 'Invitations can only go out from the lobby.';
    case 'not_host':
      return 'Only the host can invite.';
    default:
      return message;
  }
}

/** workout.session.invited: add (or update) that invitation; the session update that follows agrees. */
export function applyInvited(s: SharedWorkoutSession, u: InvitedUpdate): SharedWorkoutSession {
  if (u.session_id !== s.session_id) return s;
  const others = (s.invites ?? []).filter((i) => i.user.user_id !== u.invite.user.user_id);
  return { ...s, invites: [...others, u.invite] };
}

/** workout.session.cancelled: the host called the lobby off, so every seat left "cancelled" at that moment. */
export function applyCancelled(s: SharedWorkoutSession, u: CancelledUpdate): SharedWorkoutSession {
  if (u.session_id !== s.session_id || s.starts_at) return s;
  const off = (p: WorkoutParticipant | null) => (p && !p.left_at ? { ...p, ready: false, left_at: u.at, left_reason: 'cancelled' as const } : p);
  return { ...s, phase: 'finished', host: off(s.host)!, partner: off(s.partner) };
}

/** XP the server's shared_workout_finished award is worth (Run Module, at most three a day). Shown, never sent. */
export const SHARED_RACE_XP = 20;

/** Your line of the settled race (workout.session.completed), found by your seat's Social profile id. */
export function myCompletedResult(s: SharedWorkoutSession | null, c: SharedWorkoutCompleted | null) {
  const me = mySeat(s);
  if (!s || !c || !me || c.session_id !== s.session_id) return null;
  return c.results.find((r) => r.user.user_id === me.user.user_id) ?? null;
}

/** The per-session socket: the Exercise base with http(s) → ws(s). */
export function sessionSocketUrl(base: string, sessionId: string, token: string) {
  return `${base.replace(/\/+$/, '').replace(/^http/i, 'ws')}/ws/workout-sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Live updates: the session's socket, with a 2 s poll whenever it's down
// ---------------------------------------------------------------------------

export type InvitedUpdate = { session_id: string; invite: WorkoutInvite };
export type CancelledUpdate = { session_id: string; at: string };
export type SessionUpdate =
  | { kind: 'session'; session: SharedWorkoutSession }
  | { kind: 'reps'; update: RepsUpdate }
  | { kind: 'invited'; update: InvitedUpdate }
  | { kind: 'cancelled'; update: CancelledUpdate }
  | { kind: 'completed'; update: SharedWorkoutCompleted };
export type LinkState = 'connecting' | 'live' | 'trouble' | 'gone';

type SocketLike = {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
};

export type LinkDeps = {
  openSocket: (url: string) => SocketLike;
  socketUrl: (token: string) => string;
  getToken: () => string | null;
  refreshToken: () => Promise<string | null>;
  poll: () => Promise<SharedWorkoutSession>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
};

export const PING_EVERY_MS = 10_000;
export const POLL_EVERY_MS = 2_000;
const SOCKET_RETRY_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

/**
 * Opens the session's socket. While it's down (refused, dropped, never connected) it polls
 * GET /api/workout-sessions/{id} every 2 s and retries the socket in the background, backing off.
 * Close codes: 1000 = the session is over (stop, nothing more will come), 4401 = refresh the token
 * and reconnect, 4404 = not yours (stop). Returns a stop function.
 */
export function startSessionLink(deps: LinkDeps, onUpdate: (u: SessionUpdate) => void, onState: (s: LinkState) => void): () => void {
  let stopped = false;
  let socket: SocketLike | null = null;
  let pingTimer: unknown = null;
  let pollTimer: unknown = null;
  let retryTimer: unknown = null;
  let attempt = 0;
  let refreshedOnce = false;

  const clear = (t: unknown) => t != null && deps.clearTimer(t);
  const stopPolling = () => {
    clear(pollTimer);
    pollTimer = null;
  };
  const pollLoop = () => {
    if (stopped || pollTimer != null) return;
    const tick = async () => {
      if (stopped) return;
      try {
        onUpdate({ kind: 'session', session: await deps.poll() });
        onState('live');
      } catch {
        onState('trouble');
      }
      if (!stopped && pollTimer != null) pollTimer = deps.setTimer(tick, POLL_EVERY_MS);
    };
    pollTimer = deps.setTimer(tick, POLL_EVERY_MS);
  };
  const retryLater = () => {
    if (stopped || retryTimer != null) return;
    const wait = SOCKET_RETRY_MS[Math.min(attempt, SOCKET_RETRY_MS.length - 1)];
    attempt += 1;
    retryTimer = deps.setTimer(() => {
      retryTimer = null;
      connect();
    }, wait);
  };
  const finish = (state: LinkState) => {
    stopped = true;
    stopPolling();
    clear(pingTimer);
    clear(retryTimer);
    onState(state);
  };

  function connect() {
    if (stopped) return;
    const token = deps.getToken();
    if (!token) {
      pollLoop();
      retryLater();
      return;
    }
    let ws: SocketLike;
    try {
      ws = deps.openSocket(deps.socketUrl(token));
    } catch {
      pollLoop();
      retryLater();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      if (stopped) return ws.close();
      attempt = 0;
      refreshedOnce = false;
      stopPolling();
      onState('live');
      clear(pingTimer);
      const ping = () => {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // a dead socket shows up as onclose
        }
        pingTimer = deps.setTimer(ping, PING_EVERY_MS);
      };
      pingTimer = deps.setTimer(ping, PING_EVERY_MS);
    };
    ws.onmessage = (e) => {
      let m: { type?: string; data?: unknown };
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.type === 'workout.session.updated') onUpdate({ kind: 'session', session: m.data as SharedWorkoutSession });
      else if (m.type === 'workout.reps.updated') onUpdate({ kind: 'reps', update: m.data as RepsUpdate });
      else if (m.type === 'workout.session.invited') onUpdate({ kind: 'invited', update: m.data as InvitedUpdate });
      else if (m.type === 'workout.session.cancelled') onUpdate({ kind: 'cancelled', update: m.data as CancelledUpdate });
      else if (m.type === 'workout.session.completed') onUpdate({ kind: 'completed', update: m.data as SharedWorkoutCompleted });
    };
    ws.onerror = () => {
      // onclose follows
    };
    ws.onclose = (e) => {
      if (socket !== ws || stopped) return;
      socket = null;
      clear(pingTimer);
      pingTimer = null;
      if (e.code === 1000) return finish('gone'); // finished, expired, or you left the lobby: the last update came first
      if (e.code === 4404) return finish('gone');
      if (e.code === 4401 && !refreshedOnce) {
        refreshedOnce = true;
        pollLoop();
        deps.refreshToken().then(
          () => connect(),
          () => retryLater(),
        );
        return;
      }
      onState('trouble');
      pollLoop();
      retryLater();
    };
  }

  onState('connecting');
  connect();
  return () => {
    stopped = true;
    stopPolling();
    clear(pingTimer);
    clear(retryTimer);
    const ws = socket;
    socket = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  };
}
