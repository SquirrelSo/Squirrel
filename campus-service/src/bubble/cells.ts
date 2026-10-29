/**
 * Bubble grid: a fixed, coarse (~250 m) grid over the campus. A position is reduced to a cell key once,
 * on join, and the coordinates are then discarded. The grid's longitude step uses the campus centre's
 * latitude so that every cell has the same size and the 3×3 neighbourhood is well defined. Pure.
 */
import { config } from '../config.js';

const M_PER_DEG_LAT = 111_320;

export type Cell = { ix: number; iy: number; key: string };

function steps(cellM: number) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((config.campus.centerLat * Math.PI) / 180);
  return { dLat: cellM / M_PER_DEG_LAT, dLng: cellM / mPerDegLng };
}

export function cellKey(ix: number, iy: number): string {
  return `${iy}:${ix}`;
}

/** The grid cell containing a point. */
export function cellFor(lat: number, lng: number, cellM = config.bubble.cellM): Cell {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new RangeError('lat/lng must be finite');
  const { dLat, dLng } = steps(cellM);
  const iy = Math.floor(lat / dLat), ix = Math.floor(lng / dLng);
  return { ix, iy, key: cellKey(ix, iy) };
}

export function parseCellKey(key: string): { ix: number; iy: number } | null {
  const m = /^(-?\d+):(-?\d+)$/.exec(key);
  return m ? { iy: Number(m[1]), ix: Number(m[2]) } : null;
}

/** The 3×3 neighbourhood of a cell (the cell itself first). */
export function neighbourhood(key: string): string[] {
  const c = parseCellKey(key);
  if (!c) return [];
  const out = [key];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) out.push(cellKey(c.ix + dx, c.iy + dy));
  return out;
}

/** True when two cells are the same or touch (including diagonally). */
export function areNeighbours(a: string, b: string): boolean {
  const x = parseCellKey(a), y = parseCellKey(b);
  return !!x && !!y && Math.abs(x.ix - y.ix) <= 1 && Math.abs(x.iy - y.iy) <= 1;
}

/** Coarse proximity between two members: same cell → very_close, a touching cell → nearby. */
export function cellProximity(a: string, b: string): 'very_close' | 'nearby' | null {
  if (a === b) return 'very_close';
  return areNeighbours(a, b) ? 'nearby' : null;
}

/** Centre of a cell (test helper and documentation; never sent to clients). */
export function cellCentre(ix: number, iy: number, cellM = config.bubble.cellM): { lat: number; lng: number } {
  const { dLat, dLng } = steps(cellM);
  return { lat: (iy + 0.5) * dLat, lng: (ix + 0.5) * dLng };
}
