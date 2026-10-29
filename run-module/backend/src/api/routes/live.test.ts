import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "crypto";
import Fastify from "fastify";
import { SignJWT } from "jose";
import { liveRoutes } from "./live.js";
import { pool } from "../../db/pool.js";
import { JWT_SECRET } from "../../config/env.js";

const token = (sub: string): Promise<string> =>
  new SignJWT({ sub, typ: "access" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(new TextEncoder().encode(JWT_SECRET));

describe("GET /v1/live", () => {
  const fastify = Fastify();
  void fastify.register(liveRoutes);
  const runs: string[] = [];

  beforeAll(async () => {
    await fastify.ready();
  });
  afterEach(async () => {
    await pool.query("DELETE FROM run_points WHERE run_id = ANY($1)", [runs]);
    await pool.query("DELETE FROM runs WHERE id = ANY($1)", [runs]);
    runs.length = 0;
  });
  afterAll(async () => {
    await pool.end();
  });

  async function run(status: string, startedMinutesAgo: number, lastPointMinutesAgo: number | null): Promise<void> {
    const id = crypto.randomUUID();
    runs.push(id);
    await pool.query("INSERT INTO runs (id, user_id, started_at, status) VALUES ($1, $2, now() - make_interval(mins => $3), $4)",
      [id, crypto.randomUUID(), startedMinutesAgo, status]);
    if (lastPointMinutesAgo !== null) {
      await pool.query("INSERT INTO run_points (run_id, seq, lat, lng, recorded_at) VALUES ($1, 1, 22.96, 88.52, now() - make_interval(mins => $2))",
        [id, lastPointMinutesAgo]);
    }
  }

  const count = async (): Promise<number> =>
    (await fastify.inject({ method: "GET", url: "/v1/live", headers: { authorization: `Bearer ${await token(crypto.randomUUID())}` } }))
      .json<{ running_now: number }>().running_now;

  it("counts runs that are going on now, and not abandoned or finished ones", async () => {
    const before = await count();
    await run("active", 30, 1);        // out running
    await run("active", 5, null);      // just started, no points yet
    await run("paused", 40, 4);        // waiting at a crossing
    await run("active", 120, 60);      // phone died an hour ago
    await run("finalized", 30, 1);     // done
    expect((await count()) - before).toBe(3);
  });

  it("needs a signed-in user", async () => {
    expect((await fastify.inject({ method: "GET", url: "/v1/live" })).statusCode).toBe(401);
  });
});
