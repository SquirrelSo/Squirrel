import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isWebGeolocationAvailable,
  getWebLocationPermission,
  requestWebLocationPermission,
  watchWebPosition,
  mapGeolocationError,
  isWakeLockSupported,
  requestScreenWakeLock,
  releaseScreenWakeLock,
  isTabVisible,
  isOnline,
  addVisibilityListener,
  addConnectivityListener,
} from './webLocation.ts';

test('isWebGeolocationAvailable detects presence of navigator.geolocation', () => {
  assert.equal(isWebGeolocationAvailable(undefined), false);
  assert.equal(isWebGeolocationAvailable({}), false);
  assert.equal(isWebGeolocationAvailable({ geolocation: {} }), true);
});

test('getWebLocationPermission queries navigator.permissions when supported', async () => {
  assert.equal(await getWebLocationPermission(undefined), 'unsupported');
  assert.equal(await getWebLocationPermission({}), 'unsupported');

  // Without permissions.query
  assert.equal(await getWebLocationPermission({ geolocation: {} }), 'undetermined');

  // With permissions.query
  const mockNav = (state) => ({
    geolocation: {},
    permissions: {
      query: async ({ name }) => {
        assert.equal(name, 'geolocation');
        return { state };
      },
    },
  });

  assert.equal(await getWebLocationPermission(mockNav('granted')), 'granted');
  assert.equal(await getWebLocationPermission(mockNav('prompt')), 'undetermined');
  assert.equal(await getWebLocationPermission(mockNav('denied')), 'denied');

  // permissions.query rejects
  const failingNav = {
    geolocation: {},
    permissions: { query: async () => { throw new Error('Query error'); } },
  };
  assert.equal(await getWebLocationPermission(failingNav), 'undetermined');
});

test('requestWebLocationPermission triggers getCurrentPosition and maps status', async () => {
  assert.equal(await requestWebLocationPermission(undefined), 'unsupported');

  // Success
  const successNav = {
    geolocation: {
      getCurrentPosition: (success) => {
        success({ coords: { latitude: 22.5, longitude: 88.3, accuracy: 10 }, timestamp: 123456 });
      },
    },
  };
  assert.equal(await requestWebLocationPermission(successNav), 'granted');

  // Denied (code 1)
  const deniedNav = {
    geolocation: {
      getCurrentPosition: (_success, error) => {
        error({ code: 1, message: 'User denied geolocation' });
      },
    },
  };
  assert.equal(await requestWebLocationPermission(deniedNav), 'denied');

  // Unavailable (code 2)
  const unavailNav = {
    geolocation: {
      getCurrentPosition: (_success, error) => {
        error({ code: 2, message: 'Position unavailable' });
      },
    },
  };
  assert.equal(await requestWebLocationPermission(unavailNav), 'services_off');

  // Timeout (code 3)
  const timeoutNav = {
    geolocation: {
      getCurrentPosition: (_success, error) => {
        error({ code: 3, message: 'Timeout' });
      },
    },
  };
  assert.equal(await requestWebLocationPermission(timeoutNav), 'services_off');
});

test('watchWebPosition feeds fixes and handles clearWatch on remove', () => {
  let clearedId = null;
  let watchSuccess = null;
  let watchError = null;

  const mockNav = {
    geolocation: {
      watchPosition: (success, error, opts) => {
        watchSuccess = success;
        watchError = error;
        assert.equal(opts.enableHighAccuracy, true);
        return 42;
      },
      clearWatch: (id) => {
        clearedId = id;
      },
    },
  };

  const fixes = [];
  const errors = [];

  const sub = watchWebPosition(
    (fix) => fixes.push(fix),
    (err) => errors.push(err),
    { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 },
    mockNav,
  );

  assert.equal(typeof watchSuccess, 'function');
  assert.equal(typeof watchError, 'function');

  // Emit a fix
  watchSuccess({
    coords: { latitude: 22.95, longitude: 88.54, accuracy: 8.5 },
    timestamp: 1700000000000,
  });

  assert.equal(fixes.length, 1);
  assert.deepEqual(fixes[0], {
    lat: 22.95,
    lon: 88.54,
    t: 1700000000000,
    accuracy: 8.5,
  });

  // Emit an error
  watchError({ code: 2, message: 'Position lost' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'position_unavailable');

  // Remove subscription
  sub.remove();
  assert.equal(clearedId, 42);
});

test('mapGeolocationError translates browser error codes into descriptive errors', () => {
  assert.equal(mapGeolocationError({ code: 1 }).code, 'permission_denied');
  assert.equal(mapGeolocationError({ code: 2 }).code, 'position_unavailable');
  assert.equal(mapGeolocationError({ code: 3 }).code, 'timeout');
  assert.equal(mapGeolocationError(null).code, 'unknown');
});

test('Screen Wake Lock API requests, catches errors, and releases sentinel', async () => {
  assert.equal(isWakeLockSupported(undefined), false);
  assert.equal(isWakeLockSupported({}), false);

  let released = false;
  const mockSentinel = {
    released: false,
    release: async () => {
      released = true;
      mockSentinel.released = true;
    },
    addEventListener: () => {},
  };

  const supportedNav = {
    wakeLock: {
      request: async (type) => {
        assert.equal(type, 'screen');
        return mockSentinel;
      },
    },
  };

  assert.equal(isWakeLockSupported(supportedNav), true);

  const sentinel = await requestScreenWakeLock(supportedNav);
  assert.equal(sentinel, mockSentinel);

  await releaseScreenWakeLock(sentinel);
  assert.equal(released, true);

  // Rejection/failure handles cleanly without throwing
  const rejectingNav = {
    wakeLock: {
      request: async () => {
        throw new Error('NotAllowedError');
      },
    },
  };
  const failed = await requestScreenWakeLock(rejectingNav);
  assert.equal(failed, null);
});

test('tab visibility and connectivity helpers register and unregister cleanly', () => {
  let docListeners = {};
  const mockDoc = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => { docListeners[type] = fn; },
    removeEventListener: (type, fn) => { if (docListeners[type] === fn) delete docListeners[type]; },
  };

  assert.equal(isTabVisible(mockDoc), true);
  mockDoc.visibilityState = 'hidden';
  assert.equal(isTabVisible(mockDoc), false);

  let reportedVisibility = null;
  const unsubVis = addVisibilityListener((v) => { reportedVisibility = v; }, mockDoc);
  assert.equal(typeof docListeners.visibilitychange, 'function');

  mockDoc.visibilityState = 'visible';
  docListeners.visibilitychange();
  assert.equal(reportedVisibility, true);

  unsubVis();
  assert.equal(docListeners.visibilitychange, undefined);

  // Online / offline
  assert.equal(isOnline({ onLine: true }), true);
  assert.equal(isOnline({ onLine: false }), false);

  let winListeners = {};
  const mockWin = {
    addEventListener: (type, fn) => { winListeners[type] = fn; },
    removeEventListener: (type, fn) => { if (winListeners[type] === fn) delete winListeners[type]; },
  };

  let wentOnline = false;
  let wentOffline = false;
  const unsubConn = addConnectivityListener(
    () => { wentOnline = true; },
    () => { wentOffline = true; },
    mockWin,
  );

  winListeners.online();
  assert.equal(wentOnline, true);
  winListeners.offline();
  assert.equal(wentOffline, true);

  unsubConn();
  assert.equal(winListeners.online, undefined);
  assert.equal(winListeners.offline, undefined);
});
