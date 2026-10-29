"""One interval-level High Knee score over lift ROM and shared rule evidence."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass

from backend.engine.loader import ExerciseConfiguration
from backend.engine.timeline import RepTimeline, RuleEvidence, TimelineFrame
from backend.training.timed_contract import (
    LiftClassification,
    LiftCycleEvent,
    LiftSide,
    TimedScoreQuality,
    TimedSetScore,
    score_timed_cyclic_set,
)

SCORING_SCOPE = "timed_set"
_SIDES: tuple[LiftSide, ...] = ("left", "right")


@dataclass(frozen=True)
class HighKneeLiftScore:
    """Score for one completed side-local lift, used by the live HUD only."""

    lift_id: int
    side: LiftSide
    classification: LiftClassification
    score: float | None
    rom_factor: float | None
    form_factor: float | None
    penalty: float | None
    quality: TimedScoreQuality


class HighKneeLiftScorer:
    """Cut independent per-side evidence windows while the timed set continues."""

    def __init__(self, config: ExerciseConfiguration) -> None:
        self._config = config
        self._rom_id = next(
            rule_id
            for rule_id, template in config.templates.items()
            if config.contexts["live"][rule_id]
            and template["scoring"]["role"] == "rom"
        )
        self._penalty_ids = tuple(
            rule_id
            for rule_id, template in sorted(
                config.templates.items(), key=lambda item: item[1]["rank"]
            )
            if config.contexts["live"][rule_id]
            and template["scoring"]["role"] == "penalty"
        )
        phases = {
            rule_id: config.templates[rule_id]["scoring"]["evidence_phases"]
            for rule_id in self._penalty_ids
        }
        self._timelines = {
            side: RepTimeline(
                phases,
                max_frame_delta_ms=float(config.scoring["max_frame_delta_ms"]),
                frame_cadence=config.scoring.get("frame_cadence"),
            )
            for side in _SIDES
        }

    def push_frame(
        self,
        *,
        side: str,
        t_ms: float,
        phase: str,
        rule_states: dict[str, bool | None],
        tracking: bool,
        event: LiftCycleEvent | None = None,
        tracking_invalid: bool = False,
    ) -> HighKneeLiftScore | None:
        if side not in self._timelines:
            raise ValueError("lift-score side must be 'left' or 'right'")
        if event is not None and event.side != side:
            raise ValueError("lift-score event side does not match its timeline")
        if tracking_invalid and (
            event is None or event.classification != "invalid"
        ):
            raise ValueError("tracking-invalid evidence requires an invalid event")
        update = self._timelines[side].push(
            TimelineFrame(t_ms, phase, rule_states, tracking),
            close_rep=event is not None,
        )
        if event is None:
            return None
        if update.completed is None:
            raise RuntimeError("completed lift did not close its scoring evidence")
        score = self._score_event(
            event,
            update.completed.rules,
            tracking_invalid=tracking_invalid,
        )
        return HighKneeLiftScore(
            event.lift_id,
            event.side,
            event.classification,
            score.score,
            score.rom_factor,
            score.form_factor,
            score.penalty,
            score.quality,
        )

    def _score_event(
        self,
        event: LiftCycleEvent,
        evidence: Mapping[str, RuleEvidence],
        *,
        tracking_invalid: bool,
    ) -> TimedSetScore:
        if not event.counted:
            quality = "unavailable" if tracking_invalid else "not_performed"
            return TimedSetScore(None, None, None, None, quality)
        penalties: list[float] = []
        unavailable: list[str] = []
        for rule_id in self._penalty_ids:
            value = evidence.get(rule_id)
            if not _sufficient(self._config, value):
                unavailable.append(rule_id)
                continue
            penalties.append(
                _penalty_contribution(
                    self._config.templates[rule_id]["scoring"], value
                )
            )
        template = self._config.templates[self._rom_id]
        return score_timed_cyclic_set(
            (event.peak_progress,),
            full_rom_gate=template["full_rom_gate"],
            rom_floor=template["scoring"]["rom_floor"],
            rule_penalties=penalties,
            rom_available=True,
            coverage_reliable=not tracking_invalid and not unavailable,
        )


class HighKneeSetScorer:
    """Accumulate counted lift peaks and one non-duplicated set-level penalty timeline."""

    def __init__(self, config: ExerciseConfiguration) -> None:
        self._config = config
        self._rom_id = next(
            rule_id
            for rule_id, template in config.templates.items()
            if config.contexts["live"][rule_id]
            and template["scoring"]["role"] == "rom"
        )
        self._penalty_ids = tuple(
            rule_id
            for rule_id, template in sorted(
                config.templates.items(), key=lambda item: item[1]["rank"]
            )
            if config.contexts["live"][rule_id]
            and template["scoring"]["role"] == "penalty"
        )
        self._timeline = RepTimeline(
            {
                rule_id: config.templates[rule_id]["scoring"]["evidence_phases"]
                for rule_id in self._penalty_ids
            },
            max_frame_delta_ms=float(config.scoring["max_frame_delta_ms"]),
            frame_cadence=config.scoring.get("frame_cadence"),
        )
        self._counted_peaks: list[float] = []
        self._detected_cycles = 0
        self._tracking_invalid_cycles = 0

    @property
    def penalty_rule_ids(self) -> tuple[str, ...]:
        return self._penalty_ids

    def push_frame(
        self,
        *,
        t_ms: float,
        phase: str,
        rule_states: dict[str, bool | None],
        tracking: bool,
    ) -> None:
        self._timeline.push(TimelineFrame(t_ms, phase, rule_states, tracking))

    def record_cycle(
        self,
        event: LiftCycleEvent,
        *,
        tracking_invalid: bool,
    ) -> None:
        if not isinstance(event, LiftCycleEvent):
            raise TypeError("event must be a LiftCycleEvent")
        if not isinstance(tracking_invalid, bool):
            raise TypeError("tracking_invalid must be boolean")
        if tracking_invalid and event.classification != "invalid":
            raise ValueError("only invalid cycles can be tracking-invalid")
        self._detected_cycles += 1
        if tracking_invalid:
            self._tracking_invalid_cycles += 1
        if event.counted:
            self._counted_peaks.append(event.peak_progress)

    def score(self) -> TimedSetScore:
        if not self._counted_peaks:
            if self._detected_cycles and self._tracking_invalid_cycles:
                return TimedSetScore(None, None, None, None, "unavailable")
            return TimedSetScore(None, None, None, None, "not_performed")

        evidence = self._timeline.snapshot().rules
        penalties: list[float] = []
        unavailable_penalties: list[str] = []
        for rule_id in self._penalty_ids:
            value = evidence.get(rule_id)
            if not self._sufficient(value):
                unavailable_penalties.append(rule_id)
                continue
            penalties.append(
                _penalty_contribution(self._config.templates[rule_id]["scoring"], value)
            )
        reliable = not self._tracking_invalid_cycles and not unavailable_penalties
        template = self._config.templates[self._rom_id]
        return score_timed_cyclic_set(
            self._counted_peaks,
            full_rom_gate=template["full_rom_gate"],
            rom_floor=template["scoring"]["rom_floor"],
            rule_penalties=penalties,
            rom_available=True,
            coverage_reliable=reliable,
        )

    def coverage_document(self) -> dict:
        evidence = self._timeline.snapshot().rules
        available = [
            rule_id
            for rule_id in self._penalty_ids
            if self._sufficient(evidence.get(rule_id))
        ]
        unavailable = [
            rule_id for rule_id in self._penalty_ids if rule_id not in available
        ]
        return {
            "tracking_invalid_cycles": self._tracking_invalid_cycles,
            "penalty_rule_ids": list(self._penalty_ids),
            "available_penalty_rule_ids": available,
            "unavailable_penalty_rule_ids": unavailable,
            "reliable": not self._tracking_invalid_cycles and not unavailable,
        }

    def evidence_document(self) -> dict:
        return {
            rule_id: asdict(value)
            for rule_id, value in self._timeline.snapshot().rules.items()
        }

    def _sufficient(self, evidence: RuleEvidence | None) -> bool:
        return _sufficient(self._config, evidence)


def _sufficient(
    config: ExerciseConfiguration,
    evidence: RuleEvidence | None,
) -> bool:
    return bool(
        evidence is not None
        and evidence.active_ms >= float(config.scoring["min_active_ms"])
        and evidence.active_frames >= int(config.scoring["min_active_frames"])
    )


def _penalty_contribution(scoring: dict, evidence: RuleEvidence) -> float:
    contribution = float(scoring["weight"]) * evidence.not_ok_fraction
    policy = scoring.get("confirmed_fault")
    if policy is not None and evidence.not_ok_ms >= float(policy["min_not_ok_ms"]):
        contribution = max(contribution, float(policy["minimum_penalty"]))
    return min(1.0, max(0.0, contribution))
