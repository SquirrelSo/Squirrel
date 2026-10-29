import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../auth/verify-jwt.js";
import { dailyProgress, lifetimeProgress, progressHistory, weeklyProgress } from "../../progress/summary.js";

type Query = { date?: string; weekStart?: string; days?: string };

// All reads are derived from the authenticated subject; clients cannot request another user's rollups.
export const progressRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/v1/progress", { onRequest: [requireAuth] }, async (request) => lifetimeProgress(request.userId));
  fastify.get<{ Querystring: Query }>("/v1/progress/daily", { onRequest: [requireAuth] }, async (request) =>
    dailyProgress(request.userId, request.query.date));
  fastify.get<{ Querystring: Query }>("/v1/progress/weekly", { onRequest: [requireAuth] }, async (request) =>
    weeklyProgress(request.userId, request.query.weekStart));
  fastify.get<{ Querystring: Query }>("/v1/progress/history", { onRequest: [requireAuth] }, async (request, reply) => {
    const raw = request.query.days ?? "30";
    if (!/^\d{1,4}$/.test(raw)) return reply.code(400).send({ error: "days must be between 1 and 366" });
    return progressHistory(request.userId, Number(raw));
  });
};
