# Squirrel Social — Nearby Discovery (BLE)

> "Someone near you is on Squirrel Social 👀"

Phones discover each other over Bluetooth Low Energy. The cloud never touches a radio: it issues
anonymous rotating ids, scores repeated sightings, keeps short-lived "nearby" relationships and
decides when to notify.

| Piece | Where |
|---|---|
| Auth (register / login / refresh) | `Exercise_Mechanics--main/backend/auth/` |
| Rotating ids, proximity engine, nearby API, notifications | `Exercise_Mechanics--main/backend/nearby/` |
| `/join`, `/invite/{token}`, QR, Universal/App Link files | `Exercise_Mechanics--main/backend/deeplinks/` |
| Android BLE client (Kotlin) | `backup/mobile-nearby/nearby/android/` |
| iOS BLE client (Swift / CoreBluetooth) | `backup/mobile-nearby/nearby/ios/` |
| Mobile integration guide | [`backup/mobile-nearby/nearby/README.md`](../backup/mobile-nearby/nearby/README.md) |

---

## 1. End-to-end flow

```
Aanya: Settings → Privacy → Nearby Discovery = ON      PUT  /api/nearby/settings {enabled:true}
Phone opens a device session                            POST /api/proximity/session
   ← 8 rotating 16-byte BLE ids, one per 15-min window (2 h, so it keeps rotating offline)
Phone advertises SERVICE_UUID, serves current id via GATT; scans for SERVICE_UUID
Bilal's phone appears → one GATT read → his current id (cached until the next rotation)
Every later advertisement → sighting {id, time, RSSI} buffered on the phone
Every ~60 s (or when back online)                       POST /api/proximity/detection
Server: resolve id → account, check window, add to pair evidence
   3+ spaced sightings, ≥ 60 s dwell, median RSSI ≥ -75 dBm → nearby relationship created
   both users get a queued notification (subject to cooldowns)
Phone collects it and shows a local notification        POST /api/notifications/nearby
   "Someone near you is on Squirrel Social 👀" → squirrelsocial://nearby
Nearby screen                                           GET  /api/nearby
Connect                                                 POST /api/nearby/connect
No qualifying sighting for 15 min → relationship expires and is forgotten
```

## 2. BLE protocol

| | |
|---|---|
| Service UUID | `3c0b02ed-d244-4234-a411-8cdaf5812f97` |
| Id characteristic (read-only, no pairing) | `da2ec0af-a58d-4d28-aa65-ce93dfab8cbf` |
| Characteristic value | `[0x01 version][16 random bytes]` |
| Advertisement contents | the service UUID **only** — no name, no id, no TX power |
| Rotation | fixed wall-clock windows of 15 min, identical on every phone |

**Why a GATT read instead of putting the id in the advertisement?** iOS lets apps advertise only a
local name and service UUIDs — no service data or manufacturer data. A 128-bit UUID plus a 16-byte
id also does not fit in a 31-byte legacy advertisement. Reading the id over GATT (as
BlueTrace/OpenTrace did) works identically on both platforms. Scanners cache the id per Bluetooth
address until the next rotation boundary, so a peer that stays nearby costs one short connection
per 15 minutes; every other advertisement just yields an RSSI reading.

**Ids are random, not derived.** Each id is 16 bytes from a CSPRNG, stored server-side in memory
against the device session and window. Nobody but the server can link two ids, or an id to an
account, and the server forgets the mapping about 15 minutes after the window ends. Android restarts
its advertising set on every rotation so the OS picks a fresh random MAC at the same moment.

## 3. Proximity scoring

RSSI is approximate: walls, bodies, orientation and cases each shift it by 10 dB or more. Bands
are deliberately coarse:

| Band | Median RSSI | Rough distance |
|---|---|---|
| `very_close` | ≥ -60 dBm | 0–2 m |
| `nearby` | -61 … -75 dBm | 2–5 m |
| `far` | < -75 dBm | > 5 m — never confirms |

A relationship is **confirmed** only when, within a 5-minute evidence window:

- there are ≥ 3 sightings (sightings < 5 s apart from the same phone count once),
- the first and last are ≥ 60 s apart — someone walking past does not qualify, and
- the **median** RSSI is `nearby` or better, so one outlier packet cannot confirm or cancel it.

`confidence` (0–1) blends signal strength (40 %), sample count (20 %), dwell time (20 %) and whether
both phones saw each other (`mutual`, 20 %). All thresholds are in `backend/nearby/proximity.py`
and should be tuned with field data from real devices.

**Expiry:** each qualifying sighting pushes `expires_at` to `last_detected + 15 min`. When the
median drifts to `far`, the relationship stops being extended and lapses.

## 4. Privacy guarantees

| Requirement | How it is met |
|---|---|
| No PII over the air | Advertisement = service UUID only; GATT value = random bytes. |
| Rotating identifiers | New random id every 15 min, aligned with a fresh MAC on Android. |
| Opt-in | `nearby.json` defaults to `enabled: false`; every proximity endpoint returns 403 until the user turns it on. |
| Opt-out erases | Turning it OFF revokes all ids and sessions and deletes sightings, relationships, cooldowns and pending notifications involving the user, immediately. |
| No proximity history | Sightings, relationships and cooldowns live **only in memory** with TTLs. Nothing about who was near whom is written to disk (asserted by `test_no_proximity_history_is_written_to_disk`). Connections are stored without time or place. |
| No GPS | Nothing uses location. Android ≤ 11 makes apps hold a location permission to scan BLE at all; it is never read. Android 12+ uses `neverForLocation`. |
| No covert identification | Nearby cards are anonymous by default. A name is shown only when both are already connected, or when the sighting is **mutual** and the other person turned on `show_profile`. |
| No false claims | Notification copy never states direction ("on your right") or identity. Acquisition copy refers only to Squirrel users. |
| Anti-spam | Max one nearby notification per user every 20 min. The same person triggers at most one notification per 6 h. Pending notifications coalesce and go stale after 30 min. |
| Replay resistance | An id resolves only within its window ± 2 min, and sightings older than 15 min are dropped. A captured id cannot be replayed later. |

## 5. API reference

All `/api/*` routes except auth need `Authorization: Bearer <access_token>`.

### Auth
| Method | Path | Body → Response |
|---|---|---|
| POST | `/api/auth/register` | `{email, password (≥8), first_name, last_name}` → 201 token pair; 409 if the email exists |
| POST | `/api/auth/login` | `{email, password}` → token pair; 401 otherwise |
| POST | `/api/auth/refresh` | `{refresh_token}` → new pair. Refresh tokens are single-use and rotate. |

The token pair is `{user_id, access_token (15 min, HS256 JWT signed with `JWT_SECRET`, also accepted by the Run Module), refresh_token (30 days, opaque), *_expires_at}`. `user_id` is a UUID.

### Nearby Discovery
| Method | Path | Notes |
|---|---|---|
| GET/PUT | `/api/nearby/settings` | `{enabled, show_profile}`. Setting `enabled:false` erases the user's proximity state. |
| POST | `/api/proximity/session` | `{platform: ios\|android, device_session?}` → `{device_session, service_uuid, characteristic_uuid, payload_version, rotation_seconds, ble_ids:[{ble_id, valid_from, valid_until}]}`. Pass the existing `device_session` to extend it. |
| POST | `/api/proximity/detection` | `{device_session, detections:[{anonymous_device_token, timestamp, approximate_signal_strength}]}` (≤ 200) → `{accepted, ignored:{reason:n}, newly_confirmed}`. **409** means the session is gone: open a new one and re-upload. |
| POST | `/api/proximity/confirm` | `{device_session, anonymous_device_token}` → `{status: unknown\|pending\|confirmed, …}`. Never reveals who it is. |
| GET | `/api/nearby` | `{enabled, count, nearby:[{nearby_id, proximity, confidence, mutual, first_detected, last_detected, expires_at, connection_status, profile}]}` |
| POST | `/api/nearby/connect` | `{nearby_id}`. The first call records `requested`; when the other person also connects, both become `connected`. 404 if they are no longer nearby. |
| GET | `/api/connections` | People the user has connected with. |
| POST | `/api/notifications/nearby` | Returns and acknowledges the pending nearby notification (0 or 1). |

### Acquisition
| Method | Path | Behaviour |
|---|---|---|
| GET | `/join` | Android → Play Store, iPhone/iPod → App Store, anything else → landing page with the QR code. iPadOS is caught client-side. An installed app intercepts the URL via Universal/App Links. |
| GET | `/invite/{token}` | Same routing. Play gets `&referrer=utm_source=squirrel_invite&invite=<token>`, and the landing page says "<First L.> invited you". Unknown tokens behave like `/join`. |
| POST | `/api/invites` | → `{token, url, qr_svg_url, expires_at}` (30 days). The token is opaque and encodes nothing. |
| GET | `/join/qr.svg[?invite=]` | QR SVG for `/join` or the invite URL. |
| GET | `/join/poster` | Printable "SQUIRREL 🐿️ / Scan to join us / [QR] / Life unscrolled" poster. |
| GET | `/.well-known/apple-app-site-association`, `/.well-known/assetlinks.json` | Claim `/join`, `/invite/*`, `/nearby*` for the apps. |

## 6. Configuration

| Env var | Purpose |
|---|---|
| `JWT_SECRET` | **Required in production.** Signs access tokens; the same value as the Run Module's, so one sign-in serves both (`SQUIRREL_AUTH_SECRET` overrides it if set). Without either, a dev key is generated at `data/auth/secret.key`. |
| `SQUIRREL_PUBLIC_BASE_URL` | Public origin used in QR codes and invite links (default `https://squirrelsocial.app`). |
| `SQUIRREL_APP_STORE_URL`, `SQUIRREL_PLAY_STORE_URL` | Store listings. |
| `SQUIRREL_IOS_APP_IDS` | `TEAMID.bundle.id`, comma-separated, for the AASA file. |
| `SQUIRREL_ANDROID_PACKAGE`, `SQUIRREL_ANDROID_CERT_SHA256` | For `assetlinks.json`. |

## 7. Known limitations and next steps

- **iOS background ↔ iOS background.** When an iOS app is backgrounded, its service UUID moves to
  Apple's "overflow" area. Another iOS phone finds it only while scanning for that UUID with its
  screen on or the app in the foreground. Two locked iPhones in pockets usually won't discover each
  other. Pairs where one phone is Android, or one iPhone is in use, work. Treat this as a product
  constraint for the MVP; Apple's Exposure Notification API was the only full fix, and it isn't
  available for this use case.
- **Single process.** Proximity state is in memory and the Dockerfile runs one worker. To scale out,
  move `ProximityEngine` state to a shared TTL store (e.g. Redis) behind the same methods. A restart
  forgets all proximity state, which is safe: phones get 409 and open a new session.
- **Spoofed RSSI.** An authenticated user could report fake signal strength for an id they really
  received. Replays are bounded by the id window, and names need a mutual sighting. Per-session
  rate limits and server-side anomaly checks are the next hardening step.
- **Remote push.** Notifications are queued server-side and collected by the phone after each
  upload. The phone that saw the other is awake anyway, so no APNs/FCM keys are needed for the MVP.
  `notifications.PushSender` is the hook for APNs/FCM delivery to a peer that is not scanning.
- **Auth hardening.** Add login rate limiting, email verification and account deletion. Account
  deletion should also call `engine.forget_user`.
- **Directional discovery** ("the person on your right") is out of scope. It needs UWB (iPhone
  11+/some Android flagships), BLE direction finding (AoA/AoD hardware) or AR anchoring. It should
  also be a separate explicit opt-in.
- **Nearby UI.** The API supports the Nearby screen, cards and connect. The screens belong in the
  mobile app, which is not in this repository.

## 8. Success criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Two nearby users discover each other via BLE | Android + iOS clients (§2, §7 for the iOS background caveat) |
| 2 | Permanent identities not exposed over BLE | Random rotating ids, UUID-only adverts |
| 3 | Proximity confirmed reliably, no random notifications | Dwell + count + median RSSI + cooldowns; unit tested |
| 4 | Backend ties proximity events to authenticated users | Bearer auth + device sessions |
| 5 | Users receive a nearby notification | Server outbox → local notification on the phone |
| 6 | Nearby screen + connect | `GET /api/nearby`, `POST /api/nearby/connect` (UI in the mobile app) |
| 7 | Non-users directed to download | `/join`, landing page, store redirects |
| 8 | QR/deep-link flow on Android and iOS | QR → `/join` → store, or the app via Universal/App Links |
| 9 | Users can disable Nearby Discovery | `PUT /api/nearby/settings {enabled:false}` erases state |
| 10 | No permanent proximity history by default | In-memory TTL state only; tested |
