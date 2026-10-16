/**
 * The live coaching session: the app's side of the Exercise backend's /ws/setup and /ws/train.
 *
 * It follows the browser coach (Exercise_Mechanics--main/frontend-react, engine/useEngine.ts)
 * exactly, so the server sees the same stream from a phone as from a browser:
 *
 *   per set:  /ws/setup  (get into position; the server captures a baseline and says "ready")
 *          →  0.9 s "start" beat
 *          →  /ws/train (reps or a timed set; the server counts, scores and cues)
 *          →  rest  →  next set's /ws/setup  …  →  done
 *
 * Frames are `{ t_ms, keypoints }`: the 33 MediaPipe landmarks by name, in PIXELS of the camera
 * image, un-mirrored, visibility to 3 decimals; t_ms is a clock that stops while paused (the server
 * reads tempo from it). Frames are sent during setup and during a set, never while paused or
 * after the set has ended. Every server message is validated by the browser coach's own parser.
 *
 * No React Native imports: the workout screen subscribes to it, and it can run in Node too.
 */

import { POSE_DEBUG } from '@/api/config';
import { exerciseProfile, type ExerciseProfile } from './exerciseProfiles';
import { assessFraming, FramingStabilizer, type Framing } from './framing';
import { parseServerMessage } from './protocol/parse';
import type { WSError, WSSetup, WSTrain } from './protocol/types';
import type { WSTimedTrainContract } from './protocol/timedContract';

export const LANDMARK_NAMES = [
  'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner',
  'right_eye', 'right_eye_outer', 'left_ear', 'right_ear', 'mouth_left',
  'mouth_right', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky', 'left_index',
  'right_index', 'left_thumb', 'right_thumb', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle', 'left_heel',
  'right_heel', 'left_foot_index', 'right_foot_index',
] as const;

// Same values as the browser coach (frontend-react/src/config.ts).
export const START_SPLASH_MS = 900;
export const WS_RECONNECT_MS = 2000;
export const WS_BACKPRESSURE_CAP = 1 << 16;

/** Time to get into position (step back, stand straight) before each set's setup begins. Tracking
 *  runs so the person sees themselves, but nothing is sent: when it runs out, the server's
 *  stillness check and standing-baseline capture start on their own. */
export const GET_READY_SECONDS = 10;

/** One tracked camera frame: smoothed, normalized landmarks (x, y, z, visibility), or none. */
export type PoseFrame = {
  width: number;
  height: number;
  landmarks: [number, number, number, number][] | null;
  /** When the tracker captured the frame, on the tracker page's own clock (ms), if it says. */
  capturedAt?: number;
  /** How long the pose model took on this frame (ms), if the tracker says. */
  inferenceMs?: number;
};

/** Live pipeline figures for the debug overlay (POSE_DEBUG). */
export type CoachDebug = {
  fps: number;
  inferenceMs: number | null;
  width: number;
  height: number;
  /** This frame's framing, before stabilizing. */
  framing: Framing;
  phase: CoachPhase;
  /** The server's movement phase (e.g. descent, bottom) during a set. */
  movement: string | null;
  reps: number | null;
};

export type Keypoint = { x: number; y: number; z: number; v: number };
export type FrameMessage = { t_ms: number; keypoints: Record<string, Keypoint> };

/** Pixel keypoints exactly as the browser coach builds them (pose/usePose.ts sendKeypoints). */
export function toFrameMessage(frame: PoseFrame, tMs: number): FrameMessage {
  const keypoints: Record<string, Keypoint> = {};
  frame.landmarks?.forEach(([x, y, z, v], i) => {
    const name = LANDMARK_NAMES[i];
    if (!name) return;
    keypoints[name] = {
      x: Math.round(x * frame.width),
      y: Math.round(y * frame.height),
      z: Math.round((z ?? 0) * frame.width),
      v: Number((v ?? 1).toFixed(3)),
    };
  });
  return { t_ms: tMs, keypoints };
}

export type CoachPhase = 'getready' | 'setup' | 'starting' | 'training' | 'rest' | 'done';

export type SetResult = {
  set: number;
  /** Reps completed (rep exercises) or counted lifts (timed). */
  count: number;
  /** Average Workout Score for the set, when the server scored it. */
  score: number | null;
};

export type CoachState = {
  phase: CoachPhase;
  set: number;
  totalSets: number;
  measure: 'reps' | 'time';
  paused: boolean;
  connected: boolean;
  setup: WSSetup | null;
  train: WSTrain | null;
  /** Seconds of rest left, while resting. */
  restLeft: number | null;
  /** Seconds left to get into position, while getting ready. */
  getReadyLeft: number | null;
  /** While getting ready: whether the body is framed well enough to start (null before the first frame). */
  inView: boolean | null;
  /** While getting ready and during setup: framing quality and the one thing to fix, if any. */
  framing: Framing | null;
  results: SetResult[];
  /** The last error the server reported, or a connection that cannot recover. */
  error: WSError | null;
  /** True when the error ends the workout (the server refused the session). */
  fatal: boolean;
};

export type CoachOptions = {
  /** http(s) base of the Exercise backend; its ws(s) twin is used. */
  baseUrl: string;
  userId: string;
  /** The saved session. May come later (setSession): the get-ready countdown does not wait for it. */
  sessionId?: string;
  /** The session plan's exercise_id (e.g. 'squat', 'bicep_curl'), and its variant if any. */
  exercise: string;
  variant?: string;
  sets: number;
  measure: 'reps' | 'time';
  restSeconds: number;
  /** The signed-in access token, and a way to get a fresh one when the server refuses it. */
  getToken: () => string | null;
  refreshToken: () => Promise<string | null>;
  /** Injected for tests; default to the platform's. */
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
};

type Listener = (state: CoachState) => void;

const isTimed = (d: WSTrain): d is WSTimedTrainContract => (d as WSTimedTrainContract).set?.movement_type === 'time';

export class CoachSession {
  private state: CoachState;
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private socketFor: 'setup' | 'train' | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private restTimer: ReturnType<typeof setInterval> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private session: { id: string; exercise: string; variant?: string } | null;
  private refreshedOnce = false;
  private disposed = false;
  // Logical clock: stops while paused (browser coach usePose.ts logicalNow).
  private pausedTotal = 0;
  private pausedAt: number | null = null;
  // Tracker clock → logical clock: the smallest delivery delay seen, so frames are timed by when
  // they were captured even when messages from the tracker arrive late or in bursts.
  private captureOffset: number | null = null;
  private lastFrameT = -Infinity;
  // Framing (framing.ts) for this exercise's camera profile, and debug figures.
  private readonly profile: ExerciseProfile;
  private readonly framingStab = new FramingStabilizer();
  private stats: { fps: number; lastAt: number | null; inferenceMs: number | null; width: number; height: number; framing: Framing | null } =
    { fps: 0, lastAt: null, inferenceMs: null, width: 0, height: 0, framing: null };
  private lastLog = -Infinity;
  private readonly now: () => number;
  private readonly WS: typeof WebSocket;

  constructor(private readonly opts: CoachOptions) {
    this.now = opts.now ?? (() => (globalThis.performance ? globalThis.performance.now() : Date.now()));
    this.WS = opts.WebSocketImpl ?? globalThis.WebSocket;
    this.session = opts.sessionId ? { id: opts.sessionId, exercise: opts.exercise, variant: opts.variant } : null;
    this.profile = exerciseProfile(opts.exercise);
    this.state = {
      phase: 'getready', set: 1, totalSets: opts.sets, measure: opts.measure, paused: false, connected: false,
      getReadyLeft: null, inView: null, framing: null,
      setup: null, train: null, restLeft: null, results: [], error: null, fatal: false,
    };
  }

  // ---------------------------------------------------------------- public

  getState(): CoachState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.getReady();
  }

  /** The saved session, once the server has it. A setup that was waiting for it starts now. */
  setSession(id: string, exercise: string, variant?: string): void {
    this.session = { id, exercise, variant };
    if (this.state.phase === 'setup' && !this.ws && !this.disposed) this.open('setup');
  }

  /** Feed one tracked camera frame. Sent only when the server should be seeing it. */
  frame(frame: PoseFrame): void {
    const at = this.now();
    this.measure(frame, at);
    if (this.state.phase === 'getready' || this.state.phase === 'setup') {
      // Only a CHANGE of verdict re-renders the screen; the figures are for the debug overlay.
      const framing = this.framingStab.update(this.stats.framing!, at);
      if (framing.kind !== this.state.framing?.kind) this.update({ framing, inView: framing.ok });
    }
    if (this.state.phase === 'getready') return;
    const { phase, paused } = this.state;
    const sending = phase === 'setup' || phase === 'starting' || (phase === 'training' && !paused);
    const ws = this.ws;
    if (!sending || !ws || ws.readyState !== 1 /* OPEN */) return;
    if ((ws.bufferedAmount ?? 0) > WS_BACKPRESSURE_CAP) return;
    ws.send(JSON.stringify(toFrameMessage(frame, this.frameTime(frame))));
  }

  /** Live figures for the debug overlay. */
  debug(): CoachDebug {
    const t = this.state.train as (WSTrain & { phase?: string }) | null;
    return {
      fps: this.stats.fps,
      inferenceMs: this.stats.inferenceMs,
      width: this.stats.width,
      height: this.stats.height,
      framing: this.stats.framing ?? assessFraming(null, this.profile),
      phase: this.state.phase,
      movement: t?.phase ?? null,
      reps: t ? (isTimed(t) ? t.movement.counted_lifts : t.set.completed_reps) : null,
    };
  }

  pause(): void {
    if (this.state.paused) return;
    this.pausedAt = this.now();
    this.update({ paused: true });
  }

  resume(): void {
    if (!this.state.paused) return;
    if (this.pausedAt !== null) this.pausedTotal += this.now() - this.pausedAt;
    this.pausedAt = null;
    this.update({ paused: false });
  }

  /** Start the next set now instead of waiting out the rest. */
  skipRest(): void {
    if (this.state.phase === 'rest') this.nextSet();
  }

  addRest(seconds: number): void {
    if (this.state.restLeft !== null) this.update({ restLeft: this.state.restLeft + seconds });
  }

  /** End the workout early. Sets already finished stay recorded on the server. */
  end(): void {
    this.closeSocket();
    this.clearTimers();
    this.update({ phase: 'done', restLeft: null });
  }

  dispose(): void {
    this.disposed = true;
    this.closeSocket();
    this.clearTimers();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- sockets

  private url(endpoint: 'setup' | 'train'): string {
    const params = new URLSearchParams({
      exercise: this.session!.exercise,
      set_no: String(this.state.set),
      user_id: this.opts.userId,
      session_id: this.session!.id,
      token: this.opts.getToken() ?? '',
    });
    if (this.session!.variant) params.set('variant', this.session!.variant);
    const base = this.opts.baseUrl.replace(/\/+$/, '').replace(/^http/i, 'ws');
    return `${base}/ws/${endpoint}?${params.toString()}`;
  }

  private open(endpoint: 'setup' | 'train'): void {
    if (this.disposed || !this.session) return;
    this.closeSocket();
    const ws = new this.WS(this.url(endpoint));
    this.ws = ws;
    this.socketFor = endpoint;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.update(endpoint === 'setup'
        ? { connected: true, error: null, setup: null }
        : { connected: true, error: null });
    };
    ws.onmessage = (event: MessageEvent) => {
      if (ws !== this.ws) return;
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        raw = null;
      }
      const message = parseServerMessage(raw);
      if (!message) {
        this.update({ error: { code: 'INVALID_SERVER_MESSAGE', detail: 'The coaching stream sent an invalid message.' } });
        return;
      }
      if (message.type === 'setup.status' || message.type === 'setup.ready') this.onSetup(message.data);
      else if (message.type === 'train.status') this.onTrain(message.data);
      else if (message.type === 'setup.error' || message.type === 'train.error') this.update({ error: message.data });
    };
    ws.onclose = (event: CloseEvent) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.update({ connected: false });
      void this.onClosed(endpoint, event.code, event.reason);
    };
  }

  private async onClosed(endpoint: 'setup' | 'train', code: number, reason: string): Promise<void> {
    const { phase } = this.state;
    const stillNeeded = (endpoint === 'setup' && (phase === 'setup' || phase === 'starting'))
      || (endpoint === 'train' && phase === 'training');
    if (!stillNeeded || this.disposed) return;
    if (code === 1008) {
      // The server refused the connection. An expired sign-in is fixable once; nothing else is.
      if (reason === 'UNAUTHORIZED' && !this.refreshedOnce) {
        this.refreshedOnce = true;
        const fresh = await this.opts.refreshToken().catch(() => null);
        if (fresh) {
          this.open(endpoint);
          return;
        }
      }
      this.update({
        fatal: true,
        error: { code: reason || 'REFUSED', detail: reason === 'UNAUTHORIZED' ? 'Please sign in again.' : 'The coach refused this session.' },
      });
      return;
    }
    // Dropped (network, server restart): reconnect, as the browser coach does.
    this.later(() => this.open(endpoint), WS_RECONNECT_MS);
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.socketFor = null;
    if (ws && ws.readyState <= 1) ws.close();
  }

  // ---------------------------------------------------------------- server messages

  private onSetup(data: WSSetup): void {
    if (this.state.phase !== 'setup' || this.socketFor !== 'setup') return;
    this.refreshedOnce = false;
    this.update({ setup: data, error: null });
    if (data.phase === 'ready' && data.start && data.baseline_ready) {
      // A deterministic "start" beat before the set's socket opens (START_SPLASH_MS).
      this.update({ phase: 'starting' });
      this.later(() => {
        if (this.state.phase !== 'starting') return;
        this.update({ phase: 'training', train: null });
        this.open('train');
      }, START_SPLASH_MS);
    }
  }

  private onTrain(data: WSTrain): void {
    if (this.state.phase !== 'training' || this.state.paused) return;
    this.refreshedOnce = false;
    this.update({ train: data, error: null });
    const finished = isTimed(data) ? data.events.set_completed : data.events.set_cycle_completed;
    if (!finished) return;
    const result: SetResult = isTimed(data)
      ? { set: this.state.set, count: data.movement.counted_lifts, score: data.score.score }
      : { set: this.state.set, count: data.set.completed_reps, score: data.set.average_score };
    this.closeSocket();
    const results = [...this.state.results, result];
    if (this.state.set >= this.state.totalSets) {
      this.update({ phase: 'done', results });
      return;
    }
    this.update({ phase: 'rest', results, restLeft: this.opts.restSeconds });
    this.restTimer = setInterval(() => {
      const left = (this.state.restLeft ?? 0) - 1;
      if (left <= 0) this.nextSet();
      else this.update({ restLeft: left });
    }, 1000);
  }

  private nextSet(): void {
    if (this.restTimer) clearInterval(this.restTimer);
    this.restTimer = null;
    this.update({ set: this.state.set + 1, restLeft: null, setup: null, train: null, error: null });
    this.getReady();
  }

  private getReady(): void {
    this.framingStab.reset();
    this.update({ phase: 'getready', getReadyLeft: GET_READY_SECONDS, inView: null, framing: null });
    this.countdownTimer = setInterval(() => {
      const left = (this.state.getReadyLeft ?? 0) - 1;
      if (left <= 0) this.beginSetup();
      else this.update({ getReadyLeft: left });
    }, 1000);
  }

  private beginSetup(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.update({ phase: 'setup', getReadyLeft: null, inView: null, setup: null });
    if (this.session) this.open('setup'); // else setSession opens it when the session is saved
  }

  // ---------------------------------------------------------------- helpers

  /** The frame's time on the logical clock: its capture time when known, never going backwards
   *  (the server requires increasing t_ms). */
  private frameTime(frame: PoseFrame): number {
    const now = this.logicalNow();
    let t = now;
    if (frame.capturedAt !== undefined) {
      const offset = now - frame.capturedAt;
      if (this.captureOffset === null || offset < this.captureOffset) this.captureOffset = offset;
      t = frame.capturedAt + this.captureOffset;
    }
    t = Math.max(t, this.lastFrameT);
    this.lastFrameT = t;
    return t;
  }

  /** Frame rate, model time, resolution and framing of the latest frame (and a log line every
   *  2 s when POSE_DEBUG is on: never in production builds). */
  private measure(frame: PoseFrame, at: number): void {
    const s = this.stats;
    if (s.lastAt !== null) {
      const dt = at - s.lastAt;
      if (dt > 0) s.fps = s.fps ? s.fps + 0.15 * (1000 / dt - s.fps) : 1000 / dt;
    }
    s.lastAt = at;
    s.inferenceMs = frame.inferenceMs ?? s.inferenceMs;
    s.width = frame.width;
    s.height = frame.height;
    s.framing = assessFraming(frame.landmarks, this.profile);
    if (POSE_DEBUG && at - this.lastLog >= 2000) {
      this.lastLog = at;
      const f = s.framing, d = this.debug();
      console.log(`[FRAME] width=${s.width} height=${s.height} fps=${s.fps.toFixed(1)} inferenceMs=${s.inferenceMs ?? '-'}`);
      console.log(`[POSE] personDetected=${!!frame.landmarks} confidence=${f.confidence.toFixed(2)} visibleJoints=${f.visibleLandmarks}/33 essential=${f.visibleEssential}/${f.totalEssential} framing=${f.kind} body=${(f.bodyHeight * 100).toFixed(0)}%`);
      console.log(`[EXERCISE] phase=${d.phase} state=${d.movement ?? '-'}${d.reps !== null ? ` [REP] count=${d.reps}` : ''}`);
    }
  }

  private logicalNow(): number {
    const live = this.pausedAt !== null ? this.now() - this.pausedAt : 0;
    return this.now() - this.pausedTotal - live;
  }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(timer);
  }

  private clearTimers(): void {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    if (this.restTimer) clearInterval(this.restTimer);
    this.restTimer = null;
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }

  private update(patch: Partial<CoachState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }
}

