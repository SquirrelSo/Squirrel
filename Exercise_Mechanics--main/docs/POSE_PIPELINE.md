# Pose → rep pipeline

How a camera frame turns into a counted rep, and what each stage does to cope with low-quality
Android cameras.

| # | Stage | Code | Notes |
|---|---|---|---|
| 1 | Camera acquisition | `frontend-react/src/pose/camera.ts` | Front camera, orientation-matched `ideal` size (portrait → 720×1280), `resizeMode: 'none'` preferred so the phone does not crop its field of view, ~30 fps `ideal` (never a hard floor). Falls back to plain `{facingMode:'user'}` / `true` on `OverconstrainedError` and similar driver quirks. |
| 2 | Frame loop | `frontend-react/src/pose/usePose.ts` | `requestAnimationFrame`; runs inference once per new video frame (`video.currentTime` changes). |
| 2b | Low-light preprocessing | `frontend-react/src/pose/lowLight.ts` | Samples frame brightness from a 32×32 thumbnail every 250 ms. When the scene is dark (hysteresis 30/38 on smoothed luma) the detector gets a 1 px-blurred, brightness-boosted copy of the frame (same size, so landmark coordinates are unchanged). Not applied to normally lit frames, where it measurably hurts tiny images. Below luma ~7 the UI asks the user for more light. `?lowlight=on\|off` forces it for testing. |
| 3 | Pose model + runtime | `frontend-react/src/pose/poseModel.ts` | MediaPipe Pose Landmarker (`lite` default; `?model=full\|heavy`). The WASM runtime is bundled from the installed `@mediapipe/tasks-vision` package, so the JS API and WASM are always the same release; a no-SIMD build is used when the browser lacks WASM SIMD. Model `.task` files come from Google's official MediaPipe model hosting (bundle version pinned). GPU delegate, CPU fallback. |
| 4 | Landmark smoothing | `frontend-react/src/pose/oneEuro.ts` | One Euro filter on normalized x/y/z; visibility untouched. |
| 5 | Keypoint mapping | `frontend-react/src/pose/frameGeometry.ts` | Normalized landmarks → canonical pixel space (long side = 1280, uniform scale). A 1280×720 camera maps 1:1, identical to before; lower-resolution cameras get the same units, so pixel thresholds mean the same thing on every device. Nothing is sent before the video has a size. |
| 6 | Transport | `frontend-react/src/engine/useEngine.ts` → WS | `{ t_ms, keypoints }`; `t_ms` is a pause-aware logical clock. |
| 7 | Frame validation | `backend/core/frame.py` | Known landmark names, finite values, `v ∈ [0,1]`, monotonic time. |
| 8 | Setup gate + baseline | `backend/training/setup_flow.py`, `baseline.py`, `workouts/*/configs/setup.yaml` | Visibility (`CONFIDENCE_MIN`), pre-check stable for `stable_ms`, then a quality-gated median baseline (`min_valid_samples`, `min_valid_coverage`, `max_joint_stddev_px`). |
| 9 | Exercise configuration | `backend/engine/loader.py`, `workouts/*/configs/*.yaml` | Strictly validated FSM graph, templates, switches, scoring. |
| 10 | Movement signal + rules | `workouts/<exercise>/adapter.py`, `rules/` | Exercise kernels turn keypoints into normalized progress (depth, flexion, knee drive) and rule states. |
| 11 | Rep FSM | `backend/engine/rep_fsm.py` | Config-driven phases; tracking-unavailable frames pause the machine. |
| 12 | Evidence timeline + scoring | `backend/engine/timeline.py`, `scorer.py` | Per-rule active/not-ok time within configured phases. |
| 13 | Rep event → session | `backend/training/router.py`, `sessions/` | WS rep events, session persistence, reports. |

## Tracking-gap boundary (`scoring.frame_cadence`)

`scoring.max_frame_delta_ms` (100 ms) separates a resumable tracking blip from a real gap, for both
the rep FSM and the evidence timeline. It was tuned at ~30 fps, where it is three frame intervals.
Low-end phones commonly deliver 8–15 pose frames/s (low-light exposure, CPU inference), so the
*normal* interval approached or exceeded 100 ms; a single dropped frame then discarded the rep in
progress and no form evidence was credited.

`engine/cadence.py` makes the boundary `tolerance_frames × median frame interval`, clamped to
`[max_frame_delta_ms, max_gap_ms]`:

```yaml
scoring:
  max_frame_delta_ms: 100
  frame_cadence:
    tolerance_frames: 3
    max_gap_ms: 400
```

At 30 fps the boundary is still exactly 100 ms. Confidence floors, visibility gates, ROM gates and
rep qualification are unchanged. Configurations without `frame_cadence` (older captures) replay with
the fixed boundary.

## Low-light preprocessing — measured effect

Real MediaPipe lite model, live `detectForVideo` on a degraded 320 px stream (noise + blur),
"usable" = every rule-critical joint at visibility ≥ 0.5 (the unchanged backend floor):

| Mean frame luma | Raw | With preprocessing |
|---|---|---|
| 155 (normal) | 100% | 100% (not triggered) |
| 14–19 (dim/dark) | 100% | 100% |
| 9.7 (very dark) | 0% | 100% |
| 2.0 (near black) | 0% | 63%, and the "too dark" hint is shown |

Plain brightening without the blur measured worse than raw frames (it amplifies sensor noise), which
is why the blur comes first.
