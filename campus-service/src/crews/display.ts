/**
 * How a crew is shown (name, colour, icon) wherever territories or challenges mention one.
 *
 * Crews are Social's (ADR-032). Names and interest come from Social; Social has no crew colour.
 * If Social is unavailable or unconfigured, only the id placeholder can be shown.
 */
import { lookupCrews } from '../identity/index.js';

export type CrewDisplay = { id: string; name: string; color: string | null; icon: string | null };

const INTEREST_ICON: Record<string, string> = {
  running: 'run', walking: 'walk', cycling: 'bike', yoga: 'yoga', hiit: 'lightning-bolt',
  climbing: 'image-filter-hdr', nutrition: 'food-apple', other: 'account-group',
};

/** Display fields for each crew id that exists. A crew Social doesn't know is absent from the map. */
export async function crewDisplays(ids: Array<string | null | undefined>): Promise<Map<string, CrewDisplay>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  const out = new Map<string, CrewDisplay>();
  if (!wanted.length) return out;
  for (const [id, c] of await lookupCrews(wanted)) out.set(id, { id, name: c.name, color: null, icon: INTEREST_ICON[c.interest] ?? null });
  return out;
}

/** The crew as shown on a territory or challenge: known crews in full, an unknown one by id only. */
export function crewOrPlaceholder(id: string | null, crews: Map<string, CrewDisplay>): CrewDisplay | null {
  return id ? crews.get(id) ?? { id, name: '', color: null, icon: null } : null;
}
