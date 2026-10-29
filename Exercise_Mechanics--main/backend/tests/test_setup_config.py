"""Validated Stage 7 setup projection tests."""

from backend.training.setup_config import load_setup


def test_load_squat_setup_combines_visibility_precheck_and_capture_configuration():
    config = load_setup("squat")
    assert config.exercise == "squat"
    assert len(config.required_keypoints) == 9
    assert config.required_keypoints[0] == "nose"
    assert config.pre_check_templates == ("standing_posture", "stance_width")
    assert config.baseline_capture_templates == ("standing_posture", "stance_width")
    assert config.stable_ms == 2000.0
    assert config.baseline_required is True
    assert config.baseline_file == "squat_baseline_keypoints.json"
    assert config.capture_duration_ms == 3000.0
    assert config.min_valid_samples == 45
    assert config.min_valid_coverage == 0.8
    assert config.invalid_pause_ms == 250.0
    assert config.invalid_reset_ms == 1000.0
    assert config.max_joint_stddev_torso == 0.12
