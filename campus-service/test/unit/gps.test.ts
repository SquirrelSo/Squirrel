import { describe, it, expect } from 'vitest';
import { validatePoints, haversineM, trackStats } from '../../src/activities/gps.js';
import { trackAlong, xyToLatLng } from '../helpers.js';

describe('GPS validation', () => {
  it('accepts a plausible track', () => {
    const pts = trackAlong([[0, 0], [300, 0], [300, 200]], 3);
    expect(() => validatePoints(pts, null)).not.toThrow();
  });
  it('rejects empty and oversized batches', () => {
    expect(() => validatePoints([], null)).toThrow(/empty/);
    const pts = trackAlong([[0, 0], [3000, 0]], 3, { stepS: 1 });
    expect(pts.length).toBeGreaterThan(1000);
    expect(() => validatePoints(pts, null)).toThrow(/At most 1000/);
  });
  it('rejects out-of-order timestamps', () => {
    const pts = trackAlong([[0, 0], [100, 0]], 2);
    const swapped = [pts[0]!, { ...pts[2]!, seq: 1 }, { ...pts[1]!, seq: 2 }, ...pts.slice(3).map((p, i) => ({ ...p, seq: i + 3 }))];
    expect(() => validatePoints(swapped, null)).toThrow(/non-decreasing|seq/);
  });
  it('rejects impossible jumps (teleport)', () => {
    const pts = trackAlong([[0, 0], [100, 0]], 2);
    const far = xyToLatLng(3000, 0);
    pts[5] = { ...pts[5]!, ...far };
    expect(() => validatePoints(pts, null)).toThrow(/impossible jump/);
  });
  it('rejects poor accuracy and out-of-range coordinates', () => {
    const pts = trackAlong([[0, 0], [100, 0]], 2);
    expect(() => validatePoints([{ ...pts[0]!, accuracy_m: 500 }], null)).toThrow(/accuracy/);
    expect(() => validatePoints([{ ...pts[0]!, lat: 95 }], null)).toThrow();
  });
  it('rejects points far outside campus', () => {
    const pts = trackAlong([[0, 0], [100, 0]], 2).map((p) => ({ ...p, lat: p.lat + 1 }));
    expect(() => validatePoints(pts, null)).toThrow(/outside the campus/);
  });
  it('rejects a batch that goes back in time relative to the previous batch', () => {
    const pts = trackAlong([[0, 0], [200, 0]], 2);
    const prev = pts[10]!;
    expect(() => validatePoints(pts.slice(0, 5), prev)).toThrow(/non-decreasing/);
  });
  it('computes distance with haversine and drops jump segments in stats', () => {
    const a = xyToLatLng(0, 0), b = xyToLatLng(1000, 0);
    expect(haversineM(a.lat, a.lng, b.lat, b.lng)).toBeCloseTo(1000, -1);
    const pts = trackAlong([[0, 0], [400, 0]], 3);
    const s = trackStats(pts, 8);
    expect(s.distanceM).toBeCloseTo(400, -1);
    expect(s.droppedSegments).toBe(0);
  });
});
