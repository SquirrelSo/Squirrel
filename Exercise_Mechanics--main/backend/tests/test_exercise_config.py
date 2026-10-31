"""Fail-loud tests for the enabled-exercise configuration bundle."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml

from backend.engine.loader import (
    ConfigurationError,
    load_exercise_config,
    validate_enabled_exercises,
    validate_exercise_config,
)

_SQUAT_DIR = Path(__file__).resolve().parents[1] / "workouts" / "squat"
_FILES = ("templates.yaml", "switches.yaml", "fsm.yaml", "setup.yaml")


def _copy_config(tmp_path: Path) -> Path:
    target = tmp_path / "squat"
    (target / "configs").mkdir(parents=True)
    for name in _FILES:
        shutil.copyfile(_SQUAT_DIR / "configs" / name, target / "configs" / name)
    return target


def _mutate(directory: Path, filename: str, change) -> None:
    path = directory / "configs" / filename
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    change(data)
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")


def _templates(data: dict) -> dict[str, dict]:
    return {row["id"]: row for row in data["templates"]}


def test_real_squat_bundle_validates_and_exposes_decisions():
    bundle = validate_exercise_config("squat", _SQUAT_DIR)
    assert bundle.scoring["version"] == 9
    assert bundle.templates["depth"]["full_rom_gate"] == 0.85
    assert bundle.templates["depth"]["shallow_next_rep_cue_ms"] == 500
    assert bundle.fsm["min_rep_peak"] == 0.40
    assert bundle.templates["standing_posture"]["setup_policy"]["min_knee_extension_deg"] == 160
    assert bundle.contexts["pre_check"]["standing_posture"] is True
    assert bundle.contexts["live"]["standing_posture"] is False
    assert bundle.contexts["live"]["knee_valgus"] is True
    assert bundle.contexts["live"]["lateral_torso_lean"] is True
    knee_policy = bundle.templates["knee_valgus"]["policy"]
    assert knee_policy["mode"] == "baseline_relative"
    assert knee_policy["ranges"][1] == {
        "range": {"gt": 0.0, "lte": 0.005},
        "state": "warning",
        "skeleton_color": "green",
    }
    assert bundle.templates["knee_valgus"]["scoring"]["confirmed_fault"] == {
        "min_not_ok_ms": 250,
        "minimum_penalty": 0.30,
    }
    torso_policy = bundle.templates["lateral_torso_lean"]["policy"]
    assert torso_policy["mode"] == "baseline_relative_angle"
    assert torso_policy["ranges"][2] == {
        "range": {"gte": -3.0, "lte": 3.0},
        "state": "safe",
        "side": None,
        "skeleton_color": "green",
    }
    stance = bundle.templates["stance_width"]
    assert stance["active_phases"] == ["setup"]
    assert stance["scoring"] == {"role": "monitor"}
    assert stance["policy"]["ranges"][0] == {
        "range": {"lt": 0.70},
        "state": "not_ok",
        "skeleton_color": "red",
    }


def test_startup_fully_validates_only_enabled_exercises():
    assert tuple(bundle.slug for bundle in validate_enabled_exercises()) == (
        "squat",
        "bicep_curl",
        "high_knee",
        "pushup",
    )
    with pytest.raises(ConfigurationError, match="planned exercise"):
        load_exercise_config("plank")


def test_duplicate_template_id_fails(tmp_path: Path):
    directory = _copy_config(tmp_path)
    _mutate(directory, "templates.yaml", lambda data: data["templates"].append(dict(data["templates"][0])))
    with pytest.raises(ConfigurationError, match="duplicate template id"):
        validate_exercise_config("squat", directory)


def test_missing_scoring_version_fails(tmp_path: Path):
    directory = _copy_config(tmp_path)
    _mutate(directory, "templates.yaml", lambda data: data["scoring"].pop("version"))
    with pytest.raises(ConfigurationError, match="scoring.version"):
        validate_exercise_config("squat", directory)


def test_missing_shallow_next_rep_cue_duration_fails(tmp_path: Path):
    directory = _copy_config(tmp_path)
    _mutate(
        directory,
        "templates.yaml",
        lambda data: _templates(data)["depth"].pop("shallow_next_rep_cue_ms"),
    )
    with pytest.raises(ConfigurationError, match="depth.shallow_next_rep_cue_ms"):
        validate_exercise_config("squat", directory)


def test_unknown_required_keypoint_fails(tmp_path: Path):
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        _templates(data)["depth"]["required_keypoints"].append("left_wing")

    _mutate(directory, "templates.yaml", change)
    with pytest.raises(ConfigurationError, match="unknown keypoints"):
        validate_exercise_config("squat", directory)


def test_context_template_mismatch_fails(tmp_path: Path):
    directory = _copy_config(tmp_path)
    _mutate(directory, "switches.yaml", lambda data: data["contexts"]["live"].pop("depth"))
    with pytest.raises(ConfigurationError, match="template mismatch"):
        validate_exercise_config("squat", directory)


def test_placeholder_cannot_be_activated(tmp_path: Path):
    directory = _copy_config(tmp_path)

    def make_active_template_a_placeholder(data: dict) -> None:
        _templates(data)["lateral_torso_lean"]["tuning_status"] = "placeholder"

    _mutate(directory, "templates.yaml", make_active_template_a_placeholder)
    with pytest.raises(ConfigurationError, match="placeholder template 'lateral_torso_lean'"):
        validate_exercise_config("squat", directory)


def test_active_knee_valgus_requires_exact_baseline_relative_policy(tmp_path: Path):
    directory = _copy_config(tmp_path)

    def break_policy(data: dict) -> None:
        _templates(data)["knee_valgus"]["policy"]["mode"] = "universal_threshold"

    _mutate(directory, "templates.yaml", break_policy)
    with pytest.raises(ConfigurationError, match="mode: baseline_relative"):
        validate_exercise_config("squat", directory)


def test_active_lateral_torso_lean_requires_symmetric_baseline_relative_ranges(tmp_path: Path):
    directory = _copy_config(tmp_path)

    def make_asymmetric(data: dict) -> None:
        ranges = _templates(data)["lateral_torso_lean"]["policy"]["ranges"]
        ranges[-2]["range"]["gt"] = 3.1
        ranges[2]["range"]["lte"] = 3.1

    _mutate(directory, "templates.yaml", make_asymmetric)
    with pytest.raises(ConfigurationError, match="symmetric not_ok/warning/safe ranges"):
        validate_exercise_config("squat", directory)


def test_live_penalty_requires_weight(tmp_path: Path):
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        _templates(data)["knee_valgus"]["scoring"].pop("weight")

    _mutate(directory, "templates.yaml", change)
    with pytest.raises(ConfigurationError, match="scoring.weight must be numeric"):
        validate_exercise_config("squat", directory)


def test_confirmed_fault_minimum_penalty_cannot_exceed_rule_weight(tmp_path: Path):
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        _templates(data)["knee_valgus"]["scoring"]["confirmed_fault"][
            "minimum_penalty"
        ] = 0.60

    _mutate(directory, "templates.yaml", change)
    with pytest.raises(ConfigurationError, match="must be <= scoring.weight"):
        validate_exercise_config("squat", directory)


def test_scoring_evidence_phases_cannot_include_setup(tmp_path: Path):
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        _templates(data)["knee_valgus"]["scoring"]["evidence_phases"].insert(0, "setup")

    _mutate(directory, "templates.yaml", change)
    with pytest.raises(ConfigurationError, match="scoring.evidence_phases"):
        validate_exercise_config("squat", directory)


def test_rep_exercise_requires_exactly_one_live_rom_rule(tmp_path: Path):
    directory = _copy_config(tmp_path)
    _mutate(directory, "switches.yaml", lambda data: data["contexts"]["live"].update(depth=False))
    with pytest.raises(ConfigurationError, match="exactly one active live ROM"):
        validate_exercise_config("squat", directory)


def test_stance_policy_gap_fails(tmp_path: Path):
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        _templates(data)["stance_width"]["policy"]["ranges"][1]["range"]["gte"] = 0.71

    _mutate(directory, "templates.yaml", change)
    with pytest.raises(ConfigurationError, match="must share one boundary"):
        validate_exercise_config("squat", directory)


def test_stance_policy_state_color_mismatch_fails(tmp_path: Path):
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        _templates(data)["stance_width"]["policy"]["ranges"][0]["skeleton_color"] = "green"

    _mutate(directory, "templates.yaml", change)
    with pytest.raises(ConfigurationError, match="must use skeleton_color: red"):
        validate_exercise_config("squat", directory)


def test_missing_capture_duration_fails(tmp_path: Path):
    directory = _copy_config(tmp_path)
    _mutate(directory, "setup.yaml", lambda data: data["baseline"]["capture"].pop("duration_ms"))
    with pytest.raises(ConfigurationError, match="missing 'duration_ms'"):
        validate_exercise_config("squat", directory)


def test_setup_feature_flag_must_match_context_activation(tmp_path: Path):
    directory = _copy_config(tmp_path)
    _mutate(directory, "setup.yaml", lambda data: data["pre_check"].update(enabled=False))
    with pytest.raises(ConfigurationError, match="pre_check.enabled must match"):
        validate_exercise_config("squat", directory)


def test_setup_visibility_gate_covers_context_keypoints(tmp_path: Path):
    directory = _copy_config(tmp_path)
    _mutate(directory, "setup.yaml", lambda data: data["keypoints"].remove("left_ankle"))
    with pytest.raises(ConfigurationError, match="setup.keypoints missing pre_check requirements"):
        validate_exercise_config("squat", directory)


def test_invalid_fsm_threshold_order_fails(tmp_path: Path):
    directory = _copy_config(tmp_path)
    _mutate(directory, "fsm.yaml", lambda data: data.update(min_rep_peak=0.05))
    with pytest.raises(ConfigurationError, match="FSM progress thresholds"):
        validate_exercise_config("squat", directory)


def test_non_finite_tunable_fails(tmp_path: Path):
    directory = _copy_config(tmp_path)
    _mutate(directory, "fsm.yaml", lambda data: data.update(turnaround_ms=float("nan")))
    with pytest.raises(ConfigurationError, match="turnaround_ms must be finite"):
        validate_exercise_config("squat", directory)


def test_unknown_fsm_transition_condition_fails(tmp_path: Path):
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        data["transitions"][0]["when"] = "invented_condition"

    _mutate(directory, "fsm.yaml", change)
    with pytest.raises(ConfigurationError, match="when is not a supported condition"):
        validate_exercise_config("squat", directory)


def test_reset_cycle_transition_must_emit_rep_cycle_completed(tmp_path: Path):
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        transition = next(
            row
            for row in data["transitions"]
            if row["from"] == "reset" and row["when"] == "reset_dwell_elapsed"
        )
        transition.pop("emit")

    _mutate(directory, "fsm.yaml", change)
    with pytest.raises(ConfigurationError, match="must route reset to setup and emit"):
        validate_exercise_config("squat", directory)


def test_reset_tracking_recovery_must_restart_reset_dwell(tmp_path: Path):
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        transition = next(
            row
            for row in data["transitions"]
            if row["from"] == "reset" and row["when"] == "tracking_recovery_failed"
        )
        transition["to"] = "setup"

    _mutate(directory, "fsm.yaml", change)
    with pytest.raises(ConfigurationError, match="must restart the reset dwell"):
        validate_exercise_config("squat", directory)
