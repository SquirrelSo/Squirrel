import { describe, it, expect } from 'vitest';
import { scoreActivity } from '../../src/verification/anticheat.js';
import { trackAlong, xyToLatLng } from '../helpers.js';

const base = (pts: ReturnType<typeof trackAlong>, type: 'run' | 'walk' = 'run') => ({
  activityType: type, points: pts, clientDistanceM: null, clientDurationS: null, startedAt: pts[0]!.recorded_at, endedAt: pts[pts.length - 1]!.recorded_at,
});

describe('anti-cheat scoring', () => {
  it('verifies a normal run', () => {
    const pts = trackAlong([[0, 0], [400, 0], [400, 300], [0, 300], [0, 0]], 3.2);
    const r = scoreActivity(base(pts));
    expect(r.band).toBe('VERIFIED');
    expect(r.score).toBeGreaterThanOrEqual(0.75);
    expect(r.reason).toBe('ok');
    expect(r.stats.distanceM).toBeCloseTo(1400, -2);
  });
  it('rejects a track that is too short', () => {
    const pts = trackAlong([[0, 0], [50, 0]], 2);
    expect(scoreActivity(base(pts)).reason).toBe('too_short');
  });
  it('rejects vehicle speeds', () => {
    const pts = trackAlong([[0, 0], [2000, 0]], 12);
    const r = scoreActivity(base(pts));
    expect(r.band).toBe('REJECTED');
    expect(r.reason).toBe('too_fast');
  });
  it('rejects a walk done at running pace', () => {
    const pts = trackAlong([[0, 0], [1500, 0]], 4);
    expect(scoreActivity(base(pts, 'walk')).reason).toBe('too_fast');
  });
  it('drops a few GPS jumps but keeps the rest (partially verified or verified with segments_dropped)', () => {
    const pts = trackAlong([[0, 0], [600, 0], [600, 400]], 3);
    for (const i of [30, 60]) pts[i] = { ...pts[i]!, ...xyToLatLng(-800, -800) };
    const r = scoreActivity(base(pts));
    expect(r.band).not.toBe('REJECTED');
    expect(r.stats.droppedSegments).toBeGreaterThan(0);
    expect(r.keptPoints.length).toBeLessThan(pts.length);
    expect(r.reason).toBe('segments_dropped');
  });
  it('rejects a track riddled with jumps', () => {
    const pts = trackAlong([[0, 0], [600, 0], [600, 400]], 3);
    for (let i = 3; i < pts.length; i += 4) pts[i] = { ...pts[i]!, ...xyToLatLng(-900 + (i % 7) * 100, -900) };
    const r = scoreActivity(base(pts));
    expect(r.band).toBe('REJECTED');
    expect(r.reason).toBe('gps_jumps');
  });
  it('penalises consistently poor accuracy', () => {
    const good = scoreActivity(base(trackAlong([[0, 0], [500, 0], [500, 300]], 3, { accuracy: 6 }))).score;
    const bad = scoreActivity(base(trackAlong([[0, 0], [500, 0], [500, 300]], 3, { accuracy: 60 }))).score;
    expect(bad).toBeLessThan(good);
  });
  it('penalises over-reported client distance', () => {
    const pts = trackAlong([[0, 0], [500, 0], [500, 300]], 3);
    const honest = scoreActivity({ ...base(pts), clientDistanceM: 800 }).score;
    const liar = scoreActivity({ ...base(pts), clientDistanceM: 2500 }).score;
    expect(liar).toBeLessThan(honest);
  });
});
