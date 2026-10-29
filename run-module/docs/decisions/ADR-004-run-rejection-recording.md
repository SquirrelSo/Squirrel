# ADR-004: Run Rejection Recording

| Field          | Value                                             |
|---------------|---------------------------------------------------|
| **Status**     | Accepted                                          |
| **Date**       | 2026-09-19                                        |
| **Ticket**     | RM-3.2                                            |
| **Authors**    | Run Module team                                   |
| **Supersedes** | —                                                 |

---

## Context

When a user finishes a run, the RM-2.x geometry pipeline evaluates the uploaded GPS points. If the run fails validation (e.g., minimum area not met, isoperimetric violation), it does not produce a territory.

Initially, we considered silently discarding these runs or just setting the `runs.status` to `rejected`. However, we need to show the user *why* their run failed in the mobile app, and we need telemetry to tune the pipeline thresholds.

## Decisions

### 1. New run_rejections table
We introduce a `run_rejections` table associated 1:1 with the `runs` table. When the worker catches an `ok: false` result from the geometry pipeline, it will insert a row into `run_rejections` rather than `territories`. The table records the machine-readable `reason` code (e.g., `'below_minimum_area'`) and a human-readable `detail` string provided by the validation logic.

### 2. runs.status gains 'rejected'
`runs.status` gained a sixth value, `'rejected'`, alongside the documented `active`, `paused`, `finishing`, and `finalized`. The column is free text with allowed values carried in a comment, not a CHECK constraint, consistent with the section 4.1 schema.

## Consequences

- We can query rejection rates and adjust the thresholds if legitimate runs are being blocked.
- The mobile client can query the run status and display tailored coaching (e.g., "Try running in a wider loop next time!").
- The database schema requires this table to exist before the worker is implemented.

---

*Corrected 2026-09-19: Corrected the ticket attribution to RM-3.2 (where the migration was created) and documented that runs.status gained the 'rejected' value as a free text comment, not a CHECK constraint.*
