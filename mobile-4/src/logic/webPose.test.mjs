import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBrowserCapabilities,
  mapCameraError,
  assessTrackingQuality,
  addTabVisibilityListener,
} from './webPose.ts';

test('checkBrowserCapabilities identifies missing WebAssembly', () => {
  const caps = checkBrowserCapabilities({ hasWebAssembly: false, hasWebGL: true, hasMediaDevices: true });
  assert.equal(caps.webAssembly, false);
  assert.match(caps.error ?? '', /WebAssembly is not supported/);
});

test('checkBrowserCapabilities identifies missing WebGL', () => {
  const caps = checkBrowserCapabilities({ hasWebAssembly: true, hasWebGL: false, hasMediaDevices: true });
  assert.equal(caps.webGL, false);
  assert.match(caps.error ?? '', /Hardware graphics acceleration \(WebGL\) is disabled/);
});

test('checkBrowserCapabilities identifies missing getUserMedia', () => {
  const caps = checkBrowserCapabilities({ hasWebAssembly: true, hasWebGL: true, hasMediaDevices: false });
  assert.equal(caps.mediaDevices, false);
  assert.match(caps.error ?? '', /Camera API \(getUserMedia\) is unavailable/);
});

test('checkBrowserCapabilities succeeds when all APIs are available', () => {
  const caps = checkBrowserCapabilities({ hasWebAssembly: true, hasWebGL: true, hasMediaDevices: true });
  assert.equal(caps.webAssembly, true);
  assert.equal(caps.webGL, true);
  assert.equal(caps.mediaDevices, true);
  assert.equal(caps.error, undefined);
});

test('mapCameraError correctly maps NotAllowedError to denied', () => {
  const err = mapCameraError({ name: 'NotAllowedError', message: 'Permission denied' });
  assert.equal(err.status, 'denied');
  assert.match(err.detail, /address bar/);
});

test('mapCameraError correctly maps NotFoundError to no_camera', () => {
  const err = mapCameraError({ name: 'NotFoundError', message: 'Requested device not found' });
  assert.equal(err.status, 'no_camera');
  assert.match(err.detail, /No camera found/);
});

test('mapCameraError correctly maps NotReadableError to in-use error', () => {
  const err = mapCameraError({ name: 'NotReadableError', message: 'Device in use' });
  assert.equal(err.status, 'error');
  assert.match(err.detail, /currently in use/);
});

test('mapCameraError handles generic and unknown error shapes', () => {
  const err = mapCameraError(new Error('Hardware crash'));
  assert.equal(err.status, 'error');
  assert.match(err.detail, /Hardware crash/);
});

test('assessTrackingQuality evaluates frame loss and lighting warnings', () => {
  // With landmarks
  assert.deepEqual(assessTrackingQuality(0, true), {
    lostFilter: false,
    lowLightWarning: false,
    cueText: null,
  });

  // Brief miss (< 8 frames)
  assert.deepEqual(assessTrackingQuality(4, false), {
    lostFilter: false,
    lowLightWarning: false,
    cueText: null,
  });

  // Moderate miss (> 8 frames): filter dropped, step into view
  const moderate = assessTrackingQuality(12, false);
  assert.equal(moderate.lostFilter, true);
  assert.equal(moderate.lowLightWarning, false);
  assert.equal(moderate.cueText, 'Step into view');

  // Prolonged miss (> 30 frames): lighting / body warning
  const prolonged = assessTrackingQuality(35, false);
  assert.equal(prolonged.lostFilter, true);
  assert.equal(prolonged.lowLightWarning, true);
  assert.match(prolonged.cueText ?? '', /check room lighting/);
});

test('addTabVisibilityListener triggers callbacks on visibility state changes', () => {
  let hiddenCalled = false;
  let visibleCalled = false;
  let currentVisibility = 'visible';

  const mockDoc = {
    get visibilityState() {
      return currentVisibility;
    },
    addEventListener: (event, handler) => {
      mockDoc._handler = handler;
    },
    removeEventListener: () => {
      delete mockDoc._handler;
    },
  };

  const origDoc = globalThis.document;
  globalThis.document = mockDoc;

  try {
    const cleanup = addTabVisibilityListener({
      onHidden: () => {
        hiddenCalled = true;
      },
      onVisible: () => {
        visibleCalled = true;
      },
    });

    // Simulate tab switch away
    currentVisibility = 'hidden';
    mockDoc._handler();
    assert.equal(hiddenCalled, true);
    assert.equal(visibleCalled, false);

    // Simulate tab switch back
    currentVisibility = 'visible';
    mockDoc._handler();
    assert.equal(visibleCalled, true);

    cleanup();
    assert.equal(mockDoc._handler, undefined);
  } finally {
    globalThis.document = origDoc;
  }
});
