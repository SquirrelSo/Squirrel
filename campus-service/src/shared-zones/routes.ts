import type { FastifyInstance } from 'fastify';
import { requireAuth, currentUser } from '../auth/plugin.js';
import { getSharedZones } from './service.js';

export async function sharedZoneRoutes(app: FastifyInstance) {
  app.get('/v1/me/shared-zones', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    return getSharedZones(user.id);
  });
}
