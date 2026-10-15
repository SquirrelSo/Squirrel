/**
 * Realtime event bus. Events are published in-process and, when a Postgres LISTEN connection is
 * up, fanned out to every API instance through NOTIFY so WebSocket clients on any node see them.
 *
 * Spec event names (territory.claimed …) are emitted as-is; app-compatible aliases
 * (territory.updated, invite.updated …) are derived in ws.ts so the mobile client works unchanged.
 */
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { config } from '../config.js';

export type RealtimeEvent =
  | { type: 'territory.claimed' | 'territory.stolen' | 'territory.defended' | 'territory.contested' | 'territory.released' | 'territory.updated'; data: unknown; zone_id: string }
  | { type: 'challenge.created' | 'challenge.updated'; data: unknown; user_ids: string[] }
  | { type: 'activity.verified'; data: unknown; user_ids: string[] }
  | { type: 'zone.updated'; data: unknown; zone_id: string }
  | { type: 'stats.updated' | 'active.updated'; data: unknown }
  | { type: 'notification.created'; data: unknown; user_ids: string[] }
  | { type: BubbleEventType; data: unknown; user_ids: string[] };

export type BubbleEventType = 'bubble.user_joined' | 'bubble.user_left' | 'bubble.activity_started' | 'bubble.activity_ended';

const emitter = new EventEmitter();
emitter.setMaxListeners(1000);
const ORIGIN = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

let listenClient: pg.Client | null = null;

export function onRealtime(h: (e: RealtimeEvent) => void): () => void {
  emitter.on('event', h);
  return () => emitter.off('event', h);
}

/** Publish locally and to other instances. Fire-and-forget; never throws into request paths. */
export function publish(e: RealtimeEvent): void {
  emitter.emit('event', e);
  if (!listenClient) return;
  const body = JSON.stringify({ origin: ORIGIN, event: e });
  if (body.length > 7500) return; // NOTIFY payload limit is 8000 bytes; large events stay local (clients refetch)
  const client = listenClient;
  // Serialise NOTIFYs on the single LISTEN connection (pg warns on overlapping queries per client).
  notifyChain = notifyChain.then(() => client.query('SELECT pg_notify($1, $2)', [config.realtime.pgChannel, body])).then(() => undefined, () => undefined);
}
let notifyChain: Promise<void> = Promise.resolve();

/** Start the cross-instance LISTEN connection. Safe to call once per process. */
export async function startRealtimeFanout(log: { warn: (o: unknown, m?: string) => void; info: (m: string) => void }) {
  if (listenClient) return;
  const client = new pg.Client({ connectionString: config.databaseUrl });
  try {
    await client.connect();
    await client.query(`LISTEN ${config.realtime.pgChannel}`);
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      try {
        const parsed = JSON.parse(msg.payload) as { origin: string; event: RealtimeEvent };
        if (parsed.origin !== ORIGIN) emitter.emit('event', parsed.event);
      } catch { /* ignore malformed */ }
    });
    client.on('error', (err) => { log.warn({ err }, 'realtime LISTEN connection lost'); listenClient = null; });
    listenClient = client;
    log.info('realtime fan-out via Postgres LISTEN/NOTIFY started');
  } catch (err) {
    log.warn({ err }, 'realtime fan-out unavailable; events stay in-process');
  }
}

export async function stopRealtimeFanout() {
  const c = listenClient; listenClient = null;
  if (c) await c.end().catch(() => undefined);
}
