"""Profile-detail REST routes (the sign-up questions, readable and editable afterwards).

    GET  /api/activity-types                       the activity catalogue
    GET  /api/users/{id}/details                   everything answered, with age and BMI derived
    PUT  /api/users/{id}/details                   sign-up page 2: any sections + consents at once
    PUT  /api/users/{id}/details/fitness           fitness level, activity level, goal
    PUT  /api/users/{id}/details/activities        declared activities
    PUT  /api/users/{id}/details/physique          body type                (needs physique consent)
    PUT  /api/users/{id}/details/habits            schedule, sleep, diet, … (needs habits consent)
    GET  /api/users/{id}/measurements              measurement history, newest first
    POST /api/users/{id}/measurements              log a reading (body-fat/waist need physique consent)
    GET  /api/users/{id}/consents                  current decision per category
    POST /api/users/{id}/consents                  grant or withdraw; withdrawing erases that data
    GET  /api/me/profile-details                   the app's "About you" form, for the signed-in user
    PUT  /api/me/profile-details                   save it (the whole form)

The /api/me routes take the user from the bearer token, which they always need (even with sign-in
switched off for development): private details are never addressed by id.

Sign-up page 1 (name, date of birth, contact, height, weight) stays POST /api/users
(backend/users/router.py); page 2 is PUT /api/users/{id}/details.
Errors carry a machine-readable `code` in `detail`.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.exceptions import RequestValidationError

from backend.auth.deps import current_user
from backend.core.ids import is_valid_user_id
from backend.profiles import service
from backend.profiles.models import (
    ActivitiesAnswers,
    ConsentDecision,
    FitnessAnswers,
    HabitsAnswers,
    MeasurementIn,
    PhysiqueAnswers,
    ProfileDetailsIn,
    SignUpDetails,
)
from backend.profiles.vocab import ACTIVITY_TYPES

router = APIRouter(prefix="/api")


def _checked(user_id: str) -> str:
    # Strict: never substitute an anonymous id — writing someone's health answers into a shared
    # "_anonymous" directory would be worse than refusing.
    if not is_valid_user_id(user_id):
        raise HTTPException(status_code=400, detail={"code": "invalid_user_id", "message": "Invalid user id."})
    return user_id


def _call(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except service.ProfileError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail()) from exc


@router.get("/activity-types")
def list_activity_types() -> dict:
    return {"activity_types": [a.to_dict() for a in ACTIVITY_TYPES]}


@router.get("/users/{user_id}/details")
def get_details(user_id: str) -> dict:
    return _call(service.details, _checked(user_id))


@router.put("/users/{user_id}/details")
def put_sign_up_details(user_id: str, body: SignUpDetails) -> dict:
    return _call(service.save_sign_up_details, _checked(user_id), body.sections(),
                 [c.model_dump() for c in body.consents])


@router.put("/users/{user_id}/details/fitness")
def put_fitness(user_id: str, body: FitnessAnswers) -> dict:
    return _call(service.save_fitness, _checked(user_id), body.model_dump())


@router.put("/users/{user_id}/details/activities")
def put_activities(user_id: str, body: ActivitiesAnswers) -> dict:
    saved = _call(service.save_section, _checked(user_id), "activities",
                  [a.model_dump() for a in body.activities])
    return {"activities": saved}


@router.put("/users/{user_id}/details/physique")
def put_physique(user_id: str, body: PhysiqueAnswers) -> dict:
    return _call(service.save_section, _checked(user_id), "physique", body.model_dump())


@router.put("/users/{user_id}/details/habits")
def put_habits(user_id: str, body: HabitsAnswers) -> dict:
    return _call(service.save_section, _checked(user_id), "habits", body.model_dump())


@router.get("/users/{user_id}/measurements")
def get_measurements(user_id: str) -> dict:
    return {"measurements": _call(service.list_measurements, _checked(user_id))}


@router.post("/users/{user_id}/measurements", status_code=201)
def post_measurement(user_id: str, body: MeasurementIn) -> dict:
    return _call(service.add_measurement, _checked(user_id), body.model_dump())


@router.get("/users/{user_id}/consents")
def get_consents(user_id: str) -> dict:
    return {"consents": _call(service.current_consents, _checked(user_id))}


@router.post("/users/{user_id}/consents")
def post_consent(user_id: str, body: ConsentDecision) -> dict:
    return {"consents": _call(service.record_consent, _checked(user_id),
                              body.category, body.granted, body.policy_version)}


@router.get("/me/profile-details")
def get_profile_details(user_id: str = Depends(current_user)) -> dict:
    return _call(service.profile_details, user_id)


@router.put("/me/profile-details")
def put_profile_details(body: ProfileDetailsIn, user_id: str = Depends(current_user)) -> dict:
    try:
        return _call(service.save_profile_details, user_id, body.model_dump())
    except service.InvalidFields as exc:
        raise RequestValidationError([{"type": code, "loc": ("body", field), "msg": message}
                                      for field, code, message in exc.errors]) from None
