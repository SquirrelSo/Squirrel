# Geographic data required before launch

**Everything geographic in this repo is a development placeholder.** The seed (`src/seed/zones.ts`) places
rectangles and ovals in metres around a single campus-centre coordinate — the same convention as the mobile
dev mock — so the app and backend line up in development. None of it has been checked against the ground.
Every seeded zone carries `geometry_source = 'dev_placeholder'`; the seed will overwrite a zone's geometry only
while it still has that marker, so replacing a polygon with real data is safe and permanent.

## What is needed

| item | needed for | format | who can supply |
|---|---|---|---|
| **Campus centre + fence radius** (`CAMPUS_CENTER_LAT/LNG`, `CAMPUS_MAX_RADIUS_M`) | rejecting off-campus GPS, nearby search bias | decimal degrees; metres | a phone standing at the main gate / centre; confirm the campus fits in 4 km |
| **Zone polygons (14 seeded)** — the halls (Nivedita, Netaji Subhas Chandra Bose, Ishwar Chandra Vidyasagar), Mess, CC1, Library, LHC, Admin lawn, Main gate boulevard, Research complex, Amphitheatre, Health centre, Sports ground, Lake | qualification, claims, map | closed WGS84 polygon (GeoJSON or KML), **valid** (no self-intersections), 5–30 vertices | walk the boundary with a GPS-tracing app (OSMAnd, Strava route, Google My Maps) or trace on satellite imagery |
| **Route lines for ROUTE zones** — Sports Ground Loop, Lake Walk (+ any other loops) | route_completion | WGS84 LineString following the actual path/track | trace by walking it once with the app in dev mode and exporting the `track` from `GET /v1/activities/:id` |
| **Per-zone thresholds** (optional) | fairness | number 0–1 | product decision after a week of real runs; defaults 0.6 AREA / 0.8 ROUTE |
| **Hostel list + names** | hostel leaderboard, profiles | id, full name, short name | admin |
| **Zone kinds & short names** | UI | enum | product |

## Constraints on polygons

* SRID 4326 (lon/lat), ring closed, `ST_IsValid` true (the schema enforces it).
* Hostel zones should be the block **plus** its courtyard/approach so a loop around it is possible.
* Avoid overlapping zones unless intentional; overlapping zones qualify independently.
* AREA zones smaller than ~4 000 m² are hard to hit 60 % coverage on with 15 m buffer — either lower the threshold or enlarge the zone.

## Fastest: import from OpenStreetMap

OpenStreetMap already maps the campus (the university outline is way 354549537; Nivedita Hall, the
library and the grounds are on it). One command turns it into the app's base map and this seed:

```bash
cd mobile-4
node scripts/campus-osm.mjs --fetch          # needs internet access to overpass-api.de
# or: openstreetmap.org → Export → "Manually select a different area" around the campus → Export,
#     then: node scripts/campus-osm.mjs --in ~/Downloads/map.osm
```

It writes `mobile-4/src/api/campus/campusOsm.json` (the app draws it) and `src/seed/zones.osm.json`
(the next `npm run seed:zones` loads it with `geometry_source = 'osm'`, keeps surveyed zones as they
are, and switches off placeholder zones OpenStreetMap doesn't have). The halls, library, LHC, gate,
mess and lake keep the ids used everywhere else, so territory and hall choices carry over. Commit the
two JSON files. Anything missing from OpenStreetMap stays missing: add it there, or survey it below.

The sports loop (or any `leisure=track`) and the lake come in as ROUTE zones: you qualify by going
round. The lake's loop is the footpath around it when OSM has one, else the shore, and each ROUTE
zone's outline reaches 25 m beyond its loop so the path is inside it. Spelling mistakes in OSM names
are corrected on import (`NAME_FIXES` in the script; fix them on openstreetmap.org too). A zone an
earlier import had but a new one doesn't (renamed or removed in OSM) is switched off, not deleted.

**The running track.** A `leisure=track` is picked up whether OSM draws it as an area or a line, named
or not, and the import says whether it found one. IISER Kolkata's OSM data has none yet. Until it
does, record one lap of the track with the app, fetch it (`GET /v1/activities/:id` from
campus-service), then:

```bash
node scripts/campus-osm.mjs --trace lap.json      # writes scripts/campus-routes.json (commit it)
node scripts/campus-osm.mjs --fetch               # the sports loop is now the traced lap
```

The traced loop is stored with `geometry_source = 'traced'`. When the track is added to
OpenStreetMap, the next import uses OSM's instead.

## How to load real data by hand

```sql
UPDATE zones SET geometry = ST_GeomFromGeoJSON('{"type":"Polygon","coordinates":[[[lng,lat],…]]}'),
                 centroid = ST_Centroid(ST_GeomFromGeoJSON('…')), geometry_source = 'survey', updated_at = now()
WHERE id = 'cc1';
UPDATE zones SET required_route = ST_GeomFromGeoJSON('{"type":"LineString","coordinates":[…]}'), geometry_source='survey' WHERE id = 'sports';
```
or replace the `xy`/`routeXy` arrays in `src/seed/zones.ts` with real coordinates (change `toLngLat` to pass through) and re-run `npm run seed`.
Verify with `GET /v1/zones?format=geojson` in any GeoJSON viewer, then do one real run through each zone and check `GET /v1/activities/:id/zones`.
