import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSocialBridge } from '../../src/identity/index.js';
import { resetSocialCrewCountCache } from '../../src/crews/count.js';
import { api, HAS_DB, useTestApp } from './setup.js';

const TOKEN = 'crew-count-test-token';
let server: Server;
let socialUrl = '';
let count = 0;
let unavailable = false;
let requests = 0;
let lastAuthorization: string | undefined;

function startSocial() {
  server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/internal/v1/crews/count') { res.writeHead(404).end(); return; }
    requests++;
    lastAuthorization = req.headers.authorization;
    if (lastAuthorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
    if (unavailable) { res.writeHead(503).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ crews_total: count, as_of: new Date().toISOString() }));
  });
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
    socialUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  }));
}

describe.skipIf(!HAS_DB)('Social crew count for campus stats (integration)', () => {
  useTestApp();
  beforeAll(startSocial);
  afterAll(async () => {
    configureSocialBridge(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    resetSocialCrewCountCache();
    requests = 0;
    count = 0;
    unavailable = false;
    lastAuthorization = undefined;
    configureSocialBridge({ url: socialUrl, token: TOKEN, timeoutMs: 500 });
  });
  afterEach(() => vi.useRealTimers());

  it('loads crews_total from Social with the service token', async () => {
    count = 23;
    const stats = await api('GET', '/v1/campus/stats', null);
    expect(stats.status).toBe(200);
    expect(stats.body.crews_total).toBe(23);
    expect(lastAuthorization).toBe(`Bearer ${TOKEN}`);
    expect(requests).toBe(1);
  });

  it('caches the Social count for at least consecutive requests inside the 60-second window', async () => {
    count = 7;
    expect((await api('GET', '/v1/campus/stats', null)).body.crews_total).toBe(7);
    count = 10;
    expect((await api('GET', '/v1/stats/daily', null)).body.crews).toBe(7);
    expect(requests).toBe(1);
  });

  it('serves the last known count on outage and returns zero on a cold-cache outage', async () => {
    count = 14;
    expect((await api('GET', '/v1/campus/stats', null)).body.crews_total).toBe(14);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_001);
    unavailable = true;
    expect((await api('GET', '/v1/campus/stats', null)).body.crews_total).toBe(14);

    resetSocialCrewCountCache();
    expect((await api('GET', '/v1/campus/stats', null)).body.crews_total).toBe(0);
  });
});
