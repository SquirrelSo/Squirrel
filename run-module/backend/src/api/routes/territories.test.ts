import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { territoriesRoutes } from "./territories.js";
import { pool } from "../../db/pool.js";
import { SignJWT } from "jose";
import { resetKeyCache } from "../../auth/verify-jwt.js";
import crypto from "crypto";

describe("Territories API", () => {
  const testRunIds: string[] = [];
  const testUserIds: string[] = [];
  afterAll(async () => {
    if (testRunIds.length > 0) {
      const ids = [...testRunIds];
      const uids = testUserIds.length > 0 ? [...testUserIds] : ["00000000-0000-0000-0000-000000000000"];
      await pool.query("DELETE FROM capture_events WHERE territory_id IN (SELECT id FROM territories WHERE run_id = ANY($1)) OR actor_id = ANY($2)", [ids, uids]);
      await pool.query("DELETE FROM territories WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM runs WHERE id = ANY($1)", [ids]);
      testRunIds.length = 0;
    }
  });
  let fastify: FastifyInstance;
  let tokenA: string;
  let tokenB: string;
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const runA = crypto.randomUUID();
    testRunIds.push(runA);
  const runB = crypto.randomUUID();
    testRunIds.push(runB);
  const territoryA = crypto.randomUUID();
  const territoryB = crypto.randomUUID();

  beforeAll(async () => {
    process.env.JWT_SECRET = "dev-local-jwt-secret-not-for-production-use";
    process.env.JWT_ALGORITHM = "HS256";
    resetKeyCache();
    
    fastify = Fastify();
    await fastify.register(territoriesRoutes, { prefix: "/v1/territories" });
    await fastify.ready();

    const secret = new TextEncoder().encode("dev-local-jwt-secret-not-for-production-use");
    tokenA = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userA).sign(secret);
    tokenB = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userB).sign(secret);

    // Insert Runs
    await pool.query(
      `INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'finalized', now()), ($3, $4, 'finalized', now())`,
      [runA, userA, runB, userB]
    );

    // Insert Territories
    // geom as a simple polygon for testing: POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))
    const wkt = "POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))";
    await pool.query(
      `INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, state)
       VALUES 
       ($1, $2, $3, ST_Multi(ST_GeomFromText($7, 4326)), 100, now(), 'active'),
       ($4, $5, $6, ST_Multi(ST_GeomFromText($7, 4326)), 100, now(), 'active')`,
      [territoryA, userA, runA, territoryB, userB, runB, wkt]
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM territories WHERE id IN ($1, $2)`, [territoryA, territoryB]);
    await pool.query(`DELETE FROM runs WHERE id IN ($1, $2)`, [runA, runB]);
    await fastify.close();
  });

  it("AC1: GET /v1/territories/mine as A returns exactly A's territory", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/v1/territories/mine",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.territories).toHaveLength(1);
    expect(body.territories[0].id).toBe(territoryA);
    expect(response.payload).not.toContain(territoryB);
  });

  it("AC2: GET /v1/territories/mine as B returns exactly B's territory", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/v1/territories/mine",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.territories).toHaveLength(1);
    expect(body.territories[0].id).toBe(territoryB);
    expect(response.payload).not.toContain(territoryA);
  });

  it("AC3: A territory whose state is not active does NOT appear in the response", async () => {
    await pool.query(`UPDATE territories SET state = 'expired' WHERE id = $1`, [territoryB]);
    const response = await fastify.inject({
      method: "GET",
      url: "/v1/territories/mine",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.territories).toHaveLength(0);
  });

  it("AC4: No Authorization header returns 401", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/v1/territories/mine",
    });
    expect(response.statusCode).toBe(401);
  });

  it("AC5: The returned geometry parses as valid GeoJSON and matches expected area", async () => {
    // Update area_m2 to match exactly what PostGIS calculates for our fake geometry
    await pool.query(`UPDATE territories SET area_m2 = ST_Area(geom::geography) WHERE id = $1`, [territoryA]);
    
    const response = await fastify.inject({
      method: "GET",
      url: "/v1/territories/mine",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const body = response.json();
    const geom = body.territories[0].geometry;
    const storedArea = body.territories[0].area_m2;
    
    expect(geom.type).toBe("MultiPolygon");
    
    const res = await pool.query(
      `SELECT ST_Area(ST_GeomFromGeoJSON($1)::geography) as area`,
      [JSON.stringify(geom)]
    );
    const parsedArea = res.rows[0].area;
    const diff = Math.abs(parsedArea - storedArea) / storedArea;
    expect(diff).toBeLessThan(0.005);
  });

  it('Edge Case: A user with zero active territories gets 200 and an empty array, not 404', async () => {
    const userC = crypto.randomUUID();
    const tokenC = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userC).sign(new TextEncoder().encode("dev-local-jwt-secret-not-for-production-use"));
    const response = await fastify.inject({
      method: 'GET',
      url: '/v1/territories/mine',
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.territories).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  it('Edge Case: 200-row cap and truncated flag', async () => {
    const userD = crypto.randomUUID();
    const tokenD = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userD).sign(new TextEncoder().encode("dev-local-jwt-secret-not-for-production-use"));
    
    // Seed 205 active territories
    let query = "INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, state) VALUES ";
    const params = [];
    let p = 1;
    for (let i = 0; i < 205; i++) {
      query += `($${p++}, $${p++}, $${p++}, ST_Multi(ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))', 4326)), 1, now(), 'active')`;
      if (i < 204) query += ",";
      params.push(crypto.randomUUID(), userD, runA);
    }
    await pool.query(query, params);

    const response = await fastify.inject({
      method: 'GET',
      url: '/v1/territories/mine',
      headers: { authorization: `Bearer ${tokenD}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.territories).toHaveLength(200);
    expect(body.truncated).toBe(true);
    
    // Test under cap
    const responseB = await fastify.inject({
      method: 'GET',
      url: '/v1/territories/mine',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(responseB.statusCode).toBe(200);
    const bodyB = responseB.json();
    expect(bodyB.truncated).toBe(false);
    
    // Clean up
    await pool.query('DELETE FROM territories WHERE owner_id = $1', [userD]);
  });
});
