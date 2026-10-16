"""Nearby discovery — BLE proximity between Squirrel Social users.

Phones do the Bluetooth work (advertise a rotating anonymous id, scan for others, measure RSSI).
The server only:
    • issues rotating BLE ids to authenticated, opted-in devices          (ble_ids.py)
    • resolves ids reported by scanners and scores repeated sightings      (proximity.py, engine.py)
    • keeps short-lived "nearby" relationships that expire on their own    (engine.py)
    • decides when a nearby notification is due, with anti-spam cooldowns (notifications.py)
    • persists only what a user explicitly chose: the opt-in setting and connections

Nothing about who-was-near-whom is written to disk; all proximity state is in memory and expires.
"""
