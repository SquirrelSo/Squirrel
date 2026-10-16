# ADR-020: Android Project Structure

## Context
The RUN App requires a mobile client to handle background location tracking, Kalman smoothing, and communication with the backend. The mobile client needs to be properly scaffolded before implementing features like point rejection, filtering, and GPS acquisition. 

## Decisions

1. **Android-Only Scope**: We are targeting Android ONLY. No Mac is available for iOS builds or verification, and deferring iOS prevents the introduction of unverified cross-platform abstraction layers. `mobile/ios/` remains intentionally empty.

2. **Two-Module Architecture**:
   - `:core`: A pure Kotlin/JVM module. This module contains algorithmic logic such as point rejection filtering, Kalman smoothing, and derived metrics. It has NO Android dependencies, ensuring that these complex algorithms can be verified using plain JUnit on any machine, without requiring an Android emulator or device.
   - `:app`: The Android application module containing the foreground service, location client, Room persistence, map, and UI. It depends on `:core`.

3. **minSdk 26**: The background-location and foreground-service APIs needed for location tracking are unreliable below SDK 26 (Android 8.0 Oreo). Therefore, the minimum supported SDK is set to 26 to ensure stable background tracking.

4. **UI Toolkit - Jetpack Compose**: We are using Jetpack Compose instead of XML for the UI. Compose is the modern, declarative standard for Android UI, and upcoming MapLibre integration and UI tickets will follow this paradigm.

5. **Local Network Alias (10.0.2.2)**: For local testing, the `BASE_URL` points to `http://10.0.2.2:3000`. The Android emulator uses `10.0.2.2` to route traffic to the host machine's `localhost`. It is important not to use `localhost` in the Android app, as that would resolve to the emulator itself.


6. **Edge-to-Edge Drawing and Window Insets**:
   On current Android versions (enforced in Android 15 / API 35+), apps are drawn edge-to-edge, meaning content extends behind the status bar and navigation bars. To ensure consistent behaviour and avoid content being hidden by system bars, enableEdgeToEdge() is explicitly called. Every future screen and layout must properly handle window insets (e.g., using safeDrawingPadding()) to keep interactive and readable content clear of system bars.