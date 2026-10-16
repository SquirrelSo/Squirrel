import type { FastifyInstance } from 'fastify';
import { requireAuth, currentUser } from '../auth/plugin.js';
import { many } from '../db/pool.js';
import { SUPPRESSION_THRESHOLD_USERS } from '../heatmap/routes.js';
import { getSharedZones } from './service.js';

const MAX_SUGGESTIONS = 10;
const ACTIVITY_HOUR_WINDOW_DAYS = 30;
const DEFAULT_TIME_SLOT = '18:00–19:00';
const CAMPUS_TIME_ZONE = 'Asia/Kolkata';
const SUGGESTED_WEEKDAY = 4; // Thursday, in UTC weekday numbering.

type ZoneHourRow = { zone_id: string; hour_of_day: number };

function nextSuggestedDate(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CAMPUS_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  const date = new Date(Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day'))));
  const daysAhead = (SUGGESTED_WEEKDAY - date.getUTCDay() + 7) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}

function formatHourSlot(hour: number): string {
  const end = (hour + 1) % 24;
  return `${String(hour).padStart(2, '0')}:00–${String(end).padStart(2, '0')}:00`;
}

async function zoneTimeSlots(zoneIds: string[]): Promise<Map<string, string>> {
  if (!zoneIds.length) return new Map();
  const rows = await many<ZoneHourRow>(
    `WITH contributors AS (
       SELECT q.zone_id, a.user_id,
              extract(hour FROM (a.started_at AT TIME ZONE ($2::text)))::int AS hour_of_day
       FROM activities a
       JOIN users u ON u.id = a.user_id AND NOT u.is_banned
       JOIN qualification_results q ON q.activity_id = a.id AND q.user_id = a.user_id
       JOIN zones z ON z.id = q.zone_id AND z.is_active
       WHERE a.verification_status = 'VERIFIED'
         AND q.verified
         AND q.interaction <> 'passed_through'
         AND q.zone_id = ANY($1::text[])
         AND a.started_at >= now() - make_interval(days => $3::int)
         AND a.started_at < now()
       GROUP BY q.zone_id, a.user_id, hour_of_day
     ), supported_hours AS (
       SELECT zone_id, hour_of_day, count(*)::int AS distinct_users
       FROM contributors
       GROUP BY zone_id, hour_of_day
       HAVING count(*) >= $4::int
     )
     SELECT DISTINCT ON (zone_id) zone_id, hour_of_day
     FROM supported_hours
     ORDER BY zone_id, distinct_users DESC, hour_of_day ASC`,
    [zoneIds, CAMPUS_TIME_ZONE, ACTIVITY_HOUR_WINDOW_DAYS, SUPPRESSION_THRESHOLD_USERS],
  );
  return new Map(rows.map((row) => [row.zone_id, formatHourSlot(Number(row.hour_of_day))]));
}

export async function squirrelDateRoutes(app: FastifyInstance) {
  app.get('/v1/squirrel-dates/suggestions', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const shared = await getSharedZones(user.id);
    const timeSlots = await zoneTimeSlots(shared.zones.map((entry) => entry.zone.id));
    const suggestedDate = nextSuggestedDate();
    const suggestions = shared.zones.flatMap(({ zone, people }) => people.map((person) => ({
      person,
      zone,
      suggested_date: suggestedDate,
      time_slot: timeSlots.get(zone.id) ?? DEFAULT_TIME_SLOT,
    }))).slice(0, MAX_SUGGESTIONS);

    return {
      suggestions,
      cap: { suggestions: MAX_SUGGESTIONS },
    };
  });
}
