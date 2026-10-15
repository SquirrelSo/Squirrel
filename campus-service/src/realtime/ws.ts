/**
 * WebSocket endpoint: GET /v1/realtime
 * Protocol (matches mobile/src/api/campus/index.ts):
 *   client → { type: 'auth', token }               first frame; unauthenticated sockets only get public topics
 *   client → { type: 'subscribe', topics: [...] }  topics: territories | stats | invites | events | active | activities | notifications | bubble
 *   server → { type: '<event>', data }
 * Private events (invites, activity.verified, notifications, bubble.*) are delivered only to the users they concern.
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { onRealtime, type RealtimeEvent } from './bus.js';
import { verifyBearer } from '../auth/jwt.js';
import { translateOutbound } from '../identity/translate.js';
import { bridgeEnabled } from '../identity/index.js';

type Conn = { ws: WebSocket; userId: string | null; topics: Set<string> };

const TOPIC_OF: Record<string, string> = {
  'territory.claimed': 'territories', 'territory.stolen': 'territories', 'territory.defended': 'territories',
  'territory.contested': 'territories', 'territory.released': 'territories', 'territory.updated': 'territories',
  'zone.updated': 'territories',
  'stats.updated': 'stats', 'active.updated': 'active',
  'challenge.created': 'invites', 'challenge.updated': 'invites',
  'activity.verified': 'activities',
  'notification.created': 'notifications',
  'bubble.user_joined': 'bubble', 'bubble.user_left': 'bubble',
  'bubble.activity_started': 'bubble', 'bubble.activity_ended': 'bubble',
};

export function registerRealtime(app: FastifyInstance) {
  const conns = new Set<Conn>();

  const send = (c: Conn, frame: unknown) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(frame));
  };

  // Audience matching uses campus user ids (subs); only the data sent to clients is translated to Social
  // profile ids (identity bridge). Events are translated one at a time so their order is preserved.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (e: RealtimeEvent) => {
    if (!conns.size) return;
    if (!bridgeEnabled()) { deliver(e, e.data); return; } // bridge off: synchronous, exactly as before
    queue = queue.then(async () => deliver(e, await translateOutbound(e.data))).catch(() => undefined);
  };

  const deliver = (e: RealtimeEvent, data: unknown) => {
    const topic = TOPIC_OF[e.type];
    const frames: { type: string; data: unknown }[] = [{ type: e.type, data }];
    // App-compatible aliases
    if (e.type.startsWith('territory.') && e.type !== 'territory.updated') frames.push({ type: 'territory.updated', data });
    if (e.type === 'challenge.created' || e.type === 'challenge.updated') frames.push({ type: 'invite.updated', data });
    const audience = 'user_ids' in e ? new Set(e.user_ids) : null;
    for (const c of conns) {
      if (topic && !c.topics.has(topic)) continue;
      if (audience) { if (!c.userId || !audience.has(c.userId)) continue; }
      for (const f of frames) send(c, f);
    }
  };
  const off = onRealtime(enqueue);
  app.addHook('onClose', async () => { off(); for (const c of conns) c.ws.close(); });

  app.get('/v1/realtime', { websocket: true }, (socket) => {
    const conn: Conn = { ws: socket, userId: null, topics: new Set(['territories', 'stats', 'active']) };
    conns.add(conn);
    socket.on('message', async (raw: Buffer | string) => {
      let msg: { type?: string; token?: string; topics?: unknown };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'auth' && typeof msg.token === 'string') {
        try {
          conn.userId = (await verifyBearer(msg.token)).userId;
          conn.topics.add('invites'); conn.topics.add('activities'); conn.topics.add('notifications'); conn.topics.add('bubble');
          send(conn, { type: 'auth.ok', data: await translateOutbound({ user_id: conn.userId }) });
        } catch {
          send(conn, { type: 'auth.error', data: { code: 'unauthorized' } });
        }
      } else if (msg.type === 'subscribe' && Array.isArray(msg.topics)) {
        for (const t of msg.topics) if (typeof t === 'string') conn.topics.add(t);
        send(conn, { type: 'subscribed', data: { topics: [...conn.topics] } });
      } else if (msg.type === 'ping') {
        send(conn, { type: 'pong', data: { at: new Date().toISOString() } });
      }
    });
    socket.on('close', () => conns.delete(conn));
    socket.on('error', () => conns.delete(conn));
  });
}
