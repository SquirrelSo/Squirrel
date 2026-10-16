import type { Territory, TerritoryStatus } from '@/api/campus';
import type { IconName } from '@/data/icons';
import { colors } from '@/theme';

/** How a territory relates to the viewer. Derived from the server's owner, never guessed. */
export type Relation = 'unclaimed' | 'mine' | 'other' | 'unknown';

export const relationOf = (t: Territory | undefined, meId: string | null | undefined): Relation =>
  !t ? 'unknown' : !t.owner ? 'unclaimed' : meId && t.owner.user_id === meId ? 'mine' : 'other';

export const RELATION_COLOR: Record<Relation, string> = {
  mine: colors.primary,
  other: colors.secondary,
  unclaimed: colors.mute,
  unknown: colors.lineHi,
};

export const RELATION_LABEL: Record<Relation, string> = {
  mine: 'Your territory',
  other: 'Held',
  unclaimed: 'Unclaimed',
  unknown: 'Loading',
};

export const UNDER_ATTACK = colors.gold;

export const ZONE_ICON: Record<string, IconName> = {
  hostel: 'home-city-outline',
  academic: 'school-outline',
  sports: 'stadium-variant',
  food: 'silverware-fork-knife',
  library: 'bookshelf',
  landmark: 'map-marker-star-outline',
};

export const shortTime = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

export const untilTime = (iso: string | null | undefined) => {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

export const km = (m: number | null | undefined, digits = 1) => (m == null ? '—' : `${(m / 1000).toFixed(digits)} km`);


/** The backend's territory status; derived from owner/under_challenge only for servers that don't send it. */
export const displayStatus = (t: Territory | undefined): TerritoryStatus | 'unknown' =>
  !t ? 'unknown' : t.status ?? (!t.owner ? 'neutral' : t.under_challenge ? 'under_attack' : 'controlled');

export const STATUS_UI: Record<TerritoryStatus | 'unknown', { label: string; color: string; icon: IconName }> = {
  neutral: { label: 'Neutral', color: colors.mute, icon: 'flag-outline' },
  controlled: { label: 'Controlled', color: colors.secondary, icon: 'flag-variant' },
  contested: { label: 'Contested', color: colors.gold, icon: 'sword-cross' },
  under_attack: { label: 'Under attack', color: colors.orange, icon: 'shield-alert' },
  unknown: { label: 'Loading', color: colors.lineHi, icon: 'dots-horizontal' },
};
