import { isBlockedEitherWay, getFullBlockSet } from '../blocks/service.js';
import { many } from '../db/pool.js';
import { getPeopleLite } from '../users/repo.js';

export const MAX_SHARED_ZONES = 10;
export const MAX_SHARED_PEOPLE_PER_ZONE = 5;

type SharedZoneRow = {
  zone_id: string;
  zone_name: string;
  zone_kind: string;
  other_user_id: string | null;
  other_activity_count: number | null;
};

export type SharedZone = {
  zone: { id: string; name: string; kind: string };
  people: { user_id: string; display_name: string; avatar_url: string | null; hostel: string | null; activity: 'sometimes' | 'often' }[];
};

/** Shared eligibility and privacy policy for both shared-zone views and date suggestions. */
export async function getSharedZones(userId: string): Promise<{ zones: SharedZone[]; cap: { zones: number; people_per_zone: number } }> {
  const rows = await many<SharedZoneRow>(
    `WITH activity_zones AS (
       SELECT a.user_id, q.zone_id, a.id AS activity_id
       FROM activities a
       JOIN qualification_results q ON q.activity_id = a.id AND q.user_id = a.user_id
       JOIN zones z ON z.id = q.zone_id AND z.is_active
       JOIN users u ON u.id = a.user_id AND NOT u.is_banned
       WHERE a.verification_status = 'VERIFIED'
         AND q.verified
         AND q.interaction <> 'passed_through'
       GROUP BY a.user_id, q.zone_id, a.id
     ), mine AS (
       SELECT zone_id
       FROM activity_zones
       WHERE user_id = $1
       GROUP BY zone_id
     ), others AS (
       SELECT az.zone_id, az.user_id, count(DISTINCT az.activity_id)::int AS activity_count
       FROM activity_zones az
       JOIN users u ON u.id = az.user_id
       WHERE az.user_id <> $1
         AND u.open_to_meet
         AND (u.open_to_meet_until IS NULL OR u.open_to_meet_until > now())
       GROUP BY az.zone_id, az.user_id
     )
     SELECT z.id AS zone_id, z.name AS zone_name, z.kind AS zone_kind,
            o.user_id AS other_user_id, o.activity_count AS other_activity_count
     FROM mine m
     JOIN zones z ON z.id = m.zone_id AND z.is_active
     LEFT JOIN others o ON o.zone_id = m.zone_id
     ORDER BY z.name, o.user_id`,
    [userId],
  );

  const candidateIds = rows.map((row) => row.other_user_id).filter((id): id is string => !!id);
  const allowedIds = new Set<string>();
  try {
    const blocks = await getFullBlockSet(userId);
    for (const id of [...new Set(candidateIds)]) {
      if (!blocks.has(id)) allowedIds.add(id);
    }
  } catch (err: any) {
    if (err.code === 'blocks_unreachable') {
      return { zones: [], cap: { zones: MAX_SHARED_ZONES, people_per_zone: MAX_SHARED_PEOPLE_PER_ZONE }, hidden_reason: 'blocks_unreachable' } as any;
    }
    throw err;
  }
  const people = await getPeopleLite([...allowedIds]);
  const grouped = new Map<string, { id: string; name: string; kind: string; people: { person: NonNullable<ReturnType<typeof people.get>>; activity: 'sometimes' | 'often' }[] }>();

  for (const row of rows) {
    let zone = grouped.get(row.zone_id);
    if (!zone) {
      zone = { id: row.zone_id, name: row.zone_name, kind: row.zone_kind, people: [] };
      grouped.set(row.zone_id, zone);
    }
    if (!row.other_user_id || !allowedIds.has(row.other_user_id) || zone.people.length >= MAX_SHARED_PEOPLE_PER_ZONE) continue;
    const person = people.get(row.other_user_id);
    if (person) zone.people.push({ person, activity: (row.other_activity_count ?? 0) >= 3 ? 'often' : 'sometimes' });
  }

  return {
    zones: [...grouped.values()].slice(0, MAX_SHARED_ZONES).map((zone) => ({
      zone: { id: zone.id, name: zone.name, kind: zone.kind },
      people: zone.people.map(({ person, activity }) => ({ ...person, activity })),
    })),
    cap: { zones: MAX_SHARED_ZONES, people_per_zone: MAX_SHARED_PEOPLE_PER_ZONE },
  };
}
