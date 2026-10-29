"""Exercise-local module registry for push-up live-rule adapter construction."""

from __future__ import annotations

from types import MappingProxyType, ModuleType
from typing import TYPE_CHECKING

from backend.engine.loader import LIVE_ALLOWED_TUNING_STATUSES
from backend.workouts.pushup.rules import body_line, pushup_depth, side_view_orientation

if TYPE_CHECKING:
    from backend.engine.loader import ExerciseConfiguration

# plank_ready is intentionally absent: it is a setup-only condition (see setup_adapter.py) and must
# never be constructible as a live rule.
_MODULES = (body_line, pushup_depth, side_view_orientation)
LIVE_RULE_MODULES: MappingProxyType[str, ModuleType] = MappingProxyType(
    {module.RULE_ID: module for module in _MODULES}
)


def live_rule_module(rule_id: str) -> ModuleType:
    """Return the explicitly registered push-up live-rule module or fail on an unknown ID."""
    try:
        return LIVE_RULE_MODULES[rule_id]
    except KeyError as exc:
        raise KeyError(f"no push-up live-rule module registered for '{rule_id}'") from exc


def not_live_ready_rule_ids(config: "ExerciseConfiguration") -> tuple[str, ...]:
    """Registered rules whose validated template tuning status is not ready.

    For push-up this is currently every rule: the thresholds are geometric, not capture-derived. See
    the provenance block at the top of configs/templates.yaml.
    """
    return tuple(
        rule_id
        for rule_id in LIVE_RULE_MODULES
        if config.templates[rule_id]["tuning_status"] != "ready"
    )


def active_live_rule_modules(
    config: "ExerciseConfiguration",
) -> MappingProxyType[str, ModuleType]:
    """Resolve exactly the configured active live modules and reject unsafe activation."""
    selected: dict[str, ModuleType] = {}
    for rule_id, active in config.contexts["live"].items():
        if not active:
            continue
        module = live_rule_module(rule_id)
        if config.templates[rule_id]["tuning_status"] not in LIVE_ALLOWED_TUNING_STATUSES:
            raise RuntimeError(f"active live rule '{rule_id}' is not tuning-ready")
        declared = getattr(module, "REQUIRED_KEYPOINTS", None)
        configured = tuple(config.templates[rule_id]["required_keypoints"])
        if declared != configured:
            raise RuntimeError(
                f"live rule '{rule_id}' keypoint declaration does not match configuration"
            )
        selected[rule_id] = module
    return MappingProxyType(selected)
