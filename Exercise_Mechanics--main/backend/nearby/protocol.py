"""Wire constants shared with the mobile clients (mirrored in backup/mobile-nearby/nearby/*).

BLE layout (see backup/mobile-nearby/nearby/README.md):
    • Advertisement: the Squirrel SERVICE_UUID only. iOS cannot advertise service/manufacturer data,
      so no identifier is ever placed in the advertisement itself.
    • GATT: SERVICE_UUID exposes one read-only characteristic, BLE_ID_CHARACTERISTIC_UUID, whose value
      is `[PAYLOAD_VERSION][16-byte rotating BLE id]`. No pairing / bonding.
"""

SERVICE_UUID                 = "3c0b02ed-d244-4234-a411-8cdaf5812f97"
BLE_ID_CHARACTERISTIC_UUID   = "da2ec0af-a58d-4d28-aa65-ce93dfab8cbf"
PAYLOAD_VERSION              = 1
BLE_ID_BYTES                 = 16

# Rotation: ids are aligned to fixed windows of ROTATION_SECONDS; a session request pre-issues the
# current window plus the following ones so a phone can keep rotating while briefly offline.
ROTATION_SECONDS             = 15 * 60
IDS_PER_ISSUE                = 8          # 2 hours of rotation
SESSION_TTL_SECONDS          = 24 * 3600

# Detection acceptance. Uploads may be delayed (phone offline), but anything older than a
# relationship's lifetime can no longer matter, so it is dropped rather than stored.
CLOCK_SKEW_SECONDS           = 2 * 60
MAX_DETECTION_AGE_SECONDS    = 15 * 60
MAX_DETECTIONS_PER_UPLOAD    = 200
