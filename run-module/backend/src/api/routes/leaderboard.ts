import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../auth/verify-jwt.js";
import { LeaderboardResponseSchema } from "../schemas/leaderboard.js";
import { queryLeaderboard, LeaderboardWindow } from "../../leaderboard/query.js";

export const leaderboardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: {
      scope?: string;
      window?: string;
      limit?: number;
      cursor?: string;
      metric?: string;
    }
  }>(
    "/",
    {
      onRequest: [requireAuth],
      schema: {
        response: {
          200: LeaderboardResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { scope = 'global', window = 'weekly', limit = 20, cursor, metric = 'area' } = request.query;

      if (scope !== 'global') {
        return reply.code(400).send({ error: "Only global scope is supported" });
      }
      if (metric !== 'area') {
        return reply.code(400).send({ error: "Only area metric is supported" });
      }
      if (!['daily', 'weekly', 'alltime'].includes(window)) {
        return reply.code(400).send({ error: "Invalid window" });
      }

      const parsedLimit = Number(limit);
      if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        return reply.code(400).send({ error: "Limit must be between 1 and 100" });
      }

      const result = await queryLeaderboard(
        window as LeaderboardWindow,
        parsedLimit,
        cursor,
        request.userId
      );

      return reply.code(200).send({
        scope,
        window,
        metric,
        entries: result.entries,
        me: result.me,
        next_cursor: result.next_cursor,
        total_ranked: result.total_ranked
      });
    }
  );
};
