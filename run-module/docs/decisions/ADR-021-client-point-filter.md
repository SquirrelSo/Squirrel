# ADR-021: Client Point Filter

## Context
As specified in RM-1.2, the mobile client requires a GPS point rejection filter to proactively discard low-quality or impossible GPS fixes before they are persisted or uploaded. 

## Decisions

1. **Data Quality, Not Security**: This filter exists solely for data quality and client-side track cleanliness. It is NOT an anti-cheat measure. A malicious user controls the device and can bypass or disable this filter. The backend's anti-cheat layers (ADR-007) re-enforce every bound evaluated here, assuming this filter never ran.

2. **Threshold Parity**: The default bounds for accuracy (> 20 m) and implied speed (> 12 m/s) match the backend's server-side bounds exactly. This ensures the client and server agree on what constitutes a "bad" point. Boundaries are evaluated inclusively for acceptance (e.g., exactly 20.0 m is accepted).

3. **Stale and Future Definitions**: 
   - **Stale**: A point is stale if `receivedAtMs - recordedAt > 10,000 ms`, preventing cached "last-known" fixes from fused location providers from corrupting a live track. A point is also out-of-order if its `recordedAt` is less than or equal to the last accepted point's `recordedAt`.
   - **Future Timestamp**: A point is rejected if `recordedAt > receivedAtMs + 5,000 ms` to handle device clocks that are running ahead of reality.

4. **Reference Bug Prevention**: Implied speed is ALWAYS measured against the *last accepted point*, never the last received point. If the filter used the last received point, a single rejected teleporting fix would incorrectly become the reference point for the next legitimate fix, causing a cascade of rejections.

5. **Evaluation Order**: 
   First failure wins. The order is:
   1. `INVALID_COORDINATES`
   2. `MOCK_PROVIDER`
   3. `INVALID_ACCURACY`
   4. `LOW_ACCURACY`
   5. `FUTURE_TIMESTAMP`
   6. `STALE`
   7. `OUT_OF_ORDER`
   8. `IMPLIED_SPEED`
   *Note: Mock provider checks precede accuracy checks because a mock point is intrinsically untrustworthy and must be labeled as mock regardless of how accurate it claims to be.*

6. **Mock Provider Tension**: 
   The spec requires dropping mock points. However, ADR-008's platform layer relies on receiving the `is_mock` flag to detect spoofing. Silently discarding these points on the client hides the primary signal the server trusts. 
   **Resolution**: This ticket introduces tracking for rejection reasons. Every rejection returns a machine-readable reason, and the `PointFilter` maintains a counter for each reason. Reporting these counts to the server is deferred to RM-1.6 (upload).
