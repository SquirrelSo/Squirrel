// backend/src/api/routes/territories.ts
import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../auth/verify-jwt.js";
import { pool } from "../../db/pool.js";
import { TerritoriesMineResponseSchema } from "../schemas/territories.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlFile = await fs.readFile(
  path.join(__dirname, "../../../../db/queries/territories.sql"),
  "utf8"
);
const queries = sqlFile
  .split("----")
  .map((q) => q.trim())
  .filter(Boolean);

// [0] GET_TERRITORIES_MINE

interface TerritoryRow {
  id: string;
  area_m2: number;
  claimed_at: Date;
  expires_at: Date | null;
  state: string;
  geometry: any;
}

export const territoriesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/mine",
    {
      onRequest: [requireAuth],
      schema: {
        response: {
          200: TerritoriesMineResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.userId; // Trust boundary: only read from token subject

      const result = await pool.query<TerritoryRow>(queries[0]!, [userId]);
      let truncated = false;
      let rows = result.rows;

      if (rows.length > 200) {
        truncated = true;
        rows = rows.slice(0, 200);
      }

      const territories = rows.map((r) => ({
        id: r.id,
        area_m2: r.area_m2,
        claimed_at: r.claimed_at.toISOString(),
        expires_at: r.expires_at ? r.expires_at.toISOString() : null,
        state: r.state,
        geometry: r.geometry,
      }));

      return reply.code(200).send({
        territories,
        truncated,
      });
    }
  );
};
