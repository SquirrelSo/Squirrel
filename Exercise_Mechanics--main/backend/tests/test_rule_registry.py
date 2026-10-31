"""Squat live-rule registry and disabled-placeholder safety tests."""

from __future__ import annotations

from dataclasses import replace

import pytest

from backend.engine.loader import load_exercise_config
from backend.workouts.squat.rules.registry import (
    LIVE_RULE_MODULES,
    active_live_rule_modules,
    live_rule_module,
    not_live_ready_rule_ids,
)


def test_every_live_capable_squat_template_has_an_explicit_module():
    config = load_exercise_config("squat")
    expected = {
        template_id
        for template_id, template in config.templates.items()
        if "scoring" in template
    }
    assert set(LIVE_RULE_MODULES) == expected


def test_kernel_keypoints_match_configuration():
    config = load_exercise_config("squat")
    for rule_id in LIVE_RULE_MODULES:
        module = live_rule_module(rule_id)
        assert tuple(config.templates[rule_id]["required_keypoints"]) == module.REQUIRED_KEYPOINTS


def test_all_registered_live_rules_are_tuning_ready():
    config = load_exercise_config("squat")
    assert not_live_ready_rule_ids(config) == ()


def test_active_live_selection_resolves_only_implemented_modules():
    config = load_exercise_config("squat")
    selected = active_live_rule_modules(config)
    assert set(selected) == {
        "knee_valgus",
        "lateral_torso_lean",
        "depth",
        "stance_width",
    }
    assert all(config.templates[rule_id]["tuning_status"] == "ready" for rule_id in selected)


def test_registry_fails_closed_if_placeholder_is_forced_active():
    config = load_exercise_config("squat")
    templates = {rule_id: dict(template) for rule_id, template in config.templates.items()}
    templates["lateral_torso_lean"]["tuning_status"] = "placeholder"
    unsafe = replace(config, templates=templates)
    with pytest.raises(RuntimeError, match="not tuning-ready"):
        active_live_rule_modules(unsafe)


def test_development_rules_may_run_live_but_placeholders_may_not():
    """`development` is a real, capture-derived number awaiting confirmation from a fresh session
    (curl's ROM gate today); `placeholder` is a number nobody has stood behind."""
    config = load_exercise_config("squat")
    templates = {rule_id: dict(template) for rule_id, template in config.templates.items()}
    templates["depth"]["tuning_status"] = "development"
    provisional = replace(config, templates=templates)
    assert "depth" in active_live_rule_modules(provisional)
    assert not_live_ready_rule_ids(provisional) == ("depth",)


def test_registry_fails_closed_if_kernel_keypoints_drift_from_configuration():
    config = load_exercise_config("squat")
    templates = {rule_id: dict(template) for rule_id, template in config.templates.items()}
    templates["depth"]["required_keypoints"] = ["left_hip", "right_hip", "left_knee", "right_knee"]
    drifted = replace(config, templates=templates)
    with pytest.raises(RuntimeError, match="keypoint declaration does not match"):
        active_live_rule_modules(drifted)


def test_unknown_live_rule_is_not_resolved_implicitly():
    with pytest.raises(KeyError, match="no squat live-rule module"):
        live_rule_module("invented_rule")
