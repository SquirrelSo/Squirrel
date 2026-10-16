# ADR-024: GPS Recording & Persistence

## Context
RM-1.1 introduces local GPS acquisition and persistence. We must record a user's run even in the background and survive force-kills, without requesting ACCESS_BACKGROUND_LOCATION which requires additional Play Store justification. 

## Decisions

1. **No Background Location Permission**:
   We omit ACCESS_BACKGROUND_LOCATION. A foreground service (with oregroundServiceType="location") started while the app is visible allows continuous location updates in the background. A run always starts from an explicit user action on-screen, making the "while using the app" permission (ACCESS_FINE_LOCATION and ACCESS_COARSE_LOCATION) sufficient.

2. **Approximate Location Handling**:
   Android 12+ allows users to grant approximate location only. This is useless for tracking territory. The UI will detect this state, explain the requirement, and prevent recording from starting.

3. **Persist Raw Accepted Fixes**:
   We store exactly the fixes that pass :core's PointFilter. We do NOT store smoothed output. The KalmanSmoother is deterministic (ADR-022), so smoothed tracks can be recomputed dynamically. Rejected fixes are discarded, but the rejection count per RejectionReason is persisted on the run row to preserve mock-provider signals (ADR-021).

4. **Write-Through Persistence**:
   Each accepted fix is inserted into Room immediately as it arrives. There is no in-memory buffering. This guarantees zero point loss in the event of a force-kill. 

5. **Recovery Strategy**:
   If the app is force-killed, the service is destroyed. On the next launch, if a run is still marked RECORDING, the user is presented with a recovery screen offering to RESUME or FINISH. RESUME restarts the service and continues appending points (maintaining a strictly increasing seq). FINISH gracefully closes the run.

6. **Trace Stats Screen (Debug Only)**:
   A debug-only screen computes and displays metrics (accepted/rejected counts, accuracy percentiles, smoothed vs raw track lengths, RMS distance, speed CV, and auto-pause counts) without exporting any raw coordinates off-device. This fulfills the data needs for tuning ADR-001 (deferred) while respecting the absolute ban on exporting raw GPS data.

7. **Emulator Graphics Requirement**:
   Testing on the emulator requires setting Graphics Acceleration to **SOFTWARE**. Hardware acceleration renders the app as a black screen in the current setup.