# ADR-005: Activity Contract Write Path

| Field          | Value                                             |
|---------------|---------------------------------------------------|
| **Status**     | Accepted                                          |
| **Date**       | 2026-09-19                                        |
| **Ticket**     | RM-6.4 + RM-3.2a                                  |
| **Authors**    | Run Module team                                   |
| **Supersedes** | —                                                 |
| **Superseded in part by** | ADR-027: the XP engine reads `activity_sessions` (read-only, for XP) |

---

## Context

The Run Module acts as a producer of activity data for the broader application ecosystem. Whenever a run is finalized—whether it successfully claims a territory or is rejected—an `activity_sessions` row must be written. Per Integration Report section 3.2, `activity_sessions` is a **SHARED CONTRACT** with module-owned rows: each module writes its own rows and reads neither the other's rows nor its internal tables. That is why this repository writes to it. We must insert activity records to fulfill our contract, but we are forbidden from reading from this table, joining against it, or migrating it to add module-specific columns.

Additionally, to ensure the integrity of the data we produce, we require a consistency guard inside the database transaction (Part A of RM-3.2a). The area computed by the Node.js geometry pipeline (`area_m2`) must strictly describe the exact serialized WKT inserted into the database. If PostGIS interprets the inserted geometry differently, or if we apply server-side transforms like `ST_MakeValid` that alter the shape, the area of the stored shape will diverge from the area we store in the `area_m2` column, causing silent anti-cheat vulnerabilities (RM-4.4).

## Decisions

### 1. Write-Only Integration with Activity Sessions
The Run Module will write exactly one `activity_sessions` row during run finalization.
- **Valid Runs:** Emit an activity session with `territory_claimed: true` and the computed `area_m2`.
- **Rejected Runs:** Emit an activity session with `territory_claimed: false`, `area_m2: 0`, and the `rejection_reason` in the JSONB `metrics` payload.
- We will not execute any `SELECT` queries against `activity_sessions`, and all module-specific data must reside inside the `metrics` JSONB column.

### 2. Derived Metrics (Duration and Intensity)
The `activity_sessions` table requires `duration_s` and `intensity`.
- If the mobile client provides `elapsed_time_s`, we use it. If omitted, we derive `duration_s` by diffing the `recorded_at` timestamps of the first and last GPS points in the run.
- `intensity` is computed via MET thresholds derived from the user's running speed (m/s). This is an ENGINEERING DECISION with no specification basis:
  - `< 1.0 m/s` (walking/slow) → `low`
  - `1.0 m/s - 2.5 m/s` (jogging/moderate) → `moderate`
  - `> 2.5 m/s` (running/vigorous) → `vigorous`
- **Calories:** The Run Module has no domain knowledge of the user's weight or biometrics, so `calories_kcal` is intentionally set to `NULL`. The Exercise Module is responsible for asynchronously computing and backfilling this value if required.

### 3. Removal of ST_MakeValid in INSERT_TERRITORY (SUPERSEDED)
**NOTE: This section is SUPERSEDED by ADR-006. The conclusion below regarding un-unioned geometry is no longer true.**

*Original decision:* To guarantee area consistency, we verified that applying `ST_MakeValid` on the un-unioned WKT string during `INSERT_TERRITORY` merges overlapping faces, which alters the geometry and its resulting area (e.g., a 1.19% mismatch for noisy figure-eights). 
Therefore, `ST_MakeValid` was removed. We store the raw un-unioned geometry output by the Phase 2 pipeline. While this means the stored geometry may return `ST_IsValid() = false` for overlapping loops, `ST_Area(geom::geography)` perfectly matches the pipeline's area computation (within `0.000003%` error).

*(See ADR-006 for the reversal, where the pipeline outputs correctly unioned valid geometries).*

### 4. In-Transaction Consistency Guard and SAVEPOINT
A `CHECK_TERRITORY_AREA` query immediately follows the territory insert within the same transaction. It computes the area of the newly stored row using PostGIS (`ST_Area(geom::geography)`) and rolls back the `INSERT_TERRITORY` statement if the difference between the pipeline `area_m2` and the database area exceeds `0.5%`. This ensures corrupted or mismatched data never persists. 

Because of the `SAVEPOINT before_territory` lock, rolling back the territory insert does not abort the transaction. The `SAVEPOINT` mechanism allows the territory insert to roll back while the `activity_sessions` row still commits, so a rejected run still produces its contract row and we complete the request gracefully.

## Consequences

- The application is protected against arbitrary differences between pipeline arithmetic and PostGIS spatial evaluation.
- Activity sessions act as a reliable feed for daily streaks or run metrics for all attempts (successes and rejections), without requiring the Run Module to cross architectural boundaries.
- The intensity thresholds are an engineering estimate and should be revisited when real run data exists.

---

*Corrected 2026-09-19: Reframed activity_sessions as a shared contract rather than belonging to the Exercise Module, marked section 3 explicitly as superseded by ADR-006, and properly documented the SAVEPOINT mechanism's role in allowing rejected runs to commit their contract row.*
