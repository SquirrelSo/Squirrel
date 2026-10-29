import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPool, many, one } from '../db/pool.js';
import { errors } from '../lib/errors.js';
import { requireAuth, currentUser } from '../auth/plugin.js';
import { getZone, listZones, serializeZone, zonesNear, type ZoneRow } from './repo.js';
import { getTerritory, listTerritories, serializeTerritories, territoryOut, serializeEvents, zoneHistory, TERRITORY_SELECT, type TerritoryRow } from '../territory/repo.js';
import { actionsFor, performTerritoryAction } from '../territory/service.js';
import { getPersonLite, getPeopleLite } from '../users/repo.js';

const FilterQ = z.object({
  ownedByMe: z.coerce.boolean().optional(),
  unclaimed: z.coerce.boolean().optional(),
  contested: z.coerce.boolean().optional(),
  crew: z.string().optional(),          // crew id
  kind: z.string().optional(),
  includeInactive: z.coerce.boolean().optional(),
  format: z.enum(['latlng', 'geojson']).optional(),
});

const NearQ = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), radius_m: z.coerce.number().min(50).max(10_000).default(1000) });

async function territoryFilterZoneIds(req: FastifyRequest, f: z.infer<typeof FilterQ>): Promise<Set<string> | null> {
  const wants = f.ownedByMe || f.unclaimed || f.contested || f.crew;
  if (!wants) return null;
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.ownedByMe) { params.push(currentUser(req).id); where.push(`t.owner_id = $${params.length}`); }
  if (f.unclaimed) where.push(`t.owner_id IS NULL`);
  if (f.crew) { params.push(f.crew); where.push(`t.crew_id = $${params.length}::uuid`); }
  let rows = await listTerritories(where.length ? `WHERE ${where.join(' AND ')}` : '', params);
  if (f.contested) rows = rows.filter((r) => r.under_challenge || r.in_active_challenge);
  return new Set(rows.map((r) => r.zone_id));
}

export async function zoneRoutes(app: FastifyInstance) {
  const idParam = z.object({ id: z.string().min(1).max(64) });

  // GET /v1/zones — all zones (geometry) with optional territory filters
  app.get('/v1/zones', async (req) => {
    const f = FilterQ.parse(req.query);
    const zones = await listZones({ includeInactive: !!f.includeInactive });
    const keep = await territoryFilterZoneIds(req, f);
    const out = zones.filter((zn) => (!keep || keep.has(zn.id)) && (!f.kind || zn.kind === f.kind)).map(serializeZone);
    if (f.format === 'geojson') {
      return { type: 'FeatureCollection', features: out.map((zn) => ({ type: 'Feature', id: zn.id, geometry: zn.geometry, properties: { ...zn, geometry: undefined, polygon: undefined } })) };
    }
    return { zones: out, as_of: new Date().toISOString() };
  });

  // GET /v1/map/features — the existing active-zone GeoJSON plus public territory state.
  app.get('/v1/map/features', async () => {
    const rows = await listZones();
    const territories = await listTerritories(`WHERE t.zone_id = ANY($1)`, [rows.map((row) => row.id)]);
    const byZone = new Map(territories.map((territory) => [territory.zone_id, territory]));
    return {
      type: 'FeatureCollection',
      features: rows.map((row) => {
        const zone = serializeZone(row);
        const territory = byZone.get(row.id);
        return {
          type: 'Feature',
          id: row.id,
          geometry: zone.geometry,
          properties: {
            ...zone,
            geometry: undefined,
            polygon: undefined,
            territory: territory ? {
              state: territory.owner_id ? (territory.under_challenge || territory.in_active_challenge ? 'CONTESTED' : 'CLAIMED') : 'UNCLAIMED',
              owner_type: territory.owner_type,
              under_challenge: territory.under_challenge,
              in_active_challenge: territory.in_active_challenge,
            } : null,
          },
        };
      }),
    };
  });

  // GET /v1/zones/nearby?lat&lng&radius_m — zones near a point (server does the geo query)
  app.get('/v1/zones/nearby', async (req) => {
    const q = NearQ.parse(req.query);
    const rows = await zonesNear(q.lat, q.lng, q.radius_m);
    const territories = await serializeTerritories(await listTerritories(`WHERE t.zone_id = ANY($1)`, [rows.map((r) => r.id)]));
    const tmap = new Map(territories.map((t) => [t.zone_id, t]));
    return { zones: rows.map((r) => ({ ...serializeZone(r), distance_m: Math.round(r.distance_m), territory: tmap.get(r.id) ?? null })), as_of: new Date().toISOString() };
  });

  // GET /v1/zones/:id — zone + territory + server-decided actions + stats + history
  app.get('/v1/zones/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const zone = await getZone(id);
    if (!zone) throw errors.notFound('Zone');
    const territory = await getTerritory(id);
    if (!territory) throw errors.notFound('Territory');
    const [owner, actions, stats, history] = await Promise.all([
      getPersonLite(territory.owner_id), actionsFor(req.user, zone, territory, getPool()), zoneStats(id, req.user?.id ?? null), zoneHistory(id, 10),
    ]);
    return { zone: serializeZone(zone), territory: await territoryOut(territory, owner), actions, stats, history: await serializeEvents(history) };
  });

  // GET /v1/zones/:id/territory
  app.get('/v1/zones/:id/territory', async (req) => {
    const { id } = idParam.parse(req.params);
    const [zone, territory] = await Promise.all([getZone(id), getTerritory(id)]);
    if (!zone || !territory) throw errors.notFound('Zone');
    return { territory: await territoryOut(territory), actions: await actionsFor(req.user, zone, territory, getPool()) };
  });

  // GET /v1/zones/:id/history?limit
  app.get('/v1/zones/:id/history', async (req) => {
    const { id } = idParam.parse(req.params);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    if (!(await getZone(id))) throw errors.notFound('Zone');
    return { history: await serializeEvents(await zoneHistory(id, limit)) };
  });

  // POST /v1/zones/:id/claim | steal | defend  { idempotency_key }
  const ActionBody = z.object({ idempotency_key: z.string().min(1).max(200) });
  for (const action of ['claim', 'steal', 'defend'] as const) {
    app.post(`/v1/zones/:id/${action}`, { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const body = ActionBody.parse(req.body ?? {});
      const result = await performTerritoryAction(currentUser(req), id, action, body.idempotency_key);
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return result;
    });
  }

  // ---------------- Territories ----------------
  // GET /v1/territories — ownership state of every zone (no geometry; join with /v1/zones by zone_id)
  app.get('/v1/territories', async (req) => {
    const f = FilterQ.parse(req.query);
    const keep = await territoryFilterZoneIds(req, f);
    let rows = await listTerritories(`WHERE EXISTS (SELECT 1 FROM zones z WHERE z.id = t.zone_id AND z.is_active)`);
    if (keep) rows = rows.filter((r) => keep.has(r.zone_id));
    return { territories: await serializeTerritories(rows), as_of: new Date().toISOString() };
  });

  // GET /v1/territories/my — zones I hold, with the actions available to me
  app.get('/v1/territories/my', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const rows = await listTerritories(`WHERE t.owner_id = $1`, [user.id]);
    const out = [];
    for (const t of rows) {
      const zone = await getZone(t.zone_id);
      if (!zone) continue;
      out.push({ zone: serializeZone(zone), territory: await territoryOut(t), actions: await actionsFor(user, zone, t, getPool()) });
    }
    return { territories: out, as_of: new Date().toISOString() };
  });

  // GET /v1/territories/contested
  app.get('/v1/territories/contested', async () => {
    const rows = (await listTerritories(`WHERE t.owner_id IS NOT NULL`)).filter((r) => r.under_challenge || r.in_active_challenge);
    return { territories: await serializeTerritories(rows), as_of: new Date().toISOString() };
  });

  // GET /v1/territories/:zoneId
  app.get('/v1/territories/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const t = await getTerritory(id);
    if (!t) throw errors.notFound('Territory');
    return { territory: await territoryOut(t) };
  });
}

/** Zone activity stats for the last 7 days. */
export async function zoneStats(zoneId: string, userId: string | null) {
  const r = await one<{ runs_7d: number; visitors_7d: number; distance_7d_m: number; my_visits_7d: number }>(
    `SELECT count(*)::int AS runs_7d, count(DISTINCT q.user_id)::int AS visitors_7d, coalesce(sum(q.distance_in_zone_m), 0)::float8 AS distance_7d_m,
            count(*) FILTER (WHERE q.user_id = $2)::int AS my_visits_7d
     FROM qualification_results q WHERE q.zone_id = $1 AND q.evaluated_at > now() - interval '7 days' AND q.interaction <> 'passed_through'`,
    [zoneId, userId ?? ''],
  );
  return { runs_7d: r?.runs_7d ?? 0, visitors_7d: r?.visitors_7d ?? 0, my_visits_7d: r?.my_visits_7d ?? 0, distance_7d_m: Math.round(r?.distance_7d_m ?? 0) };
}
