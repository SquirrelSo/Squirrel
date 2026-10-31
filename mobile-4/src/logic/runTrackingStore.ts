// @ts-expect-error Node's built-in strip-types test runner needs the explicit .ts extension.
import { addFix, addFixBatch, emptyTrack, type Fix, type TrackState } from './track.ts';

export type RunSource = 'gps' | 'demo';
export type RunTrackingSnapshot = {
  track: TrackState;
  latestFix: Fix | null;
  lastFixAt: number;
  active: boolean;
  paused: boolean;
  source: RunSource | null;
};

const initial = (): RunTrackingSnapshot => ({
  track: emptyTrack(),
  latestFix: null,
  lastFixAt: 0,
  active: false,
  paused: false,
  source: null,
});

let snapshot = initial();
const listeners = new Set<() => void>();

function publish(next: RunTrackingSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getRunTrackingSnapshot() {
  return snapshot;
}

export function subscribeRunTracking(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function beginRunTracking(source: RunSource, now = Date.now()) {
  publish({ ...initial(), lastFixAt: now, active: true, source });
}

export function prepareRunTracking(source: RunSource) {
  publish({ ...initial(), lastFixAt: Date.now(), source });
}

export function endRunTracking() {
  publish({ ...snapshot, active: false, paused: false, source: null });
}

export function clearRunTracking() {
  publish(initial());
}

export function setRunTrackingPaused(paused: boolean) {
  publish({ ...snapshot, paused });
}

export function noteRunLocationFix(fix: Fix) {
  publish({ ...snapshot, latestFix: fix, lastFixAt: Date.now() });
}

export function addRunTrackingFix(fix: Fix) {
  if (!snapshot.active || !snapshot.source) return;
  publish({ ...snapshot, latestFix: fix, lastFixAt: Date.now(), track: snapshot.paused ? snapshot.track : addFix(snapshot.track, fix) });
}

/** Background batches can arrive out of order; sort each batch before addFix's monotonic gate. */
export function addRunTrackingBatch(fixes: readonly Fix[]) {
  if (!snapshot.active || snapshot.source !== 'gps' || fixes.length === 0) return;
  const ordered = [...fixes].sort((a, b) => a.t - b.t);
  publish({
    ...snapshot,
    latestFix: ordered[ordered.length - 1],
    lastFixAt: Date.now(),
    track: snapshot.paused ? snapshot.track : addFixBatch(snapshot.track, ordered),
  });
}
