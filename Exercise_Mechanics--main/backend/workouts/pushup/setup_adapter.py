"""Push-up-specific setup conditions and final baseline validation.

Two conditions gate a push-up set, and both run on the pre-check AND on every baseline-capture frame:

    plank_ready            the capture is being taken at the top of a real push-up
    side_view_orientation  the camera is at the user's side, where the measurements are valid

``validate_baseline`` then re-runs both against the persisted median pose and adds one reference
check of its own: the captured frame must actually yield a usable depth zero point. Without that,
the live adapter would be built against a baseline it cannot measure from, and the set would start and
immediately report no tracking.
"""

from __future__ import annotations

from backend.engine.loader import ExerciseConfiguration, load_exercise_config
from backend.training.baseline import BaselineQuality
from backend.training.setup_contract import BaselineValidation, ConditionResult
from backend.workouts.pushup.rules.plank_ready import PlankReadyRule
from backend.workouts.pushup.rules.pushup_depth import PushUpDepthRule
from backend.workouts.pushup.rules.side_view_orientation import SideViewOrientationRule


class PushUpSetupAdapter:
    def __init__(self, config: ExerciseConfiguration) -> None:
        self._config = config
        plank = config.templates["plank_ready"]["setup_policy"]
        self._plank = PlankReadyRule(
            min_elbow_extension_deg=plank["min_elbow_extension_deg"],
            max_body_line_offset=plank["max_body_line_offset"],
            max_torso_deg_from_horizontal=plank["max_torso_deg_from_horizontal"],
        )
        orientation = config.templates["side_view_orientation"]
        self._orientation = SideViewOrientationRule(
            orientation["policy"]["ranges"],
            min_torso_length_px=orientation["min_torso_length_px"],
            # No frame hysteresis in setup: the setup flow holds its own `stable_ms` dwell, and a gate
            # that lags by three frames would let a front-on user accumulate dwell they should not.
            hysteresis=False,
        )

    def evaluate(
        self,
        template_ids: tuple[str, ...],
        keypoints: dict,
    ) -> tuple[ConditionResult, ...]:
        return tuple(
            self._evaluate_one(template_id, keypoints, reference=False)
            for template_id in template_ids
        )

    def validate_baseline(
        self,
        baseline: dict,
        quality: BaselineQuality,
        template_ids: tuple[str, ...],
    ) -> BaselineValidation:
        del quality
        results = [
            self._evaluate_one(template_id, baseline, reference=True)
            for template_id in template_ids
        ]
        results.append(self._depth_reference(baseline))
        output = tuple(results)
        return BaselineValidation(all(result.passed for result in output), output)

    def _depth_reference(self, baseline: dict) -> ConditionResult:
        """Can push-up depth actually be measured from this capture?

        Constructing the real rule is the check: it is the same code the live adapter will run, so a
        baseline that passes here cannot fail there for a different reason.
        """
        template = self._config.templates["pushup_depth"]
        try:
            rule = PushUpDepthRule(
                baseline,
                target_elbow_angle_deg=template["target_elbow_angle_deg"],
                full_rom_gate=template["full_rom_gate"],
                min_baseline_elbow_angle_deg=template["min_baseline_elbow_angle_deg"],
                min_upper_arm_px=template["min_upper_arm_px"],
            )
        except ValueError:
            return ConditionResult(
                "depth_reference",
                "failed",
                "baseline_depth_reference_unavailable",
                # Not the live "lower further" cue: the captured top position had no usable arm.
                "Hold the top with your near arm straight and in the picture.",
            )
        angles = rule.baseline_elbow_angles_deg
        return ConditionResult(
            "depth_reference",
            "passed",
            None,
            None,
            {
                "baseline_elbow_angles_deg": {
                    side: round(angle, 3) for side, angle in angles.items()
                },
                "usable_sides": sorted(angles),
                "minimum_deg": float(template["min_baseline_elbow_angle_deg"]),
            },
        )

    def _evaluate_one(
        self,
        template_id: str,
        keypoints: dict,
        *,
        reference: bool,
    ) -> ConditionResult:
        template = self._config.templates[template_id]
        if template_id == "plank_ready":
            reading = (
                self._plank.read_reference(keypoints)
                if reference
                else self._plank.read(keypoints)
            )
            if reading is None:
                return ConditionResult(
                    template_id,
                    "unavailable",
                    "plank_ready_unavailable",
                    template.get("unavailable_cue", template["cue"]),
                )
            if not reading.torso_horizontal:
                reason = "not_in_plank_position"
            elif not reading.arms_extended:
                reason = "arms_not_extended"
            elif not reading.body_straight:
                reason = "body_not_straight"
            else:
                reason = None
            return ConditionResult(
                template_id,
                "passed" if reading.passed else "failed",
                reason,
                None if reading.passed else (template.get("reason_cues") or {}).get(reason, template["cue"]),
                {
                    "elbow_angle_deg": reading.elbow_angle_deg,
                    "body_line_offset": reading.body_line_offset,
                    "torso_deg_from_horizontal": reading.torso_deg_from_horizontal,
                    "analysed_side": reading.analysed_side,
                    "arms_extended": reading.arms_extended,
                    "body_straight": reading.body_straight,
                    "torso_horizontal": reading.torso_horizontal,
                },
            )
        if template_id == "side_view_orientation":
            reading = (
                self._orientation.read_reference(keypoints)
                if reference
                else self._orientation.read(keypoints)
            )
            if reading is None:
                return ConditionResult(
                    template_id,
                    "unavailable",
                    "side_view_orientation_unavailable",
                    template.get("unavailable_cue", template["cue"]),
                )
            # A warning band is not a gate failure: it is "close enough to measure, and worth saying".
            passed = not reading.not_ok
            return ConditionResult(
                template_id,
                "passed" if passed else "failed",
                None if passed else "camera_not_side_on",
                None if passed else template["cue"],
                {
                    "spread_ratio": reading.spread_ratio,
                    "shoulder_spread_ratio": reading.shoulder_spread_ratio,
                    "hip_spread_ratio": reading.hip_spread_ratio,
                    "torso_length_px": reading.torso_length_px,
                    "state": reading.state,
                    "skeleton_color": reading.skeleton_color,
                    "far_side_hidden": reading.far_side_hidden,
                },
            )
        raise ValueError(f"unsupported push-up setup template: {template_id}")


def build_pushup_setup_adapter(
    *,
    config: ExerciseConfiguration | None = None,
) -> PushUpSetupAdapter:
    return PushUpSetupAdapter(config or load_exercise_config("pushup"))
