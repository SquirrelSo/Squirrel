/**
 * Geometry for the Run Module's labelled demo route (logic/demoRoute.ts): a fixed loop around the
 * IISER Kolkata campus centre, used only where GPS can't exist (web preview, location denied).
 * The run screen always marks it "Demo route · simulated, not a real activity" and never uploads it.
 * This is the one simulation kept on purpose; it holds no campus data (no zones, people or maps).
 */
import type { LatLng } from '@/api/campus/types';

const CAMPUS_CENTER: LatLng = [22.9637, 88.5245];
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos((CAMPUS_CENTER[0] * Math.PI) / 180);

/** Local metres (x east, y north) → [lat, lng]. */
export const toLatLng = (x: number, y: number): LatLng => [CAMPUS_CENTER[0] + y / M_PER_DEG_LAT, CAMPUS_CENTER[1] + x / M_PER_DEG_LNG];

const oval = (cx: number, cy: number, rx: number, ry: number, n = 16): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as [number, number];
  });

/** The loop, in local metres: Main Gate → Admin Lawn → CC1 → a lap of the Sports Ground → back. */
export const DEMO_ROUTE_XY: [number, number][] = [
  [10, -240],
  [10, -160],
  [40, -80],
  [120, 20],
  [130, 90],
  [60, 110],
  [-60, 90],
  [-200, 70],
  [-270, 70],
  ...oval(-390, 70, 120, 80, 20),
  [-270, 70],
  [-200, 40],
  [-60, -40],
  [10, -160],
  [10, -240],
];
