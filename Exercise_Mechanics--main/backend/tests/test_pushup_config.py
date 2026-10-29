"""Push-up package configuration, catalog registration and live-rule wiring."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.engine.loader import (
    ConfigurationError,
    load_exercise_config,
    validate_exercise_config,
    validate_enabled_exercises,
)
from backend.training.builders import EXERCISE_BUILDERS, build_setup_adapter
from backend.workouts.catalog import load_catalog
from backend.workouts.pushup.rules.registry import (
    LIVE_RULE_MODULES,
    active_live_rule_modules,
    live_rule_module,
    not_live_ready_rule_ids,
)

_PACKAGE = Path(__file__).resolve().parents[1] / "workouts" / "pushup"


@pytest.fixture(scope="module")
def config():
    return validate_exercise_config("pushup", _PACKAGE)


class TestCatalogRegistration:
    def test_pushup_is_an_enabled_side_view_exercise(self):
        entry = load_catalog().get("pushup")
        assert entry is not None
        assert entry.status == "enabled"
        # The whole point of the exercise: elbow bend and hip alignment are sagittal-plane
        # quantities, so this is the first enabled exercise coached from the side.
        assert entry.view == "side"

    def test_startup_validation_covers_pushup(self):
        assert "pushup" in {bundle.slug for bundle in validate_enabled_exercises()}

    def test_both_adapters_are_registered(self):
        assert "pushup" in EXERCISE_BUILDERS
        assert build_setup_adapter("pushup") is not None

    def test_it_is_a_rep_exercise(self, config):
        assert config.fsm["movement_type"] == "reps"


class TestTemplates:
    def test_the_four_expected_templates_exist(self, config):
        assert sorted(config.templates) == [
            "body_line",
            "plank_ready",
            "pushup_depth",
            "side_view_orientation",
        ]

    def test_depth_is_the_single_live_rom_template(self, config):
        roms = [
            template_id
            for template_id, template in config.templates.items()
            if config.contexts["live"][template_id]
            and template["scoring"]["role"] == "rom"
        ]
        assert roms == ["pushup_depth"]

    def test_camera_check_is_a_monitor_and_never_scores(self, config):
        scoring = config.templates["side_view_orientation"]["scoring"]
        # A front-on camera invalidates the measurement; it is not a fault in the user's form.
        assert scoring == {"role": "monitor"}

    def test_camera_check_runs_in_every_context(self, config):
        for context in ("pre_check", "baseline_capture", "live"):
            assert config.contexts[context]["side_view_orientation"] is True

    def test_camera_check_is_monitored_in_every_phase(self, config):
        # Drifting front-on between reps is exactly when it happens.
        assert set(config.templates["side_view_orientation"]["active_phases"]) == set(
            config.fsm["phases"]
        )

    def test_plank_ready_is_setup_only(self, config):
        assert config.contexts["pre_check"]["plank_ready"] is True
        assert config.contexts["live"]["plank_ready"] is False
        assert "plank_ready" not in LIVE_RULE_MODULES

    def test_body_line_penalises_both_sag_and_pike(self, config):
        sides = {
            entry["side"]
            for entry in config.templates["body_line"]["policy"]["ranges"]
            if entry["state"] == "not_ok"
        }
        assert sides == {"sag", "pike"}

    def test_thresholds_are_declared_development_not_ready(self, config):
        """Push-up thresholds are geometric, not capture-derived — see templates.yaml.

        This test exists to make a promotion to `ready` a deliberate act with a capture behind it,
        rather than something that happens quietly.
        """
        assert set(not_live_ready_rule_ids(config)) == set(LIVE_RULE_MODULES)
        for template in config.templates.values():
            assert template["tuning_status"] == "development"

    def test_min_rep_peak_sits_below_the_full_rom_gate(self, config):
        assert config.fsm["min_rep_peak"] < config.templates["pushup_depth"]["full_rom_gate"]


class TestRuleWiring:
    def test_every_live_rule_has_a_registered_module(self, config):
        assert sorted(active_live_rule_modules(config)) == [
            "body_line",
            "pushup_depth",
            "side_view_orientation",
        ]

    def test_declared_keypoints_match_configuration(self, config):
        for rule_id, module in LIVE_RULE_MODULES.items():
            assert module.REQUIRED_KEYPOINTS == tuple(
                config.templates[rule_id]["required_keypoints"]
            )

    def test_unknown_rule_id_fails_loudly(self):
        with pytest.raises(KeyError, match="no push-up live-rule module"):
            live_rule_module("elbow_flare_corridor")

    def test_setup_keypoints_cover_every_setup_requirement(self, config):
        declared = set(config.setup["keypoints"]) | {
            f"{side}_{base}" for base in config.setup.get("either_side", []) for side in ("left", "right")
        }
        for context in ("pre_check", "baseline_capture"):
            for rule_id, active in config.contexts[context].items():
                if active:
                    assert set(config.templates[rule_id]["required_keypoints"]) <= declared

    def test_baseline_is_required(self, config):
        assert config.setup["baseline"]["required"] is True
        assert config.setup["baseline"]["file"] == "pushup_baseline_keypoints.json"


class TestConfigurationIsFailLoud:
    def test_a_placeholder_template_cannot_go_live(self, tmp_path: Path):
        """The guard that stops an unvalidated threshold scoring anybody."""
        import shutil

        import yaml

        directory = tmp_path / "pushup"
        shutil.copytree(_PACKAGE / "configs", directory / "configs")
        path = directory / "configs" / "templates.yaml"
        data = yaml.safe_load(path.read_text())
        for template in data["templates"]:
            if template["id"] == "pushup_depth":
                template["tuning_status"] = "placeholder"
        path.write_text(yaml.safe_dump(data, sort_keys=False))
        with pytest.raises(ConfigurationError, match="placeholder template"):
            validate_exercise_config("pushup", directory)

    def test_planned_exercises_cannot_be_loaded_as_pushup_can(self):
        assert load_exercise_config("pushup").slug == "pushup"
        with pytest.raises(ConfigurationError, match="planned exercise"):
            load_exercise_config("plank")
