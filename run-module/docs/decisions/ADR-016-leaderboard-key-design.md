# ADR-016: Leaderboard Key Design

## Status
Accepted

## Context
The leaderboard needs to support rolling daily and weekly windows, as well as an all-time cumulative score. Real-time updates must have (\log n)$ performance and handle replay idempotently so exactly-once semantics are preserved.

## Decisions

### 1. Dated Buckets vs Rolling Keys
**Decision**: Use daily bucket keys (lb:day:<YYYY-MM-DD> in UTC, TTL 9 days) and a single permanent lb:alltime key. Weekly leaderboards are computed dynamically on read by performing a ZUNIONSTORE over the past 7 days into a short-lived temporary key.
**Rationale**: A single rolling 24-hour or 7-day key cannot be maintained by increments alone, as there is no mechanism to decrement a delta once it ages out of the window. By grouping deltas into static daily buckets, old data simply expires via Redis TTL, making the window genuinely rolling and naturally surviving database rebuilds (RM-6.3).

### 2. Idempotency Marker
**Decision**: Before processing an event, the worker executes a Redis WATCH transaction on a marker key (lb:processed:<eventId>, TTL 30 days). If the key does not exist, it executes a MULTI block containing the marker SETEX and the ZINCRBY commands.
**Rationale**: Redis ZINCRBY is inherently non-idempotent. Conditionally checking a processed marker ensures replayed events are safely ignored. A 30-day TTL is used as it exceeds our maximum 7-day rolling window with ample safety margin.

### 3. Member Attribution (Victim not Actor)
**Decision**: When applying score deltas, the ctor_id receives positive deltas (for claimed events), but the previous_owner_id receives negative deltas (for partial_capture, ull_capture, and expired events).
**Rationale**: A carve or decay event represents territory lost by the original owner. Applying a negative delta to the actor would incorrectly penalize an attacker for their own success, while failing to subtract the area from the victim.

### 4. Database Transaction Isolation
**Decision**: All capture_events rows are enqueued to the leaderboard worker *strictly after* the PostgreSQL transaction commits. Redis commands are never executed inside an open database transaction.
**Rationale**: Executing Redis commands inside a database transaction couples database availability to Redis availability, violating transaction safety. A Redis timeout would hold database locks open or cause unintended rollback of the primary territory state.

### 5. UTC Boundaries
**Decision**: All daily buckets are defined strictly by UTC day boundaries (getUTCFullYear, getUTCMonth, getUTCDate).
**Rationale**: A unified global UTC boundary avoids fragmented user-specific buckets, allowing a single ZUNIONSTORE computation to serve all users. The localization of the day boundary for presentation is outside the scope of this syncing layer.
