# ADR-018: Leaderboard Snapshot and Rebuild

## Context
Redis operates purely as an ephemeral cache for the leaderboard, with capture_events acting as the authoritative ledger. In the event of a total cache loss, rebuilding the leaderboard from scratch by replaying the entire history of capture_events would grow unbounded and become prohibitively slow over time. Furthermore, because territory decays (emitting 'expired' events per RM-5.4), simply recomputing from active territories is insufficient. We need a bounded and exact recovery mechanism.

## Decision
We will implement a 'restore-plus-tail' rebuild strategy using periodic Postgres snapshots.

### 1. Snapshot Strategy
A periodic BullMQ job (hourly) will snapshot the state of the leaderboard into a new Postgres table leaderboard_snapshots. 
- **Single Timestamp:** A single captured_at timestamp is used across all windows in a single snapshot run. This ensures that the snapshot represents a consistent point in time, preventing race conditions or mixed states between windows.
- **Day-Bucket Resolution:** Redis stores individual day buckets (e.g., lb:day:2026-09-20), whereas daily and weekly are aggregated from these buckets. A weekly total cannot be decomposed back into seven distinct day keys. To solve this, the snapshot will persist both the aggregated windows (daily, weekly, lltime) for historical reporting, AND the individual day keys (using window values like day:YYYY-MM-DD). 
- **Reserved Words:** The column window is a reserved word in SQL and must be explicitly quoted as "window" in every query.

### 2. Rebuild Strategy
Rebuilding the leaderboard from scratch will not be exposed via an API route; it is strictly an operational procedure. The process is:
1. Delete the existing lb:* Redis keys.
2. Find the most recent captured_at from leaderboard_snapshots.
3. Restore the lltime window and individual day:YYYY-MM-DD buckets from that snapshot using ZADD. (The aggregated daily and weekly snapshot rows are ignored during restore, as they will be naturally recomputed by ZUNIONSTORE using the restored day keys).
4. Replay every capture_events row where occurred_at > captured_at through the exact same logic used by the standard sync worker. This applies attribution rules consistently and guarantees the positive-only lltime rule is respected.
Neither step is sufficient alone. Snapshot-only would produce stale rankings lacking recent events. Tail-only would be an unbounded replay from the beginning of time. Together, they provide bounded, exact recovery.

### 3. Retention
To prevent leaderboard_snapshots from growing indefinitely and causing a slow leak, snapshot rows older than 30 days will be deleted as part of the scheduled snapshot execution.
