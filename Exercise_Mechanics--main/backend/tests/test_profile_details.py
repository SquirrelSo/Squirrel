"""The app's "About you" form on its one home (ADR-032): GET/PUT /api/me/profile-details.

Each field has one source: the name, mobile, gender and date of birth (age) from the account's
profile, the sign-in email as college_email; only personal_email, course and CGPA are stored for it.
Runs on files or, with TEST_ACCOUNTS_DATABASE_URL, on PostgreSQL (conftest.py).
"""

from __future__ import annotations

from datetime import date

import pytest

from backend import config
from backend.profiles.service import age_on
from backend.tests.asgi_client import call

# main.py mounts the built web app; a fresh checkout that hasn't run `npm run build` has no folder.
(config._REPO_ROOT / "frontend-dist").mkdir(exist_ok=True)
from backend.main import app  # noqa: E402

URL = "/api/me/profile-details"
DOB = "1994-05-10"
_PAGE_ONE = {"first_name": "Ana", "last_name": "Tester", "gender": "female", "height_cm": 165,
             "weight_kg": 60, "date_of_birth": DOB, "mobile": "9990001111", "password": "correct horse"}


def _age() -> int:
    return age_on(date.fromisoformat(DOB), date.today())


def _form(**changes) -> dict:
    return {"full_name": "Ana Tester", "personal_email": "ana.personal@gmail.test",
            "college_email": "ana@iiser.ac.in", "phone": "+919876543210", "gender": "non_binary",
            "date_of_birth": DOB, "age": _age(), "course": "BS-MS", "cgpa": 8.42, **changes}


@pytest.fixture(autouse=True)
def _users(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path / "users")


def _bearer(token: str) -> dict:
    return {"authorization": f"Bearer {token}"}


def _sign_up(email: str = "ana@iiser.ac.in", **changes) -> tuple[str, dict]:
    res = call(app, "POST", "/api/users", json={**_PAGE_ONE, "email": email, **changes})
    assert res.status == 200, res.body
    return res.json()["user_id"], _bearer(res.json()["access_token"])


def _profile(uid: str, auth: dict) -> dict:
    return call(app, "GET", f"/api/users/{uid}", headers=auth).json()


def test_before_the_first_save_it_answers_with_what_the_account_knows():
    _, auth = _sign_up(email="Ana@IISER.ac.in")
    res = call(app, "GET", URL, headers=auth)
    assert res.status == 200, res.body
    assert res.json() == {"full_name": "Ana Tester", "personal_email": None, "college_email": "ana@iiser.ac.in",
                          "phone": "9990001111", "gender": "female", "date_of_birth": DOB, "age": _age(),
                          "course": None, "cgpa": None}


def test_the_form_round_trips_and_lands_on_the_account_fields():
    uid, auth = _sign_up()
    saved = call(app, "PUT", URL, json=_form(personal_email="  Ana.Personal@Gmail.test "), headers=auth)
    assert saved.status == 200, saved.body
    assert saved.json() == _form()
    assert call(app, "GET", URL, headers=auth).json() == _form()
    # One source per field: the name, phone and gender are the account's own.
    profile = _profile(uid, auth)
    assert (profile["first_name"], profile["last_name"]) == ("Ana", "Tester")
    assert profile["mobile"] == "+919876543210" and profile["gender"] == "non_binary"
    assert profile["date_of_birth"] == DOB and "age" not in profile and "course" not in profile
    # Saved again with CGPA left out: the whole form is replaced, so it is cleared.
    again = {k: v for k, v in _form(course="PhD").items() if k != "cgpa"}
    assert call(app, "PUT", URL, json=again, headers=auth).json() == {**again, "cgpa": None}


@pytest.mark.parametrize("field, value", [
    ("phone", "9876543210"),          # not E.164
    ("phone", "+15551234567"),        # not an Indian mobile
    ("phone", "+91 98765 43210"),
    ("phone", "+915876543210"),       # Indian mobiles start 6-9
    ("cgpa", 10.5),
    ("cgpa", -0.1),
    ("cgpa", 8.123),                  # at most 2 decimals
    ("personal_email", "ana.gmail.test"),
    ("personal_email", "ana@gmail"),
    ("college_email", "ana@"),
    ("gender", "other"),              # Exercise's own vocabulary has it; the form doesn't offer it
    ("gender", "robot"),
    ("age", 15),
    ("age", 100),
    ("full_name", "A"),
    ("full_name", "12345"),
    ("full_name", "x" * 61),
    ("course", "  "),
    ("course", "c" * 61),
])
def test_invalid_answers_are_refused_and_change_nothing(field, value):
    uid, auth = _sign_up()
    before = call(app, "GET", URL, headers=auth).json()
    res = call(app, "PUT", URL, json=_form(**{field: value}), headers=auth)
    assert res.status == 422, (field, value, res.body)
    assert [error["loc"][-1] for error in res.json()["detail"]] == [field]
    assert call(app, "GET", URL, headers=auth).json() == before


def test_unknown_or_missing_fields_are_refused():
    _, auth = _sign_up()
    assert call(app, "PUT", URL, json=_form(date_of_birth="2000-01-01"), headers=auth).status == 422
    missing = {k: v for k, v in _form().items() if k != "course"}
    assert call(app, "PUT", URL, json=missing, headers=auth).status == 422


def test_the_personal_email_must_differ_from_the_college_one():
    _, auth = _sign_up()
    res = call(app, "PUT", URL, json=_form(personal_email="ANA@iiser.ac.in"), headers=auth)
    assert res.status == 422
    assert [(e["loc"], e["type"]) for e in res.json()["detail"]] == [(["body", "personal_email"],
                                                                      "personal_email_same_as_college")]


def test_age_comes_from_the_date_of_birth_and_a_different_one_is_refused():
    _, auth = _sign_up()
    res = call(app, "PUT", URL, json=_form(age=_age() + 1), headers=auth)
    assert res.status == 422
    [error] = res.json()["detail"]
    assert error["loc"] == ["body", "age"] and error["type"] == "age_mismatch"
    assert "date of birth" in error["msg"] and str(_age()) in error["msg"]
    assert call(app, "GET", URL, headers=auth).json()["personal_email"] is None  # nothing saved


def test_the_college_email_is_the_sign_in_address_and_cannot_be_changed_here():
    uid, auth = _sign_up()
    res = call(app, "PUT", URL, json=_form(college_email="someone.else@iiser.ac.in"), headers=auth)
    assert res.status == 422
    [error] = res.json()["detail"]
    assert error["loc"] == ["body", "college_email"] and error["type"] == "college_email_read_only"
    assert _profile(uid, auth)["email"] == "ana@iiser.ac.in"
    # The same address in another case or with spaces is the same address.
    assert call(app, "PUT", URL, json=_form(college_email=" ANA@iiser.ac.in "), headers=auth).status == 200


def test_without_a_date_of_birth_on_file_the_form_must_send_one():
    # An app account (code or password sign-in with a name only) has no date of birth, gender or mobile.
    account = call(app, "POST", "/api/auth/register", json={
        "email": "cara@iiser.ac.in", "password": "correct horse", "first_name": "Cara", "last_name": "App"}).json()
    auth = _bearer(account["access_token"])
    assert call(app, "GET", URL, headers=auth).json() == {
        "full_name": "Cara App", "personal_email": None, "college_email": "cara@iiser.ac.in", "phone": None,
        "gender": None, "date_of_birth": None, "age": None, "course": None, "cgpa": None}
    form = _form(full_name="Cara App", college_email="cara@iiser.ac.in")

    # An age alone is not enough: it would go stale, and it is never stored.
    missing = call(app, "PUT", URL, json={**form, "date_of_birth": None}, headers=auth)
    assert missing.status == 422 and missing.json()["detail"][0]["type"] == "date_of_birth_required"
    too_young = call(app, "PUT", URL, json={**form, "date_of_birth": f"{date.today().year - 10}-01-01", "age": None}, headers=auth)
    assert too_young.status == 422 and too_young.json()["detail"][0]["type"] == "age_out_of_range"
    assert call(app, "GET", URL, headers=auth).json()["date_of_birth"] is None  # a refused save changes nothing

    saved = call(app, "PUT", URL, json={**form, "age": None}, headers=auth)
    assert saved.status == 200, saved.body
    assert saved.json() == form  # the age comes back, derived from the date of birth now on file
    assert _profile(account["user_id"], auth)["date_of_birth"] == DOB


def test_another_users_token_reaches_only_their_own_details():
    ana_id, ana = _sign_up()
    _, bob = _sign_up(email="bob@iiser.ac.in", first_name="Bob")
    assert call(app, "PUT", URL, json=_form(), headers=ana).status == 200
    assert call(app, "GET", URL, headers=bob).json()["college_email"] == "bob@iiser.ac.in"
    assert call(app, "GET", URL, headers=bob).json()["personal_email"] is None
    # Bob can't write Ana's form: the user is the token's, and her sign-in address isn't his.
    hijack = call(app, "PUT", URL, json=_form(phone="+919000000000"), headers=bob)
    assert hijack.status == 422 and hijack.json()["detail"][0]["type"] == "college_email_read_only"
    assert call(app, "GET", URL, headers=ana).json() == _form()
    assert _profile(ana_id, ana)["mobile"] == "+919876543210"


@pytest.mark.parametrize("auth_switch", [None, "0"])
def test_without_a_valid_token_it_is_401_even_with_sign_in_switched_off(auth_switch, monkeypatch):
    _, auth = _sign_up()
    if auth_switch is not None:
        monkeypatch.setenv(config.REQUIRE_AUTH_ENV, auth_switch)
    for headers in ({}, {"authorization": "Bearer not-a-token"}, {"authorization": auth["authorization"][7:]}):
        assert call(app, "GET", URL, headers=headers).status == 401
        assert call(app, "PUT", URL, json=_form(), headers=headers).status == 401
    assert call(app, "GET", URL, headers=auth).json()["personal_email"] is None


@pytest.mark.parametrize("full_name, first, last", [
    ("Ana Maria Tester", "Ana", "Maria Tester"),  # split on the first space
    ("  Ana   Maria  Tester ", "Ana", "Maria Tester"),
    ("Ana", "Ana", ""),                           # one word: all first name, no last name
])
def test_the_full_name_is_split_on_the_first_space(full_name, first, last):
    uid, auth = _sign_up()
    saved = call(app, "PUT", URL, json=_form(full_name=full_name), headers=auth)
    assert saved.status == 200, saved.body
    assert saved.json()["full_name"] == " ".join(full_name.split())
    profile = _profile(uid, auth)
    assert (profile["first_name"], profile["last_name"]) == (first, last)


def test_an_unchanged_full_name_keeps_how_it_was_split():
    uid, auth = _sign_up(first_name="Mary Ann", last_name="Smith")
    assert call(app, "GET", URL, headers=auth).json()["full_name"] == "Mary Ann Smith"
    assert call(app, "PUT", URL, json=_form(full_name="Mary Ann Smith"), headers=auth).status == 200
    profile = _profile(uid, auth)
    assert (profile["first_name"], profile["last_name"]) == ("Mary Ann", "Smith")
