/**
 * Web Pose & Camera capabilities and error mapping.
 * Handles browser-specific checks: WebGL, WebAssembly, MediaDevices, camera permissions,
 * low-light / body detection loss, tab visibility, and WebSocket connectivity.
 */

import type { TrackerStatus } from '@/workout/tracker/types';

export type BrowserCapabilities = {
  webAssembly: boolean;
  webGL: boolean;
  mediaDevices: boolean;
  error?: string;
};

/** Checks whether the current runtime environment supports MediaPipe WASM and WebGL hardware acceleration. */
export function checkBrowserCapabilities(env: {
  hasWebAssembly?: boolean;
  hasWebGL?: boolean;
  hasMediaDevices?: boolean;
} = {}): BrowserCapabilities {
  const webAssembly =
    env.hasWebAssembly ??
    (typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function');

  let webGL = env.hasWebGL ?? false;
  if (env.hasWebGL === undefined && typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas');
      const gl =
        canvas.getContext('webgl2') ||
        canvas.getContext('webgl') ||
        canvas.getContext('experimental-webgl');
      webGL = !!gl;
    } catch {
      webGL = false;
    }
  }

  const mediaDevices =
    env.hasMediaDevices ??
    (typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function');

  let error: string | undefined;
  if (!webAssembly) {
    error = 'WebAssembly is not supported or disabled in this browser. Please use an updated modern browser.';
  } else if (!webGL) {
    error = 'Hardware graphics acceleration (WebGL) is disabled or unsupported. Please enable hardware acceleration in your browser settings.';
  } else if (!mediaDevices) {
    error = 'Camera API (getUserMedia) is unavailable. Please ensure you are browsing over HTTPS.';
  }

  return { webAssembly, webGL, mediaDevices, error };
}

/** Translates DOMExceptions from getUserMedia into standard TrackerStatus and human-readable advice. */
export function mapCameraError(err: unknown): { status: TrackerStatus; detail: string } {
  const e = err as { name?: string; message?: string } | null;
  const name = e?.name || '';

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return {
      status: 'denied',
      detail: 'Camera permission was denied in your browser. Click the camera icon in your address bar to allow access, then tap Try again.',
    };
  }

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      status: 'no_camera',
      detail: 'No camera found on this device. Please connect a webcam or switch to a device with a camera.',
    };
  }

  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return {
      status: 'error',
      detail: 'Camera is currently in use by another application or browser tab.',
    };
  }

  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return {
      status: 'error',
      detail: 'Camera does not meet requested resolution requirements.',
    };
  }

  return {
    status: 'error',
    detail: e?.message ? `Camera unavailable: ${e.message}` : 'Camera could not be started.',
  };
}

/** Assesses consecutive landmark misses for lighting or visibility problems. */
export function assessTrackingQuality(missedFrames: number, hasLandmarks: boolean): {
  lostFilter: boolean;
  lowLightWarning: boolean;
  cueText: string | null;
} {
  const lostFilter = !hasLandmarks && missedFrames > 8;
  const lowLightWarning = !hasLandmarks && missedFrames > 30;

  let cueText: string | null = null;
  if (lowLightWarning) {
    cueText = 'No body detected · check room lighting or step into view';
  } else if (lostFilter) {
    cueText = 'Step into view';
  }

  return { lostFilter, lowLightWarning, cueText };
}

/** Web visibility listener for auto-pausing the workout when the tab is backgrounded. */
export function addTabVisibilityListener(callbacks: {
  onHidden?: () => void;
  onVisible?: () => void;
}): () => void {
  if (typeof document === 'undefined') return () => {};

  const handler = () => {
    if (document.visibilityState === 'hidden') {
      callbacks.onHidden?.();
    } else if (document.visibilityState === 'visible') {
      callbacks.onVisible?.();
    }
  };

  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}
