/**
 * Run / Walk tracking state machine.
 *
 * Encapsulates the lifecycle, transitions, guards, accuracy validation, and user notices
 * for both native and web execution.
 */

// @ts-expect-error Node strip-types needs explicit .ts extension for test runner
import { MAX_ACCURACY_M, type Fix } from './track.ts';
import type { WebLocationError } from './webLocation';

export type RunPhase = 'setup' | 'countdown' | 'running' | 'paused' | 'uploading' | 'done';
export type RunSource = 'gps' | 'demo';
export type RunPerm = 'checking' | 'undetermined' | 'granted' | 'denied' | 'blocked' | 'approximate' | 'services_off' | 'web' | 'unsupported';

export type RunStateMachine = {
  phase: RunPhase;
  source: RunSource | null;
  perm: RunPerm;
  countdown: number;
  isWeb: boolean;
  tabVisible: boolean;
  isOnline: boolean;
  wakeLockActive: boolean;
  notice: string | null;
  lastFixAt: number;
  latestFix: Fix | null;
  startedAt: number;
  pausedAt: number;
  pausedTotalMs: number;
  endedAt: number;
  uploadFailed: boolean;
  uploadNote?: string;
};

export const WEB_FOREGROUND_WARNING = 'Keep this tab open and in front. Web GPS pauses if the tab is hidden or minimized.';
export const TAB_BACKGROUNDED_WARNING = 'Tab was backgrounded. Tracking may pause or drop points when the tab is hidden — keep Squirrel in front.';
export const NO_GPS_FIX_WARNING = 'No GPS fix for 20 s. Head into open sky — distance only counts with a location fix.';
export const NETWORK_OFFLINE_WARNING = 'You appear to be offline. Your route is tracked locally and will upload when connection is restored.';

export function createInitialRunState(options: { isWeb: boolean; initialPerm?: RunPerm }): RunStateMachine {
  return {
    phase: 'setup',
    source: null,
    perm: options.initialPerm ?? (options.isWeb ? 'checking' : 'checking'),
    countdown: 3,
    isWeb: options.isWeb,
    tabVisible: true,
    isOnline: true,
    wakeLockActive: false,
    notice: null,
    lastFixAt: 0,
    latestFix: null,
    startedAt: 0,
    pausedAt: 0,
    pausedTotalMs: 0,
    endedAt: 0,
    uploadFailed: false,
  };
}

export function setRunPermission(state: RunStateMachine, perm: RunPerm): RunStateMachine {
  return { ...state, perm };
}

export function startRunCountdown(state: RunStateMachine, source: RunSource): RunStateMachine {
  // A real activity requires granted location permission; demo can start anytime.
  if (source === 'gps' && state.perm !== 'granted') return state;

  const notice = state.isWeb && source === 'gps' ? WEB_FOREGROUND_WARNING : null;

  return {
    ...state,
    phase: 'countdown',
    source,
    countdown: 3,
    notice,
    uploadFailed: false,
    uploadNote: undefined,
  };
}

export function tickCountdown(state: RunStateMachine, now = Date.now()): RunStateMachine {
  if (state.phase !== 'countdown') return state;

  if (state.countdown <= 1) {
    return {
      ...state,
      phase: 'running',
      countdown: 0,
      startedAt: now,
      pausedAt: 0,
      pausedTotalMs: 0,
      lastFixAt: now,
      wakeLockActive: state.isWeb && state.source === 'gps',
      notice: state.isWeb && state.source === 'gps' ? (state.notice ?? WEB_FOREGROUND_WARNING) : state.notice,
    };
  }

  return {
    ...state,
    countdown: state.countdown - 1,
  };
}

export function toggleRunPause(state: RunStateMachine, now = Date.now()): RunStateMachine {
  if (state.phase === 'running') {
    return {
      ...state,
      phase: 'paused',
      pausedAt: now,
      wakeLockActive: false,
    };
  }
  if (state.phase === 'paused') {
    const additionalPausedMs = state.pausedAt ? Math.max(0, now - state.pausedAt) : 0;
    return {
      ...state,
      phase: 'running',
      pausedAt: 0,
      pausedTotalMs: state.pausedTotalMs + additionalPausedMs,
      wakeLockActive: state.isWeb && state.source === 'gps',
    };
  }
  return state;
}

export function handleLocationFix(state: RunStateMachine, fix: Fix): RunStateMachine {
  const isWeak = fix.accuracy != null && fix.accuracy > MAX_ACCURACY_M;
  let notice = state.notice;

  if (isWeak && state.phase === 'running' && state.source === 'gps') {
    notice = `Weak GPS (±${Math.round(fix.accuracy ?? 0)} m). Points worse than ±${MAX_ACCURACY_M} m are skipped.`;
  } else if (notice === NO_GPS_FIX_WARNING) {
    notice = state.isWeb ? WEB_FOREGROUND_WARNING : null;
  }

  return {
    ...state,
    latestFix: fix,
    lastFixAt: fix.t || Date.now(),
    notice,
  };
}

export function handleLocationError(state: RunStateMachine, error: WebLocationError): RunStateMachine {
  let perm = state.perm;
  if (error.code === 'permission_denied') perm = 'denied';
  else if (error.code === 'position_unavailable') perm = 'services_off';

  return {
    ...state,
    perm,
    notice: error.message,
  };
}

export function handleTabVisibility(state: RunStateMachine, visible: boolean): RunStateMachine {
  if (state.tabVisible === visible) return state;

  let notice = state.notice;
  let wakeLockActive = state.wakeLockActive;

  if (state.phase === 'running' && state.source === 'gps') {
    if (!visible) {
      notice = TAB_BACKGROUNDED_WARNING;
      wakeLockActive = false; // browser auto-releases wake lock on tab hide
    } else {
      notice = WEB_FOREGROUND_WARNING;
      wakeLockActive = state.isWeb;
    }
  }

  return {
    ...state,
    tabVisible: visible,
    wakeLockActive,
    notice,
  };
}

export function handleConnectivity(state: RunStateMachine, online: boolean): RunStateMachine {
  if (state.isOnline === online) return state;

  let notice = state.notice;
  if (!online && (state.phase === 'running' || state.phase === 'paused')) {
    notice = NETWORK_OFFLINE_WARNING;
  } else if (online && notice === NETWORK_OFFLINE_WARNING) {
    notice = state.isWeb && state.source === 'gps' ? WEB_FOREGROUND_WARNING : null;
  }

  return {
    ...state,
    isOnline: online,
    notice,
  };
}

export function checkGpsFixStaleness(state: RunStateMachine, now = Date.now(), thresholdMs = 20000): RunStateMachine {
  if (state.phase !== 'running' || state.source !== 'gps') return state;

  if (state.lastFixAt > 0 && now - state.lastFixAt > thresholdMs) {
    return {
      ...state,
      notice: NO_GPS_FIX_WARNING,
    };
  }

  return state;
}

export function finishRunState(state: RunStateMachine, now = Date.now()): RunStateMachine {
  return {
    ...state,
    phase: 'done',
    endedAt: now,
    wakeLockActive: false,
  };
}

export function discardRunState(state: RunStateMachine): RunStateMachine {
  return {
    ...createInitialRunState({ isWeb: state.isWeb, initialPerm: state.perm }),
  };
}

export function dismissRunNotice(state: RunStateMachine): RunStateMachine {
  return { ...state, notice: null };
}
