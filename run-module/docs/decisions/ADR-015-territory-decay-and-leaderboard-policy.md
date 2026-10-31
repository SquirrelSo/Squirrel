# ADR-015: Territory Decay and Leaderboard Policy

## Status
Accepted

## Context
The game's dynamic map requires territories to decay over time to prevent stagnation and reward continuous engagement. Without decay, players could capture an area once and dominate it forever, locking out newcomers and removing any incentive to run again. Additionally, the leaderboard needs clear metrics (scopes and windows) to rank players, and these metrics must correctly reflect the map's current state (including decay). We need to formalize the decay policy, event sourcing requirements, and leaderboard ranking definitions before building the scheduled jobs and aggregation workers.

## Decisions

### 1. Decay Window (14 Days, Hard Expiry)
**Decision**: Territories expire 14 days from their \claimed_at\ timestamp. Expiry is a binary state change ('active' to 'expired') with no gradual shrinking.
**Rationale**: Gradual shrinkage would require nightly \ST_Buffer\ or \ST_Difference\ recalculations for every single active territory in the database. This would produce performance-killing table scans, create topological edge cases (slivers, split multipolygons), and make the capture transaction incredibly brittle by altering boundaries asynchronously. 
On the product side, a 7-day expiry unfairly punishes casual runners who might miss a week due to illness or vacation, leading to churn. A 30-day expiry leaves "dead" territories cluttering the map. 14 days is the sweet spot, letting a weekly runner hold ground while keeping the map dynamic.

### 2. Event Emission for Expiry
**Decision**: When a territory expires, it emits a \capture_events\ row with:
- \event_type\: 'expired'
- \	erritory_id\: the expiring territory's ID
- \ctor_id\: the territory owner's ID
- \previous_owner_id\: the territory owner's ID
- \rea_delta_m2\: negative (the full area lost)
**Rationale**: \capture_events\ acts as our system's single source of truth (an event ledger). If expiration did not emit an event, the ledger would no longer sum to the true map state. Rebuilding the leaderboard (RM-6.3) would replay ghost territories, inflating scores over time. Furthermore, the leaderboard worker would have to cross-reference the \	erritories\ table to reconcile expirations, defeating the decoupled architecture. By modeling decay as a self-inflicted carve, the downstream workers can process \rea_delta_m2\ blindly with no special-case temporal logic.

### 3. Leaderboard Windows and Scopes
**Decision**: The leaderboard ranks players by total active territory area, utilizing the following time windows:
- **Daily**: Rolling 24 hours of signed area deltas.
- **Weekly**: Rolling 7 days of signed area deltas.
- **All-Time**: Sums *positive* deltas only, tracking the cumulative lifetime area a user has ever claimed.
**Rationale**: This ensures daily and weekly leaderboards reflect net active performance in the time window (naturally accounting for decay), while all-time acts as an ever-growing lifetime progression stat to reward long-term retention. 

### 4. Leaderboard Snapshots Schema
**Decision**: The \leaderboard_snapshots\ table will track the state using the following schema:
- \id\, \scope\, \window\, \user_id\, \score\, \ank\, \captured_at\
- Indexed on \(scope, window, captured_at)\
**Rationale**: This is the minimal footprint required to perfectly reconstruct Redis sorted sets (with tie-breaking handled by \captured_at\). 

### 5. Carved Territories
**Decision**: When a territory is partially carved by a new capture, its \expires_at\ timestamp is **unchanged**. Being attacked does not reset the clock on the surviving slivers.
**Rationale**: This keeps the decay timeline deterministic from the moment the territory was originally claimed, preventing edge cases where tiny interactions keep large areas immortal indefinitely.

### 6. Job Execution (Batching and Lock Ordering)
**Decision**: The decay job will process in batches of 500 rows, selecting candidate rows with \FOR UPDATE\ locking ordered by \id ASC\.
**Rationale**: Batching prevents the scheduled job from holding a single monolithic lock across the entire table, which would block real-time captures. Using \ORDER BY id ASC\ strictly enforces the identical lock ordering used in the \captureTerritory\ transaction, mathematically guaranteeing that the decay worker and the capture worker cannot deadlock against each other when operating on the same territories concurrently. 

## Consequences
- The nightly decay job will safely update the state of the database and append events to \capture_events\.
- Real-time leaderboard updates can remain completely ignorant of "time", purely adding incoming event deltas to Redis scores.
