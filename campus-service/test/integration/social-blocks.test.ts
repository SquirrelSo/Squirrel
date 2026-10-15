import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSocialBridge, resetIdentityState } from '../../src/identity/index.js';
import { api, app, HAS_DB, sql, useTestApp } from './setup.js';
import { config } from '../../src/config.js';

async function active(userId: string) {
  await api('GET', '/v1/me', userId);
  await sql(`INSERT INTO activities (user_id, activity_type, verification_status, started_at) VALUES ($1, 'walk', 'VERIFIED', now())`, [userId]);
  await api('PUT', '/v1/me/open-to-meet', userId, { enabled: true });
  await api('PUT', '/v1/map/presence', userId, { lat: 22.9637, lng: 88.5284 });
}

const TOKEN = 'test-internal-token';

const social = {
  blocks: new Map<string, string[]>(), // subject -> array of blocked subjects
  mode: 'ok' as 'ok' | 'error' | 'hang' | '404',
  blockCalls: [] as string[],
  clear() {
    this.blocks.clear();
    this.blockCalls = [];
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
      
      if (req.method === 'GET' && req.url?.startsWith('/internal/v1/blocks/')) {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
        const sub = decodeURIComponent(req.url.split('/internal/v1/blocks/')[1] || '');
        social.blockCalls.push(sub);
        
        const blocked = social.blocks.get(sub);
        if (!blocked) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ subject: sub, blocked: [], as_of: new Date().toISOString() }));
          return;
        }
        
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ subject: sub, blocked, as_of: new Date().toISOString() }));
        return;
      }
      
      if (req.method === 'POST' && req.url === '/internal/v1/crews/memberships') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ people: [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/internal/v1/crews/lookup') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ crews: [] }));
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/v1/people/resolve') {
         res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ people: [] }));
         return;
      }

      res.writeHead(404).end();
    });
  });
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { socialUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); }));
}

describe.skipIf(!HAS_DB)('blocks via Social (integration)', () => {
  useTestApp();

  beforeAll(async () => {
    await startFakeSocial();
  });
  afterAll(() => {
    server.close();
    configureSocialBridge(null); // restore to env
  });

  beforeEach(() => {
    social.clear();
    resetIdentityState();
    configureSocialBridge({ url: socialUrl, token: TOKEN });
  });

  it('blocked in Social only: hidden from lists, meetup invite refused', async () => {
    await active('u_sb_1');
    await active('u_sb_2');

    social.blocks.set('u_sb_1', ['u_sb_2']);

    const players = await api('GET', '/v1/map/players', 'u_sb_1');
    expect(players.body.players.find((p: any) => p.user_id === 'u_sb_2')).toBeUndefined();
    
    const nearby = await api('GET', '/v1/activity/nearby', 'u_sb_1');
    expect(nearby.body.nearby.find((p: any) => p.person?.user_id === 'u_sb_2')).toBeUndefined();

    const invite = await api('POST', '/v1/meetups', 'u_sb_1', { place_text: 'Campus cafe', starts_at: new Date(Date.now() + 3600000).toISOString(), invitee_ids: ['u_sb_2'] });
    expect(invite.status).toBe(409);
    expect(invite.body.code).toBe('meetup_blocked');
  });

  it('blocked locally only: still hidden (union holds)', async () => {
    await api('GET', '/v1/me', 'u_sb_3');
    await api('GET', '/v1/me', 'u_sb_4');
    
    social.blocks.set('u_sb_3', []);
    
    await api('POST', '/v1/users/u_sb_4/block', 'u_sb_3');
    
    const invite = await api('POST', '/v1/meetups', 'u_sb_3', { place_text: 'Campus cafe', starts_at: new Date(Date.now() + 3600000).toISOString(), invitee_ids: ['u_sb_4'] });
    expect(invite.status).toBe(409);
    expect(invite.body.code).toBe('meetup_blocked');
  });

  describe('after the import (LEGACY_LOCAL_BLOCKS=0): Social alone decides', () => {
    const blocks = config.blocks as { legacyLocal: boolean };
    const original = blocks.legacyLocal;
    beforeEach(() => { blocks.legacyLocal = false; });
    afterAll(() => { blocks.legacyLocal = original; });

    it('a stale local row no longer blocks, so an unblock in the app (Social) takes effect', async () => {
      await api('GET', '/v1/me', 'u_sb_20');
      await api('GET', '/v1/me', 'u_sb_21');
      await sql(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ('u_sb_20', 'u_sb_21')`);
      social.blocks.set('u_sb_20', []);
      const invite = await api('POST', '/v1/meetups', 'u_sb_20', { place_text: 'Campus cafe', starts_at: new Date(Date.now() + 3600000).toISOString(), invitee_ids: ['u_sb_21'] });
      expect(invite.status).toBe(201);
    });

    it('a Social block in either direction still refuses, and Social down still fails closed', async () => {
      await api('GET', '/v1/me', 'u_sb_22');
      await api('GET', '/v1/me', 'u_sb_23');
      social.blocks.set('u_sb_22', ['u_sb_23']); // Social answers both directions for the subject
      const blocked = await api('POST', '/v1/meetups', 'u_sb_22', { place_text: 'Campus cafe', starts_at: new Date(Date.now() + 3600000).toISOString(), invitee_ids: ['u_sb_23'] });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('meetup_blocked');
      social.mode = 'error';
      resetIdentityState();
      const down = await api('POST', '/v1/meetups', 'u_sb_22', { place_text: 'Campus cafe', starts_at: new Date(Date.now() + 3600000).toISOString(), invitee_ids: ['u_sb_23'] });
      expect(down.status).toBe(503);
      expect(down.body.code).toBe('blocks_unreachable');
    });

    it('the local block routes answer 410 instead of writing a table nobody reads', async () => {
      await api('GET', '/v1/me', 'u_sb_24');
      await api('GET', '/v1/me', 'u_sb_25');
      for (const [method, path] of [['POST', '/v1/users/u_sb_25/block'], ['DELETE', '/v1/users/u_sb_25/block'], ['GET', '/v1/me/blocks']] as const) {
        const r = await api(method, path, 'u_sb_24');
        expect(r.status).toBe(410);
        expect(r.body.code).toBe('blocks_moved');
      }
      expect((await sql(`SELECT count(*)::int AS n FROM blocks WHERE blocker_id = 'u_sb_24'`))[0].n).toBe(0);
    });
  });

  it('Social unreachable: lists return empty with hidden_reason, meetup invite returns 503', async () => {
    await active('u_sb_5');
    await active('u_sb_6');

    social.mode = 'error';

    const players = await api('GET', '/v1/map/players', 'u_sb_5');
    expect(players.status).toBe(200);
    expect(players.body.players).toEqual([]);
    expect(players.body.hidden_reason).toBe('blocks_unreachable');

    const invite = await api('POST', '/v1/meetups', 'u_sb_5', { place_text: 'Campus cafe', starts_at: new Date(Date.now() + 3600000).toISOString(), invitee_ids: ['u_sb_6'] });
    expect(invite.status).toBe(503);
    expect(invite.body.code).toBe('blocks_unreachable');
  });

  it('cached answer older than 30s is refreshed', async () => {
    vi.useFakeTimers();

    await api('GET', '/v1/me', 'u_sb_7');
    await api('GET', '/v1/me', 'u_sb_8');

    social.blocks.set('u_sb_7', []);
    
    await api('GET', '/v1/users/u_sb_8/context', 'u_sb_7');
    expect(social.blockCalls).toContain('u_sb_7');
    social.blockCalls = [];

    await api('GET', '/v1/users/u_sb_8/context', 'u_sb_7');
    expect(social.blockCalls).toHaveLength(0);

    vi.advanceTimersByTime(31000);

    await api('GET', '/v1/users/u_sb_8/context', 'u_sb_7');
    expect(social.blockCalls).toContain('u_sb_7');

    vi.useRealTimers();
  });

  it('Social returns empty list for unseen user: nothing breaks, nobody wrongly hidden', async () => {
    await active('u_sb_11');
    await active('u_sb_12');

    const players = await api('GET', '/v1/map/players', 'u_sb_11');
    expect(players.status).toBe(200);
    expect(players.body.hidden_reason).toBeNull();
    expect(players.body.players.find((p: any) => p.user_id === 'u_sb_12')).toBeDefined();
  });

  it('Social returns 404: lists empty with hidden_reason, meetup invite returns 503', async () => {
    await active('u_sb_9');
    await active('u_sb_10');

    // Make social return 404 for this specific user to simulate a missing route or bad token
    social.mode = '404';

    const players = await api('GET', '/v1/map/players', 'u_sb_9');
    expect(players.status).toBe(200);
    expect(players.body.players).toEqual([]);
    expect(players.body.hidden_reason).toBe('blocks_unreachable');

    const invite = await api('POST', '/v1/meetups', 'u_sb_9', { place_text: 'Campus cafe', starts_at: new Date(Date.now() + 3600000).toISOString(), invitee_ids: ['u_sb_10'] });
    expect(invite.status).toBe(503);
    expect(invite.body.code).toBe('blocks_unreachable');
  });
});
