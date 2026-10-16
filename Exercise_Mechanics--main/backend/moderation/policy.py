"""What can be reported, and how a report moves through review."""

from __future__ import annotations

CATEGORIES = {
    "harassment": "Harassment or inappropriate behaviour",
    "fake_profile": "Fake or suspicious profile",
    "inappropriate_content": "Inappropriate content",
    "spam": "Spam",
    "cheating": "Cheating or manipulated workout data",
    "other": "Other violation",
}

# open -> in_review -> resolved | dismissed. A closed report can be reopened.
STATUSES = ("open", "in_review", "resolved", "dismissed")
ACTIVE_STATUSES = ("open", "in_review")

# A report is about a member, or about one of their sessions (e.g. suspected manipulated data).
TARGET_TYPES = ("user", "session")

# Where in the app the report was made, so moderators have context.
SOURCES = ("profile", "partner_hunt", "activity_matching", "session", "other")

DESCRIPTION_MAX = 1000
NOTE_MAX = 1000
DAILY_LIMIT = 20  # reports one member can file in 24 hours
