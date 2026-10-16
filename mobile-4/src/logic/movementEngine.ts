/**
 * Movement challenge engine — pure logic, no React Native imports, so it's unit-tested directly
 * (movementEngine.test.mjs). It turns a stream of motion samples into challenge progress:
 *
 *   continuous  (Dance, Shake)   seconds count only while you're actually moving
 *   reps        (Squats, Jumps)  each detected rep counts; reps are never taken away
 *
 * Samples are linear acceleration (gravity removed) in m/s², the way DeviceMotion reports it,
 * plus a timestamp in ms. Where samples come from (motion sensors today, a camera pose model
 * later) is the detector's business — see features/alarm/MovementDetectionService.ts.
 */

export type MotionSample = { t: number; x: number; y: number; z: number };

export type ContinuousRule = {
  kind: 'continuous';
  /** Seconds of movement needed. */
  target: number;
  /** Rolling movement intensity (m/s², RMS) that counts as moving. */
  moveThreshold: number;
  /** Still for longer than this (ms) → "Keep moving!" and progress stops counting. */
  graceMs: number;
  /** After stopping: 'pause' keeps progress; 'reset' drops back to 0 once still for `resetAfterMs`. */
  onStop: 'pause' | 'reset';
  resetAfterMs?: number;
};

export type RepRule = {
  kind: 'reps';
  /** Reps needed. */
  target: number;
  /** A rep: intensity rises above `peak`, then settles below `settle`. */
  peak: number;
  settle: number;
  /** Minimum time between two reps (ms) — one movement never counts twice. */
  minGapMs: number;
  /** No rep for this long → "Keep moving!" (progress is kept). */
  nudgeAfterMs: number;
};

export type ChallengeRule = ContinuousRule | RepRule;

export type EngineStatus = 'waiting' | 'moving' | 'stopped' | 'done';

export type EngineState = {
  status: EngineStatus;
  /** Seconds (continuous) or reps done. */
  progress: number;
  target: number;
  /** Current movement intensity (m/s² RMS over the last ~0.5 s), for the live meter. */
  intensity: number;
  /** Set when a rep was just counted (timestamp), so the UI can celebrate it. */
  lastRepAt: number | null;
  /** The engine dropped progress back to zero (continuous 'reset' rule) on this update. */
  wasReset: boolean;
  /** When progress last dropped back to zero, if ever (ms). */
  resetAt: number | null;
  /** Time of this state (ms), so views can tell how long ago things happened without reading the clock. */
  now: number;
};

const WINDOW_MS = 500;

export function createEngine(rule: ChallengeRule) {
  const window: { t: number; m2: number }[] = [];
  let progressMs = 0;
  let reps = 0;
  let lastT: number | null = null;
  let lastMoveAt: number | null = null;
  let lastRepAt: number | null = null;
  let armed = false; // reps: intensity went above `peak`, waiting to settle
  let started = false;
  let wasReset = false;
  let resetAt: number | null = null;
  let intensity = 0;

  const target = rule.target;
  const done = () => (rule.kind === 'continuous' ? progressMs >= target * 1000 : reps >= target);

  function state(now: number): EngineState {
    if (done()) return { status: 'done', progress: target, target, intensity, lastRepAt, wasReset, resetAt, now };
    let status: EngineStatus = 'waiting';
    if (started) {
      if (rule.kind === 'continuous') status = lastMoveAt != null && now - lastMoveAt <= rule.graceMs ? 'moving' : 'stopped';
      else {
        const since = now - (lastRepAt ?? lastMoveAt ?? now);
        status = since > rule.nudgeAfterMs ? 'stopped' : 'moving';
      }
    }
    const progress = rule.kind === 'continuous' ? Math.min(target, Math.floor(progressMs / 1000)) : reps;
    return { status, progress, target, intensity, lastRepAt, wasReset, resetAt, now };
  }

  return {
    /** Feed one sample; returns the new state. */
    push(s: MotionSample): EngineState {
      if (done()) return state(s.t);
      const m2 = s.x * s.x + s.y * s.y + s.z * s.z;
      window.push({ t: s.t, m2 });
      while (window.length && s.t - window[0].t > WINDOW_MS) window.shift();
      intensity = Math.sqrt(window.reduce((a, w) => a + w.m2, 0) / window.length);
      const dt = lastT == null ? 0 : Math.max(0, Math.min(250, s.t - lastT)); // ignore gaps (backgrounded)
      lastT = s.t;
      wasReset = false;

      if (rule.kind === 'continuous') {
        if (intensity >= rule.moveThreshold) {
          started = true;
          lastMoveAt = s.t;
          progressMs += dt;
        } else if (started && rule.onStop === 'reset' && lastMoveAt != null && s.t - lastMoveAt > (rule.resetAfterMs ?? rule.graceMs) && progressMs > 0) {
          progressMs = 0;
          wasReset = true;
          resetAt = s.t;
        }
      } else {
        const mag = Math.sqrt(m2);
        if (mag >= rule.settle) lastMoveAt = s.t;
        if (!armed && mag >= rule.peak && (lastRepAt == null || s.t - lastRepAt >= rule.minGapMs)) {
          armed = true;
          started = true;
        } else if (armed && mag < rule.settle) {
          armed = false;
          reps += 1;
          lastRepAt = s.t;
        }
      }
      return state(s.t);
    },
    /** Re-evaluate without a new sample (sensors go quiet when the phone is perfectly still). */
    tick(now: number): EngineState {
      if (rule.kind === 'continuous' && started && rule.onStop === 'reset' && !done() && lastMoveAt != null && now - lastMoveAt > (rule.resetAfterMs ?? rule.graceMs) && progressMs > 0) {
        progressMs = 0;
        wasReset = true;
        resetAt = now;
        return state(now);
      }
      wasReset = false;
      return state(now);
    },
    /** Count a rep or a second from a non-sensor source (the backup tap challenge). */
    credit(now: number, amount = 1): EngineState {
      started = true;
      lastMoveAt = now;
      if (rule.kind === 'continuous') progressMs = Math.min(target * 1000, progressMs + amount * 1000);
      else {
        reps = Math.min(target, reps + amount);
        lastRepAt = now;
      }
      return state(now);
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
