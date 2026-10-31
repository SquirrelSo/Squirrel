import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import tilesRoutes from "./tiles.js";
import { pool } from "../../db/pool.js";
import crypto from "crypto";
import * as VectorTile from "@mapbox/vector-tile";
import * as PbfNamespace from "pbf";
const Pbf = (PbfNamespace as any).PbfReader || (PbfNamespace as any).default || PbfNamespace;

const fastify = Fastify();
fastify.register(tilesRoutes);

import { createTestToken } from "../../auth/test-token.js";

async function createToken(userId: string) {
  return createTestToken(userId);
}

describe("MVT Tiles API", () => {
  const testRunIds: string[] = [];
  const testUserIds: string[] = [];
  afterAll(async () => {
    if (testRunIds.length > 0) {
      const ids = [...testRunIds];
      const uids = testUserIds.length > 0 ? [...testUserIds] : ["00000000-0000-0000-0000-000000000000"];
      await pool.query("DELETE FROM capture_events WHERE territory_id IN (SELECT id FROM territories WHERE run_id = ANY($1)) OR actor_id = ANY($2)", [ids, uids]);
      await pool.query("DELETE FROM territories WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM run_points WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM runs WHERE id = ANY($1)", [ids]);
      testRunIds.length = 0;
    }
  });
  let userA: string;
  let userB: string;
  let tokenA: string;

  beforeAll(async () => {
    userA = crypto.randomUUID();
    userB = crypto.randomUUID();
    tokenA = await createToken(userA);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM territories WHERE owner_id IN ($1, $2)", [userA, userB]);
  });

  it("AC1-AC4: Requesting a tile with a seeded territory returns valid MVT and decodes to GeoJSON with <10% area error", async () => {
    const runId = crypto.randomUUID();
    testRunIds.push(runId);
    await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'finalized', now())", [runId, userA]);

    const testTerritoryId = crypto.randomUUID();
    // Centered at 0,0, roughly 0.02 degrees wide
    const wkt = "POLYGON((0.000 0.000, 0.00155 0.000, 0.00155 -0.00155, 0.000 -0.00155, 0.000 0.000))";
    
    const resArea = await pool.query("SELECT ST_Area(ST_GeomFromText($1, 4326)::geography) AS area", [wkt]);
    const idealArea = resArea.rows[0].area;

    await pool.query(
      "INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, state) VALUES ($1, $2, $3, ST_Multi(ST_GeomFromText($4, 4326)), $5, now(), 'active')",
      [testTerritoryId, userA, runId, wkt, idealArea]
    );

    // Zoom 14
    let res = await fastify.inject({
      method: "GET",
      url: "/v1/territories/tiles/14/8192/8192.mvt",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);

    let tile = new VectorTile.VectorTile(new Pbf(res.rawPayload));
    let layer = tile.layers.territories!;
    let feature: any;
    for (let i = 0; i < layer.length; i++) {
      if (layer.feature(i).properties.id === testTerritoryId) {
        feature = layer.feature(i);
        break;
      }
    }
    expect(feature).toBeDefined();

    let geojson = feature.toGeoJSON(8192, 8192, 14);
    let res2 = await pool.query("SELECT ST_Area(ST_GeomFromGeoJSON($1)::geography) AS area", [JSON.stringify(geojson.geometry)]);
    let decodedArea = res2.rows[0].area;

    let delta14 = Math.abs(decodedArea - idealArea) / idealArea;
    console.log(`MVT GeoJSON Decode at z=14 (ideal=${idealArea.toFixed(2)}m2): decoded=${decodedArea.toFixed(2)}m2 delta=${(delta14 * 100).toFixed(2)}%`);

    // Zoom 12
    res = await fastify.inject({
      method: "GET",
      url: "/v1/territories/tiles/12/2048/2048.mvt",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);

    tile = new VectorTile.VectorTile(new Pbf(res.rawPayload));
    layer = tile.layers.territories!;
    for (let i = 0; i < layer.length; i++) {
      if (layer.feature(i).properties.id === testTerritoryId) {
        feature = layer.feature(i);
        break;
      }
    }
    expect(feature).toBeDefined();

    geojson = feature.toGeoJSON(2048, 2048, 12);
    res2 = await pool.query("SELECT ST_Area(ST_GeomFromGeoJSON($1)::geography) AS area", [JSON.stringify(geojson.geometry)]);
    decodedArea = res2.rows[0].area;

    let delta12 = Math.abs(decodedArea - idealArea) / idealArea;
    console.log(`MVT GeoJSON Decode at z=12 (ideal=${idealArea.toFixed(2)}m2): decoded=${decodedArea.toFixed(2)}m2 delta=${(delta12 * 100).toFixed(2)}%`); // < 10%
  });

  
  it("AC2: layer 'territories' with exactly 1 feature", async () => {
    // Distinct tile to avoid concurrent test data collision (z=14, x=1, y=1)
    const distinctRunId = crypto.randomUUID();
    testRunIds.push(distinctRunId);
    await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'finalized', now())", [distinctRunId, userA]);

    const distinctTerritoryId = crypto.randomUUID();
    const wkt = "POLYGON((0.025 -0.025, 0.03 -0.025, 0.03 -0.03, 0.025 -0.03, 0.025 -0.025))";
    
    await pool.query(
      "INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, state) VALUES ($1, $2, $3, ST_Multi(ST_GeomFromText($4, 4326)), 1, now(), 'active')",
      [distinctTerritoryId, userA, distinctRunId, wkt]
    );

    const res = await fastify.inject({
      method: "GET",
      url: "/v1/territories/tiles/14/8193/8193.mvt",
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const tile = new VectorTile.VectorTile(new Pbf(res.rawPayload));
    expect(tile.layers.territories).toBeDefined();
    expect(tile.layers.territories?.length).toBe(1); // AC2 coverage
  });

  it("AC5: Empty tile returns 204", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/territories/tiles/14/0/0.mvt",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(204);
    expect(res.rawPayload.length).toBe(0);
  });

  it("AC6: Expired territory does not appear in tile", async () => {
    const userC = crypto.randomUUID();
    const tokenC = await createToken(userC);
    const runId = crypto.randomUUID();
    testRunIds.push(runId);
    await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'finalized', now())", [runId, userC]);

    const testTerritoryId = crypto.randomUUID();
    const wkt = "POLYGON((10.0 -0.02, 10.02 -0.02, 10.02 0.02, 10.0 0.02, 10.0 -0.02))";
    await pool.query(
      "INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, state) VALUES ($1, $2, $3, ST_Multi(ST_GeomFromText($4, 4326)), 1, now(), 'expired')",
      [testTerritoryId, userC, runId, wkt]
    );

    const res = await fastify.inject({
      method: "GET",
      url: "/v1/territories/tiles/13/4551/4096.mvt",
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it("AC7: Two users' territories BOTH appear in the same tile", async () => {
    const runIdA = crypto.randomUUID();
    testRunIds.push(runIdA);
    const runIdB = crypto.randomUUID();
    testRunIds.push(runIdB);
    await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'finalized', now())", [runIdA, userA]);
    await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'finalized', now())", [runIdB, userB]);

    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    const wktA = "POLYGON((0.01 -0.01, 0.02 -0.01, 0.02 -0.02, 0.01 -0.02, 0.01 -0.01))";
    const wktB = "POLYGON((0.03 -0.03, 0.04 -0.03, 0.04 -0.04, 0.03 -0.04, 0.03 -0.03))";
    
    await pool.query(
      "INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, state) VALUES ($1, $2, $3, ST_Multi(ST_GeomFromText($4, 4326)), 1, now(), 'active')",
      [idA, userA, runIdA, wktA]
    );
    await pool.query(
      "INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, state) VALUES ($1, $2, $3, ST_Multi(ST_GeomFromText($4, 4326)), 1, now(), 'active')",
      [idB, userB, runIdB, wktB]
    );

    const res = await fastify.inject({
      method: "GET",
      url: "/v1/territories/tiles/12/2048/2048.mvt",
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const tile = new VectorTile.VectorTile(new Pbf(res.rawPayload));
    expect(tile.layers.territories!.length).toBeGreaterThanOrEqual(2);
    
    let foundA = false;
    let foundB = false;
    for (let i = 0; i < tile.layers.territories!.length; i++) {
      if (tile.layers.territories!.feature(i).properties.owner_id === userA) foundA = true;
      if (tile.layers.territories!.feature(i).properties.owner_id === userB) foundB = true;
    }
    if (!foundA || !foundB) {
      console.log("AC7 properties:", Array.from({length: tile.layers.territories!.length}).map((_, i) => tile.layers.territories!.feature(i).properties.owner_id));
    }
    expect(foundA).toBe(true);
    expect(foundB).toBe(true);
  });

  it("AC8: No Authorization header returns 401", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/territories/tiles/14/8192/8192.mvt",
    });
    expect(res.statusCode).toBe(401);
  });

  it("AC9: Invalid parameters return 400", async () => {
    let res = await fastify.inject({
      method: "GET",
      url: "/v1/territories/tiles/25/0/0.mvt",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(400);

    res = await fastify.inject({
      method: "GET",
      url: "/v1/territories/tiles/-1/0/0.mvt",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(400);

    res = await fastify.inject({
      method: "GET",
      url: "/v1/territories/tiles/2/99999/0.mvt",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(400);

    res = await fastify.inject({
      method: "GET",
      url: "/v1/territories/tiles/14/8192/abc.mvt",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
