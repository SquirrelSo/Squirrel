/**
 * MovementDetectionService — the only place that touches movement hardware. Screens ask it for a
 * detector, check its status, request permission and subscribe to samples; the challenge logic
 * (logic/movementEngine.ts) turns samples into progress. No device code lives in the UI.
 *
 * Detectors:
 *   motion     REAL. expo-sensors DeviceMotion: linear acceleration (gravity removed) at ~20 Hz.
 *              iOS, Android and mobile browsers (iOS Safari asks permission on a tap). Desktop
 *              browsers have no motion sensor → 'unsupported'.
 *   camera     NOT CONNECTED. NATIVE INTEGRATION POINT: a pose model (e.g. MediaPipe / ML Kit pose
 *              detection through a vision-camera frame processor) that emits the same samples
 *              (body-centre acceleration) or rep events. The phone has no pose model today, so it
 *              always reports 'unsupported' — the camera is never used to pretend.
 *   simulated  DEVELOPMENT ONLY (`__DEV__`), off unless switched on in the alarm screen. It generates
 *              samples so the flow can be tried in a desktop browser; every screen it touches says
 *              "Simulated — not real movement". It is never available in a production build.
 */
import { Platform } from 'react-native';
import { DeviceMotion } from 'expo-sensors';
import type { MotionSample } from '@/logic/movementEngine';

export type DetectorId = 'motion' | 'camera' | 'simulated';

export type DetectorStatus =
  | { state: 'ready' }
  | { state: 'needs-permission' } // can ask (first time, or the browser asks on a tap)
  | { state: 'denied'; canAskAgain: boolean } // said no (canAskAgain false → only Settings can fix it)
  | { state: 'unsupported'; reason: string }; // this device / build can't do it

export type SampleListener = (s: MotionSample) => void;

/** The sensor exists on paper but never produces readings (desktop browsers): treated as unsupported. */
export class NoMotionDataError extends Error {
  constructor() {
    super('No motion readings came from this device.');
    this.name = 'NoMotionDataError';
  }
}
export const isNoMotionData = (e: unknown) => e instanceof NoMotionDataError || (e instanceof Error && e.name === 'NoMotionDataError');

export interface MovementDetector {
  readonly id: DetectorId;
  readonly label: string;
  /** Shown on the permission screen: why we need it. */
  readonly why: string;
  status(): Promise<DetectorStatus>;
  requestPermission(): Promise<DetectorStatus>;
  /** Start streaming samples. `onError` fires if the sensor dies mid-challenge. Returns stop(). */
  start(onSample: SampleListener, onError: (e: unknown) => void): () => void;
}

// ---------------------------------------------------------------------------------------------
// Motion sensors (real)
// ---------------------------------------------------------------------------------------------

const SAMPLE_MS = 50;

class MotionSensorDetector implements MovementDetector {
  readonly id = 'motion' as const;
  readonly label = 'Motion sensors';
  readonly why = 'Squirrel Social uses your phone’s motion sensors to check you’re really moving. Nothing is recorded or uploaded — it only counts movement during the challenge.';

  async status(): Promise<DetectorStatus> {
    const available = await DeviceMotion.isAvailableAsync().catch(() => false);
    if (!available) return { state: 'unsupported', reason: Platform.OS === 'web' ? 'This browser has no motion sensor (desktop computers don’t).' : 'This device has no motion sensor.' };
    const p = await DeviceMotion.getPermissionsAsync().catch(() => null);
    if (!p) return { state: 'needs-permission' };
    if (p.granted) return { state: 'ready' };
    if (p.status === 'denied') return { state: 'denied', canAskAgain: p.canAskAgain };
    return { state: 'needs-permission' };
  }

  async requestPermission(): Promise<DetectorStatus> {
    const p = await DeviceMotion.requestPermissionsAsync().catch(() => null);
    if (p?.granted) return { state: 'ready' };
    return p ? { state: 'denied', canAskAgain: p.canAskAgain } : { state: 'unsupported', reason: 'Motion access couldn’t be requested on this device.' };
  }

  start(onSample: SampleListener, onError: (e: unknown) => void) {
    if (Platform.OS === 'web') return startWebMotion(onSample, onError);
    let lastAt = Date.now();
    const startedAt = lastAt;
    let alive = true;
    DeviceMotion.setUpdateInterval(SAMPLE_MS);
    const sub = DeviceMotion.addListener((m) => {
      lastAt = Date.now();
      // Prefer gravity-free acceleration; some devices only report it including gravity.
      const a = m.acceleration ?? (m.accelerationIncludingGravity ? withoutGravity(m.accelerationIncludingGravity) : null);
      if (a) onSample({ t: lastAt, x: a.x, y: a.y, z: a.z });
    });
    // A sensor that goes silent (revoked mid-challenge, suspended) is a failure, not stillness.
    const watchdog = setInterval(() => {
      if (alive && Date.now() - lastAt > 4000) onError(Date.now() - startedAt < 4500 ? new NoMotionDataError() : new Error('The motion sensor stopped responding.'));
    }, 1000);
    return () => {
      alive = false;
      clearInterval(watchdog);
      sub.remove();
    };
  }
}

/**
 * Web: the browser's own `devicemotion` events (expo-sensors' web listener isn't reliable here).
 * Desktop browsers often expose the event but never send real readings → NoMotionDataError.
 */
function startWebMotion(onSample: SampleListener, onError: (e: unknown) => void) {
  const w = globalThis as unknown as { addEventListener?: Window['addEventListener']; removeEventListener?: Window['removeEventListener'] };
  if (!w.addEventListener) {
    onError(new NoMotionDataError());
    return () => {};
  }
  let got = 0;
  let lastAt = Date.now();
  let alive = true;
  const handler = (ev: Event) => {
    const e = ev as DeviceMotionEvent;
    const a = e.acceleration?.x != null ? e.acceleration : e.accelerationIncludingGravity?.x != null ? withoutGravity({ x: e.accelerationIncludingGravity.x ?? 0, y: e.accelerationIncludingGravity.y ?? 0, z: e.accelerationIncludingGravity.z ?? 0 }) : null;
    if (!a || a.x == null) return;
    got += 1;
    lastAt = Date.now();
    onSample({ t: lastAt, x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 });
  };
  w.addEventListener('devicemotion', handler);
  const startedAt = Date.now();
  const watchdog = setInterval(() => {
    if (!alive) return;
    if (!got && Date.now() - startedAt > 2500) onError(new NoMotionDataError());
    else if (got && Date.now() - lastAt > 4000) onError(new Error('The motion sensor stopped responding.'));
  }, 500);
  return () => {
    alive = false;
    clearInterval(watchdog);
    w.removeEventListener?.('devicemotion', handler);
  };
}

/** Crude high-pass for devices without linear acceleration: subtract a slow running average. */
let gravity: { x: number; y: number; z: number } | null = null;
function withoutGravity(a: { x: number; y: number; z: number }) {
  const k = 0.9;
  gravity = gravity ? { x: k * gravity.x + (1 - k) * a.x, y: k * gravity.y + (1 - k) * a.y, z: k * gravity.z + (1 - k) * a.z } : { ...a };
  return { x: a.x - gravity.x, y: a.y - gravity.y, z: a.z - gravity.z };
}

// ---------------------------------------------------------------------------------------------
// Camera (boundary only)
// ---------------------------------------------------------------------------------------------

class CameraPoseDetector implements MovementDetector {
  readonly id = 'camera' as const;
  readonly label = 'Camera';
  readonly why = 'Squirrel Social can watch your movement through the camera to count it. Video stays on your phone.';
  async status(): Promise<DetectorStatus> {
    // NATIVE INTEGRATION POINT: report 'ready' / permission state once a pose model is bundled.
    return { state: 'unsupported', reason: 'Camera movement tracking needs a pose model that isn’t in this app yet.' };
  }
  async requestPermission(): Promise<DetectorStatus> {
    return this.status();
  }
  start(_onSample: SampleListener, onError: (e: unknown) => void) {
    onError(new Error('Camera movement tracking isn’t available.'));
    return () => {};
  }
}

// ---------------------------------------------------------------------------------------------
// Development simulator (never in production)
// ---------------------------------------------------------------------------------------------

export const SIMULATOR_ALLOWED = typeof __DEV__ !== 'undefined' && __DEV__;

class SimulatedDetector implements MovementDetector {
  readonly id = 'simulated' as const;
  readonly label = 'Simulated (development)';
  readonly why = 'Development build: movement is simulated so the flow can be tried without a phone. Not real detection.';
  /** Hold-to-move: the dev screen sets this while its "Simulate moving" button is pressed. */
  static moving = false;
  async status(): Promise<DetectorStatus> {
    return SIMULATOR_ALLOWED ? { state: 'ready' } : { state: 'unsupported', reason: 'Simulation is only available in development builds.' };
  }
  async requestPermission() {
    return this.status();
  }
  start(onSample: SampleListener) {
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      // While "moving": 2 Hz bursts (250 ms hard movement, 250 ms settle) — reads as continuous
      // movement and as one rep per burst. Otherwise near-still noise.
      const m = SimulatedDetector.moving;
      const burst = m && i % 10 < 5;
      const v = burst ? 9 * (i % 2 ? 1 : -1) : (Math.random() - 0.5) * (m ? 0.4 : 0.06);
      onSample({ t: Date.now(), x: v, y: 0, z: 0 });
    }, SAMPLE_MS);
    return () => clearInterval(t);
  }
}
export const setSimulatedMoving = (on: boolean) => {
  SimulatedDetector.moving = on;
};

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

const detectors: Record<DetectorId, MovementDetector> = {
  motion: new MotionSensorDetector(),
  camera: new CameraPoseDetector(),
  simulated: new SimulatedDetector(),
};

/** Order of preference. The simulator is only ever chosen when explicitly enabled in a dev build. */
const PREFERENCE: DetectorId[] = ['motion', 'camera'];

export const MovementDetectionService = {
  get: (id: DetectorId) => detectors[id],

  /**
   * The detector to use for a challenge and its status: the first one that's ready, else the most
   * actionable one (permission can be asked > denied > unsupported) so the screen can help.
   */
  async pick(opts: { simulate?: boolean } = {}): Promise<{ detector: MovementDetector; status: DetectorStatus }> {
    if (opts.simulate && SIMULATOR_ALLOWED) return { detector: detectors.simulated, status: { state: 'ready' } };
    const results = await Promise.all(PREFERENCE.map(async (id) => ({ detector: detectors[id], status: await detectors[id].status().catch((): DetectorStatus => ({ state: 'unsupported', reason: 'Couldn’t check this sensor.' })) })));
    const rank = (s: DetectorStatus) => (s.state === 'ready' ? 0 : s.state === 'needs-permission' ? 1 : s.state === 'denied' ? 2 : 3);
    return results.sort((a, b) => rank(a.status) - rank(b.status))[0];
  },
};
