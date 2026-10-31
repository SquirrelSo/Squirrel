"""Fail-loud enabled-exercise configuration loader and schema validation."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from math import isfinite
from numbers import Real
from pathlib import Path

import yaml

from backend.core.landmarks import ALL_LANDMARKS
from backend.engine.range_policy import NumericRangePolicy, RangePolicyError
from backend.workouts.catalog import load_catalog

_WORKOUTS_DIR = Path(__file__).resolve().parent.parent / "workouts"
_CONTEXTS = ("pre_check", "baseline_capture", "live")
# The only two phase names the engine fixes: every rep exercise rests in `setup` and dwells in
# `reset`. Each exercise names its own movement phases (squat: descent/bottom/ascent; curl:
# ascent/top/descent) in its fsm.yaml; those are validated per-exercise, not against a fixed set.
_SETUP_PHASE = "setup"
_RESET_PHASE = "reset"
_LIFECYCLE_PHASES = frozenset({_SETUP_PHASE, _RESET_PHASE})
_FSM_RUNTIME_KEYS = (
    "phases",
    "initial_phase",
    "transitions",
    "descent_trigger",
    "top_return",
    "min_rep_peak",
    "turnaround_ms",
    "reset_dwell_ms",
    "stale_phase_ms",
)
_FSM_ALL_KEYS = _FSM_RUNTIME_KEYS
# Optional: how long tracking may drop out (slow camera frames, a joint briefly hidden) before an
# attempt in progress is discarded. Without it the scoring frame gap (max_frame_delta_ms) applies.
_FSM_OPTIONAL_KEYS = ("max_tracking_gap_ms",)
# Optional, rep exercises: whether a rep short of the full-ROM gate still counts (default true),
# the shortest believable rep (ms, leaving the resting band to returning to it) and the cue shown
# when a rep was faster than that.
_REP_FSM_OPTIONAL_KEYS = ("count_shallow", "min_rep_ms", "too_fast_cue")
# Optional, timed lifts: the slowest lift that still counts (ms, leaving the standing band to
# returning to it) and the cue shown when a lift was slower.
_TIMED_FSM_OPTIONAL_KEYS = ("max_lift_ms", "too_slow_cue")
_TIMED_FSM_KEYS = (
    "phases",
    "initial_phase",
    "transitions",
    "movement_start",
    "reset",
    "min_lift_peak",
    "turnaround_ms",
    "reset_dwell_ms",
    "stale_phase_ms",
)
_FSM_CONDITIONS = frozenset(
    {
        "tracking_recovery_failed",
        "phase_stale",
        "descent_started",
        "full_rom_reached",
        "turnaround_confirmed",
        "top_returned",
        "reset_dwell_elapsed",
    }
)
_FSM_ACTIONS = frozenset({"complete_attempt", "discard_attempt", "reset_attempt"})
_FSM_EVENTS = frozenset({"attempt_completed", "attempt_discarded", "rep_cycle_completed"})
# Template tuning lifecycle. `placeholder` is a number nobody has stood behind and may never be
# active in any context; `development` is a real, capture-derived number that may run live while it
# waits for confirmation from a fresh session; `ready` is tuned and confirmed.
TUNING_STATUSES = frozenset({"ready", "development", "placeholder"})
LIVE_ALLOWED_TUNING_STATUSES = frozenset({"ready", "development"})
_CAPTURE_KEYS = (
    "duration_ms",
    "min_valid_samples",
    "min_valid_coverage",
    "invalid_pause_ms",
    "invalid_reset_ms",
    "max_joint_stddev_torso",
)


class ConfigurationError(ValueError):
    """An enabled exercise configuration is incomplete, contradictory or unsafe to load."""


@dataclass(frozen=True)
class ExerciseConfiguration:
    slug: str
    templates: dict[str, dict]
    contexts: dict[str, dict[str, bool]]
    scoring: dict
    fsm: dict
    setup: dict


def _read_mapping(path: Path, *, schema_versions: frozenset[int] = frozenset({1})) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            value = yaml.safe_load(handle) or {}
    except OSError as exc:
        raise ConfigurationError(f"cannot read required config: {path.name}") from exc
    except yaml.YAMLError as exc:
        raise ConfigurationError(f"invalid YAML in {path.name}") from exc
    if not isinstance(value, dict):
        raise ConfigurationError(f"{path.name} must contain a mapping")
    if value.get("schema_version") not in schema_versions:
        expected = ", ".join(str(version) for version in sorted(schema_versions))
        raise ConfigurationError(f"{path.name} must declare schema_version: {expected}")
    return value


def _is_number(value: object) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool)


def _number(value: object, context: str, *, minimum: float | None = None, strict: bool = False) -> float:
    if not _is_number(value):
        raise ConfigurationError(f"{context} must be numeric")
    result = float(value)
    if not isfinite(result):
        raise ConfigurationError(f"{context} must be finite")
    if minimum is not None and (result <= minimum if strict else result < minimum):
        operator = ">" if strict else ">="
        raise ConfigurationError(f"{context} must be {operator} {minimum}")
    return result


def _mapping(value: object, context: str) -> dict:
    if not isinstance(value, dict):
        raise ConfigurationError(f"{context} must be a mapping")
    return value


def _validate_templates(
    raw: dict,
    *,
    all_phases: frozenset[str],
    movement_phases: frozenset[str],
) -> tuple[dict[str, dict], dict]:
    rows = raw.get("templates")
    if not isinstance(rows, list) or not rows:
        raise ConfigurationError("templates.yaml must contain a non-empty templates list")
    scoring = _mapping(raw.get("scoring"), "templates.scoring")
    version = scoring.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise ConfigurationError("scoring.version must be a positive integer")
    _number(scoring.get("min_active_ms"), "scoring.min_active_ms", minimum=0, strict=True)
    min_frames = _number(scoring.get("min_active_frames"), "scoring.min_active_frames", minimum=1)
    if not min_frames.is_integer():
        raise ConfigurationError("scoring.min_active_frames must be an integer")
    max_delta = _number(
        scoring.get("max_frame_delta_ms"), "scoring.max_frame_delta_ms", minimum=0, strict=True
    )
    # Optional: older captured configurations predate it and replay with the fixed boundary.
    if "frame_cadence" in scoring:
        cadence = _mapping(scoring.get("frame_cadence"), "scoring.frame_cadence")
        if set(cadence) != {"tolerance_frames", "max_gap_ms"}:
            raise ConfigurationError(
                "scoring.frame_cadence must define exactly tolerance_frames and max_gap_ms"
            )
        _number(
            cadence.get("tolerance_frames"),
            "scoring.frame_cadence.tolerance_frames",
            minimum=0,
            strict=True,
        )
        ceiling = _number(
            cadence.get("max_gap_ms"), "scoring.frame_cadence.max_gap_ms", minimum=0, strict=True
        )
        if ceiling < max_delta:
            raise ConfigurationError(
                "scoring.frame_cadence.max_gap_ms must be >= scoring.max_frame_delta_ms"
            )
    _number(scoring.get("cue_min_display_ms"), "scoring.cue_min_display_ms", minimum=0)

    landmarks = set(ALL_LANDMARKS)
    templates: dict[str, dict] = {}
    ranks: set[int] = set()
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ConfigurationError(f"template at index {index} must be a mapping")
        template_id = row.get("id")
        if not isinstance(template_id, str) or not template_id.strip():
            raise ConfigurationError(f"template at index {index} has no valid id")
        if template_id in templates:
            raise ConfigurationError(f"duplicate template id: {template_id}")
        rank = row.get("rank")
        if not isinstance(rank, int) or isinstance(rank, bool) or rank < 1:
            raise ConfigurationError(f"template '{template_id}' rank must be a positive integer")
        if rank in ranks:
            raise ConfigurationError(f"duplicate template rank: {rank}")
        ranks.add(rank)

        keypoints = row.get("required_keypoints")
        if (
            not isinstance(keypoints, list)
            or not keypoints
            or any(not isinstance(name, str) for name in keypoints)
            or len(set(keypoints)) != len(keypoints)
        ):
            raise ConfigurationError(f"template '{template_id}' required_keypoints must be a unique non-empty list")
        unknown = [name for name in keypoints if name not in landmarks]
        if unknown:
            raise ConfigurationError(f"template '{template_id}' has unknown keypoints: {unknown}")
        phases = row.get("active_phases")
        if (
            not isinstance(phases, list)
            or not phases
            or any(not isinstance(phase, str) or phase not in all_phases for phase in phases)
            or len(set(phases)) != len(phases)
        ):
            raise ConfigurationError(f"template '{template_id}' has invalid active_phases")
        if "scoring" in row:
            template_scoring = _mapping(
                row.get("scoring"),
                f"template '{template_id}' scoring",
            )
            if template_scoring.get("role") == "monitor":
                if set(template_scoring) != {"role"}:
                    raise ConfigurationError(
                        f"template '{template_id}' monitor scoring must define only role"
                    )
            else:
                evidence_phases = template_scoring.get("evidence_phases")
                if (
                    not isinstance(evidence_phases, list)
                    or not evidence_phases
                    or any(
                        not isinstance(phase, str) or phase not in movement_phases
                        for phase in evidence_phases
                    )
                    or len(set(evidence_phases)) != len(evidence_phases)
                ):
                    raise ConfigurationError(
                        f"template '{template_id}' scoring.evidence_phases must be a unique "
                        f"non-empty list of movement phases {sorted(movement_phases)}"
                    )
                outside_monitoring = sorted(set(evidence_phases) - set(phases))
                if outside_monitoring:
                    raise ConfigurationError(
                        f"template '{template_id}' scoring.evidence_phases are not monitored: "
                        f"{outside_monitoring}"
                    )
        if row.get("tuning_status") not in TUNING_STATUSES:
            raise ConfigurationError(f"template '{template_id}' has invalid tuning_status")
        required_text = ["fault_label", "issue", "cue"]
        # Report coaching is only surfaced for faults that can occur during reps; setup-only
        # checks (e.g. stance width, standing posture) never appear in the summary, so they
        # do not need a coaching sentence.
        if set(phases) != {_SETUP_PHASE}:
            required_text.append("coaching")
        for text_key in required_text:
            if not isinstance(row.get(text_key), str) or not row[text_key].strip():
                raise ConfigurationError(f"template '{template_id}' requires non-empty {text_key}")
        templates[template_id] = row

    return templates, scoring


def _validate_contexts(raw: dict, templates: dict[str, dict]) -> dict[str, dict[str, bool]]:
    contexts = _mapping(raw.get("contexts"), "switches.contexts")
    if set(contexts) != set(_CONTEXTS):
        raise ConfigurationError(f"switches.contexts must define exactly {list(_CONTEXTS)}")
    template_ids = set(templates)
    result: dict[str, dict[str, bool]] = {}
    for context in _CONTEXTS:
        values = _mapping(contexts[context], f"switches.contexts.{context}")
        if set(values) != template_ids:
            missing = sorted(template_ids - set(values))
            unknown = sorted(set(values) - template_ids)
            raise ConfigurationError(f"context '{context}' template mismatch; missing={missing}, unknown={unknown}")
        if any(not isinstance(enabled, bool) for enabled in values.values()):
            raise ConfigurationError(f"context '{context}' values must be booleans")
        result[context] = dict(values)

    for template_id, template in templates.items():
        if template["tuning_status"] == "placeholder" and any(result[context][template_id] for context in _CONTEXTS):
            raise ConfigurationError(f"placeholder template '{template_id}' cannot be active")
    return result


def _validate_template_policies(templates: dict[str, dict], contexts: dict[str, dict[str, bool]], fsm: dict) -> None:
    live_rom: list[str] = []
    for template_id, template in templates.items():
        if contexts["live"][template_id]:
            score = _mapping(template.get("scoring"), f"template '{template_id}' scoring")
            role = score.get("role")
            if role == "penalty":
                weight = _number(score.get("weight"), f"template '{template_id}' scoring.weight", minimum=0)
                if weight > 1:
                    raise ConfigurationError(f"template '{template_id}' scoring.weight must be <= 1")
                confirmed_fault = score.get("confirmed_fault")
                if confirmed_fault is not None:
                    confirmed_fault = _mapping(
                        confirmed_fault,
                        f"template '{template_id}' scoring.confirmed_fault",
                    )
                    if set(confirmed_fault) != {"min_not_ok_ms", "minimum_penalty"}:
                        raise ConfigurationError(
                            f"template '{template_id}' scoring.confirmed_fault must define "
                            "min_not_ok_ms and minimum_penalty"
                        )
                    _number(
                        confirmed_fault.get("min_not_ok_ms"),
                        f"template '{template_id}' scoring.confirmed_fault.min_not_ok_ms",
                        minimum=0,
                        strict=True,
                    )
                    minimum_penalty = _number(
                        confirmed_fault.get("minimum_penalty"),
                        f"template '{template_id}' scoring.confirmed_fault.minimum_penalty",
                        minimum=0,
                        strict=True,
                    )
                    if minimum_penalty > weight:
                        raise ConfigurationError(
                            f"template '{template_id}' scoring.confirmed_fault.minimum_penalty "
                            "must be <= scoring.weight"
                        )
            elif role == "rom":
                live_rom.append(template_id)
            elif role == "monitor":
                pass
            else:
                raise ConfigurationError(f"live template '{template_id}' has invalid scoring role")

    if len(live_rom) > 1:
        raise ConfigurationError("exercises may define at most one active live ROM template")
    if fsm.get("movement_type") == "reps" and len(live_rom) != 1:
        raise ConfigurationError("rep exercises must define exactly one active live ROM template")

    # Exercise-agnostic ROM contract: whichever live template carries role `rom` owns the full-ROM
    # gate the FSM turns on. Keyed by role, not a hard-coded template name, so squat `depth` and
    # curl `elbow_flexion` are validated by the same rule.
    for rom_id in live_rom:
        rom_template = templates[rom_id]
        gate = _number(
            rom_template.get("full_rom_gate"), f"{rom_id}.full_rom_gate", minimum=0, strict=True
        )
        score = _mapping(rom_template.get("scoring"), f"{rom_id}.scoring")
        if score.get("role") != "rom" or score.get("mode") != "rom":
            raise ConfigurationError(f"{rom_id} scoring must use role/mode 'rom'")
        floor = _number(score.get("rom_floor"), f"{rom_id}.scoring.rom_floor", minimum=0)
        if floor > 1:
            raise ConfigurationError(f"{rom_id}.scoring.rom_floor must be <= 1")
        movement_type = fsm.get("movement_type")
        peak_key = "min_rep_peak" if movement_type == "reps" else "min_lift_peak"
        min_peak = _number(fsm.get(peak_key), f"fsm.{peak_key}", minimum=0, strict=True)
        if not min_peak < gate:
            raise ConfigurationError(f"fsm.{peak_key} must be below {rom_id}.full_rom_gate")

    # Squat depth carries two exercise-specific extras beyond the generic ROM contract above.
    depth = templates.get("depth")
    if depth:
        _number(depth.get("min_baseline_span_px"), "depth.min_baseline_span_px", minimum=0, strict=True)
        _number(
            depth.get("shallow_next_rep_cue_ms"),
            "depth.shallow_next_rep_cue_ms",
            minimum=0,
            strict=True,
        )

    # Bicep-curl ROM maps each wrist's body-local height to progress between the captured resting
    # hang and captured shoulder target. `target_offset` is measured in baseline upper-arm lengths
    # below that target, so 0.0 means wrist level with the baseline shoulder. The per-person resting
    # offset (~1.8–1.9) is known only at runtime; the kernel rejects a baseline whose hang does not
    # sit below the configured target.
    curl = templates.get("curl_rom")
    if curl:
        target = _number(curl.get("target_offset"), "curl_rom.target_offset")
        if not -1.0 <= target < 1.5:
            raise ConfigurationError(
                "curl_rom.target_offset must lie within [-1.0, 1.5) upper-arm lengths of the shoulder"
            )
        _number(
            curl.get("min_upper_arm_px"), "curl_rom.min_upper_arm_px", minimum=0, strict=True
        )
        _number(
            curl.get("shallow_next_rep_cue_ms"),
            "curl_rom.shallow_next_rep_cue_ms",
            minimum=0,
            strict=True,
        )

    # High Knee measures each live hip-to-knee gap along a live body-up axis and normalizes it by
    # that side's standing baseline gap. These are degeneracy/plausibility floors, not ROM tuning.
    knee_drive = templates.get("knee_drive_rom")
    if knee_drive:
        _number(
            knee_drive.get("min_baseline_gap_px"),
            "knee_drive_rom.min_baseline_gap_px",
            minimum=0,
            strict=True,
        )
        _number(
            knee_drive.get("min_torso_length_px"),
            "knee_drive_rom.min_torso_length_px",
            minimum=0,
            strict=True,
        )

    asymmetry = templates.get("left_right_asymmetry")
    if asymmetry and contexts["live"]["left_right_asymmetry"]:
        minimum = _number(
            asymmetry.get("min_lifts_per_side"),
            "left_right_asymmetry.min_lifts_per_side",
            minimum=1,
        )
        if not minimum.is_integer():
            raise ConfigurationError(
                "left_right_asymmetry.min_lifts_per_side must be an integer"
            )
        gap = _number(
            asymmetry.get("max_travel_gap"),
            "left_right_asymmetry.max_travel_gap",
            minimum=0,
            strict=True,
        )
        if gap > 1:
            raise ConfigurationError(
                "left_right_asymmetry.max_travel_gap must be <= 1"
            )

    knee_tracking = templates.get("knee_tracking_corridor")
    if knee_tracking and contexts["live"]["knee_tracking_corridor"]:
        for field in ("min_shoulder_width_px", "min_torso_length_px"):
            _number(
                knee_tracking.get(field),
                f"knee_tracking_corridor.{field}",
                minimum=0,
                strict=True,
            )
        policy = _mapping(
            knee_tracking.get("policy"),
            "knee_tracking_corridor.policy",
        )
        if (
            set(policy) != {"mode", "ranges"}
            or policy.get("mode") != "baseline_relative_lateral_drift"
        ):
            raise ConfigurationError(
                "knee_tracking_corridor.policy must define "
                "mode: baseline_relative_lateral_drift and ranges"
            )
        try:
            ranges = NumericRangePolicy(policy.get("ranges")).ranges
        except RangePolicyError as exc:
            raise ConfigurationError(f"knee_tracking_corridor.policy: {exc}") from exc
        if [entry.state for entry in ranges] != ["safe", "warning", "not_ok"]:
            raise ConfigurationError(
                "knee_tracking_corridor.policy ranges must order safe, warning and not_ok"
            )
        if [entry.skeleton_color for entry in ranges] != ["green", "green", "red"]:
            raise ConfigurationError(
                "knee_tracking_corridor.policy colors must order green, green and red"
            )
        safe, warning, not_ok = ranges
        if not (
            safe.lower is None
            and safe.upper is not None
            and safe.upper > 0
            and safe.upper_inclusive
            and warning.lower == safe.upper
            and not warning.lower_inclusive
            and warning.upper is not None
            and warning.upper > warning.lower
            and warning.upper_inclusive
            and not_ok.lower == warning.upper
            and not not_ok.lower_inclusive
            and not_ok.upper is None
        ):
            raise ConfigurationError(
                "knee_tracking_corridor.policy must define safe through a positive boundary, "
                "then warning and not_ok"
            )

    elbow_flare = templates.get("elbow_flare_corridor")
    if elbow_flare and contexts["live"]["elbow_flare_corridor"]:
        _number(
            elbow_flare.get("min_shoulder_width_px"),
            "elbow_flare_corridor.min_shoulder_width_px",
            minimum=0,
            strict=True,
        )
        _number(
            elbow_flare.get("min_torso_length_px"),
            "elbow_flare_corridor.min_torso_length_px",
            minimum=0,
            strict=True,
        )
        policy = _mapping(elbow_flare.get("policy"), "elbow_flare_corridor.policy")
        if (
            set(policy) != {"mode", "ranges"}
            or policy.get("mode") != "baseline_relative_elbow_outward_offset"
        ):
            raise ConfigurationError(
                "elbow_flare_corridor.policy must define "
                "mode: baseline_relative_elbow_outward_offset and ranges"
            )
        try:
            ranges = NumericRangePolicy(policy.get("ranges")).ranges
        except RangePolicyError as exc:
            raise ConfigurationError(f"elbow_flare_corridor.policy: {exc}") from exc
        if [entry.state for entry in ranges] != ["safe", "warning", "not_ok"]:
            raise ConfigurationError(
                "elbow_flare_corridor.policy ranges must order safe, warning and not_ok"
            )
        if [entry.skeleton_color for entry in ranges] != ["green", "green", "red"]:
            raise ConfigurationError(
                "elbow_flare_corridor.policy colors must order green, green and red"
            )
        safe, warning, not_ok = ranges
        if not (
            safe.lower is None
            and safe.upper is not None
            and safe.upper > 0
            and safe.upper_inclusive
            and warning.lower == safe.upper
            and not warning.lower_inclusive
            and warning.upper is not None
            and warning.upper > warning.lower
            and warning.upper_inclusive
            and not_ok.lower == warning.upper
            and not not_ok.lower_inclusive
            and not_ok.upper is None
        ):
            raise ConfigurationError(
                "elbow_flare_corridor.policy must define safe through a positive boundary, "
                "then warning and not_ok"
            )

    shoulder_elevation = templates.get("shoulder_elevation")
    if shoulder_elevation and contexts["live"]["shoulder_elevation"]:
        for field in ("min_shoulder_width_px", "min_torso_length_px"):
            _number(
                shoulder_elevation.get(field),
                f"shoulder_elevation.{field}",
                minimum=0,
                strict=True,
            )
        # A non-positive slope would mean the tracker lifts the shoulder LESS as the wrists rise,
        # which contradicts every capture; it is a typo, not a tuning choice.
        _number(
            shoulder_elevation.get("curl_height_slope"),
            "shoulder_elevation.curl_height_slope",
            minimum=0,
            strict=True,
        )
        policy = _mapping(
            shoulder_elevation.get("policy"),
            "shoulder_elevation.policy",
        )
        if (
            set(policy) != {"mode", "ranges"}
            or policy.get("mode") != "baseline_relative_rise_curl_corrected"
        ):
            raise ConfigurationError(
                "shoulder_elevation.policy must define "
                "mode: baseline_relative_rise_curl_corrected and ranges"
            )
        try:
            ranges = NumericRangePolicy(policy.get("ranges")).ranges
        except RangePolicyError as exc:
            raise ConfigurationError(f"shoulder_elevation.policy: {exc}") from exc
        if [entry.state for entry in ranges] != ["safe", "warning", "not_ok"]:
            raise ConfigurationError(
                "shoulder_elevation.policy ranges must order safe, warning and not_ok"
            )
        if [entry.skeleton_color for entry in ranges] != ["green", "green", "red"]:
            raise ConfigurationError(
                "shoulder_elevation.policy colors must order green, green and red"
            )
        safe, warning, not_ok = ranges
        if not (
            safe.lower is None
            and safe.upper is not None
            and safe.upper > 0
            and safe.upper_inclusive
            and warning.lower == safe.upper
            and not warning.lower_inclusive
            and warning.upper is not None
            and warning.upper > warning.lower
            and warning.upper_inclusive
            and not_ok.lower == warning.upper
            and not not_ok.lower_inclusive
            and not_ok.upper is None
        ):
            raise ConfigurationError(
                "shoulder_elevation.policy must define safe through a positive boundary, "
                "then warning and not_ok"
            )

    stance = templates.get("stance_width")
    if stance:
        _number(stance.get("min_shoulder_px"), "stance_width.min_shoulder_px", minimum=0, strict=True)
        policy = _mapping(stance.get("policy"), "stance_width.policy")
        try:
            ranges = NumericRangePolicy(policy.get("ranges")).ranges
        except RangePolicyError as exc:
            raise ConfigurationError(f"stance_width.policy: {exc}") from exc
        expected_states = {"safe", "warning", "not_ok"}
        if {entry.state for entry in ranges} != expected_states:
            raise ConfigurationError("stance_width.policy must define safe, warning and not_ok states")
        for entry in ranges:
            expected_color = "red" if entry.state == "not_ok" else "green"
            if entry.skeleton_color != expected_color:
                raise ConfigurationError(
                    f"stance_width.policy state '{entry.state}' must use skeleton_color: {expected_color}"
                )
        safe = tuple(entry for entry in ranges if entry.state == "safe")
        if len(safe) != 1 or safe[0].lower is None or safe[0].upper is None:
            raise ConfigurationError("stance_width.policy must define exactly one bounded safe range")
        score = _mapping(stance.get("scoring"), "stance_width.scoring")
        if score != {"role": "monitor"}:
            raise ConfigurationError("stance_width must use monitor-only scoring")
        if stance.get("active_phases") != ["setup"]:
            raise ConfigurationError("stance_width must be active only during setup")

    knee = templates.get("knee_valgus")
    if knee and contexts["live"]["knee_valgus"]:
        policy = _mapping(knee.get("policy"), "knee_valgus.policy")
        if set(policy) != {"mode", "ranges"} or policy.get("mode") != "baseline_relative":
            raise ConfigurationError(
                "knee_valgus.policy must define mode: baseline_relative and ranges"
            )
        try:
            ranges = NumericRangePolicy(policy.get("ranges")).ranges
        except RangePolicyError as exc:
            raise ConfigurationError(f"knee_valgus.policy: {exc}") from exc
        if [entry.state for entry in ranges] != ["safe", "warning", "not_ok"]:
            raise ConfigurationError(
                "knee_valgus.policy ranges must order safe, warning and not_ok"
            )
        if [entry.skeleton_color for entry in ranges] != ["green", "green", "red"]:
            raise ConfigurationError(
                "knee_valgus.policy colors must order green, green and red"
            )
        safe, warning, not_ok = ranges
        if not (
            safe.lower is None
            and safe.upper == 0
            and safe.upper_inclusive
            and warning.lower == 0
            and not warning.lower_inclusive
            and warning.upper is not None
            and warning.upper > 0
            and warning.upper_inclusive
            and not_ok.lower == warning.upper
            and not not_ok.lower_inclusive
            and not_ok.upper is None
        ):
            raise ConfigurationError(
                "knee_valgus.policy must define safe <= 0, a positive warning band, "
                "then not_ok"
            )

    torso = templates.get("lateral_torso_lean")
    if torso and contexts["live"]["lateral_torso_lean"]:
        # Squat predates the live geometry floor. Newer exercise-owned implementations require it
        # so a collapsed shoulder-to-hip line becomes unavailable instead of a fault-sized angle.
        requires_torso_floor = "curl_rom" in templates or "knee_drive_rom" in templates
        if requires_torso_floor or "min_torso_length_px" in torso:
            _number(
                torso.get("min_torso_length_px"),
                "lateral_torso_lean.min_torso_length_px",
                minimum=0,
                strict=True,
            )
        policy = _mapping(torso.get("policy"), "lateral_torso_lean.policy")
        if (
            set(policy) != {"mode", "ranges"}
            or policy.get("mode") != "baseline_relative_angle"
        ):
            raise ConfigurationError(
                "lateral_torso_lean.policy must define mode: baseline_relative_angle and ranges"
            )
        try:
            ranges = NumericRangePolicy(policy.get("ranges")).ranges
        except RangePolicyError as exc:
            raise ConfigurationError(f"lateral_torso_lean.policy: {exc}") from exc
        if [entry.state for entry in ranges] != [
            "not_ok", "warning", "safe", "warning", "not_ok"
        ]:
            raise ConfigurationError(
                "lateral_torso_lean.policy ranges must order "
                "not_ok, warning, safe, warning, not_ok"
            )
        if [entry.skeleton_color for entry in ranges] != [
            "red", "green", "green", "green", "red"
        ]:
            raise ConfigurationError(
                "lateral_torso_lean.policy colors must order red, green, green, green, red"
            )
        if [entry.side for entry in ranges] != ["right", "right", None, "left", "left"]:
            raise ConfigurationError(
                "lateral_torso_lean.policy sides must order right, right, null, left, left"
            )
        right_not_ok, right_warning, safe, left_warning, left_not_ok = ranges
        if not (
            right_not_ok.lower is None
            and right_not_ok.upper is not None
            and not right_not_ok.upper_inclusive
            and right_warning.lower == right_not_ok.upper
            and right_warning.lower_inclusive
            and right_warning.upper is not None
            and not right_warning.upper_inclusive
            and safe.lower == right_warning.upper
            and safe.lower_inclusive
            and safe.upper is not None
            and safe.upper_inclusive
            and left_warning.lower == safe.upper
            and not left_warning.lower_inclusive
            and left_warning.upper is not None
            and left_warning.upper_inclusive
            and left_not_ok.lower == left_warning.upper
            and not left_not_ok.lower_inclusive
            and left_not_ok.upper is None
            and right_not_ok.upper == -left_not_ok.lower
            and right_warning.upper == -left_warning.lower
        ):
            raise ConfigurationError(
                "lateral_torso_lean.policy must define symmetric not_ok/warning/safe ranges"
            )

    posture = templates.get("standing_posture")
    if posture:
        policy = _mapping(posture.get("setup_policy"), "standing_posture.setup_policy")
        angle = _number(policy.get("min_knee_extension_deg"), "standing_posture.min_knee_extension_deg", minimum=0, strict=True)
        if angle >= 180:
            raise ConfigurationError("standing_posture.min_knee_extension_deg must be below 180")
        if not isinstance(policy.get("require_hip_above_knee"), bool):
            raise ConfigurationError("standing_posture.require_hip_above_knee must be boolean")

    arms = templates.get("arms_extended")
    if arms:
        policy = _mapping(arms.get("setup_policy"), "arms_extended.setup_policy")
        angle = _number(
            policy.get("min_elbow_extension_deg"),
            "arms_extended.min_elbow_extension_deg",
            minimum=0,
            strict=True,
        )
        if angle >= 180:
            raise ConfigurationError("arms_extended.min_elbow_extension_deg must be below 180")

    high_knee_setup = templates.get("setup_readiness")
    if high_knee_setup:
        policy = _mapping(
            high_knee_setup.get("setup_policy"),
            "setup_readiness.setup_policy",
        )
        expected = {
            "min_shoulder_width_px",
            "min_hip_width_px",
            "min_torso_length_px",
            "min_upper_leg_px",
            "min_lower_leg_px",
            "max_side_length_ratio",
            "min_knee_extension_deg",
            "min_stance_ratio",
            "max_stance_ratio",
            "max_foot_height_difference_ratio",
        }
        if set(policy) != expected:
            raise ConfigurationError(
                "setup_readiness.setup_policy must define the exact setup geometry fields"
            )
        for key in (
            "min_shoulder_width_px",
            "min_hip_width_px",
            "min_torso_length_px",
            "min_upper_leg_px",
            "min_lower_leg_px",
            "max_foot_height_difference_ratio",
        ):
            _number(
                policy.get(key),
                f"setup_readiness.{key}",
                minimum=0,
                strict=True,
            )
        side_ratio = _number(
            policy.get("max_side_length_ratio"),
            "setup_readiness.max_side_length_ratio",
            minimum=1,
        )
        if side_ratio < 1:
            raise ConfigurationError(
                "setup_readiness.max_side_length_ratio must be >= 1"
            )
        knee_angle = _number(
            policy.get("min_knee_extension_deg"),
            "setup_readiness.min_knee_extension_deg",
            minimum=0,
            strict=True,
        )
        if knee_angle >= 180:
            raise ConfigurationError(
                "setup_readiness.min_knee_extension_deg must be below 180"
            )
        stance_min = _number(
            policy.get("min_stance_ratio"),
            "setup_readiness.min_stance_ratio",
            minimum=0,
            strict=True,
        )
        stance_max = _number(
            policy.get("max_stance_ratio"),
            "setup_readiness.max_stance_ratio",
            minimum=0,
            strict=True,
        )
        if stance_min >= stance_max:
            raise ConfigurationError(
                "setup_readiness stance ratios must satisfy min_stance_ratio < max_stance_ratio"
            )


def _validate_fsm(raw: dict) -> dict:
    movement_type = raw.get("movement_type")
    if movement_type not in {"reps", "time"}:
        raise ConfigurationError("fsm.movement_type must be 'reps' or 'time'")
    keys = _FSM_ALL_KEYS if movement_type == "reps" else _TIMED_FSM_KEYS
    optional = (
        *_FSM_OPTIONAL_KEYS,
        *(_REP_FSM_OPTIONAL_KEYS if movement_type == "reps" else _TIMED_FSM_OPTIONAL_KEYS),
    )
    allowed = {"schema_version", "movement_type", *keys, *optional}
    unknown = sorted(set(raw) - allowed)
    if unknown:
        raise ConfigurationError(f"fsm contains unknown fields: {unknown}")
    missing = sorted(set(keys) - set(raw))
    if missing:
        raise ConfigurationError(f"fsm is missing required fields: {missing}")
    for key in keys:
        if key in {"phases", "initial_phase", "transitions"}:
            continue
        minimum = 0
        strict = key in {
            "turnaround_ms", "reset_dwell_ms", "stale_phase_ms", "min_rep_peak",
            "movement_start", "min_lift_peak",
        }
        _number(raw.get(key), f"fsm.{key}", minimum=minimum, strict=strict)
    for key in _FSM_OPTIONAL_KEYS:
        if key in raw:
            _number(raw[key], f"fsm.{key}", minimum=0, strict=True)
    if "count_shallow" in raw and not isinstance(raw["count_shallow"], bool):
        raise ConfigurationError("fsm.count_shallow must be boolean")
    if "min_rep_ms" in raw:
        _number(raw["min_rep_ms"], "fsm.min_rep_ms", minimum=0, strict=True)
        if not isinstance(raw.get("too_fast_cue"), str) or not raw["too_fast_cue"].strip():
            raise ConfigurationError("fsm.min_rep_ms needs a non-empty fsm.too_fast_cue")
    elif "too_fast_cue" in raw:
        raise ConfigurationError("fsm.too_fast_cue is only used with fsm.min_rep_ms")
    if "max_lift_ms" in raw:
        _number(raw["max_lift_ms"], "fsm.max_lift_ms", minimum=0, strict=True)
        if not isinstance(raw.get("too_slow_cue"), str) or not raw["too_slow_cue"].strip():
            raise ConfigurationError("fsm.max_lift_ms needs a non-empty fsm.too_slow_cue")
    elif "too_slow_cue" in raw:
        raise ConfigurationError("fsm.too_slow_cue is only used with fsm.max_lift_ms")
    if movement_type == "reps":
        reset = float(raw["top_return"])
        start = float(raw["descent_trigger"])
        min_peak = float(raw["min_rep_peak"])
        if not 0 <= reset <= start < min_peak:
            raise ConfigurationError(
                "FSM progress thresholds must satisfy "
                "0 <= top_return <= descent_trigger < min_rep_peak"
            )
    else:
        reset = float(raw["reset"])
        start = float(raw["movement_start"])
        min_peak = float(raw["min_lift_peak"])
        if not 0 <= reset < start < min_peak:
            raise ConfigurationError(
                "timed FSM progress thresholds must satisfy "
                "0 <= reset < movement_start < min_lift_peak"
            )

    phases = raw.get("phases")
    if (
        not isinstance(phases, list)
        or not phases
        or any(not isinstance(phase, str) or not phase for phase in phases)
        or len(set(phases)) != len(phases)
    ):
        raise ConfigurationError("fsm.phases must be a unique non-empty list of phase names")
    if not _LIFECYCLE_PHASES <= set(phases):
        raise ConfigurationError(
            f"fsm.phases must include the lifecycle phases {sorted(_LIFECYCLE_PHASES)}"
        )
    if not set(phases) - _LIFECYCLE_PHASES:
        raise ConfigurationError("fsm.phases must define at least one movement phase")
    if raw.get("initial_phase") != _SETUP_PHASE:
        raise ConfigurationError(f"fsm.initial_phase must be '{_SETUP_PHASE}'")
    transitions = raw.get("transitions")
    if not isinstance(transitions, list) or not transitions:
        raise ConfigurationError("fsm.transitions must be a non-empty list")
    identities: set[tuple[str, str]] = set()
    destinations: dict[str, set[str]] = {phase: set() for phase in phases}
    for index, transition in enumerate(transitions):
        context = f"fsm.transitions[{index}]"
        if not isinstance(transition, dict):
            raise ConfigurationError(f"{context} must be a mapping")
        if set(transition) - {"from", "to", "when", "action", "emit"}:
            raise ConfigurationError(f"{context} contains unknown fields")
        source = transition.get("from")
        destination = transition.get("to")
        condition = transition.get("when")
        action = transition.get("action")
        event = transition.get("emit")
        if source not in phases or destination not in phases:
            raise ConfigurationError(f"{context} must reference known phases")
        if condition not in _FSM_CONDITIONS:
            raise ConfigurationError(f"{context}.when is not a supported condition")
        if action is not None and action not in _FSM_ACTIONS:
            raise ConfigurationError(f"{context}.action is not supported")
        if event is not None and event not in _FSM_EVENTS:
            raise ConfigurationError(f"{context}.emit is not supported")
        identity = (source, condition)
        if identity in identities:
            raise ConfigurationError(f"duplicate FSM transition for {source}/{condition}")
        identities.add(identity)
        destinations[source].add(destination)
    if any(not destinations[phase] for phase in phases):
        raise ConfigurationError("every FSM phase must define at least one outgoing transition")
    reachable = {raw["initial_phase"]}
    while True:
        expanded = reachable | {
            destination
            for source in reachable
            for destination in destinations[source]
        }
        if expanded == reachable:
            break
        reachable = expanded
    if reachable != set(phases):
        raise ConfigurationError("fsm.transitions contain unreachable phases")
    if not any(
        transition.get("from") == "reset"
        and transition.get("to") == "setup"
        and transition.get("when") == "reset_dwell_elapsed"
        and transition.get("emit") == "rep_cycle_completed"
        for transition in transitions
    ):
        raise ConfigurationError(
            "fsm reset_dwell_elapsed transition must route reset to setup and emit rep_cycle_completed"
        )
    if not any(
        transition.get("from") == "reset"
        and transition.get("to") == "reset"
        and transition.get("when") == "tracking_recovery_failed"
        and transition.get("action") == "reset_attempt"
        and transition.get("emit") is None
        for transition in transitions
    ):
        raise ConfigurationError(
            "fsm reset tracking recovery must restart the reset dwell without completing the cycle"
        )
    # The single top_returned completion names the returning movement phase and the reset phase;
    # the FSM derives its lifecycle roles from it, so the graph must define exactly one, running
    # from a movement phase into reset and completing the attempt.
    completions = [
        transition for transition in transitions if transition.get("when") == "top_returned"
    ]
    if len(completions) != 1:
        raise ConfigurationError(
            "fsm.transitions must define exactly one top_returned completion transition"
        )
    completion = completions[0]
    if (
        completion.get("to") != _RESET_PHASE
        or completion.get("from") in _LIFECYCLE_PHASES
        or completion.get("action") != "complete_attempt"
        or completion.get("emit") != "attempt_completed"
    ):
        raise ConfigurationError(
            "the top_returned completion must run from a movement phase into reset, completing "
            "and emitting attempt_completed"
        )
    return raw


def _validate_setup(raw: dict, slug: str) -> dict:
    if raw.get("exercise") != slug:
        raise ConfigurationError(f"setup.exercise must equal '{slug}'")
    keypoints = raw.get("keypoints")
    # Optional: joints needed on ONE side only, by base name (a side-on exercise).
    either_side = raw.get("either_side", [])
    if (
        not isinstance(either_side, list)
        or any(not isinstance(base, str) for base in either_side)
        or len(set(either_side)) != len(either_side)
    ):
        raise ConfigurationError("setup.either_side must be a unique list of joint names")
    side_names = [f"{side}_{base}" for base in either_side for side in ("left", "right")]
    if (
        not isinstance(keypoints, list)
        or not (keypoints or either_side)
        or any(not isinstance(name, str) for name in keypoints)
        or len(set(keypoints)) != len(keypoints)
    ):
        raise ConfigurationError("setup.keypoints must be a unique list, non-empty without either_side")
    unknown = [name for name in (*keypoints, *side_names) if name not in set(ALL_LANDMARKS)]
    if unknown:
        raise ConfigurationError(f"setup has unknown keypoints: {unknown}")
    if set(keypoints) & set(side_names):
        raise ConfigurationError("setup.keypoints and setup.either_side overlap")
    pre_check = _mapping(raw.get("pre_check"), "setup.pre_check")
    if not isinstance(pre_check.get("enabled"), bool):
        raise ConfigurationError("setup.pre_check.enabled must be boolean")
    if pre_check["enabled"]:
        _number(pre_check.get("stable_ms"), "setup.pre_check.stable_ms", minimum=0, strict=True)

    baseline = _mapping(raw.get("baseline"), "setup.baseline")
    if not isinstance(baseline.get("required"), bool):
        raise ConfigurationError("setup.baseline.required must be boolean")
    filename = baseline.get("file")
    if baseline["required"] and (
        not isinstance(filename, str)
        or not filename.endswith(".json")
        or Path(filename).name != filename
    ):
        raise ConfigurationError("setup.baseline.file must be a safe JSON filename")
    capture = _mapping(baseline.get("capture"), "setup.baseline.capture")
    for key in _CAPTURE_KEYS:
        if key not in capture:
            raise ConfigurationError(f"setup.baseline.capture missing '{key}'")
    _number(capture["duration_ms"], "capture.duration_ms", minimum=0, strict=True)
    samples = _number(capture["min_valid_samples"], "capture.min_valid_samples", minimum=1)
    if not samples.is_integer():
        raise ConfigurationError("capture.min_valid_samples must be an integer")
    coverage = _number(capture["min_valid_coverage"], "capture.min_valid_coverage", minimum=0, strict=True)
    if coverage > 1:
        raise ConfigurationError("capture.min_valid_coverage must be <= 1")
    pause = _number(capture["invalid_pause_ms"], "capture.invalid_pause_ms", minimum=0)
    reset = _number(capture["invalid_reset_ms"], "capture.invalid_reset_ms", minimum=0)
    if reset < pause:
        raise ConfigurationError("capture.invalid_reset_ms must be >= invalid_pause_ms")
    stillness = _number(capture["max_joint_stddev_torso"], "capture.max_joint_stddev_torso", minimum=0, strict=True)
    if stillness >= 1:
        raise ConfigurationError("capture.max_joint_stddev_torso is a fraction of a torso length and must be < 1")
    return raw


def _validate_setup_context_alignment(
    setup: dict,
    contexts: dict[str, dict[str, bool]],
    templates: dict[str, dict],
) -> None:
    """Reject feature flags or landmark gates that contradict context activation."""
    pre_check_active = any(contexts["pre_check"].values())
    if bool(setup["pre_check"]["enabled"]) != pre_check_active:
        raise ConfigurationError(
            "setup.pre_check.enabled must match whether the pre_check context has active templates"
        )
    # A baseline may be captured (keypoints + per-joint median) without any condition templates
    # gating the capture window — squat re-checks posture/stance while capturing, curl records the
    # median only. So capture-condition templates imply a required baseline, but a required baseline
    # does not imply capture-condition templates.
    baseline_active = any(contexts["baseline_capture"].values())
    if baseline_active and not bool(setup["baseline"]["required"]):
        raise ConfigurationError(
            "baseline_capture condition templates require setup.baseline.required to be true"
        )

    # Joints needed on one side only are captured for both sides (either may be the one in view).
    setup_keypoints = set(setup["keypoints"]) | {
        f"{side}_{base}" for base in setup.get("either_side", []) for side in ("left", "right")
    }
    for context in ("pre_check", "baseline_capture"):
        required = {
            keypoint
            for template_id, active in contexts[context].items()
            if active
            for keypoint in templates[template_id]["required_keypoints"]
        }
        missing = sorted(required - setup_keypoints)
        if missing:
            raise ConfigurationError(f"setup.keypoints missing {context} requirements: {missing}")


def validate_exercise_config(slug: str, exercise_dir: Path) -> ExerciseConfiguration:
    """Load and validate all four configuration files for one enabled exercise."""
    configs_dir = exercise_dir / "configs"
    templates_raw = _read_mapping(configs_dir / "templates.yaml")
    switches_raw = _read_mapping(configs_dir / "switches.yaml")
    fsm = _validate_fsm(
        _read_mapping(configs_dir / "fsm.yaml", schema_versions=frozenset({2}))
    )
    setup = _validate_setup(_read_mapping(configs_dir / "setup.yaml"), slug)
    all_phases = frozenset(fsm["phases"])
    movement_phases = all_phases - _LIFECYCLE_PHASES
    templates, scoring = _validate_templates(
        templates_raw,
        all_phases=all_phases,
        movement_phases=movement_phases,
    )
    contexts = _validate_contexts(switches_raw, templates)
    _validate_template_policies(templates, contexts, fsm)
    _validate_setup_context_alignment(setup, contexts, templates)
    return ExerciseConfiguration(
        slug=slug,
        templates=templates,
        contexts=contexts,
        scoring=scoring,
        fsm=fsm,
        setup=setup,
    )


@lru_cache(maxsize=None)
def load_exercise_config(slug: str) -> ExerciseConfiguration:
    entry = load_catalog().get(slug)
    if entry is None:
        raise ConfigurationError(f"unknown exercise: {slug}")
    if not entry.enabled:
        raise ConfigurationError(f"planned exercise cannot be fully loaded: {slug}")
    return validate_exercise_config(slug, _WORKOUTS_DIR / slug)


def validate_enabled_exercises() -> tuple[ExerciseConfiguration, ...]:
    """Fully validate enabled entries; planned catalog metadata is intentionally not loaded."""
    return tuple(load_exercise_config(entry.slug) for entry in load_catalog().enabled())


def load_templates(slug: str) -> dict[str, dict]:
    return load_exercise_config(slug).templates


def get_template(slug: str, template_id: str) -> dict | None:
    return load_templates(slug).get(template_id)


def load_contexts(slug: str) -> dict[str, dict[str, bool]]:
    return load_exercise_config(slug).contexts


def scoring_params(slug: str) -> dict:
    return load_exercise_config(slug).scoring


def fsm_config(slug: str) -> dict:
    return load_exercise_config(slug).fsm


def fsm_params(slug: str) -> dict:
    """Validated FSM inputs, sharing the timeline's configured frame-gap boundary."""
    spec = fsm_config(slug)
    if spec["movement_type"] != "reps":
        raise ConfigurationError("fsm_params is available only for repetition FSMs")
    params = {key: spec[key] for key in _FSM_RUNTIME_KEYS}
    params["max_frame_delta_ms"] = scoring_params(slug)["max_frame_delta_ms"]
    params.update({key: spec[key] for key in _FSM_OPTIONAL_KEYS if key in spec})
    params["frame_cadence"] = scoring_params(slug).get("frame_cadence")
    return params
