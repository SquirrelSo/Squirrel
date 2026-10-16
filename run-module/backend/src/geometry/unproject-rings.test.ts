import { describe, it, expect } from "vitest";
import { pool } from "../db/pool.js";
import { createLocalProjection } from "./projection.js";
import { unprojectAeqdTo4326 } from "./pipeline.js";

describe("unprojectAeqdTo4326 interior ring handling", () => {
  it("correctly unprojects a POLYGON with an interior ring", async () => {
    const centre = { lat: 0, lng: 0 };
    const proj = createLocalProjection([centre]);
    
    const exterior = "-50 -50, 50 -50, 50 50, -50 50, -50 -50";
    const interior = "-25 -25, -25 25, 25 25, 25 -25, -25 -25";
    const wktAeqd = `POLYGON((${exterior}), (${interior}))`;

    const wkt4326 = unprojectAeqdTo4326(wktAeqd, proj);

    const res = await pool.query(`SELECT 
      ST_IsValid(ST_GeomFromText($1, 4326)) AS is_valid,
      ST_NumInteriorRings(ST_GeomFromText($1, 4326)) AS num_rings,
      ST_Area(ST_GeomFromText($1, 4326)::geography) AS area,
      ST_Contains(
        ST_GeomFromText($1, 4326), 
        ST_Centroid(ST_InteriorRingN(ST_GeomFromText($1, 4326), 1))
      ) AS contains_hole_centroid,
      ST_Contains(
        ST_MakePolygon(ST_ExteriorRing(ST_GeomFromText($1, 4326))),
        ST_Centroid(ST_InteriorRingN(ST_GeomFromText($1, 4326), 1))
      ) AS exterior_contains_hole_centroid
      `,
      [wkt4326]
    );

    const row = res.rows[0];
    expect(row.is_valid).toBe(true);
    expect(row.num_rings).toBe(1);
    
    const diff = Math.abs(row.area - 7500) / 7500;
    expect(diff).toBeLessThan(0.005);
    
    // Result does NOT contain the hole centroid
    expect(row.contains_hole_centroid).toBe(false);
    // Exterior ring DOES contain the hole centroid
    expect(row.exterior_contains_hole_centroid).toBe(true);
  });
});
