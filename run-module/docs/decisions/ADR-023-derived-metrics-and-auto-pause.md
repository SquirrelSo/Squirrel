# ADR-023: Derived Metrics and Auto-Pause

## Context
As specified in RM-1.4, the client must compute derived metrics (distance, elapsed time, moving time, speed) and implement auto-pause logic based on the smoothed GPS track.

## Decisions

1. **Display Only (Trust Boundary)**: These metrics are for client-side display only. The backend server recalculates authoritative distance, moving time, and elapsed time from the uploaded point stream (RM-5.1a). The client-submitted metrics are entirely ignored by the RM-1.5 upload endpoint, closing handoff debt #6.

2. **Backdated Pause**: Auto-pause triggers when the smoothed speed stays strictly below `0.5 m/s` for more than `10,000 ms`. When confirmed, the start of the pause is backdated to the exact moment the speed first dropped below the threshold. The pending distance accumulated during this evaluation window is discarded, and the pending time is reclassified from moving to paused.

3. **Resume Confirmation**: To prevent flapping when a runner hovers around `0.5 m/s`, the auto-resume requires the speed to stay at or above `0.5 m/s` for `3,000 ms`. Once confirmed, the resume is backdated to the start of the recovery period, and the pending distance and time are credited to the moving totals.

4. **Distance While Paused**: Segments that occur entirely within a paused interval (including the backdated window) contribute 0 metres to the moving distance.

5. **Gap Handling**: Any temporal gap strictly greater than the smoother's `gapResetMs` (30,000 ms) breaks continuity. The gap is evaluated by its implied average speed (`distance / dt`). If the implied speed is `>= 0.5 m/s` (e.g. going through a tunnel), it is added to the moving time and distance. If `< 0.5 m/s`, it is classified as paused time.

6. **Strict Thresholds**: Boundaries are evaluated strictly. Speed exactly `0.5 m/s` is considered high speed (moving). A low-speed duration of exactly `10,000 ms` is not enough to trigger a pause; it must exceed it.

7. **Auto-Pause Lag**:
   As a known consequence of the smoother's q = 0.005 setting, there is a significant lag in detecting pauses. In tests, measured moving time was 616 s against 600 s true. This is caused by smoother lag at q = 0.005 — pause detection latency is 31 s and resume is 6 s, adding roughly +16 s of moving time per stop. This will be retuned on real device data.