"""Fail-loud tests for the double-arm bicep curl configuration bundle.

Mirrors tests/test_exercise_config.py (squat) so every enabled exercise has the same validation
safety net. Bicep curl is still catalog-`planned`, so these drive the low-level
``validate_exercise_config`` directly rather than through the enabled-exercise loader.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml

from backend.engine.loader import ConfigurationError, validate_exercise_config
from backend.workouts.bicep_curl.rules.registry import active_live_rule_modules

_CURL_DIR = Path(__file__).resolve().parents[1] / "workouts" / "bicep_curl"
_FILES = ("templates.yaml", "switches.yaml", "fsm.yaml", "setup.yaml")


def _copy_config(tmp_path: Path) -> Path:
    target = tmp_path / "bicep_curl"
    (target / "configs").mkdir(parents=True)
    for name in _FILES:
        shutil.copyfile(_CURL_DIR / "configs" / name, target / "configs" / name)
    return target


def _mutate(directory: Path, filename: str, change) -> None:
    path = directory / "configs" / filename
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    change(data)
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")


def _templates(data: dict) -> dict[str, dict]:
    return {row["id"]: row for row in data["templates"]}


# --------------------------------------------------------------------------- positive

def test_real_bicep_curl_bundle_validates_and_exposes_decisions():
    bundle = validate_exercise_config("bicep_curl", _CURL_DIR)
    assert bundle.fsm["phases"] == ["setup", "ascent", "top", "descent", "reset"]
    assert bundle.fsm["initial_phase"] == "setup"
    assert set(bundle.templates) == {
        "elbow_flare_corridor",
        "lateral_torso_lean",
        "shoulder_elevation",
        "curl_rom",
        "stance_width",
        "arms_extended",
    }
    flare = bundle.templates["elbow_flare_corridor"]
    assert flare["rank"] == 1
    assert flare["tier"] == "high"
    assert flare["tuning_status"] == "development"
    assert flare["scoring"]["role"] == "penalty"
    assert flare["scoring"]["weight"] == 0.50
    assert flare["policy"]["mode"] == "baseline_relative_elbow_outward_offset"
    lean = bundle.templates["lateral_torso_lean"]
    assert lean["rank"] == 3
    assert lean["tier"] == "high"
    assert lean["tuning_status"] == "development"
    assert lean["scoring"] == {
        "role": "penalty",
        "weight": 0.30,
        "evidence_phases": ["ascent", "top", "descent"],
    }
    assert lean["policy"]["mode"] == "baseline_relative_angle"
    rom = bundle.templates["curl_rom"]
    assert rom["scoring"]["role"] == "rom" and rom["scoring"]["mode"] == "rom"
    assert rom["target_offset"] == 0.0 and rom["min_upper_arm_px"] == 30
    assert rom["tuning_status"] == "development"  # corrected body-relative signal needs a rig
    # Shoulders only: the hips are often out of frame when curling close to the camera.
    assert rom["required_keypoints"] == ["left_shoulder", "right_shoulder"]
    assert rom["full_rom_gate"] == 0.75
    assert rom["active_phases"] == ["ascent", "top", "descent"]
    # Stance and arms-extended run ONLY in the pre-check gate: not during the baseline capture
    # (which records keypoints + per-joint median only) and never live.
    assert bundle.templates["stance_width"]["scoring"] == {"role": "monitor"}
    assert bundle.templates["arms_extended"]["setup_policy"]["min_elbow_extension_deg"] == 150
    # Feet position has no bearing on a curl: the stance check is off, only the arms are checked.
    assert bundle.contexts["pre_check"]["stance_width"] is False
    assert bundle.contexts["pre_check"]["arms_extended"] is True
    for setup_only in ("stance_width", "arms_extended"):
        assert bundle.contexts["baseline_capture"][setup_only] is False
        assert bundle.contexts["live"][setup_only] is False
    shoulder = bundle.templates["shoulder_elevation"]
    assert shoulder["rank"] == 4
    assert shoulder["tuning_status"] == "development"
    assert shoulder["scoring"]["role"] == "penalty"
    assert shoulder["policy"]["mode"] == "baseline_relative_rise_curl_corrected"
    assert shoulder["curl_height_slope"] == 0.040
    assert {"left_wrist", "right_wrist"}.issubset(shoulder["required_keypoints"])
    assert bundle.contexts["live"]["shoulder_elevation"] is True
    assert bundle.contexts["live"]["curl_rom"] is True
    assert bundle.contexts["live"]["elbow_flare_corridor"] is True
    assert bundle.contexts["live"]["lateral_torso_lean"] is True
    # NOTE: this tuple is switches.yaml declaration order, NOT rank order. Cue priority is decided
    # separately by `rank` in CueSelector; do not read preemption order out of this.
    assert tuple(active_live_rule_modules(bundle)) == (
        "elbow_flare_corridor",
        "lateral_torso_lean",
        "shoulder_elevation",
        "curl_rom",
    )
    assert [bundle.templates[r]["rank"] for r in ("elbow_flare_corridor", "curl_rom",
                                                 "lateral_torso_lean", "shoulder_elevation")] == [1, 2, 3, 4]
    # Three severity tiers only. `pre_check` marks templates that run in the pre-check gate and
    # is not a severity — named to match the switches.yaml context key, and deliberately NOT
    # "setup", which is already an FSM phase name.
    assert {t["tier"] for t in bundle.templates.values()} == {"high", "medium", "low", "pre_check"}
    # A baseline is still captured (keypoints + median) even with no capture-condition templates.
    assert bundle.setup["baseline"]["required"] is True


def test_baseline_capture_records_median_without_condition_templates(tmp_path):
    """The baseline capture gates on keypoints + stillness only; no condition templates run."""
    from backend.training.setup_config import build_setup_config

    bundle = validate_exercise_config("bicep_curl", _CURL_DIR)
    setup = build_setup_config(bundle)
    assert setup.baseline_capture_templates == ()
    assert setup.baseline_required is True
    assert setup.pre_check_templates == ("arms_extended",)


def test_capture_condition_without_required_baseline_rejected(tmp_path):
    """A baseline_capture condition template implies the baseline is required."""
    directory = _copy_config(tmp_path)
    _mutate(
        directory,
        "switches.yaml",
        lambda data: data["contexts"]["baseline_capture"].update(stance_width=True),
    )
    _mutate(directory, "setup.yaml", lambda data: data["baseline"].update(required=False))
    with pytest.raises(ConfigurationError, match="setup.baseline.required"):
        validate_exercise_config("bicep_curl", directory)


def test_arms_extended_angle_at_or_above_180_rejected(tmp_path):
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        for row in data["templates"]:
            if row["id"] == "arms_extended":
                row["setup_policy"]["min_elbow_extension_deg"] = 180

    _mutate(directory, "templates.yaml", change)
    with pytest.raises(ConfigurationError, match="min_elbow_extension_deg must be below 180"):
        validate_exercise_config("bicep_curl", directory)


def test_setup_reference_keypoints_cover_both_arms():
    bundle = validate_exercise_config("bicep_curl", _CURL_DIR)
    for side in ("left", "right"):
        for joint in ("shoulder", "elbow", "wrist"):
            assert f"{side}_{joint}" in bundle.setup["keypoints"]
        assert f"{side}_hip" in bundle.setup["keypoints"]
        assert f"{side}_ankle" in bundle.setup["keypoints"]


def test_elbow_flare_policy_requires_positive_ordered_one_sided_bands(tmp_path):
    directory = _copy_config(tmp_path)
    _mutate(
        directory,
        "switches.yaml",
        lambda data: data["contexts"]["live"].update(elbow_flare_corridor=True),
    )

    def change(data: dict) -> None:
        flare = _templates(data)["elbow_flare_corridor"]
        flare["policy"]["ranges"][0]["state"] = "warning"

    _mutate(directory, "templates.yaml", change)
    with pytest.raises(ConfigurationError, match="must order safe, warning and not_ok"):
        validate_exercise_config("bicep_curl", directory)


def test_elbow_flare_rejects_wrong_mode_and_non_positive_geometry_floor(tmp_path):
    directory = _copy_config(tmp_path)
    _mutate(
        directory,
        "switches.yaml",
        lambda data: data["contexts"]["live"].update(elbow_flare_corridor=True),
    )

    def wrong_mode(data: dict) -> None:
        _templates(data)["elbow_flare_corridor"]["policy"]["mode"] = "absolute_x"

    _mutate(directory, "templates.yaml", wrong_mode)
    with pytest.raises(ConfigurationError, match="baseline_relative_elbow_outward_offset"):
        validate_exercise_config("bicep_curl", directory)

    directory = _copy_config(tmp_path / "floor")
    _mutate(
        directory,
        "switches.yaml",
        lambda data: data["contexts"]["live"].update(elbow_flare_corridor=True),
    )

    def bad_floor(data: dict) -> None:
        _templates(data)["elbow_flare_corridor"]["min_shoulder_width_px"] = 0

    _mutate(directory, "templates.yaml", bad_floor)
    with pytest.raises(ConfigurationError, match="min_shoulder_width_px"):
        validate_exercise_config("bicep_curl", directory)


def test_lateral_torso_lean_rejects_wrong_mode_and_asymmetric_ranges(tmp_path):
    directory = _copy_config(tmp_path)
    _mutate(
        directory,
        "switches.yaml",
        lambda data: data["contexts"]["live"].update(lateral_torso_lean=True),
    )

    def wrong_mode(data: dict) -> None:
        _templates(data)["lateral_torso_lean"]["policy"]["mode"] = "absolute_angle"

    _mutate(directory, "templates.yaml", wrong_mode)
    with pytest.raises(ConfigurationError, match="baseline_relative_angle"):
        validate_exercise_config("bicep_curl", directory)

    directory = _copy_config(tmp_path / "ranges")
    _mutate(
        directory,
        "switches.yaml",
        lambda data: data["contexts"]["live"].update(lateral_torso_lean=True),
    )

    def asymmetric(data: dict) -> None:
        ranges = _templates(data)["lateral_torso_lean"]["policy"]["ranges"]
        ranges[3]["range"]["lte"] = 6.0
        ranges[4]["range"]["gt"] = 6.0

    _mutate(directory, "templates.yaml", asymmetric)
    with pytest.raises(ConfigurationError, match="symmetric not_ok/warning/safe ranges"):
        validate_exercise_config("bicep_curl", directory)


# ------------------------------------------------------------- curl-specific negatives

def test_implausible_target_offset_rejected(tmp_path):
    """The target is measured in upper-arm lengths around the shoulder; a wrist target metres
    below the shoulder is a units mistake, not a curl."""
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        _templates(data)  # touch for symmetry
        for row in data["templates"]:
            if row["id"] == "curl_rom":
                row["target_offset"] = 2.0

    _mutate(directory, "templates.yaml", change)
    with pytest.raises(ConfigurationError, match="curl_rom.target_offset"):
        validate_exercise_config("bicep_curl", directory)


def test_non_positive_min_upper_arm_rejected(tmp_path):
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        for row in data["templates"]:
            if row["id"] == "curl_rom":
                row["min_upper_arm_px"] = 0

    _mutate(directory, "templates.yaml", change)
    with pytest.raises(ConfigurationError, match="curl_rom.min_upper_arm_px"):
        validate_exercise_config("bicep_curl", directory)


def test_min_rep_peak_at_or_above_the_gate_rejected(tmp_path):
    """A rep that cannot be an attempt without already being full leaves no shallow band."""
    directory = _copy_config(tmp_path)
    _mutate(directory, "fsm.yaml", lambda data: data.update(min_rep_peak=0.75))
    with pytest.raises(ConfigurationError, match="min_rep_peak must be below"):
        validate_exercise_config("bicep_curl", directory)


def test_squat_phase_name_in_active_phases_rejected(tmp_path):
    """A curl template cannot reference a phase absent from curl's fsm.yaml (e.g. squat 'bottom')."""
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        for row in data["templates"]:
            if row["id"] == "curl_rom":
                row["active_phases"] = ["ascent", "bottom", "descent"]

    _mutate(directory, "templates.yaml", change)
    with pytest.raises(ConfigurationError, match="active_phases"):
        validate_exercise_config("bicep_curl", directory)


def test_evidence_phase_outside_movement_rejected(tmp_path):
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        for row in data["templates"]:
            if row["id"] == "curl_rom":
                row["scoring"]["evidence_phases"] = ["ascent", "setup"]

    _mutate(directory, "templates.yaml", change)
    with pytest.raises(ConfigurationError, match="evidence_phases"):
        validate_exercise_config("bicep_curl", directory)


def test_disabling_live_rom_rejected(tmp_path):
    """A rep exercise must keep exactly one live ROM template."""
    directory = _copy_config(tmp_path)
    _mutate(
        directory,
        "switches.yaml",
        lambda data: data["contexts"]["live"].update(curl_rom=False),
    )
    with pytest.raises(ConfigurationError, match="exactly one active live ROM template"):
        validate_exercise_config("bicep_curl", directory)


def test_initial_phase_must_be_setup(tmp_path):
    directory = _copy_config(tmp_path)
    _mutate(directory, "fsm.yaml", lambda data: data.update(initial_phase="ascent"))
    with pytest.raises(ConfigurationError, match="initial_phase must be 'setup'"):
        validate_exercise_config("bicep_curl", directory)


def test_missing_movement_phase_rejected(tmp_path):
    """A phase list of only lifecycle phases has no movement phase to score."""
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        data["phases"] = ["setup", "reset"]

    _mutate(directory, "fsm.yaml", change)
    with pytest.raises(ConfigurationError):
        validate_exercise_config("bicep_curl", directory)


def test_duplicate_completion_transition_rejected(tmp_path):
    directory = _copy_config(tmp_path)

    def change(data: dict) -> None:
        data["transitions"].append(
            {
                "from": "top",
                "to": "reset",
                "when": "top_returned",
                "action": "complete_attempt",
                "emit": "attempt_completed",
            }
        )

    _mutate(directory, "fsm.yaml", change)
    with pytest.raises(ConfigurationError):
        validate_exercise_config("bicep_curl", directory)
