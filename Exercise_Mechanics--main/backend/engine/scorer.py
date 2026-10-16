"""Active-context rep scorer over plain completed-attempt evidence."""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from numbers import Real

from backend.engine.loader import ExerciseConfiguration, load_exercise_config
from backend.engine.timeline import RepEvidence, RepTimeline, RuleEvidence


@dataclass(frozen=True)
class CompletedRep:
    """Plain scorer input supplied by the later FSM/adapter integration."""

    qualified: bool
    rep_peak: float | None
    evidence: RepEvidence

    def __post_init__(self) -> None:
        if not isinstance(self.qualified, bool):
            raise ValueError("completed rep qualified must be boolean")
        if not isinstance(self.evidence, RepEvidence):
            raise ValueError("completed rep evidence must be RepEvidence")


@dataclass(frozen=True)
class ScoreCoverage:
    active_rule_ids: tuple[str, ...]
    available_rule_ids: tuple[str, ...]
    unavailable_rule_ids: tuple[str, ...]
    ratio: float
    reliable: bool


@dataclass(frozen=True)
class RepScore:
    score: float | None
    time_score: float | None
    rom_factor: float | None
    penalty: float | None
    quality: str
    coverage: ScoreCoverage
    scoring_config_version: int
    active_rule_ids: tuple[str, ...]
    phase_scores: dict[str, dict]


class RepScorer:
    """Score completed attempts using only rules active in an exercise's live context."""

    def __init__(self, config: ExerciseConfiguration) -> None:
        self._config = config
        self._active_ids = tuple(
            template_id
            for template_id, template in sorted(
                config.templates.items(), key=lambda item: item[1]["rank"]
            )
            if config.contexts["live"][template_id]
            and template["scoring"]["role"] != "monitor"
        )
        self._rom_id = next(
            template_id
            for template_id in self._active_ids
            if config.templates[template_id]["scoring"]["role"] == "rom"
        )
        self._min_active_ms = float(config.scoring["min_active_ms"])
        self._min_active_frames = int(config.scoring["min_active_frames"])
        self._version = int(config.scoring["version"])
        self._evidence_phases = {
            template_id: tuple(
                config.templates[template_id]["scoring"]["evidence_phases"]
            )
            for template_id in self._active_ids
        }
        self._phase_order = tuple(
            dict.fromkeys(
                phase
                for template_id in self._active_ids
                for phase in self._evidence_phases[template_id]
            )
        )

    @classmethod
    def for_exercise(cls, slug: str) -> "RepScorer":
        return cls(load_exercise_config(slug))

    @property
    def active_rule_ids(self) -> tuple[str, ...]:
        return self._active_ids

    def new_timeline(self) -> RepTimeline:
        active_phases = {
            template_id: self._evidence_phases[template_id]
            for template_id in self._active_ids
        }
        return RepTimeline(
            active_phases,
            max_frame_delta_ms=float(self._config.scoring["max_frame_delta_ms"]),
            frame_cadence=self._config.scoring.get("frame_cadence"),
        )

    def score(self, rep: CompletedRep) -> RepScore:
        if not isinstance(rep, CompletedRep):
            raise TypeError("rep must be a CompletedRep")

        available: list[str] = []
        unavailable: list[str] = []
        peak_available = self._valid_peak(rep.rep_peak)
        for template_id in self._active_ids:
            evidence = rep.evidence.rules.get(template_id)
            sufficient = self._sufficient(evidence)
            if template_id == self._rom_id:
                sufficient = sufficient and peak_available
            (available if sufficient else unavailable).append(template_id)

        coverage = ScoreCoverage(
            active_rule_ids=self._active_ids,
            available_rule_ids=tuple(available),
            unavailable_rule_ids=tuple(unavailable),
            ratio=round(len(available) / len(self._active_ids), 3),
            reliable=not unavailable,
        )
        phase_scores = self._score_phases(rep.evidence)

        if not rep.qualified:
            return self._empty("not_scored", coverage, phase_scores)
        if self._rom_id in unavailable:
            return self._empty("unavailable", coverage, phase_scores)

        penalty = 0.0
        for template_id in available:
            template = self._config.templates[template_id]
            scoring = template["scoring"]
            if scoring["role"] != "penalty":
                continue
            evidence = rep.evidence.rules[template_id]
            penalty += self._penalty_contribution(scoring, evidence)[0]
        penalty = min(1.0, max(0.0, penalty))
        time_score = 100.0 * max(0.0, 1.0 - penalty)

        rom_template = self._config.templates[self._rom_id]
        gate = float(rom_template["full_rom_gate"])
        floor = float(rom_template["scoring"]["rom_floor"])
        rom_factor = min(1.0, max(floor, float(rep.rep_peak) / gate))
        score = round(time_score * rom_factor, 1)
        quality = "reliable" if coverage.reliable else "low_confidence"
        return RepScore(
            score=score,
            time_score=round(time_score, 1),
            rom_factor=round(rom_factor, 6),
            penalty=round(penalty, 6),
            quality=quality,
            coverage=coverage,
            scoring_config_version=self._version,
            active_rule_ids=self._active_ids,
            phase_scores=phase_scores,
        )

    def _empty(
        self,
        quality: str,
        coverage: ScoreCoverage,
        phase_scores: dict[str, dict],
    ) -> RepScore:
        return RepScore(
            score=None,
            time_score=None,
            rom_factor=None,
            penalty=None,
            quality=quality,
            coverage=coverage,
            scoring_config_version=self._version,
            active_rule_ids=self._active_ids,
            phase_scores=phase_scores,
        )

    def _score_phases(self, evidence: RepEvidence) -> dict[str, dict]:
        """Explain form quality by configured movement phase; ROM remains a rep-level factor."""
        phase_scores: dict[str, dict] = {}
        for phase in self._phase_order:
            rule_ids = tuple(
                rule_id
                for rule_id in self._active_ids
                if phase in self._evidence_phases[rule_id]
            )
            phase_evidence = evidence.rules_by_phase.get(phase, {})
            available: list[str] = []
            unavailable: list[str] = []
            insufficient: list[str] = []
            rules: dict[str, dict] = {}
            weighted_penalty = 0.0
            available_penalty_rules = 0

            for rule_id in rule_ids:
                value = phase_evidence.get(rule_id)
                is_available = bool(
                    value is not None
                    and value.active_ms > 0
                    and value.active_frames > 0
                )
                (available if is_available else unavailable).append(rule_id)
                meets_evidence_floor = self._sufficient(value) if is_available else False
                if is_available and not meets_evidence_floor:
                    insufficient.append(rule_id)
                template_scoring = self._config.templates[rule_id]["scoring"]
                role = template_scoring["role"]
                fraction = value.not_ok_fraction if is_available and value is not None else None
                rule_score = None
                contribution = None
                if role == "penalty" and fraction is not None:
                    available_penalty_rules += 1
                    rule_score = round(100.0 * (1.0 - fraction), 1)
                    contribution, confirmed_fault, minimum_applied = (
                        self._penalty_contribution(template_scoring, value)
                    )
                    weighted_penalty += contribution
                else:
                    confirmed_fault = False
                    minimum_applied = False
                rule_result = {
                    "role": role,
                    "available": is_available,
                    "meets_evidence_floor": meets_evidence_floor,
                    "active_ms": value.active_ms if value is not None else 0.0,
                    "active_frames": value.active_frames if value is not None else 0,
                    "not_ok_ms": value.not_ok_ms if value is not None else 0.0,
                    "not_ok_fraction": (
                        round(fraction, 6) if fraction is not None else None
                    ),
                    "score": rule_score,
                    "weighted_penalty": (
                        round(contribution, 6) if contribution is not None else None
                    ),
                }
                if template_scoring.get("confirmed_fault") is not None:
                    rule_result.update(
                        confirmed_fault=confirmed_fault,
                        minimum_penalty_applied=minimum_applied,
                    )
                rules[rule_id] = rule_result

            weighted_penalty = min(1.0, max(0.0, weighted_penalty))
            score = (
                round(100.0 * (1.0 - weighted_penalty), 1)
                if available_penalty_rules
                else None
            )
            phase_scores[phase] = {
                "score": score,
                "penalty": round(weighted_penalty, 6) if score is not None else None,
                "quality": (
                    "unavailable"
                    if score is None
                    else "reliable"
                    if not unavailable and not insufficient
                    else "low_confidence"
                ),
                "duration_ms": float(evidence.phase_ms.get(phase, 0.0)),
                "active_rule_ids": list(rule_ids),
                "available_rule_ids": available,
                "unavailable_rule_ids": unavailable,
                "insufficient_rule_ids": insufficient,
                "rules": rules,
            }
        return phase_scores

    @staticmethod
    def _penalty_contribution(
        scoring: dict,
        evidence: RuleEvidence,
    ) -> tuple[float, bool, bool]:
        duration_penalty = float(scoring["weight"]) * evidence.not_ok_fraction
        policy = scoring.get("confirmed_fault")
        confirmed = bool(
            policy is not None
            and evidence.not_ok_ms >= float(policy["min_not_ok_ms"])
        )
        if not confirmed:
            return duration_penalty, False, False
        contribution = max(duration_penalty, float(policy["minimum_penalty"]))
        return contribution, True, contribution > duration_penalty

    def _sufficient(self, evidence: RuleEvidence | None) -> bool:
        return bool(
            evidence is not None
            and evidence.active_ms >= self._min_active_ms
            and evidence.active_frames >= self._min_active_frames
        )

    @staticmethod
    def _valid_peak(value: object) -> bool:
        return (
            isinstance(value, Real)
            and not isinstance(value, bool)
            and isfinite(float(value))
            and float(value) >= 0
        )
