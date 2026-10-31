import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialRunState,
  setRunPermission,
  startRunCountdown,
  tickCountdown,
  toggleRunPause,
  handleLocationFix,
  handleLocationError,
  handleTabVisibility,
  handleConnectivity,
  checkGpsFixStaleness,
  finishRunState,
  discardRunState,
  WEB_FOREGROUND_WARNING,
  TAB_BACKGROUNDED_WARNING,
  NO_GPS_FIX_WARNING,
  NETWORK_OFFLINE_WARNING,
} from './runStateMachine.ts';

test('createInitialRunState sets clean initial values', () => {
  const webState = createInitialRunState({ isWeb: true });
  assert.equal(webState.phase, 'setup');
  assert.equal(webState.isWeb, true);
  assert.equal(webState.source, null);
  assert.equal(webState.countdown, 3);
  assert.equal(webState.wakeLockActive, false);
});

test('startRunCountdown guards GPS start on granted permission, allows demo freely', () => {
  let state = createInitialRunState({ isWeb: true, initialPerm: 'denied' });

  // GPS with denied permission stays in setup
  let attempted = startRunCountdown(state, 'gps');
  assert.equal(attempted.phase, 'setup');

  // Demo starts without location permission
  let demoState = startRunCountdown(state, 'demo');
  assert.equal(demoState.phase, 'countdown');
  assert.equal(demoState.source, 'demo');
  assert.equal(demoState.notice, null);

  // GPS with granted permission starts countdown and sets web notice
  state = setRunPermission(state, 'granted');
  let gpsState = startRunCountdown(state, 'gps');
  assert.equal(gpsState.phase, 'countdown');
  assert.equal(gpsState.source, 'gps');
  assert.equal(gpsState.notice, WEB_FOREGROUND_WARNING);
});

test('tickCountdown counts down from 3 to 1 and transitions to running', () => {
  let state = createInitialRunState({ isWeb: true, initialPerm: 'granted' });
  state = startRunCountdown(state, 'gps');

  state = tickCountdown(state);
  assert.equal(state.phase, 'countdown');
  assert.equal(state.countdown, 2);

  state = tickCountdown(state);
  assert.equal(state.phase, 'countdown');
  assert.equal(state.countdown, 1);

  const now = 1700000000000;
  state = tickCountdown(state, now);
  assert.equal(state.phase, 'running');
  assert.equal(state.countdown, 0);
  assert.equal(state.startedAt, now);
  assert.equal(state.lastFixAt, now);
  assert.equal(state.wakeLockActive, true);
});

test('toggleRunPause pauses and resumes run tracking while managing wake lock', () => {
  let state = createInitialRunState({ isWeb: true, initialPerm: 'granted' });
  state = startRunCountdown(state, 'gps');
  state = tickCountdown(state);
  state = tickCountdown(state);
  state = tickCountdown(state, 1000);

  // Pause at t=5000
  state = toggleRunPause(state, 5000);
  assert.equal(state.phase, 'paused');
  assert.equal(state.pausedAt, 5000);
  assert.equal(state.wakeLockActive, false);

  // Resume at t=9000 (paused for 4000ms)
  state = toggleRunPause(state, 9000);
  assert.equal(state.phase, 'running');
  assert.equal(state.pausedAt, 0);
  assert.equal(state.pausedTotalMs, 4000);
  assert.equal(state.wakeLockActive, true);
});

test('handleLocationFix detects weak GPS and resets no-fix warning', () => {
  let state = createInitialRunState({ isWeb: true, initialPerm: 'granted' });
  state = startRunCountdown(state, 'gps');
  state = tickCountdown(state);
  state = tickCountdown(state);
  state = tickCountdown(state);

  // Good fix (accuracy <= 20)
  state = handleLocationFix(state, { lat: 22.5, lon: 88.3, t: 1000, accuracy: 8 });
  assert.equal(state.lastFixAt, 1000);
  assert.equal(state.notice, WEB_FOREGROUND_WARNING);

  // Weak fix (accuracy = 35 > 20)
  state = handleLocationFix(state, { lat: 22.51, lon: 88.31, t: 2000, accuracy: 35 });
  assert.match(state.notice, /Weak GPS \(±35 m\)/);

  // Stale check
  state = checkGpsFixStaleness(state, 30000, 20000); // 30000 - 2000 = 28s > 20s
  assert.equal(state.notice, NO_GPS_FIX_WARNING);

  // Fresh good fix recovers from stale warning
  state = handleLocationFix(state, { lat: 22.52, lon: 88.32, t: 31000, accuracy: 6 });
  assert.equal(state.notice, WEB_FOREGROUND_WARNING);
});

test('handleLocationError maps error and updates permission', () => {
  let state = createInitialRunState({ isWeb: true, initialPerm: 'granted' });
  state = handleLocationError(state, { code: 'permission_denied', message: 'User denied' });
  assert.equal(state.perm, 'denied');
  assert.equal(state.notice, 'User denied');

  state = handleLocationError(state, { code: 'position_unavailable', message: 'No GPS' });
  assert.equal(state.perm, 'services_off');
  assert.equal(state.notice, 'No GPS');
});

test('handleTabVisibility warns on backgrounding and manages wake lock', () => {
  let state = createInitialRunState({ isWeb: true, initialPerm: 'granted' });
  state = startRunCountdown(state, 'gps');
  state = tickCountdown(state);
  state = tickCountdown(state);
  state = tickCountdown(state);
  assert.equal(state.wakeLockActive, true);

  // Tab hidden
  state = handleTabVisibility(state, false);
  assert.equal(state.tabVisible, false);
  assert.equal(state.wakeLockActive, false);
  assert.equal(state.notice, TAB_BACKGROUNDED_WARNING);

  // Tab visible again
  state = handleTabVisibility(state, true);
  assert.equal(state.tabVisible, true);
  assert.equal(state.wakeLockActive, true);
  assert.equal(state.notice, WEB_FOREGROUND_WARNING);
});

test('handleConnectivity tracks offline network loss and restore', () => {
  let state = createInitialRunState({ isWeb: true, initialPerm: 'granted' });
  state = startRunCountdown(state, 'gps');
  state = tickCountdown(state);
  state = tickCountdown(state);
  state = tickCountdown(state);

  // Offline
  state = handleConnectivity(state, false);
  assert.equal(state.isOnline, false);
  assert.equal(state.notice, NETWORK_OFFLINE_WARNING);

  // Back online
  state = handleConnectivity(state, true);
  assert.equal(state.isOnline, true);
  assert.equal(state.notice, WEB_FOREGROUND_WARNING);
});

test('finishRunState and discardRunState properly transition or reset state', () => {
  let state = createInitialRunState({ isWeb: true, initialPerm: 'granted' });
  state = startRunCountdown(state, 'gps');
  state = tickCountdown(state);
  state = tickCountdown(state);
  state = tickCountdown(state);

  // Finish
  const finished = finishRunState(state, 50000);
  assert.equal(finished.phase, 'done');
  assert.equal(finished.endedAt, 50000);
  assert.equal(finished.wakeLockActive, false);

  // Discard
  const discarded = discardRunState(state);
  assert.equal(discarded.phase, 'setup');
  assert.equal(discarded.source, null);
  assert.equal(discarded.wakeLockActive, false);
});
