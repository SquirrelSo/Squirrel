"""Shared workout policy — every timing, limit and vocabulary the feature decides on, in one place."""

from __future__ import annotations

# A race lasts exactly one of these, chosen when the session is created. The duration is also the
# race's maximum length: ends_at = starts_at + duration, so a race can never run on.
DURATIONS_S = (60, 180, 300)

# An unstarted lobby closes this long after it was created.
LOBBY_TTL_S = 10 * 60

# Once both players are ready, the race starts this long later, so both phones count down together.
COUNTDOWN_S = 3

# Rep reports (and Finish) arriving this long after ends_at still count. Hand taps are throttled to
# one report every 500 ms, so the last ones are often in flight when time runs out. They change the
# result shown, not the XP: that is settled when the race finishes (see XP below).
REPS_GRACE_S = 5

# "connected": a socket is open, or the player made a request this recently.
CONNECTED_WINDOW_S = 10
# During the countdown or the race, this long with neither ends that player's race.
DISCONNECT_AFTER_S = 30

MAX_REPS = 2000
MAX_SEQ = 2**31 - 1

# Plausibility: a running total above this many reps per second of race time so far (plus a little
# slack for the first taps) is refused (422 implausible_reps). Nobody does four push-ups a second.
PLAUSIBLE_REPS_PER_S = 4
PLAUSIBLE_REPS_SLACK = 5

# Rep reports per user per second (429 rate_limited beyond it). The app throttles to two a second.
REPS_RATE_PER_S = 5

# Invitations from the host to their Partner Hunt connections (buddies): this many still waiting
# per session at once.
MAX_PENDING_INVITES = 3

# XP: a flat shared_workout_finished award (xp_awards.py) to each player who finished the race (did
# not leave before the end) and reported at least one rep. Never per rep; the Run Module caps it at
# three a day. Settled once per session, when the race reaches `finished`.

# Races nobody looks at any more (both apps closed) are settled by a background sweep this often.
COMPLETION_SWEEP_S = 30

# Rep exercises a race can be run on: the app's rep-measured library entries (keys as the app sends
# them). Timed exercises (high knees, plank) can't be a rep race.
EXERCISES = {
    "squat": "Squat",
    "bicep_curl_single": "Single Arm Bicep Curl",
    "bicep_curl_double": "Double Arm Bicep Curl",
    "pushup": "Push-up",
    "lunge": "Lunges",
}

# Hand-tapped in this version. Camera-counted reps (and XP for them) come later.
REP_SOURCE = "hand_tapped"

# Invite codes: 8 characters without look-alikes (no 0/O, 1/I/L).
INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
INVITE_LENGTH = 8

# Finished sessions are deleted this long after they close (they hold names and photos).
KEEP_CLOSED_S = 7 * 24 * 3600
