#!/usr/bin/env python3
"""Watch the push-up rules run live, on a camera, a video file, or a synthetic body.

    # webcam, live window (needs opencv-python, not the headless build)
    python backend/tools/live_pushup.py --source 0 --window

    # macOS: if MediaPipe aborts with "DrishtiMetalHelper" / "Service is unavailable", the Tasks
    # API hit its Metal bug. Install the legacy line, which this tool then picks automatically:
    #   pip install 'mediapipe<1.0'

    # a clip of someone doing push-ups side-on, rendered to a file
    python backend/tools/live_pushup.py --source pushups.mp4 --out annotated.mp4

    # no camera and no model: a drawn body that holds a plank, then does 6 reps
    python backend/tools/live_pushup.py --source synthetic --out demo.mp4

    # the same, but the hips start sagging from rep 3 / the body turns front-on
    python backend/tools/live_pushup.py --source synthetic --fault sag --out demo.mp4
    python backend/tools/live_pushup.py --source synthetic --fault frontal --out demo.mp4

WHAT IT ACTUALLY RUNS. Nothing here re-implements any analysis. The tool feeds pixel-space landmarks
into the real `SetupOrchestrator` (the same combined gate `/ws/setup` drives) and then into the real
push-up adapter built by `build_training_adapter`, and draws what they return. So the depth
percentage, the rep verdicts, the sag/pike call, the camera check and the cues on screen are the
exact values a browser client would receive — if the overlay says a rep was shallow, the backend
said it was shallow.

The session runs in the three stages the product has, and the overlay names whichever is current:

    PRE-CHECK   hold the top of a push-up, side-on, until the dwell fills
    CAPTURING   hold still while the baseline is measured (it is the zero point for every signal)
    LIVE        reps are counted, scored and coached

Local development only; it is not imported by the service. Install its extra dependencies with
`pip install -r backend/tools/requirements-vision.txt`.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.engine.loader import load_exercise_config  # noqa: E402
from backend.tools.vision_source import MediaPipeSource, SyntheticPushUpSource  # noqa: E402
from backend.training.builders import build_setup_adapter, build_training_adapter  # noqa: E402
from backend.training.setup_config import load_setup  # noqa: E402
from backend.training.setup_flow import (  # noqa: E402
    COLLECTING,
    PRECHECK,
    READY,
    VALIDATING,
    SetupOrchestrator,
)
from backend.training.target_contract import RepTarget  # noqa: E402

EXERCISE = "pushup"

# --- palette (BGR) ---------------------------------------------------------
INK = (236, 240, 245)
MUTED = (150, 152, 158)
GOOD = (120, 220, 150)
WARN = (90, 200, 250)
BAD = (95, 105, 245)
ACCENT = (235, 190, 110)
PANEL = (28, 26, 24)

FONT = cv2.FONT_HERSHEY_SIMPLEX

#: The skeleton this tool draws. Only the joints the push-up rules actually use, so the picture
#: matches the measurement rather than flattering it.
BONES = (
    ("shoulder", "elbow"),
    ("elbow", "wrist"),
    ("shoulder", "hip"),
    ("hip", "knee"),
    ("knee", "ankle"),
)
MEASURED_JOINTS = ("shoulder", "elbow", "wrist", "hip", "knee", "ankle")


def main() -> None:
    args = _parse_args()
    source = _build_source(args)
    source_label = _source_label(args.source)
    config = load_exercise_config(EXERCISE)
    setup_config = load_setup(EXERCISE)
    orchestrator = SetupOrchestrator(setup_config, build_setup_adapter(EXERCISE))

    writer: Optional[cv2.VideoWriter] = None
    window_open = False
    adapter = None
    live_status: Optional[dict] = None
    setup_status = orchestrator.status()
    rejected: Optional[str] = None
    frame_count = 0
    started = time.perf_counter()

    try:
        for frame in source.frames():
            frame_count += 1
            keypoints = frame.keypoints or {}

            if orchestrator.phase != READY:
                setup_status = orchestrator.update(keypoints, frame.t_ms)
                if setup_status.phase == VALIDATING:
                    setup_status, adapter, rejected = _accept_or_reject(
                        orchestrator, args.reps, config
                    )
            elif adapter is not None:
                live_status = adapter.process(_training_frame(keypoints, frame.t_ms))

            canvas = frame.image.copy()
            _draw_skeleton(canvas, keypoints, live_status)
            _draw_overlay(
                canvas,
                stage=orchestrator.phase,
                setup_status=setup_status,
                live_status=live_status,
                rejected=rejected,
                target_reps=args.reps,
                config=config,
                fps=frame_count / max(1e-6, time.perf_counter() - started),
                source_label=source_label,
            )

            if args.out:
                if writer is None:
                    writer = _open_writer(args.out, canvas, source.native_fps or 30.0)
                writer.write(canvas)
            if args.window:
                try:
                    cv2.imshow("push-up (Exercise Mechanics rules)", canvas)
                    window_open = True
                    if cv2.waitKey(1) & 0xFF in (27, ord("q")):
                        break
                except cv2.error:
                    print(
                        "this OpenCV build has no GUI support (opencv-python-headless) — "
                        "install opencv-python for --window, or use --out FILE"
                    )
                    args.window = False
            if args.max_frames and frame_count >= args.max_frames:
                break
    finally:
        source.close() if hasattr(source, "close") else None
        if writer is not None:
            writer.release()
            print(f"wrote {args.out} ({frame_count} frames)")
        if window_open:
            cv2.destroyAllWindows()

    _print_summary(orchestrator, live_status, frame_count, time.perf_counter() - started)


# ---------------------------------------------------------------------------
# session plumbing
# ---------------------------------------------------------------------------


def _accept_or_reject(orchestrator: SetupOrchestrator, reps: int, config):
    """Mirror what /ws/setup does when a baseline candidate appears.

    The acceptance test is building the real training adapter: if the captured pose cannot produce a
    depth zero point, the candidate is rejected here rather than starting a set that would report no
    tracking forever.
    """
    baseline = orchestrator.baseline
    quality = orchestrator.quality
    if baseline is None or quality is None:
        return orchestrator.reject_candidate("baseline_candidate_incomplete"), None, (
            "baseline incomplete"
        )
    try:
        adapter = build_training_adapter(
            EXERCISE,
            baseline=baseline,
            target=RepTarget("reps", reps),
            config=config,
        )
    except (TypeError, ValueError, RuntimeError) as exc:
        return (
            orchestrator.reject_candidate("baseline_adapter_rejected", str(exc)),
            None,
            str(exc),
        )
    return orchestrator.mark_ready(), adapter, None


def _training_frame(keypoints: dict, t_ms: float):
    from backend.core.frame import TrainingFrame

    return TrainingFrame(t_ms, keypoints)


def _source_label(source: str) -> str:
    """Short, non-overlapping caption for the header (a full path would run into the title)."""
    if source == "synthetic":
        return "synthetic"
    if source.isdigit():
        return f"camera {source}"
    name = Path(source).name
    return name if len(name) <= 24 else f"{name[:21]}..."


def _build_source(args):
    if args.source == "synthetic":
        return SyntheticPushUpSource(
            reps=args.reps + 2,
            fault=args.fault,
            fps=args.fps,
        )
    return MediaPipeSource(
        args.source,
        complexity=args.complexity,
        model_path=Path(args.model) if args.model else None,
        flip=args.flip,
        width=args.width,
        backend=args.backend,
    )


def _open_writer(path: str, canvas: np.ndarray, fps: float) -> cv2.VideoWriter:
    height, width = canvas.shape[:2]
    writer = cv2.VideoWriter(
        path, cv2.VideoWriter_fourcc(*"mp4v"), max(1.0, fps), (width, height)
    )
    if not writer.isOpened():
        raise SystemExit(f"could not open {path} for writing")
    return writer


# ---------------------------------------------------------------------------
# drawing
# ---------------------------------------------------------------------------


def _draw_skeleton(canvas: np.ndarray, keypoints: dict, live_status: Optional[dict]) -> None:
    """Draw the measured chain, colouring the side the rules actually read.

    The analysed side comes from the adapter's own reading, so the highlight shows which arm the
    depth signal used rather than guessing.
    """
    if not keypoints:
        return
    analysed = None
    if live_status:
        analysed = (live_status.get("rom") or {}).get("analysed_side")
    fault_colour = _skeleton_fault_colour(live_status)

    for side in ("left", "right"):
        is_analysed = analysed == side or (analysed is None and side == "left")
        colour = (fault_colour or (ACCENT if is_analysed else (90, 90, 95)))
        thickness = 4 if is_analysed else 2
        for first, second in BONES:
            start = keypoints.get(f"{side}_{first}")
            end = keypoints.get(f"{side}_{second}")
            if not start or not end:
                continue
            cv2.line(
                canvas,
                (int(start["x"]), int(start["y"])),
                (int(end["x"]), int(end["y"])),
                colour,
                thickness,
                cv2.LINE_AA,
            )
        for joint in MEASURED_JOINTS:
            point = keypoints.get(f"{side}_{joint}")
            if point:
                cv2.circle(
                    canvas,
                    (int(point["x"]), int(point["y"])),
                    5 if is_analysed else 3,
                    colour,
                    -1,
                    cv2.LINE_AA,
                )

    # The straight line the body line rule measures against, drawn so a sag or pike is visible.
    side = analysed or "left"
    shoulder = keypoints.get(f"{side}_shoulder")
    ankle = keypoints.get(f"{side}_ankle")
    if shoulder and ankle:
        cv2.line(
            canvas,
            (int(shoulder["x"]), int(shoulder["y"])),
            (int(ankle["x"]), int(ankle["y"])),
            (70, 70, 75),
            1,
            cv2.LINE_AA,
        )


def _skeleton_fault_colour(live_status: Optional[dict]):
    if not live_status:
        return None
    for issue in live_status.get("issues") or ():
        if issue.get("skeleton_color") == "red":
            return BAD
    return None


def _draw_overlay(
    canvas: np.ndarray,
    *,
    stage: str,
    setup_status,
    live_status: Optional[dict],
    rejected: Optional[str],
    target_reps: int,
    config,
    fps: float,
    source_label: str,
) -> None:
    height, width = canvas.shape[:2]
    _panel(canvas, 0, 0, width, 46)
    stage_label, stage_colour = _stage_label(stage, live_status)
    # Shrink to fit rather than clip: a narrow camera frame must still read the whole stage name.
    title_scale = _fitting_scale(stage_label, width - 240, 0.7, thickness=2)
    cv2.putText(canvas, stage_label, (14, 30), FONT, title_scale, stage_colour, 2, cv2.LINE_AA)
    caption = f"push-up | {source_label} | {fps:5.1f} fps"
    (caption_width, _), _ = cv2.getTextSize(caption, FONT, 0.5, 1)
    (title_width, _), _ = cv2.getTextSize(stage_label, FONT, title_scale, 2)
    if 14 + title_width + 20 + caption_width < width:
        cv2.putText(
            canvas,
            caption,
            (width - caption_width - 14, 30),
            FONT,
            0.5,
            MUTED,
            1,
            cv2.LINE_AA,
        )

    if stage == READY and live_status is not None:
        _draw_live(canvas, live_status, target_reps, config)
    else:
        _draw_setup(canvas, setup_status, rejected)


def _fitting_scale(text: str, max_width: int, preferred: float, *, thickness: int = 1) -> float:
    """Largest font scale at or below ``preferred`` whose text fits ``max_width``."""
    scale = preferred
    while scale > 0.35:
        (text_width, _), _ = cv2.getTextSize(text, FONT, scale, thickness)
        if text_width <= max_width:
            break
        scale -= 0.05
    return scale


def _stage_label(stage: str, live_status: Optional[dict]) -> tuple[str, tuple]:
    if stage == PRECHECK:
        return "1/3  PRE-CHECK - get into the top of a push-up, side-on", WARN
    if stage == COLLECTING:
        return "2/3  CAPTURING BASELINE - hold still", ACCENT
    if stage == VALIDATING:
        return "2/3  VALIDATING BASELINE", ACCENT
    if live_status and not (live_status.get("tracking") or {}).get("available", True):
        invalidated = (live_status.get("tracking") or {}).get("invalidated_by") or ()
        if invalidated:
            return "3/3  LIVE - PAUSED: camera is not side-on", BAD
        return "3/3  LIVE - PAUSED: body not tracked", BAD
    return "3/3  LIVE", GOOD


def _draw_setup(canvas: np.ndarray, status, rejected: Optional[str]) -> None:
    """Show the gate the way the app's setup screen does: what is missing, and how far in."""
    height, width = canvas.shape[:2]
    top = 60
    rows: list[tuple[str, tuple]] = []

    if status.missing:
        rows.append((f"not visible: {', '.join(status.missing[:6])}", BAD))
    for condition in status.conditions:
        if condition.status == "passed":
            rows.append((f"[ok]   {condition.template_id}", GOOD))
        elif condition.status == "unavailable":
            rows.append((f"[?]    {condition.template_id}  (not measurable)", WARN))
        else:
            detail = condition.reason_id or "failed"
            rows.append((f"[x]    {condition.template_id}  -> {detail}", BAD))
    if rejected:
        rows.append((f"baseline rejected: {rejected}", BAD))

    panel_height = 34 + 22 * len(rows) + 58
    _panel(canvas, 10, top, 560, panel_height)
    y = top + 26
    cue = _first_cue(status)
    if cue:
        cv2.putText(canvas, cue, (24, y), FONT, 0.6, INK, 2, cv2.LINE_AA)
        y += 28
    for text, colour in rows:
        cv2.putText(canvas, text, (24, y), FONT, 0.5, colour, 1, cv2.LINE_AA)
        y += 22

    if status.stable_ms:
        _bar(
            canvas,
            24,
            y + 4,
            520,
            10,
            status.dwell_ms / status.stable_ms,
            GOOD,
            f"hold steady  {status.dwell_ms:.0f}/{status.stable_ms:.0f} ms",
        )
        y += 34
    if status.phase in (COLLECTING, VALIDATING):
        _bar(
            canvas,
            24,
            y + 4,
            520,
            10,
            status.capture_progress,
            ACCENT,
            f"capturing baseline  {status.frames_collected} frames"
            + ("  (PAUSED)" if status.capture_paused else ""),
        )


def _draw_live(canvas: np.ndarray, status: dict, target_reps: int, config) -> None:
    height, width = canvas.shape[:2]
    counters = status.get("counters") or {}
    rom = status.get("rom") or {}
    set_info = status.get("set") or {}
    tracking = status.get("tracking") or {}

    # --- left: reps + depth -------------------------------------------------
    _panel(canvas, 10, 60, 330, 216)
    reps = set_info.get("completed_reps", 0)
    cv2.putText(canvas, f"{reps}", (26, 128), FONT, 2.2, INK, 4, cv2.LINE_AA)
    cv2.putText(
        canvas,
        f"/ {target_reps} reps",
        (26 + 60 * len(str(reps)), 128),
        FONT,
        0.7,
        MUTED,
        2,
        cv2.LINE_AA,
    )
    cv2.putText(
        canvas,
        f"full {counters.get('full_rom', 0)}   shallow {counters.get('shallow', 0)}"
        f"   invalid {counters.get('invalid', 0)}",
        (26, 156),
        FONT,
        0.5,
        MUTED,
        1,
        cv2.LINE_AA,
    )
    cv2.putText(
        canvas,
        f"phase: {status.get('phase', '-')}",
        (26, 182),
        FONT,
        0.55,
        ACCENT,
        1,
        cv2.LINE_AA,
    )

    ratio = rom.get("ratio")
    gate = rom.get("full_rom_gate") or 0.9
    depth_colour = GOOD if rom.get("full_depth") else WARN
    _bar(
        canvas,
        26,
        200,
        290,
        14,
        (ratio or 0.0),
        depth_colour if ratio is not None else (70, 70, 75),
        f"depth {rom.get('percent') if ratio is not None else '--'}%"
        f"   elbow {_fmt(rom.get('elbow_angle_deg'))}deg",
        marker=gate,
    )
    average = set_info.get("average_score")
    cv2.putText(
        canvas,
        f"avg score {average if average is not None else '--'}"
        f"    last {(status.get('last_rep') or {}).get('score', '--')}",
        (26, 262),
        FONT,
        0.5,
        MUTED,
        1,
        cv2.LINE_AA,
    )

    # --- right: what every rule reported this frame -------------------------
    debug_rows = _rule_rows(status, config)
    _panel(canvas, width - 350, 60, 340, 30 + 22 * len(debug_rows))
    y = 84
    for text, colour in debug_rows:
        cv2.putText(canvas, text, (width - 336, y), FONT, 0.46, colour, 1, cv2.LINE_AA)
        y += 22

    # --- bottom: the cue the user would hear -------------------------------
    cue = status.get("cue")
    if cue:
        _panel(canvas, 10, height - 76, width - 20, 62)
        cv2.putText(
            canvas, cue["text"], (26, height - 38), FONT, 0.8, INK, 2, cv2.LINE_AA
        )
        cv2.putText(
            canvas,
            f"({cue['rule_id']})",
            (26, height - 18),
            FONT,
            0.45,
            MUTED,
            1,
            cv2.LINE_AA,
        )
    elif tracking.get("invalidated_by"):
        _panel(canvas, 10, height - 76, width - 20, 62)
        cv2.putText(
            canvas,
            "reps paused - turn your side to the camera",
            (26, height - 38),
            FONT,
            0.8,
            BAD,
            2,
            cv2.LINE_AA,
        )


def _rule_rows(status: dict, config) -> list[tuple[str, tuple]]:
    """One line per active rule, with the number it produced — the point of the whole tool."""
    rows: list[tuple[str, tuple]] = [("rules this frame", MUTED)]
    issues = {issue["id"]: issue for issue in status.get("issues") or ()}
    rom = status.get("rom") or {}
    tracking = status.get("tracking") or {}

    for rule_id in status.get("active_rule_ids") or ():
        template = config.templates.get(rule_id, {})
        role = (template.get("scoring") or {}).get("role", "-")
        if rule_id in (tracking.get("unavailable_rule_ids") or ()):
            rows.append((f"{rule_id}: no reading", WARN))
            continue
        if role == "rom":
            if rom.get("ratio") is None:
                rows.append((f"{rule_id}: no reading", WARN))
            else:
                rows.append(
                    (
                        f"{rule_id}: {rom.get('percent')}%  "
                        f"gate {int(float(rom.get('full_rom_gate', 0)) * 100)}%",
                        GOOD if rom.get("full_depth") else INK,
                    )
                )
            continue
        issue = issues.get(rule_id)
        if issue:
            side = f" ({issue['side']})" if issue.get("side") else ""
            rows.append((f"{rule_id}: FAULT{side}", BAD))
        else:
            rows.append((f"{rule_id}: ok", GOOD))
    if tracking.get("invalidated_by"):
        rows.append((f"paused by {', '.join(tracking['invalidated_by'])}", BAD))
    return rows


# ---------------------------------------------------------------------------
# small drawing helpers
# ---------------------------------------------------------------------------


def _panel(canvas: np.ndarray, x: int, y: int, width: int, height: int) -> None:
    """A translucent slab, so text stays readable over any footage."""
    x2, y2 = min(canvas.shape[1], x + width), min(canvas.shape[0], y + height)
    if x2 <= x or y2 <= y:
        return
    region = canvas[y:y2, x:x2]
    slab = np.full(region.shape, PANEL, dtype=np.uint8)
    cv2.addWeighted(slab, 0.72, region, 0.28, 0, region)


def _bar(
    canvas: np.ndarray,
    x: int,
    y: int,
    width: int,
    height: int,
    value: float,
    colour: tuple,
    label: str,
    *,
    marker: Optional[float] = None,
) -> None:
    cv2.rectangle(canvas, (x, y), (x + width, y + height), (64, 62, 60), -1)
    filled = int(max(0.0, min(1.0, value)) * width)
    if filled:
        cv2.rectangle(canvas, (x, y), (x + filled, y + height), colour, -1)
    if marker is not None and 0.0 < marker <= 1.0:
        mark_x = x + int(marker * width)
        cv2.line(canvas, (mark_x, y - 3), (mark_x, y + height + 3), INK, 1, cv2.LINE_AA)
    cv2.putText(canvas, label, (x, y + height + 16), FONT, 0.45, MUTED, 1, cv2.LINE_AA)


def _first_cue(status) -> Optional[str]:
    for condition in (*status.failures, *status.conditions):
        if condition.cue:
            return condition.cue
    return None


def _fmt(value, digits: int = 0) -> str:
    if value is None:
        return "--"
    return f"{float(value):.{digits}f}"


def _print_summary(
    orchestrator: SetupOrchestrator,
    live_status: Optional[dict],
    frames: int,
    seconds: float,
) -> None:
    print()
    print(f"frames {frames}  |  {frames / max(1e-6, seconds):.1f} fps  |  {seconds:.1f}s")
    print(f"setup reached: {orchestrator.phase}")
    if live_status is None:
        print("no live session started (setup never completed)")
        if orchestrator.phase != READY:
            print("  the pre-check needs the top of a push-up, side-on, whole body in frame")
        return
    counters = live_status.get("counters") or {}
    set_info = live_status.get("set") or {}
    print(
        f"reps {set_info.get('completed_reps')}/{set_info.get('target_reps')}  "
        f"full {counters.get('full_rom')}  shallow {counters.get('shallow')}  "
        f"invalid {counters.get('invalid')}  avg score {set_info.get('average_score')}"
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--source",
        default="synthetic",
        help="camera index (0), a video path, or 'synthetic' for a drawn body",
    )
    parser.add_argument("--reps", type=int, default=5, help="target reps for the set")
    parser.add_argument("--window", action="store_true", help="show a live OpenCV window")
    parser.add_argument("--out", help="write the annotated video here")
    parser.add_argument("--width", type=int, default=960, help="downscale camera frames to this")
    parser.add_argument("--flip", action="store_true", help="mirror the camera image")
    parser.add_argument("--complexity", type=int, default=1, choices=(0, 1, 2))
    parser.add_argument("--model", help="path to a pose_landmarker .task bundle (tasks backend)")
    parser.add_argument(
        "--backend",
        default="auto",
        choices=("auto", "solutions", "tasks"),
        help=(
            "MediaPipe API to use. auto prefers the legacy CPU-only mp.solutions.pose when the "
            "install has it (mediapipe<1.0), which is what works on macOS; tasks is the 1.0+ API"
        ),
    )
    parser.add_argument("--fps", type=int, default=30, help="synthetic source frame rate")
    parser.add_argument(
        "--fault",
        choices=("sag", "pike", "frontal"),
        help="synthetic only: inject this fault partway through the set",
    )
    parser.add_argument("--max-frames", type=int, default=0, help="stop after N frames")
    args = parser.parse_args()
    if not args.window and not args.out:
        args.window = True
    return args


if __name__ == "__main__":
    main()
