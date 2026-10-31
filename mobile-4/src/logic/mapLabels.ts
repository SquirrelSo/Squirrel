/**
 * What the world map writes, and where. Every zone, place and building keeps its label — the map
 * only decides how many show at once: a tier per place (how important it is to a student), the
 * scale it appears at, and a collision pass so text never piles onto text or onto people.
 * Pure, so it's unit-tested (mapLabels.test.mjs).
 */

/** 1 = always (homes, food, library, grounds) · 2 = mid zoom · 3 = close up only. */
export type LabelTier = 1 | 2 | 3;

/** Metres per screen pixel below which each tier appears. */
export const TIER_MPP: Record<LabelTier, number> = { 1: Infinity, 2: 2.4, 3: 1.2 };
/** People's first names show only this close (their avatars carry them before that). */
export const PERSON_LABEL_MPP = 0.8;

const MINOR = /faculty|quarters|prefab|substation|bungalow|school|scool|staff|guest ?house|pump|tank|store/i;

/** How prominent a zone's name is. Hostels, food, the library and the grounds are what students navigate by. */
export function zoneTier(z: { kind: string; name: string }): LabelTier {
  if (MINOR.test(z.name)) return 3;
  if (z.kind === 'hostel' || z.kind === 'food' || z.kind === 'library' || z.kind === 'sports') return 1;
  return 2;
}

const PHRASES: [RegExp, string][] = [
  [/\bLecture Hall Complex\b/i, 'LHC'],
  [/\bResearch Complex\b/i, 'Research'],
  [/\bFaculty Quarters\b/i, 'Faculty Qtrs'],
  [/\bSwimming Pool\b/i, 'Pool'],
  [/\bElectrical Substation\b/i, 'Substation'],
  [/\bAuditorium\b/i, 'Auditorium'],
  [/\bBuilding\b/i, 'Bldg'],
];

/**
 * A clean, short map label. Backends cut `short_name` at a fixed length ("IISER Kolkata Libr"), so a
 * short name that is just a prefix of the full name isn't used; the campus name is dropped (every
 * place is on campus), long phrases are abbreviated, and anything still long is cut at a word.
 */
export function placeLabel(name: string, shortName?: string | null, max = 22): string {
  const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
  const full = tidy(name);
  const short = shortName ? tidy(shortName) : '';
  const truncated = !!short && short.length < full.length && full.toLowerCase().startsWith(short.toLowerCase());
  if (short && !truncated && short.length <= max) return short;
  let s = full.replace(/^IISER\s+Kolkata\s+/i, '').replace(/\s+IISER\s+Kolkata(\s+Campus)?$/i, '');
  if (s.length <= max) return s;
  for (const [re, to] of PHRASES) {
    s = s.replace(re, to);
    if (s.length <= max) return s;
  }
  // Still long: whole words up to the limit (a person's name is never cut mid-word).
  const words = s.split(' ');
  let out = words[0];
  for (const w of words.slice(1)) {
    if ((out + ' ' + w).length > max) break;
    out += ' ' + w;
  }
  return out;
}

export type LabelCandidate = {
  id: string;
  /** Screen position (pixels) of the label's centre. */
  x: number;
  y: number;
  text: string;
  tier: LabelTier;
  /** Selected, yours, contested: shown at any scale, placed first. */
  pinned?: boolean;
  fontSize: number;
};
export type Obstacle = { x: number; y: number; r: number };

/** On-screen box of a label (uppercase condensed type, a little padding). */
export function labelBox(c: Pick<LabelCandidate, 'x' | 'y' | 'text' | 'fontSize'>) {
  const w = c.text.length * c.fontSize * 0.56 + 10;
  const h = c.fontSize + 8;
  return { x0: c.x - w / 2, x1: c.x + w / 2, y0: c.y - h / 2, y1: c.y + h / 2 };
}

/** Where a label may sit relative to its anchor (screen px): on it, just below, just above, then a step further. */
const SLOTS: [number, number][] = [[0, 0], [0, 26], [0, -26], [0, 44], [0, -44]];

/**
 * Which labels show at this scale, and where. Pinned first, then tier 1 → 3 (ties: original order,
 * which the caller sorts by size). A label shows only if its tier is visible at `mpp`; it takes the
 * first slot (on its anchor, below, above) that overlaps no label already placed and no obstacle
 * (you, people, clusters) — so a crowd standing on a hostel moves its name aside rather than hiding it.
 * Returns the shown labels with their offset (screen px).
 */
export function placeLabels(cands: LabelCandidate[], mpp: number, obstacles: Obstacle[] = []): Map<string, { dx: number; dy: number }> {
  const order = cands
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.pinned || mpp <= TIER_MPP[c.tier])
    .sort((a, b) => Number(!!b.c.pinned) - Number(!!a.c.pinned) || a.c.tier - b.c.tier || a.i - b.i);
  const placed: ReturnType<typeof labelBox>[] = [];
  const shown = new Map<string, { dx: number; dy: number }>();
  for (const { c } of order) {
    for (const [dx, dy] of SLOTS) {
      const b = labelBox({ ...c, x: c.x + dx, y: c.y + dy });
      const hitsLabel = placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
      const hitsMarker = obstacles.some((o) => o.x + o.r > b.x0 && o.x - o.r < b.x1 && o.y + o.r > b.y0 && o.y - o.r < b.y1);
      if (hitsLabel || hitsMarker) continue;
      placed.push(b);
      shown.set(c.id, { dx, dy });
      break;
    }
  }
  return shown;
}

/** Same place, said twice (a building captioned with its zone's name): keep the zone's. */
export const sameName = (a: string, b: string) => {
  const n = (s: string) => s.toLowerCase().replace(/^iiser kolkata\s+/, '').replace(/[^a-z0-9]/g, '');
  const x = n(a);
  const y = n(b);
  return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
};
