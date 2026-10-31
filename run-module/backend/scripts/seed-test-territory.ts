import { pool } from '../src/db/pool.js';
import { randomUUID } from 'crypto';

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 3) {
        console.error("Usage: npm run seed:territory -- <userId> <lat> <lng>");
        process.exit(1);
    }
    const userId = args[0];
    const lat = parseFloat(args[1]);
    const lng = parseFloat(args[2]);

    const dLat = 0.0009; // approx 100m
    const dLng = 0.0009 / Math.cos(lat * Math.PI / 180);

    const geomWkt = 'POLYGON((' + (lng - dLng) + ' ' + (lat - dLat) + ', ' + (lng + dLng) + ' ' + (lat - dLat) + ', ' + (lng + dLng) + ' ' + (lat + dLat) + ', ' + (lng - dLng) + ' ' + (lat + dLat) + ', ' + (lng - dLng) + ' ' + (lat - dLat) + '))';
    const runId = randomUUID();
    const terrId = randomUUID();
    
    try {
        await pool.query(
            "INSERT INTO runs (id, user_id, started_at, status, distance_m, moving_time_s, elapsed_time_s) VALUES ($1, $2, now(), 'finalized', 0, 0, 0)",
            [runId, userId]
        );

        const res = await pool.query(
            "INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, expires_at, state) VALUES ($1, $2, $3, ST_Multi(ST_GeomFromText($4, 4326)), ST_Area(ST_Multi(ST_GeomFromText($4, 4326))::geography), now(), now() + interval '14 days', 'active') RETURNING id, area_m2",
            [terrId, userId, runId, geomWkt]
        );
        console.log("Inserted territory " + res.rows[0].id);
        console.log("Computed area_m2: " + res.rows[0].area_m2.toFixed(2));
        console.log("For user id: " + userId);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
main();