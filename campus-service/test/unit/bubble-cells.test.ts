import { describe, it, expect } from 'vitest';
import { areNeighbours, cellCentre, cellFor, cellKey, cellProximity, neighbourhood, parseCellKey } from '../../src/bubble/cells.js';
import { haversineM } from '../../src/activities/gps.js';
import { config } from '../../src/config.js';

describe('bubble grid cells', () => {
  const lat = config.campus.centerLat, lng = config.campus.centerLng;

  it('is deterministic and keyed by integer indices only', () => {
    const a = cellFor(lat, lng), b = cellFor(lat, lng);
    expect(a).toEqual(b);
    expect(a.key).toMatch(/^-?\d+:-?\d+$/);
    expect(a.key).toBe(cellKey(a.ix, a.iy));
    expect(parseCellKey(a.key)).toEqual({ ix: a.ix, iy: a.iy });
  });

  it('cells are ~250 m: the centre is within half a diagonal of any point in the cell', () => {
    const c = cellFor(lat, lng);
    const centre = cellCentre(c.ix, c.iy);
    expect(cellFor(centre.lat, centre.lng).key).toBe(c.key);
    expect(haversineM(lat, lng, centre.lat, centre.lng)).toBeLessThanOrEqual(Math.SQRT2 * 125 + 1);
    // a neighbouring cell centre is one cell (≈250 m) away
    const east = cellCentre(c.ix + 1, c.iy), north = cellCentre(c.ix, c.iy + 1);
    expect(haversineM(centre.lat, centre.lng, east.lat, east.lng)).toBeGreaterThan(245);
    expect(haversineM(centre.lat, centre.lng, east.lat, east.lng)).toBeLessThan(255);
    expect(haversineM(centre.lat, centre.lng, north.lat, north.lng)).toBeGreaterThan(245);
    expect(haversineM(centre.lat, centre.lng, north.lat, north.lng)).toBeLessThan(255);
  });

  it('points a few metres apart inside one cell share it; crossing an edge changes it', () => {
    const c = cellFor(lat, lng);
    const centre = cellCentre(c.ix, c.iy);
    expect(cellFor(centre.lat + 0.0002, centre.lng + 0.0002).key).toBe(c.key); // ~25 m
    expect(cellFor(cellCentre(c.ix + 1, c.iy).lat, cellCentre(c.ix + 1, c.iy).lng).key).not.toBe(c.key);
  });

  it('the neighbourhood is the 3×3 block, the cell itself first', () => {
    const c = cellFor(lat, lng);
    const n = neighbourhood(c.key);
    expect(n).toHaveLength(9);
    expect(new Set(n).size).toBe(9);
    expect(n[0]).toBe(c.key);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) expect(n).toContain(cellKey(c.ix + dx, c.iy + dy));
    expect(n).not.toContain(cellKey(c.ix + 2, c.iy));
    expect(neighbourhood('garbage')).toEqual([]);
  });

  it('proximity buckets: same cell very_close, touching nearby, further none', () => {
    const k = cellKey(10, 10);
    expect(cellProximity(k, k)).toBe('very_close');
    expect(cellProximity(k, cellKey(11, 11))).toBe('nearby');
    expect(cellProximity(k, cellKey(9, 10))).toBe('nearby');
    expect(cellProximity(k, cellKey(12, 10))).toBeNull();
    expect(areNeighbours(k, cellKey(10, 12))).toBe(false);
  });

  it('negative indices work (west / south of the origin)', () => {
    const c = cellFor(-22.5, -43.2);
    expect(c.ix).toBeLessThan(0);
    expect(c.iy).toBeLessThan(0);
    expect(neighbourhood(c.key)).toContain(cellKey(c.ix - 1, c.iy - 1));
  });

  it('rejects non-finite input', () => {
    expect(() => cellFor(NaN, 1)).toThrow();
  });
});
