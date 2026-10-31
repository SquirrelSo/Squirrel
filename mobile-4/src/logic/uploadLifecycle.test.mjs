import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadAndClearOnSuccess } from './uploadLifecycle.ts';
import { addRunTrackingFix, beginRunTracking, clearRunTracking, getRunTrackingSnapshot } from './runTrackingStore.ts';

const seedTrack = () => {
  clearRunTracking();
  beginRunTracking('gps', 0);
  addRunTrackingFix({ lat: 0, lon: 0, t: 1_000, accuracy: 1 });
  addRunTrackingFix({ lat: 0, lon: 0.0001, t: 2_000, accuracy: 1 });
};

test('RUN UPLOAD SUCCESS: clears tracking state after upload resolves', async () => {
  seedTrack();
  const result = await uploadAndClearOnSuccess(async () => ({ status: 'uploaded' }), clearRunTracking);

  assert.deepEqual(result, { status: 'uploaded' });
  assert.deepEqual(getRunTrackingSnapshot().track.points, []);
  assert.equal(getRunTrackingSnapshot().active, false);
});

test('RUN UPLOAD FAILURE: keeps tracking state when upload rejects', async () => {
  seedTrack();
  const pointsBeforeUpload = getRunTrackingSnapshot().track.points;

  await assert.rejects(
    uploadAndClearOnSuccess(async () => { throw new Error('network failure'); }, clearRunTracking),
    /network failure/,
  );
  assert.deepEqual(getRunTrackingSnapshot().track.points, pointsBeforeUpload);
  assert.equal(getRunTrackingSnapshot().active, true);
});
