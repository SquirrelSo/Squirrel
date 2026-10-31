/**
 * Features that exist in the UI but are not launched yet. While locked they render as
 * "Coming soon" and every entry point (buttons, routes, state actions) is a no-op.
 * Flip a flag to false at launch.
 *
 * Screens should not read LOCKED directly: use `useLocks()` / `<FeatureGate>` from
 * components/Locked.tsx (UI) or `isLocked()` (state and data).
 */
export const LOCKED = {
  /** Meal + water logging (Create actions, the water/meal daily missions). */
  mealWater: true,
  /** Events: /events, /event/[id], event cards, study-break walks, joining. Not launching yet. */
  events: true,
  /** Partner Hunt: find a workout buddy (Exercise). Unlocked; set true to show the locked screen on every /partner-hunt route. */
  partnerHunt: false,
  /** Story viewer (story bubbles on Social). Posting your own story via the composer still works. */
  stories: true,
} as const;

export type Feature = keyof typeof LOCKED;

export const isLocked = (feature: Feature): boolean => LOCKED[feature];

export const COMING_SOON: Record<Feature, string> = {
  mealWater: 'Meal & water tracking is coming soon',
  events: 'Events are coming soon',
  partnerHunt: 'Partner Hunt is coming soon',
  stories: 'Stories are coming soon',
};

/** Missions that belong to a not-yet-launched feature. */
const MISSION_FEATURE: Record<string, Feature> = {
  'm-water': 'mealWater',
  'm-meal': 'mealWater',
  'w-event': 'events',
};

/** Missions whose feature is currently locked (derived from LOCKED; no second list to keep in sync). */
export const LOCKED_MISSIONS = new Set<string>(Object.keys(MISSION_FEATURE).filter((id) => isLocked(MISSION_FEATURE[id])));
