"""Profile-detail rules: derived values (age, BMI), consent gating and erasure, and onboarding.

Consent is decided from the append-only log and fails closed: if the log cannot be read, no
category counts as consented, so sensitive data is neither stored nor shown until it is readable.
Withdrawal is always accepted and erases that category's data.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timezone

from backend.profiles import store
from backend.profiles.store import HistoryUnreadable
from backend.profiles.vocab import ABOUT_YOU_AGE, CONSENT_CATEGORIES, MEASUREMENT_FIELDS, PHYSIQUE_MEASUREMENTS
from backend.auth import store as auth_store
from backend.users.store import create_user_record, delete_user_record, read_profile, read_skill, write_profile, write_skill

log = logging.getLogger(__name__)

# Which consent each section needs before it may be stored. Unlisted sections need none.
SECTION_CONSENT = {"physique": "physique", "habits": "habits"}


class ProfileError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message}


class InvalidFields(Exception):
    """A 422 on named request fields: [(field, code, message)], answered in the shape of FastAPI's
    own validation errors so a client reads both the same way."""
    def __init__(self, errors: list[tuple[str, str, str]]):
        super().__init__("; ".join(message for _, _, message in errors))
        self.errors = errors


# ---------------------------------------------------------------- derived values

def parse_date_of_birth(raw: object) -> date | None:
    if not isinstance(raw, str):
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def age_on(date_of_birth: date, today: date) -> int:
    before_birthday = (today.month, today.day) < (date_of_birth.month, date_of_birth.day)
    return today.year - date_of_birth.year - before_birthday


def bmi(height_cm: float, weight_kg: float) -> float:
    return round(weight_kg / (height_cm / 100) ** 2, 1)


def _when(raw: object) -> datetime:
    """Sort key for a measurement timestamp; anything unparseable sorts first (oldest)."""
    try:
        moment = datetime.fromisoformat(str(raw))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def latest_values(measurements: list[dict]) -> dict[str, tuple[float, str]]:
    """field -> (value, measured_at) for the most recent reading of EACH field independently.

    Height is rarely re-entered, so BMI pairs the latest height with the latest weight rather than
    requiring both in one reading. Ties on measured_at go to the later entry in the history."""
    latest: dict[str, tuple[float, str]] = {}
    ordered = sorted(enumerate(measurements), key=lambda item: (_when(item[1].get("measured_at")), item[0]))
    for _, reading in ordered:
        for field in MEASUREMENT_FIELDS:
            value = reading.get(field)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                latest[field] = (float(value), str(reading.get("measured_at")))
    return latest


# ---------------------------------------------------------------- consent

def consent_state(events: list[dict]) -> dict[str, dict | None]:
    """The latest event per category (the log is append-only, so the last one wins)."""
    state: dict[str, dict | None] = {category: None for category in CONSENT_CATEGORIES}
    for event in events:
        category = event.get("category")
        if category in state:
            state[category] = {
                "granted": event.get("granted") is True,
                "policy_version": event.get("policy_version"),
                "recorded_at": event.get("recorded_at"),
            }
    return state


def current_consents(user_id: str) -> dict[str, dict | None]:
    _require_user(user_id)
    try:
        return consent_state(store.read_consent_events(user_id))
    except HistoryUnreadable as exc:
        raise ProfileError(503, "consents_unreadable", "Consent settings can't be read right now.") from exc


def _granted_categories(user_id: str) -> frozenset[str] | None:
    """Granted categories, or None when the consent log cannot be read."""
    try:
        state = consent_state(store.read_consent_events(user_id))
    except HistoryUnreadable:
        log.error("consent log unreadable for %s; treating every category as not consented", user_id)
        return None
    return frozenset(category for category, event in state.items() if event and event["granted"])


def _require_consent(user_id: str, category: str) -> None:
    granted = _granted_categories(user_id)
    if granted is None:
        raise ProfileError(503, "consents_unreadable",
                           "Your consent settings can't be read right now, so this wasn't saved.")
    if category not in granted:
        raise ProfileError(403, "consent_required",
                           f"Turn on consent for '{category}' before saving these details.")


def record_consent(user_id: str, category: str, granted: bool, policy_version: str,
                   *, now: datetime | None = None) -> dict:
    """Append a consent decision. Withdrawal is recorded first, so the data is hidden at once,
    and then erased."""
    _require_user(user_id)
    event = {
        "category": category,
        "granted": granted,
        "policy_version": policy_version,
        "recorded_at": (now or datetime.now(timezone.utc)).isoformat(),
    }
    try:
        events = store.append_consent_event(user_id, event)
    except HistoryUnreadable as exc:
        raise ProfileError(503, "consents_unreadable",
                           "Your consent settings can't be read right now; nothing was changed.") from exc
    if not granted:
        _erase_category(user_id, category)
    return consent_state(events)


def _erase_category(user_id: str, category: str) -> None:
    for section, needed in SECTION_CONSENT.items():
        if needed == category:
            store.erase_section(user_id, section)
    if category == "physique":
        try:
            readings = store.read_measurements(user_id)
        except HistoryUnreadable as exc:
            # Consent is already withdrawn, so these are hidden everywhere; say plainly that the
            # stored copy could not be removed rather than reporting a clean erasure.
            raise ProfileError(500, "erasure_incomplete",
                               "Consent was withdrawn, but stored body measurements could not be "
                               "erased yet. They are hidden and will not be used.") from exc
        kept = []
        for reading in readings:
            stripped = {k: v for k, v in reading.items() if k not in PHYSIQUE_MEASUREMENTS}
            if any(field in stripped for field in MEASUREMENT_FIELDS):
                kept.append(stripped)
        if kept != readings:
            store.write_measurements(user_id, kept)


# ---------------------------------------------------------------- sections

def _require_user(user_id: str) -> dict:
    profile = read_profile(user_id)
    if profile is None:
        raise ProfileError(404, "user_not_found", "No such user.")
    return profile


def save_fitness(user_id: str, fitness: dict) -> dict:
    """Fitness level goes to skill.json (the dashboard's source of truth); the rest to fitness.json."""
    _require_user(user_id)
    write_skill(user_id, fitness["fitness_level"])
    store.write_section(user_id, "fitness", {k: v for k, v in fitness.items() if k != "fitness_level"})
    return _fitness_view(user_id)


def save_section(user_id: str, section: str, value: dict | list) -> dict | list:
    _require_user(user_id)
    if section in SECTION_CONSENT:
        _require_consent(user_id, SECTION_CONSENT[section])
    store.write_section(user_id, section, value)
    return value


def add_measurement(user_id: str, reading: dict, *, now: datetime | None = None) -> dict:
    """Append one reading. Body-fat and waist are physique data and need that consent."""
    profile = _require_user(user_id)
    if any(reading.get(field) is not None for field in PHYSIQUE_MEASUREMENTS):
        _require_consent(user_id, "physique")
    moment = reading.get("measured_at") or now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    record = {
        "id": uuid.uuid4().hex[:12],
        "measured_at": moment.astimezone(timezone.utc).isoformat(),
        "source": reading["source"],
        **{field: reading[field] for field in MEASUREMENT_FIELDS if reading.get(field) is not None},
    }
    try:
        history = _history_with_onboarding_values(user_id, profile)
    except HistoryUnreadable as exc:
        raise ProfileError(500, "measurements_unreadable",
                           "Stored measurements can't be read, so nothing was added.") from exc
    store.write_measurements(user_id, history + [record])
    return record


def _history_with_onboarding_values(user_id: str, profile: dict) -> list[dict]:
    """Stored readings. A user created before measurement history existed has none; their
    onboarding height and weight become the first reading, so a new weight never drops the
    height that BMI needs."""
    history = store.read_measurements(user_id)
    if history or store.has_measurement_history(user_id):
        return history
    seed = {field: profile.get(field) for field in ("height_cm", "weight_kg")
            if isinstance(profile.get(field), (int, float)) and not isinstance(profile.get(field), bool)}
    if not seed:
        return []
    return [{"id": "onboarding", "measured_at": profile.get("created_at"), "source": "self_reported", **seed}]


def list_measurements(user_id: str) -> list[dict]:
    """Newest first. Physique readings are left out unless physique consent is granted."""
    profile = _require_user(user_id)
    try:
        history = _history_with_onboarding_values(user_id, profile)
    except HistoryUnreadable as exc:
        raise ProfileError(500, "measurements_unreadable", "Stored measurements can't be read.") from exc
    granted = _granted_categories(user_id) or frozenset()
    out = []
    for reading in history:
        if "physique" not in granted:
            reading = {k: v for k, v in reading.items() if k not in PHYSIQUE_MEASUREMENTS}
        if any(field in reading for field in MEASUREMENT_FIELDS):
            out.append(reading)
    return sorted(out, key=lambda r: _when(r.get("measured_at")), reverse=True)


# ---------------------------------------------------------------- read models

def _fitness_view(user_id: str) -> dict:
    level, configured = read_skill(user_id)
    saved = store.read_section(user_id, "fitness") or {}
    return {
        "fitness_level": level,
        "fitness_level_set": configured,
        "activity_level": saved.get("activity_level"),
        "primary_goal": saved.get("primary_goal"),
    }


def details(user_id: str, *, today: date | None = None) -> dict:
    """Everything asked at sign-up, with age and BMI derived. Sensitive sections are shown only
    while their consent is granted."""
    profile = _require_user(user_id)
    today = today or date.today()
    dob = parse_date_of_birth(profile.get("date_of_birth"))

    try:
        consents = consent_state(store.read_consent_events(user_id))
        consents_readable = True
    except HistoryUnreadable:
        log.error("consent log unreadable for %s; hiding every consented section", user_id)
        consents = {category: None for category in CONSENT_CATEGORIES}
        consents_readable = False
    granted = {category for category, event in consents.items() if event and event["granted"]}

    try:
        latest = latest_values(_history_with_onboarding_values(user_id, profile))
    except HistoryUnreadable:
        log.error("measurements unreadable for %s; body values unavailable", user_id)
        latest = {}
    height = latest.get("height_cm")
    weight = latest.get("weight_kg")

    physique = None
    if "physique" in granted:
        saved = store.read_section(user_id, "physique") or {}
        body_fat = latest.get("body_fat_pct")
        waist = latest.get("waist_cm")
        physique = {
            "body_type": saved.get("body_type"),
            "body_fat_pct": body_fat[0] if body_fat else None,
            "body_fat_measured_at": body_fat[1] if body_fat else None,
            "waist_cm": waist[0] if waist else None,
            "waist_measured_at": waist[1] if waist else None,
        }
    habits = store.read_section(user_id, "habits") if "habits" in granted else None
    activities = store.read_section(user_id, "activities")
    fitness = _fitness_view(user_id)

    return {
        "user_id": user_id,
        "date_of_birth": dob.isoformat() if dob else None,
        "age": age_on(dob, today) if dob else None,
        "gender": profile.get("gender"),
        "fitness": fitness,
        "activities": activities or [],
        "body": {
            "height_cm": height[0] if height else None,
            "height_measured_at": height[1] if height else None,
            "weight_kg": weight[0] if weight else None,
            "weight_measured_at": weight[1] if weight else None,
            "bmi": bmi(height[0], weight[0]) if height and weight else None,
        },
        "physique": physique,
        "habits": habits,
        "consents": consents,
        "consents_readable": consents_readable,
        # What has been answered, so the client knows what is still worth asking.
        "answered": {
            "fitness": fitness["fitness_level_set"],
            "activities": activities is not None,
            "physique": bool(physique and physique["body_type"]),
            "habits": habits is not None,
        },
    }


def profile_with_latest_body(user_id: str) -> dict | None:
    """profile.json with height and weight replaced by the latest readings, so the dashboard's BMI
    follows logged measurements. Falls back to the onboarding values if history can't be read."""
    profile = read_profile(user_id)
    if profile is None:
        return None
    try:
        latest = latest_values(_history_with_onboarding_values(user_id, profile))
    except HistoryUnreadable:
        return profile
    for field in ("height_cm", "weight_kg"):
        if field in latest:
            profile[field] = latest[field][0]
    return profile


# ---------------------------------------------------------------- onboarding

CORE_PROFILE_FIELDS = ("gender", "height_cm", "weight_kg", "date_of_birth", "mobile")


def onboard(core: dict, *, password: str | None = None, now: datetime | None = None,
            email_verified: bool = False) -> dict:
    """Sign-up page 1: create the user, with their height and weight as the first measurement.

    With a password this creates a sign-in account (auth.store; the id is a UUID). Without one,
    only the legacy password-less user the browser coach creates while auth is switched off.
    All or nothing: if the measurement can't be written, the half-created user is removed.
    Raises auth.store.EmailTaken when the email already has an account."""
    now = now or datetime.now(timezone.utc)
    if password is None:
        identity = create_user_record(core)
    else:
        extra = {k: v for k, v in core.items() if k not in ("first_name", "last_name", "email")}
        user_id = auth_store.register_account(core["email"], password, core["first_name"], core["last_name"], extra,
                                              email_verified=email_verified)
        identity = {"user_id": user_id, "first_name": core["first_name"], "last_name": core["last_name"]}
    user_id = identity["user_id"]
    try:
        profile = read_profile(user_id) or {}
        store.write_measurements(user_id, [{
            "id": "onboarding",
            "measured_at": profile.get("created_at") or now.isoformat(),
            "source": "self_reported",
            "height_cm": core["height_cm"],
            "weight_kg": core["weight_kg"],
        }])
    except BaseException:
        if password is None:
            delete_user_record(user_id)
        else:
            auth_store.delete_account(core["email"], user_id)
        raise
    return identity


def complete_profile(user_id: str, fields: dict, *, now: datetime | None = None) -> dict:
    """Save the page-1 details (gender, height, weight, date of birth, mobile, and optionally the
    name) onto an existing account, e.g. one registered from the app with only email and name.
    Height and weight also become a measurement, so BMI and history use them."""
    profile = _require_user(user_id)
    # The reading first: it seeds history from the profile as it was, so it isn't logged twice.
    if fields.get("height_cm") is not None or fields.get("weight_kg") is not None:
        add_measurement(user_id, {"source": "self_reported", "height_cm": fields.get("height_cm"),
                                  "weight_kg": fields.get("weight_kg")}, now=now)
    write_profile(user_id, {**profile, **{k: v for k, v in fields.items() if v is not None}})
    return profile_with_latest_body(user_id)


def save_sign_up_details(user_id: str, sections: dict, consents: list[dict], *,
                         now: datetime | None = None) -> dict:
    """Sign-up page 2: save every answered section and the consent decisions in one request.

    A sensitive section needs its consent, granted in this request or earlier (and not withdrawn
    in this request). Every check runs before anything is written, so a refused request changes
    nothing. Sections left out are left as they were, so the page can be resubmitted safely."""
    _require_user(user_id)
    decided = {c["category"]: c["granted"] for c in consents}
    needs_log = bool(consents) or any(
        sections.get(section) is not None and category not in decided
        for section, category in SECTION_CONSENT.items()
    )
    granted = _granted_categories(user_id) if needs_log else frozenset()
    if granted is None:
        raise ProfileError(503, "consents_unreadable",
                           "Your consent settings can't be read right now, so nothing was saved.")
    for section, category in SECTION_CONSENT.items():
        if sections.get(section) is None:
            continue
        if not decided.get(category, category in granted):
            raise ProfileError(403, "consent_required",
                               f"'{section}' can only be saved with consent for '{category}'.")

    for consent in consents:
        record_consent(user_id, consent["category"], consent["granted"], consent["policy_version"], now=now)
    if sections.get("fitness") is not None:
        save_fitness(user_id, sections["fitness"])
    for section in ("activities", "physique", "habits"):
        if sections.get(section) is not None:
            save_section(user_id, section, sections[section])
    return details(user_id)


# ---------------------------------------------------------------- "About you" (the app's profile details)

# The app's form, read and written as one object (ADR-032: Exercise is the home of private details).
# Each field has one source: full_name is first_name + last_name, phone is mobile, gender is gender,
# date_of_birth is the profile's (age is derived from it, never stored) and college_email is the
# sign-in address (read-only here); only personal_email, course and CGPA are stored for this form
# (store.write_personal_details).

def full_name(profile: dict) -> str | None:
    parts = (profile.get("first_name") or "", profile.get("last_name") or "")
    return " ".join(" ".join(parts).split()) or None


def split_full_name(name: str) -> tuple[str, str]:
    """First name up to the first space, last name the rest. A one-word name is all first name with
    an empty last name, as an account made by code sign-in without a last name already has."""
    first, _, last = " ".join(name.split()).partition(" ")
    return first, last


def profile_details(user_id: str, *, today: date | None = None) -> dict:
    """The form as saved. Before its first save it is still answered, with what the account already
    knows and null for the rest (personal_email, course, cgpa; and anything never given, such as a
    date of birth and so age), so the app can prefill the form."""
    profile = _require_user(user_id)
    saved = store.read_personal_details(user_id) or {}
    dob = parse_date_of_birth(profile.get("date_of_birth"))
    return {
        "full_name": full_name(profile),
        "personal_email": saved.get("personal_email"),
        "college_email": profile.get("email"),
        "phone": profile.get("mobile"),
        "gender": profile.get("gender"),
        "date_of_birth": dob.isoformat() if dob else None,
        "age": age_on(dob, today or date.today()) if dob else None,
        "course": saved.get("course"),
        "cgpa": saved.get("cgpa"),
    }


def save_profile_details(user_id: str, details: dict, *, today: date | None = None) -> dict:
    """Replace the form (the app always sends all of it). Raises InvalidFields, changing nothing, when
    there is no date of birth (sent or on file), it gives an age outside 16–99, a sent age disagrees
    with it, or the college email isn't the sign-in address."""
    profile = _require_user(user_id)
    errors = []
    if details["college_email"] != (profile.get("email") or "").lower():
        errors.append(("college_email", "college_email_read_only",
                       "college_email is the address you sign in with and can't be changed here"))
    elif details["personal_email"] == details["college_email"]:
        errors.append(("personal_email", "personal_email_same_as_college",
                       "use a personal address, different from your college email"))
    # Age is never stored, so it can't go stale: it comes from the date of birth, sent here or on file.
    dob = parse_date_of_birth(details.get("date_of_birth") or profile.get("date_of_birth"))
    derived_age = age_on(dob, today or date.today()) if dob else None
    if dob is None:
        errors.append(("date_of_birth", "date_of_birth_required", "enter your date of birth"))
    elif not ABOUT_YOU_AGE[0] <= derived_age <= ABOUT_YOU_AGE[1]:
        errors.append(("date_of_birth", "age_out_of_range",
                       f"you must be {ABOUT_YOU_AGE[0]}–{ABOUT_YOU_AGE[1]} to use Squirrel"))
    elif details.get("age") is not None and derived_age != details["age"]:
        errors.append(("age", "age_mismatch", f"age comes from your date of birth, which makes you "
                                              f"{derived_age}; change your date of birth to change it"))
    if errors:
        raise InvalidFields(errors)

    first, last = split_full_name(details["full_name"])
    if details["full_name"] == full_name(profile):  # unchanged: keep how the name was split before
        first, last = profile.get("first_name") or "", profile.get("last_name") or ""
    store.write_personal_details(user_id, details)
    write_profile(user_id, {**profile, "first_name": first, "last_name": last, "mobile": details["phone"],
                            "gender": details["gender"], "date_of_birth": dob.isoformat()})
    return profile_details(user_id, today=today)
