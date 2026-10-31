"""Catalog lifecycle validation: enabled implementations versus lightweight planned entries."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.workouts.catalog import CatalogError, load_catalog, parse_catalog
from backend.workouts.router import list_exercises


def _write(path: Path, body: str) -> Path:
    path.write_text(body, encoding="utf-8")
    return path


def test_application_catalog_enables_completed_exercises():
    catalog = load_catalog()
    assert [entry.slug for entry in catalog.enabled()] == [
        "squat",
        "bicep_curl",
        "high_knee",
        "pushup",
    ]
    # Push-up is the first enabled SIDE-view exercise; the front-view exercises are unaffected.
    assert catalog.get("pushup").view == "side"
    assert catalog.get("squat").view == "front"
    assert catalog.get("bicep_curl").status == "enabled"
    assert catalog.get("high_knee").status == "enabled"
    assert catalog.get("plank").view == "side"


def test_catalog_api_exposes_lifecycle_metadata():
    response = list_exercises()
    by_id = {entry["id"]: entry for entry in response["exercises"]}
    assert by_id["squat"] == {"id": "squat", "view": "front", "status": "enabled"}
    assert by_id["bicep_curl"] == {"id": "bicep_curl", "view": "front", "status": "enabled"}
    assert by_id["high_knee"] == {
        "id": "high_knee",
        "view": "front",
        "status": "enabled",
    }


def test_planned_entry_does_not_require_implementation_directory(tmp_path):
    workouts = tmp_path / "workouts"
    (workouts / "squat").mkdir(parents=True)
    path = _write(tmp_path / "catalog.yaml", """
exercises:
  squat: {view: front, status: enabled}
  future_move: {view: side, status: planned}
""")
    catalog = parse_catalog(path, workouts)
    assert catalog.get("future_move").status == "planned"


def test_enabled_entry_requires_implementation_directory(tmp_path):
    path = _write(tmp_path / "catalog.yaml", """
exercises:
  missing_move: {view: front, status: enabled}
""")
    with pytest.raises(CatalogError, match="no implementation directory"):
        parse_catalog(path, tmp_path / "workouts")


@pytest.mark.parametrize(
    "entry, message",
    [
        ("Bad-Slug: {view: front, status: planned}", "invalid exercise slug"),
        ("squat: {view: rear, status: planned}", "invalid view"),
        ("squat: {view: front, status: live}", "invalid status"),
        ("squat: {view: front}", "missing fields"),
        ("squat: {view: front, status: planned, extra: true}", "unknown fields"),
    ],
)
def test_invalid_catalog_metadata_fails_loud(tmp_path, entry, message):
    path = _write(tmp_path / "catalog.yaml", f"exercises:\n  {entry}\n")
    with pytest.raises(CatalogError, match=message):
        parse_catalog(path, tmp_path / "workouts")
