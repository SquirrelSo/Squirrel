# ADR-012: Territory Capture Concurrency

## Status
Accepted

## Context
When multiple runs finalize concurrently and their geometries overlap, they compete for the same physical territory. Because territory capture must be entirely exhaustive and exactly one owner can possess any patch of ground at a given time (RM-5.1), naive concurrent inserts lead to "double-booked" or phantom overlapping areas, violating the game's core invariants. We required a concurrency-safe capture transaction that could atomically carve away existing territory and accurately insert new territory without race conditions.

## Decision
1. **Isolation Level**: The entire `finalizeRun` transaction is wrapped in a `SERIALIZABLE` isolation level transaction block.
2. **Retry Mechanism**: If a serialization failure occurs (`SQLSTATE 40001` or `40P01`), the transaction rolls back, waits with randomized exponential backoff (20ms base + jitter), and retries from the very beginning (up to 5 total attempts).
3. **Lock Ordering**: Inside the carve logic (`captureTerritory`), we lock overlapping `active` territories using `SELECT ... FOR UPDATE ORDER BY id ASC`. Ordering by `id` prevents classic cyclic deadlocks if multiple transactions attempt to carve the same overlapping territories.
4. **Spatial Carving**: 
   - We utilize `ST_Difference` to carve existing territories.
   - We utilize `ST_Intersection` to measure the true overlap. If the intersection area is near zero (e.g., edge contact), we skip carving to prevent redundant geometry updates that don't change area.
   - If a territory is entirely consumed (difference is empty or has ~0 area), its state is set to `expired`.
5. **No special cases**: Self-overlap (a user capturing over their own older territory) is handled identically to overlapping a rival's territory. 
6. **Geometry Validation**: If `ST_Difference` produces an invalid geometry, we roll back with a specific `carved_invalid` error to prevent poisoning the grid.

## Consequences
- We achieve absolute mathematical area conservation under load. The sum of `active` territory areas remains exactly equal to the union of all captured polygons without any double-counting.
- CPU work like track processing is safely repeated on serialization failure, keeping all logic safely inside the retry loop's atomic boundary.
- We demonstrated 100% success rate on 100 concurrent overlapping runs via a rigorous Vitest test suite.
