/**
 * Screens that notifications point to. The backends write routes of the older app; this maps
 * them onto this app's screens (push taps and the in-app notification list both use it).
 */
const ALIASES: Record<string, string> = {
  '/challenges': '/invites', // head-to-head duels live under Challenge invites here
  '/invite': '/referral', // "X joined with your invite" → your invite code and place in line
  '/territory': '/explore',
};

/** The app route for a backend `data.route`, or null when it isn't a route. */
export function appRoute(route: unknown): string | null {
  if (typeof route !== 'string' || !route.startsWith('/')) return null;
  return ALIASES[route] ?? route;
}
