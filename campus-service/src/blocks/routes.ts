import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, query, withTransaction } from '../db/pool.js';
import { requireAuth, currentUser } from '../auth/plugin.js';
import { ApiError, errors } from '../lib/errors.js';
import { getPeopleLite } from '../users/repo.js';
import { config } from '../config.js';

/** After the import (LEGACY_LOCAL_BLOCKS=0) nothing reads the local table, so writing it would be a silent no-op. */
async function legacyOnly() {
  if (!config.blocks.legacyLocal) throw new ApiError(410, 'blocks_moved', 'Blocking is managed by the Social service: POST/DELETE /v1/users/{id}/block there.');
}

export async function blockRoutes(app: FastifyInstance) {
  app.post('/v1/users/:id/block', { preHandler: [requireAuth, legacyOnly] }, async (req) => {
    const user = currentUser(req);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(req.params);
    if (id === user.id) throw errors.invalid('You cannot block yourself.');
    if (!(await one(`SELECT 1 FROM users WHERE id = $1`, [id]))) throw errors.notFound('Squirrel');
    await withTransaction(async (tx) => {
      await many(`SELECT id FROM users WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [[user.id, id]], tx);
      await query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT (blocker_id, blocked_id) DO NOTHING`, [user.id, id], tx);
    });
    return { blocked: true, user_id: id };
  });

  app.delete('/v1/users/:id/block', { preHandler: [requireAuth, legacyOnly] }, async (req) => {
    const user = currentUser(req);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(req.params);
    await query(`DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [user.id, id]);
    return { blocked: false, user_id: id };
  });

  app.get('/v1/me/blocks', { preHandler: [requireAuth, legacyOnly] }, async (req) => {
    const user = currentUser(req);
    const rows = await many<{ blocked_id: string; created_at: string }>(
      `SELECT blocked_id, created_at FROM blocks WHERE blocker_id = $1 ORDER BY created_at DESC, blocked_id`, [user.id],
    );
    const people = await getPeopleLite(rows.map((r) => r.blocked_id));
    return { blocks: rows.map((r) => ({ user_id: r.blocked_id, created_at: r.created_at, person: people.get(r.blocked_id) ?? null })) };
  });
}
