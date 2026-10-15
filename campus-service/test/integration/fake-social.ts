/** A minimal fake Social for bubble / discover tests: blocks, notifications, crews; outage modes. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { configureSocialBridge, resetIdentityState } from '../../src/identity/index.js';

export const FAKE_SOCIAL_TOKEN = 'test-internal-token';

export type FakeCrew = { id: string; name: string; interest: string; members: { subject: string; role: string; joined_at: string }[] };

export function fakeSocial() {
  const state = {
    blocks: new Map<string, string[]>(),
    crews: new Map<string, FakeCrew>(),
    notifications: [] as Record<string, unknown>[],
    mode: 'ok' as 'ok' | 'error',
    url: '',
  };
  let server: Server;
  const json = (res: import('node:http').ServerResponse, body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  return {
    state,
    async start() {
      server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          if (state.mode === 'error') { res.writeHead(500).end('boom'); return; }
          if (req.headers.authorization !== `Bearer ${FAKE_SOCIAL_TOKEN}`) { res.writeHead(401).end(); return; }
          const body = raw ? JSON.parse(raw) : {};
          if (req.method === 'GET' && req.url?.startsWith('/internal/v1/blocks/')) {
            const sub = decodeURIComponent(req.url.split('/internal/v1/blocks/')[1] ?? '');
            const blocked = new Set(state.blocks.get(sub) ?? []);
            for (const [other, list] of state.blocks) if (list.includes(sub)) blocked.add(other); // either direction
            return json(res, { subject: sub, blocked: [...blocked], as_of: new Date().toISOString() });
          }
          if (req.method === 'POST' && req.url === '/internal/v1/notifications') {
            state.notifications.push(body);
            return json(res, { created: true, notification_id: `n${state.notifications.length}` });
          }
          if (req.method === 'POST' && req.url === '/internal/v1/people/resolve') return json(res, { people: [] });
          if (req.method === 'POST' && req.url === '/internal/v1/crews/memberships') {
            const people = (body.subjects as string[]).map((subject) => ({ subject,
              crews: [...state.crews.values()].flatMap((c) => c.members.filter((m) => m.subject === subject).map((m) => ({ id: c.id, name: c.name, role: m.role, joined_at: m.joined_at }))) }));
            return json(res, { people });
          }
          if (req.method === 'POST' && req.url === '/internal/v1/crews/lookup') {
            const crews = (body.crew_ids as string[] ?? body.ids as string[] ?? []).map((id) => state.crews.get(id)).filter(Boolean)
              .map((c) => ({ ...c, members_count: c!.members.length }));
            return json(res, { crews });
          }
          res.writeHead(404).end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    on() { resetIdentityState(); configureSocialBridge({ url: state.url, token: FAKE_SOCIAL_TOKEN }); },
    off() { configureSocialBridge(null); resetIdentityState(); },
    reset() { state.blocks.clear(); state.crews.clear(); state.notifications = []; state.mode = 'ok'; },
    async stop() { configureSocialBridge(null); resetIdentityState(); await new Promise((r) => server.close(r)); },
  };
}

/** Throws if any key or value in the payload looks like a coordinate, a position or a distance. */
export function assertNoCoordinates(v: unknown, path = '$'): void {
  const FORBIDDEN = /^(lat|lng|lon|latitude|longitude|position|coordinates|geom|geometry|centroid|center|centre|distance|distance_m|cell|accuracy_m|precision_m)$/i;
  if (Array.isArray(v)) {
    if (v.length === 2 && v.every((x) => typeof x === 'number')) throw new Error(`coordinate-like pair at ${path}`);
    v.forEach((x, i) => assertNoCoordinates(x, `${path}[${i}]`));
    return;
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN.test(k)) throw new Error(`forbidden key ${path}.${k}`);
      assertNoCoordinates(x, `${path}.${k}`);
    }
  }
}
