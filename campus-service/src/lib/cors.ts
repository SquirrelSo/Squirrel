/**
 * CORS_ORIGINS entries → what @fastify/cors accepts. Exact origins stay strings; an entry with `*`
 * (e.g. https://squirrel-*.vercel.app for Vercel previews) becomes a RegExp where `*` matches
 * letters, digits and hyphens only — never a dot, so it can't reach another domain. Same rule as
 * the Social service and the Exercise backend.
 */
export function corsOrigins(entries: readonly string[]): (string | RegExp)[] | false {
  const out = entries
    .map((e) => e.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .map((e) => (e.includes('*') ? new RegExp('^' + e.split('*').map(escape).join('[a-z0-9-]+') + '$') : e));
  return out.length ? out : false;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
