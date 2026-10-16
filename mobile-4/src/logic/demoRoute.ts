/**
 * Demo movement for when there is no GPS (web, or location denied): a fixed loop around the
 * campus, walked at a steady pace. It is always labelled "Demo" in the UI and never uploaded
 * to a live backend as a real run.
 */
import type { LatLng } from '@/api/campus/types';
import { DEMO_ROUTE_XY, toLatLng } from '@/logic/demoLoop';

const PATH: [number, number][] = DEMO_ROUTE_XY;
const SEGS = PATH.slice(1).map((p, i) => Math.hypot(p[0] - PATH[i][0], p[1] - PATH[i][1]));
const TOTAL = SEGS.reduce((s, d) => s + d, 0);

/** Position after `meters` along the loop (wraps around). */
export function demoPosition(meters: number): LatLng {
  let m = ((meters % TOTAL) + TOTAL) % TOTAL;
  for (let i = 0; i < SEGS.length; i++) {
    if (m <= SEGS[i]) {
      const t = SEGS[i] ? m / SEGS[i] : 0;
      const [ax, ay] = PATH[i];
      const [bx, by] = PATH[i + 1];
      return toLatLng(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
    m -= SEGS[i];
  }
  return toLatLng(PATH[0][0], PATH[0][1]);
}

/** Metres per second for the demo, by activity. */
export const DEMO_SPEED = { run: 2.65, walk: 1.35 } as const;
