# Golden WKT Files — Geometry Pipeline Determinism

These files contain the expected serialized WKT output of the full geometry
pipeline (`processTrack`) for each synthetic fixture.

## What they are

Each `.wkt` file holds the `multiPolygonWkt4326` string produced by running
`processTrack` on the named fixture with its default seed, noise, and rotation
settings.

## Why they exist

The RM-2.6 determinism test cross-checks the live pipeline output against
these files on every test run.  A mismatch means one of:

1. **A regression** — a change to `simplify.ts`, `polygonize.ts`, `validate.ts`,
   or any supporting file altered the numeric output of the pipeline.
2. **An intentional change** — a deliberate update to the pipeline that changes
   its output (e.g. changed epsilon, changed coordinate precision).

## What to do on a mismatch

If a change is **intentional** (you knowingly changed the pipeline and the new
output is correct), regenerate the golden files by deleting them and running
`npm run test:geometry` once — the test will recreate them and report that it
did so.  Then commit the new golden files alongside the pipeline change.

If a change is **unexpected**, treat it as a bug.  The determinism harness is
the primary signal that RM-4.4's anti-cheat layer can rely on stable geometry.

## Format

- Encoding: UTF-8
- Line endings: LF (Unix)
- No trailing newline
- Content: raw MULTIPOLYGON WKT string, single line

## Files

| File | Fixture |
|---|---|
| `simple-loop.wkt` | `generateSimpleLoop()` — 200×150 m rotated rectangle |
| `figure-eight.wkt` | `generateFigureEight()` — clean crossing, 2 faces |
| `noisy-figure-eight.wkt` | `generateNoisyFigureEight()` — 10 microfaces |
| `out-and-back.wkt` | `generateOutAndBack()` — 1 face, spur discarded |
