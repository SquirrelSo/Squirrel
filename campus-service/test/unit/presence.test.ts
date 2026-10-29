import { describe, it, expect } from 'vitest';
import { bucket, snapToGrid } from '../../src/presence/service.js';
import { haversineM } from '../../src/activities/gps.js';

describe('presence privacy', () => {
  it('buckets distances', () => {
    expect(bucket(50)).toBe('very_close');
    expect(bucket(300)).toBe('nearby');
    expect(bucket(2000)).toBe('on_campus');
    expect(bucket(null)).toBe('on_campus');
  });
  it('grid snapping never reveals a position more precisely than the grid', () => {
    const lat = 22.96371234, lng = 88.52456789;
    const s = snapToGrid(lat, lng, 100);
    expect(haversineM(lat, lng, s.lat, s.lng)).toBeLessThan(100);
    const s2 = snapToGrid(lat + 0.0001, lng + 0.0001, 100);
    expect(s2.lat === s.lat || Math.abs(s2.lat - s.lat) > 0.0005).toBe(true); // either same cell or a whole cell away
  });
});
