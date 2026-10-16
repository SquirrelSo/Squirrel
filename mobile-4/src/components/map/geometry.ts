import type { LatLng, MapFeatures, Zone } from '@/api/campus/types';

export type Projection = { project: (p: LatLng) => [number, number]; width: number; height: number };

const PAD = 60; // metres around the outermost feature

/** Equirectangular projection → SVG units (1 unit = 1 m), framed around zones (+ base map). */
export function makeProjection(zones: Zone[], features?: MapFeatures | null): Projection | null {
  const pts = zones.flatMap((z) => z.polygon);
  if (!pts.length) return null;
  const all = features ? [...pts, ...features.buildings.flatMap((b) => b.polygon), ...features.terrain.flatMap((t) => t.polygon), ...features.roads.flatMap((r) => r.points)] : pts;
  const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const mLat = 111_320;
  const mLng = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of all) {
    const x = p[1] * mLng;
    const y = p[0] * mLat;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  minX -= PAD;
  maxX += PAD;
  minY -= PAD;
  maxY += PAD;
  return { project: (p) => [p[1] * mLng - minX, maxY - p[0] * mLat], width: maxX - minX, height: maxY - minY };
}

/** Fit of the SVG viewBox inside a w×h view (preserveAspectRatio "meet"). */
export function fitOf(proj: Projection, w: number, h: number) {
  const k = Math.min(w / proj.width, h / proj.height);
  return { k, ox: (w - proj.width * k) / 2, oy: (h - proj.height * k) / 2 };
}

/** Ray casting in projected units (for your OWN position only — e.g. "near Library"). */
export function inPolygon(pt: [number, number], poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const pts = (proj: Projection, list: LatLng[]) => list.map((p) => proj.project(p).map((n) => n.toFixed(1)).join(',')).join(' ');
