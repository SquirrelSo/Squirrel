import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureSocialBridge, resetIdentityState } from '../../src/identity/index.js';
import { api, HAS_DB, sql, useTestApp } from './setup.js';
import crypto from 'node:crypto';

const TOKEN = 'test-internal-token';

const social = {
  crews: [] as { id: string; name: string }[],
  memberships: new Map<string, string[]>(), // subject -> array of crew_ids
  mode: 'ok' as 'ok' | 'error' | 'hang' | '404',
  clear() {
    this.crews = [];
    this.memberships.clear();
    this.mode = 'ok';
  }
};

let server: Server;
let socialUrl = '';

function startFakeSocial() {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (social.mode === 'hang') return;
      if (social.mode === 'error') { res.writeHead(500).end('boom'); return; }
      if (social.mode === '404') { res.writeHead(404).end(); return; }
      
      if (req.method === 'POST' && req.url === '/internal/v1/crews/memberships') {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
        const { subjects } = JSON.parse(raw);
        const people = subjects.map((sub: string) => {
          const crewIds = social.memberships.get(sub) || [];
          const crews = crewIds.map(id => {
            const crew = social.crews.find(c => c.id === id);
            return { id, name: crew?.name ?? 'Unknown Crew', role: 'member', joined_at: new Date().toISOString() };
          });
          return { subject: sub, crews };
        });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ people }));
        return;
      }
      
      if (req.method === 'POST' && req.url === '/internal/v1/crews/lookup') {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
        const { crew_ids } = JSON.parse(raw);
        const crews = crew_ids.map((id: string) => {
          const c = social.crews.find(x => x.id === id);
          if (!c) return null;
          const members = Array.from(social.memberships.entries())
            .filter(([_, cids]) => cids.includes(id))
            .map(([sub]) => ({ subject: sub, role: 'member', joined_at: new Date().toISOString() }));
          return { id, name: c.name, interest: 'running', scope: 'open', hostel: null, members_count: members.length, members };
        }).filter(Boolean);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ crews }));
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/v1/people/resolve') {
        const { subjects, profile_ids } = JSON.parse(raw);
        const out = [];
        if (subjects) for (const s of subjects) out.push({ subject: s, profile_id: s, display_name: 'Name', avatar_url: null, current_hostel: null });
        if (profile_ids) for (const p of profile_ids) out.push({ subject: p, profile_id: p, display_name: 'Name', avatar_url: null, current_hostel: null });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ people: out }));
        return;
      }

      res.writeHead(404).end();
    });
  });
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { socialUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); }));
}

describe.skipIf(!HAS_DB)('crews via Social (integration)', () => {
  useTestApp();

  beforeAll(async () => {
    await startFakeSocial();
  });
  afterAll(() => {
    server.close();
    configureSocialBridge(null);
  });

  beforeEach(() => {
    social.clear();
    resetIdentityState();
    configureSocialBridge({ url: socialUrl, token: TOKEN });
  });

  it('a person in a crew in Social but NOT in the local table is treated as a member', async () => {
    const crewId = crypto.randomUUID();
    social.crews.push({ id: crewId, name: 'Social Crew' });
    social.memberships.set('u_aanya', [crewId]);

    await api('GET', '/v1/me', 'u_aanya');
    
    // Check public profile to confirm they are returned as a member of this crew
    const socialProfile = await api('GET', `/v1/users/u_aanya`, 'u_aanya');
    expect(socialProfile.body.crews).toContainEqual(expect.objectContaining({ id: crewId }));
  });

  it('a person absent from Social is not a member even when a territory names that Social crew', async () => {
    const crewId = crypto.randomUUID();
    social.crews.push({ id: crewId, name: 'Local Crew' });

    await api('GET', '/v1/me', 'u_dev');
    
    const zoneId = 'cc1';
    // Territory references the Social crew id; membership still comes only from Social.
    await sql(`UPDATE territories SET crew_id = $1, owner_id = NULL WHERE zone_id = $2`, [crewId, zoneId]);

    // Since u_dev is not in Social, they are NOT a member, meaning they cannot defend this territory
    const localZone = await api('GET', `/v1/zones/${zoneId}`, 'u_dev');
    expect(localZone.body.actions.defend.allowed).toBe(false);

    // Profile should not show them in the crew either
    const localProfile = await api('GET', `/v1/users/u_dev`, 'u_dev');
    expect(localProfile.body.crews).not.toContainEqual(expect.objectContaining({ id: crewId }));
  });

  it('Social unreachable: fail open (returns empty array)', async () => {
    const crewId = crypto.randomUUID();
    social.crews.push({ id: crewId, name: 'Social Crew' });
    social.memberships.set('u_aanya', [crewId]);

    social.mode = 'error';

    // If unreachable, they appear to have 0 crews (fail open). 
    // They don't get 500, they just get no crew bonuses.
    const profile = await api('GET', `/v1/users/u_aanya`, 'u_aanya');
    expect(profile.status).toBe(200);
    expect(profile.body.crews).toHaveLength(0);
  });
});
