"""High Knee package/config boundaries through the Phase 4 ROM milestone."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml

from backend.engine.loader import (
    ConfigurationError,
    load_exercise_config,
    validate_exercise_config,
)
from backend.training.replay import ReplayError
from backend.training.builders import (
    EXERCISE_BUILDERS,
    build_setup_adapter,
    build_training_adapter,
    validate_training_builders,
)
from backend.training.target_contract import TimeTarget
from backend.workouts.catalog import load_catalog
from backend.workouts.high_knee.adapter import (
    HighKneeAdapter,
    build_high_knee_adapter,
)
from backend.workouts.high_knee.replay_analysis import (
    analyze_high_knee_signals,
)
from backend.workouts.high_knee.rules.registry import (
    RULE_MODULES,
    active_live_rule_modules,
    rule_module,
)
from backend.workouts.high_knee.setup_adapter import (
    HighKneeSetupAdapter,
    build_high_knee_setup_adapter,
)

_PACKAGE = Path(__file__).resolve().parents[1] / "workouts" / "high_knee"
_RULE_IDS = (
    "knee_tracking_corridor",
    "lateral_torso_lean",
    "knee_drive_rom",
    "left_right_asymmetry",
)
_SETUP_KEYPOINTS = {
    "left_shoulder",
    "right_shoulder",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
}
_BASELINE = {
    "left_shoulder": {"x": 250.0, "y": 100.0},
    "right_shoulder": {"x": 150.0, "y": 100.0},
    "left_hip": {"x": 230.0, "y": 250.0},
    "right_hip": {"x": 170.0, "y": 250.0},
    "left_knee": {"x": 230.0, "y": 400.0},
    "right_knee": {"x": 170.0, "y": 400.0},
    "left_ankle": {"x": 230.0, "y": 550.0},
    "right_ankle": {"x": 170.0, "y": 550.0},
}


def _enable_live_rule(copied: Path, rule_id: str) -> None:
    """Turn a placeholder rule live in a copied package so the loader validates it.

    Both penalty rules ship disabled pending rig validation, and the loader only checks a rule's
    geometry/policy when it is live. These fail-closed tests re-enable the rule under test so the
    validation they assert still runs.
    """
    switches_path = copied / "configs/switches.yaml"
    document = yaml.safe_load(switches_path.read_text(encoding="utf-8"))
    document["contexts"]["live"][rule_id] = True
    switches_path.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")


def test_phase_two_package_contains_every_planned_boundary():
    required = {
        "__init__.py",
        "adapter.py",
        "lift_detector.py",
        "set_scorer.py",
        "setup_adapter.py",
        "replay_analysis.py",
        "configs/fsm.yaml",
        "configs/setup.yaml",
        "configs/switches.yaml",
        "configs/templates.yaml",
        "rules/__init__.py",
        "rules/registry.py",
        "rules/knee_drive_rom.py",
        "rules/knee_tracking_corridor.py",
        "rules/lateral_torso_lean.py",
        "rules/left_right_asymmetry.py",
        "rules/setup_readiness.py",
    }
    assert all((_PACKAGE / relative).is_file() for relative in required)
    assert not (_PACKAGE / "rules/cadence.py").exists()
    assert not (_PACKAGE / "rules/alternation.py").exists()


def test_live_config_enables_development_rules_rom_and_asymmetry_monitor():
    config = validate_exercise_config("high_knee", _PACKAGE)

    assert config.fsm["movement_type"] == "time"
    assert set(config.setup["keypoints"]) == _SETUP_KEYPOINTS
    assert config.setup["pre_check"]["enabled"] is True
    assert config.contexts["live"] == {
        # Both penalty rules are live for rig validation (thresholds still provisional); ROM drives
        # the score and the asymmetry monitor stays live (unscored).
        "knee_tracking_corridor": True,
        "lateral_torso_lean": True,
        "knee_drive_rom": True,
        "left_right_asymmetry": True,
        "setup_readiness": False,
    }
    assert config.contexts["pre_check"]["setup_readiness"] is True
    assert config.contexts["baseline_capture"]["setup_readiness"] is True
    ordered = tuple(
        rule_id
        for rule_id, _ in sorted(
            config.templates.items(), key=lambda item: item[1]["rank"]
        )
    )
    assert ordered == (*_RULE_IDS, "setup_readiness")
    assert config.templates["knee_tracking_corridor"]["tuning_status"] == "development"
    assert config.templates["lateral_torso_lean"]["tuning_status"] == "development"
    assert config.templates["knee_drive_rom"]["tuning_status"] == "development"
    assert config.templates["left_right_asymmetry"]["tuning_status"] == "development"
    assert config.templates["left_right_asymmetry"]["scoring"] == {"role": "monitor"}
    assert config.templates["setup_readiness"]["tuning_status"] == "development"
    assert "cadence" not in config.templates
    assert "alternation" not in config.templates


def test_rule_registry_matches_template_ids_and_keypoint_declarations():
    config = validate_exercise_config("high_knee", _PACKAGE)

    assert tuple(RULE_MODULES) == _RULE_IDS
    for rule_id in _RULE_IDS:
        module = rule_module(rule_id)
        assert module.RULE_ID == rule_id
        assert module.REQUIRED_KEYPOINTS == tuple(
            config.templates[rule_id]["required_keypoints"]
        )
    with pytest.raises(KeyError, match="no High Knee rule module"):
        rule_module("cadence")

    # All four development rules are constructed (both penalty rules now live for validation).
    active = active_live_rule_modules(config)
    assert tuple(active) == (
        "knee_tracking_corridor",
        "lateral_torso_lean",
        "knee_drive_rom",
        "left_right_asymmetry",
    )
    assert active["knee_tracking_corridor"] is rule_module("knee_tracking_corridor")
    assert active["lateral_torso_lean"] is rule_module("lateral_torso_lean")
    assert active["knee_drive_rom"] is rule_module("knee_drive_rom")
    assert active["left_right_asymmetry"] is rule_module("left_right_asymmetry")


def test_lateral_torso_lean_config_requires_geometry_floor(tmp_path):
    copied = tmp_path / "high_knee"
    shutil.copytree(_PACKAGE, copied)
    _enable_live_rule(copied, "lateral_torso_lean")
    templates_path = copied / "configs/templates.yaml"
    document = yaml.safe_load(templates_path.read_text(encoding="utf-8"))
    lean = next(
        template
        for template in document["templates"]
        if template["id"] == "lateral_torso_lean"
    )
    lean.pop("min_torso_length_px")
    templates_path.write_text(
        yaml.safe_dump(document, sort_keys=False),
        encoding="utf-8",
    )

    with pytest.raises(ConfigurationError, match="min_torso_length_px"):
        validate_exercise_config("high_knee", copied)


@pytest.mark.parametrize("field", ["min_shoulder_width_px", "min_torso_length_px"])
def test_knee_tracking_config_fails_closed_when_geometry_floor_is_missing(
    tmp_path,
    field,
):
    copied = tmp_path / "high_knee"
    shutil.copytree(_PACKAGE, copied)
    _enable_live_rule(copied, "knee_tracking_corridor")
    templates_path = copied / "configs/templates.yaml"
    document = yaml.safe_load(templates_path.read_text(encoding="utf-8"))
    tracking = next(
        template
        for template in document["templates"]
        if template["id"] == "knee_tracking_corridor"
    )
    tracking.pop(field)
    templates_path.write_text(
        yaml.safe_dump(document, sort_keys=False),
        encoding="utf-8",
    )

    with pytest.raises(ConfigurationError, match=field):
        validate_exercise_config("high_knee", copied)


def test_knee_tracking_config_rejects_wrong_signal_mode(tmp_path):
    copied = tmp_path / "high_knee"
    shutil.copytree(_PACKAGE, copied)
    _enable_live_rule(copied, "knee_tracking_corridor")
    templates_path = copied / "configs/templates.yaml"
    document = yaml.safe_load(templates_path.read_text(encoding="utf-8"))
    tracking = next(
        template
        for template in document["templates"]
        if template["id"] == "knee_tracking_corridor"
    )
    tracking["policy"]["mode"] = "wrong"
    templates_path.write_text(
        yaml.safe_dump(document, sort_keys=False),
        encoding="utf-8",
    )

    with pytest.raises(ConfigurationError, match="baseline_relative_lateral_drift"):
        validate_exercise_config("high_knee", copied)


@pytest.mark.parametrize("field", ["min_baseline_gap_px", "min_torso_length_px"])
def test_knee_drive_rom_config_fails_closed_when_geometry_floor_is_missing(
    tmp_path,
    field,
):
    copied = tmp_path / "high_knee"
    shutil.copytree(_PACKAGE, copied)
    templates_path = copied / "configs/templates.yaml"
    document = yaml.safe_load(templates_path.read_text(encoding="utf-8"))
    rom = next(
        template
        for template in document["templates"]
        if template["id"] == "knee_drive_rom"
    )
    rom.pop(field)
    templates_path.write_text(
        yaml.safe_dump(document, sort_keys=False),
        encoding="utf-8",
    )

    with pytest.raises(ConfigurationError, match=field):
        validate_exercise_config("high_knee", copied)


def test_setup_readiness_policy_fails_closed_when_incomplete(tmp_path):
    copied = tmp_path / "high_knee"
    shutil.copytree(_PACKAGE, copied)
    templates_path = copied / "configs/templates.yaml"
    document = yaml.safe_load(templates_path.read_text(encoding="utf-8"))
    setup = next(
        template
        for template in document["templates"]
        if template["id"] == "setup_readiness"
    )
    setup["setup_policy"].pop("min_torso_length_px")
    templates_path.write_text(
        yaml.safe_dump(document, sort_keys=False),
        encoding="utf-8",
    )

    with pytest.raises(ConfigurationError, match="exact setup geometry fields"):
        validate_exercise_config("high_knee", copied)


def test_high_knee_is_enabled_and_registered_for_normal_startup():
    entry = load_catalog().get("high_knee")
    assert entry is not None and entry.status == "enabled" and entry.view == "front"
    assert "high_knee" in EXERCISE_BUILDERS
    assert validate_training_builders() == ("bicep_curl", "high_knee", "pushup", "squat")
    assert load_exercise_config("high_knee").fsm["movement_type"] == "time"


def test_setup_phase_six_adapter_and_phase_seven_analyzer_boundaries_are_available():
    assert isinstance(
        build_high_knee_adapter(baseline=_BASELINE, target_duration_ms=1_000),
        HighKneeAdapter,
    )
    assert isinstance(build_high_knee_setup_adapter(), HighKneeSetupAdapter)
    with pytest.raises(ReplayError, match="timed high_knee capture"):
        analyze_high_knee_signals(None)


def test_normal_builders_construct_high_knee():
    assert isinstance(build_setup_adapter("high_knee"), HighKneeSetupAdapter)
    adapter = build_training_adapter(
        "high_knee",
        baseline=_BASELINE,
        target=TimeTarget("time", 1_000),
    )
    assert isinstance(adapter, HighKneeAdapter)
