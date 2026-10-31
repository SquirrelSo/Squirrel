/**
 * Inbound translation — user ids sent by clients may be Social profile ids (that is what outbound
 * translation hands out). One global preHandler rewrites them to campus user ids (subs) before the route
 * handler (and its Zod validation) runs, so route code only ever sees subs.
 *
 * An id that does not resolve is left unchanged: an existing campus users.id (dev tokens, bridge off, ids
 * handed out while Social was down) keeps working, and an unknown id gets the route's usual 404.
 *
 * Every request field that takes a user id must be listed in INBOUND_USER_ID_FIELDS.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { bridgeEnabled, resolveInboundIds } from './index.js';

type Bag = Record<string, unknown>;
type Extract = (req: FastifyRequest) => { get: () => string[]; set: (map: Map<string, string>) => void } | null;

const obj = (v: unknown): Bag | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Bag) : null);

/** A single string field on `req.params` or `req.body`. */
const field = (where: 'params' | 'body', key: string, when?: (b: Bag) => boolean): Extract => (req) => {
  const b = obj(req[where]);
  if (!b || typeof b[key] !== 'string' || (when && !when(b))) return null;
  return { get: () => [b[key] as string], set: (m) => { b[key] = m.get(b[key] as string) ?? b[key]; } };
};

/** An array-of-strings body field. */
const list = (key: string): Extract => (req) => {
  const b = obj(req.body);
  const v = b?.[key];
  if (!b || !Array.isArray(v) || v.length > 200) return null;
  return { get: () => v.filter((x): x is string => typeof x === 'string'), set: (m) => { b[key] = v.map((x) => (typeof x === 'string' ? m.get(x) ?? x : x)); } };
};

/** Nested `target.id` of a challenge when it targets a user. */
const challengeTarget: Extract = (req) => {
  const target = obj(obj(req.body)?.target);
  if (!target || target.type !== 'user' || typeof target.id !== 'string') return null;
  return { get: () => [target.id as string], set: (m) => { target.id = m.get(target.id as string) ?? target.id; } };
};

/** `METHOD route-url` → user-id fields in that request. */
export const INBOUND_USER_ID_FIELDS: Record<string, Extract[]> = {
  'GET /v1/users/:id': [field('params', 'id')],
  'GET /v1/users/:id/context': [field('params', 'id')],
  'POST /v1/users/:id/block': [field('params', 'id')],
  'DELETE /v1/users/:id/block': [field('params', 'id')],
  'POST /v1/meetups': [list('invitee_ids')],
  'POST /v1/challenge-invites': [challengeTarget],
  'POST /v1/challenges': [challengeTarget],
};

export function registerInboundIdentity(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    if (!bridgeEnabled()) return;
    const extractors = INBOUND_USER_ID_FIELDS[`${req.method} ${req.routeOptions.url}`];
    if (!extractors) return;
    const slots = extractors.map((x) => x(req)).filter((s): s is NonNullable<typeof s> => s !== null);
    const ids = slots.flatMap((s) => s.get());
    if (!ids.length) return;
    let map: Map<string, string>;
    try { map = await resolveInboundIds(ids); } catch (err) { req.log.warn({ err }, 'inbound id resolution failed; using ids as sent'); return; }
    for (const s of slots) s.set(map);
  });
}
