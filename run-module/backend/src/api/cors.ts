/**
 * src/api/cors.ts
 *
 * Cross-origin access for the web app (e.g. the Expo web build on Vercel), which runs on its own
 * domain and calls this API from the browser.
 *
 *   CORS_ALLOWED_ORIGINS=https://squirrel.vercel.app,https://squirrel-*-team.vercel.app
 *
 * Comma-separated origins. A `*` matches one run of letters, digits and dashes inside a host name
 * (for Vercel preview URLs), never a dot, so it cannot widen to another domain. Unset or empty: no
 * cross-origin browser access (the phone app is not a browser and is unaffected).
 *
 * No cookies are involved (requests carry a bearer token), so credentials stay off. The Exercise
 * backend reads the same variable with the same rules (backend/cors.py).
 */

import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

const escape = (s: string): string => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&");

export function parseAllowedOrigins(raw: string | undefined): (string | RegExp)[] {
  return (raw ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => o !== "")
    .map((o) =>
      o.includes("*")
        ? new RegExp(`^${o.split("*").map(escape).join("[a-z0-9-]+")}$`, "i")
        : o,
    );
}

export async function registerCors(fastify: FastifyInstance, raw: string | undefined): Promise<void> {
  const origins = parseAllowedOrigins(raw);
  if (origins.length === 0) return;
  await fastify.register(cors, {
    origin: origins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
    exposedHeaders: ["Retry-After"],
    maxAge: 600,
  });
}
