/**
 * Grouping people on the map by how close they are on screen, not by which grid cell they fall in
 * (two people either side of a cell boundary used to land on top of each other). The rule is that
 * no two markers ever touch: people within `radius` of a group join it; three or more become a
 * count; a pair sits side by side with a clear gap; and if, laid out, any two markers would still
 * touch (a pair's side against a neighbouring count, zoomed far out), those groups merge and the
 * layout runs again. Your own dot (`fixed`) never moves and is never covered: a marker that would
 * touch it slides just clear of it. Pure, so it's unit-tested (mapCluster.test.mjs).
 */

/** A pair's centres sit this far apart — at least the clearance, so no two markers anywhere are closer. */
export const PAIR_GAP_PX = 44;
/** Closer than this on screen and two people are one group. */
export const GROUP_RADIUS_PX = 34;
/** Two laid-out markers closer than this (centre to centre) would touch: a count is up to 40 px, an avatar with its badge ~36. */
export const MARKER_CLEARANCE_PX = 42;

export type ScreenPoint = { id: string; x: number; y: number };
export type Placed =
  | { kind: 'single'; id: string; x: number; y: number }
  | { kind: 'cluster'; key: string; ids: string[]; x: number; y: number };

type Group = { pts: ScreenPoint[]; x: number; y: number };
const centre = (pts: ScreenPoint[]) => ({ x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length });

function layout(groups: Group[], gap: number): { g: number; p: Placed }[] {
  const out: { g: number; p: Placed }[] = [];
  groups.forEach((grp, g) => {
    if (grp.pts.length >= 3) {
      const ids = grp.pts.map((p) => p.id);
      out.push({ g, p: { kind: 'cluster', key: [...ids].sort().join('|'), ids, x: grp.x, y: grp.y } });
    } else if (grp.pts.length === 2) {
      // Side by side, left one first (stable: by id), centred on the pair.
      const [a, b] = [...grp.pts].sort((p, q) => p.x - q.x || (p.id < q.id ? -1 : 1));
      out.push({ g, p: { kind: 'single', id: a.id, x: grp.x - gap / 2, y: grp.y } }, { g, p: { kind: 'single', id: b.id, x: grp.x + gap / 2, y: grp.y } });
    } else out.push({ g, p: { kind: 'single', id: grp.pts[0].id, x: grp.pts[0].x, y: grp.pts[0].y } });
  });
  return out;
}

/** Your dot is smaller than an avatar: this close (centre to centre) and someone would cover it. */
export const FIXED_CLEARANCE_PX = 30;

export function groupMarkers(points: ScreenPoint[], fixed: { x: number; y: number } | null = null, radius = GROUP_RADIUS_PX, gap = PAIR_GAP_PX, clearance = MARKER_CLEARANCE_PX): Placed[] {
  let groups: Group[] = [];
  for (const p of points) {
    const g = groups.find((q) => Math.hypot(q.x - p.x, q.y - p.y) < radius);
    if (g) {
      g.pts.push(p);
      Object.assign(g, centre(g.pts));
    } else groups.push({ pts: [p], x: p.x, y: p.y });
  }
  // Merge any groups whose laid-out markers would touch, until none do; slide any that would cover
  // your dot just clear of it. Merges remove a group each time; slides are bounded by `rounds`.
  for (let rounds = 0; ; rounds++) {
    const placed = layout(groups, gap);
    if (fixed && rounds < 40) {
      const under = placed.find((x) => Math.hypot(x.p.x - fixed.x, x.p.y - fixed.y) < FIXED_CLEARANCE_PX);
      if (under) {
        const dx = under.p.x - fixed.x;
        const dy = under.p.y - fixed.y;
        const d = Math.hypot(dx, dy) || 1;
        // Straight away from you (straight down if exactly on top), by just enough.
        const [ux, uy] = Math.hypot(dx, dy) ? [dx / d, dy / d] : [0, 1];
        const push = FIXED_CLEARANCE_PX - Math.hypot(dx, dy) + 1;
        const grp = groups[under.g];
        grp.x += ux * push;
        grp.y += uy * push;
        if (grp.pts.length === 1) grp.pts = [{ ...grp.pts[0], x: grp.pts[0].x + ux * push, y: grp.pts[0].y + uy * push }];
        continue;
      }
    }
    let hit: [number, number] | null = null;
    for (let i = 0; i < placed.length && !hit; i++)
      for (let j = i + 1; j < placed.length; j++)
        if (placed[i].g !== placed[j].g && Math.hypot(placed[i].p.x - placed[j].p.x, placed[i].p.y - placed[j].p.y) < clearance) {
          hit = [placed[i].g, placed[j].g];
          break;
        }
    if (!hit) return placed.map((x) => x.p);
    const [a, b] = hit;
    const pts = [...groups[a].pts, ...groups[b].pts];
    groups = groups.filter((_, k) => k !== a && k !== b).concat({ pts, ...centre(pts) });
  }
}
