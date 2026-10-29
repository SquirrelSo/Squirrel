import { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../../auth/verify-jwt.js';
import { pool } from '../../db/pool.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlPath = path.resolve(__dirname, '../../../../db/queries/tiles.sql');
const sqlFile = fs.readFileSync(sqlPath, 'utf8');
const sqlFragments = sqlFile.split(/^----$/m).map((s) => s.trim()).filter(Boolean);

const GET_TERRITORIES_TILE = sqlFragments[1] as string;

const tilesRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /v1/territories/tiles/:z/:x/:y.mvt
  // NOTE: This endpoint MUST use Web Mercator (EPSG:3857). ADR-001 and RM-2.1
  // forbid Web Mercator for MEASUREMENT, but vector tiles are DEFINED in Web Mercator.
  // Using it for tile rendering is correct and required.
  fastify.get('/v1/territories/tiles/:z/:x/:yString', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { z, x, yString } = request.params as { z: string; x: string; yString: string };

    if (!yString.endsWith('.mvt')) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Tile must end with .mvt' });
    }

    const yStr = yString.slice(0, -4);
    
    const zInt = Number(z);
    const xInt = Number(x);
    const yInt = Number(yStr);

    if (!Number.isInteger(zInt) || !Number.isInteger(xInt) || !Number.isInteger(yInt)) {
      return reply.status(400).send({ error: 'Bad Request', message: 'z, x, y must be integers' });
    }

    if (zInt < 0 || zInt > 20) {
      return reply.status(400).send({ error: 'Bad Request', message: 'z must be in [0, 20]' });
    }

    const maxCoord = Math.pow(2, zInt) - 1;
    if (xInt < 0 || xInt > maxCoord || yInt < 0 || yInt > maxCoord) {
      return reply.status(400).send({ error: 'Bad Request', message: 'x and y must be in [0, 2^z - 1]' });
    }

    const { rows } = await pool.query(GET_TERRITORIES_TILE, [zInt, xInt, yInt]);
    const tileBytes = rows.length > 0 ? (rows[0] as any).tile : null;

    reply.header('Cache-Control', 'private, max-age=60');
    reply.header('Content-Type', 'application/vnd.mapbox-vector-tile');

    if (!tileBytes || tileBytes.length === 0) {
      return reply.status(204).send();
    }

    return reply.status(200).send(tileBytes);
  });
};

export default tilesRoutes;
