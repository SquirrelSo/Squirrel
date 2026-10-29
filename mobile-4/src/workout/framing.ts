/**
 * Framing quality: where the person is in the picture and what (if anything) they should change.
 *
 * Adapts to the person instead of assuming a distance. From one tracked frame it measures the
 * body's box, height, centre and which essential joints (exerciseProfiles.ts) are tracked inside
 * the picture, then says the ONE thing to fix, or that the framing is good:
 *
 *   no_person       nothing tracked                                   "Step into view"
 *   turn_upright    a standing body lies sideways in the picture      "Hold the phone upright"
 *   move_back       essential joints cut off at the top or bottom     "Move slightly back"
 *   move_left/right essential joints cut off at a side                "Move a little to your left/right"
 *   show_full_body  essential joints missing inside the picture       "Show your full body"
 *   move_closer     the body is tiny (under MIN_BODY of the frame)    "Move slightly closer"
 *   good/excellent  everything essential tracked                      "Perfect"
 *
 * Measured on real footage (MediaPipe lite): the person is detected at every size from 15 % of the
 * frame height to 115 %, and all joints stay usable up to ~55-70 %; only then do the feet leave the
 * picture. So "closer" is asked only below MIN_BODY, and "back" only when joints are actually cut
 * off, never for a size that works.
 *
 * Landmarks are the tracker's: normalized to the camera image, un-mirrored. The preview of the
 * front camera is mirrored, so a body cut off at the image's left edge (x ≈ 0) appears at the
 * right of the screen, and the person should move to THEIR left.
 */

import type { ExerciseProfile } from './exerciseProfiles';

export type FramingKind =
  | 'no_person' | 'turn_upright' | 'move_back' | 'move_left' | 'move_right' | 'show_full_body' | 'move_closer'
  | 'good' | 'excellent';

export type Framing = {
  kind: FramingKind;
  /** Good enough for the server to start (every essential joint tracked in the picture). */
  ok: boolean;
  message: string;
  /** Essential joints tracked inside the picture / required. */
  visibleEssential: number;
  totalEssential: number;
  /** Visible landmarks of the 33 (visibility ≥ VIS). */
  visibleLandmarks: number;
  /** Mean visibility of the essential joints: the person-confidence figure. */
  confidence: number;
  /** Box of the visible joints, normalized to the camera image; null without a person. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Body height as a fraction of the picture height. */
  bodyHeight: number;
};

export const MESSAGES: Record<FramingKind, string> = {
  no_person: 'Step into view',
  turn_upright: 'Hold the phone upright',
  move_back: 'Move slightly back',
  move_left: 'Move a little to your left',
  move_right: 'Move a little to your right',
  show_full_body: 'Show your full body',
  move_closer: 'Move slightly closer',
  good: 'Perfect · hold still',
  excellent: 'Perfect · hold still',
};

/** A plank is framed by moving the phone (it lies on the floor beside the person), not the body. */
const PLANK_MESSAGES: Partial<Record<FramingKind, string>> = {
  move_back: 'Move the phone a little farther away',
  move_closer: 'Move the phone a little closer',
};
const messageFor = (kind: FramingKind, profile: ExerciseProfile) =>
  (profile.posture === 'plank' ? PLANK_MESSAGES[kind] : undefined) ?? MESSAGES[kind];

/** The server's confidence floor for a joint it computes on (backend config CONFIDENCE_MIN). */
export const VIS = 0.5;
/** A joint within this margin of the picture's edge counts as cut off. */
const EDGE = 0.02;
/** Below this body height the person is asked to come closer (detection holds to ~15 %). */
export const MIN_BODY = 0.12;
/** Excellent: comfortably sized and centred, nothing optional missing. */
const EXCELLENT_BODY: [number, number] = [0.3, 0.85];
const CENTRE: [number, number] = [0.2, 0.8];

type Lm = readonly [number, number, number, number];

/** Left-side landmark index → its right-side twin (MediaPipe numbering: odd left, even right). */
const twin = (i: number) => (i >= 11 && i % 2 === 1 ? i + 1 : i >= 12 && i % 2 === 0 ? i - 1 : i);
const isLeft = (i: number) => i >= 11 && i % 2 === 1;

export function assessFraming(landmarks: readonly Lm[] | null, profile: ExerciseProfile): Framing {
  // Side-on exercises need the essential chain on ONE side: judge the side closer to complete.
  const chain = profile.sides === 'either'
    ? [...new Set(profile.essential.map((i) => (isLeft(i) || i < 11 ? i : twin(i))))]
    : profile.essential;
  const total = chain.length;
  const empty: Framing = { kind: 'no_person', ok: false, message: MESSAGES.no_person, visibleEssential: 0, totalEssential: total, visibleLandmarks: 0, confidence: 0, box: null, bodyHeight: 0 };
  if (!landmarks || landmarks.length < 29) return empty;

  const tracked = (i: number) => (landmarks[i]?.[3] ?? 0) >= VIS;
  const inside = (i: number) => {
    const p = landmarks[i]!;
    return p[0] >= EDGE && p[0] <= 1 - EDGE && p[1] >= EDGE && p[1] <= 1 - EDGE;
  };
  const visibleLandmarks = landmarks.filter((p) => p[3] >= VIS).length;
  const body = [...profile.essential, ...profile.optional].filter(tracked);
  if (body.length < 3) return { ...empty, visibleLandmarks };

  const xs = body.map((i) => landmarks[i]![0]), ys = body.map((i) => landmarks[i]![1]);
  const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  const bodyHeight = Math.min(1, Math.max(0, Math.min(1, box.y1) - Math.max(0, box.y0)));
  const cx = (Math.max(0, box.x0) + Math.min(1, box.x1)) / 2;
  const ok = (i: number) => tracked(i) && inside(i);
  // For 'either', the left chain or its right twin, whichever has more joints in view.
  const essential = profile.sides === 'either' && chain.filter((i) => ok(twin(i))).length > chain.filter(ok).length
    ? chain.map(twin)
    : chain;
  const essentialOk = essential.filter(ok);
  const confidence = essential.reduce((a, i) => a + (landmarks[i]?.[3] ?? 0), 0) / total;
  const base = { visibleEssential: essentialOk.length, totalEssential: total, visibleLandmarks, confidence, box, bodyHeight };
  const verdict = (kind: FramingKind): Framing => ({ ...base, kind, ok: kind === 'good' || kind === 'excellent', message: messageFor(kind, profile) });

  // A standing body whose shoulders→hips axis runs across the picture: the phone is on its side.
  // Only from torso joints that are really in the picture: the model's guesses for joints outside
  // it (a person half out of view) can point anywhere.
  if (profile.posture === 'standing' && [11, 12, 23, 24].every((i) => tracked(i) && inside(i))) {
    const sx = (landmarks[11]![0] + landmarks[12]![0]) / 2, sy = (landmarks[11]![1] + landmarks[12]![1]) / 2;
    const hx = (landmarks[23]![0] + landmarks[24]![0]) / 2, hy = (landmarks[23]![1] + landmarks[24]![1]) / 2;
    if (Math.abs(hx - sx) > Math.abs(hy - sy) * 1.2) return verdict('turn_upright');
  }

  const missing = essential.filter((i) => !ok(i));
  if (missing.length > 0) {
    // Where are they lost? Cut off at an edge (their predicted position is outside the picture)
    // tells the direction to move; otherwise they are hidden.
    const off = missing.map((i) => landmarks[i]!);
    const below = off.some((p) => p[1] > 1 - EDGE), above = off.some((p) => p[1] < EDGE);
    const leftEdge = off.some((p) => p[0] < EDGE), rightEdge = off.some((p) => p[0] > 1 - EDGE);
    // Too big for the picture (cut off at the top/bottom, or wider than most of it): step back.
    // Only a body that fits but sits to one side is asked to move sideways.
    const tooWide = Math.min(1, box.x1) - Math.max(0, box.x0) > 0.75;
    // In a plank the phone is on the floor beside the person: cut off anywhere, the phone moves.
    if (below || above || tooWide || (profile.posture === 'plank' && (leftEdge || rightEdge))) return verdict('move_back');
    if (leftEdge && !rightEdge) return verdict('move_left');    // image left = screen right (mirrored)
    if (rightEdge && !leftEdge) return verdict('move_right');
    if (leftEdge && rightEdge) return verdict('move_back');
    return verdict('show_full_body');
  }
  if (bodyHeight < MIN_BODY) return verdict('move_closer');
  const centred = cx >= CENTRE[0] && cx <= CENTRE[1];
  const allOptional = profile.optional.every(tracked);
  return verdict(centred && allOptional && bodyHeight >= EXCELLENT_BODY[0] && bodyHeight <= EXCELLENT_BODY[1] ? 'excellent' : 'good');
}

/**
 * Framing changes shown to the person only once they last: one noisy frame must not flash
 * "Move back" and a joint hovering at the confidence floor must not flicker the message. A change
 * is adopted after it has held for `holdMs`; a return to what is shown cancels it.
 */
export class FramingStabilizer {
  private shown: Framing | null = null;
  private candidate: FramingKind | null = null;
  private since = 0;

  constructor(private readonly holdMs = 400) {}

  update(next: Framing, nowMs: number): Framing {
    if (!this.shown) {
      this.shown = next;
      return next;
    }
    if (next.kind === this.shown.kind) {
      this.candidate = null;
      this.shown = next;                       // same verdict: take the fresh measurements
      return next;
    }
    if (next.kind !== this.candidate) {
      this.candidate = next.kind;
      this.since = nowMs;
    }
    if (nowMs - this.since >= this.holdMs) {
      this.shown = next;
      this.candidate = null;
    }
    return { ...next, kind: this.shown.kind, ok: this.shown.ok, message: this.shown.message };
  }

  reset(): void {
    this.shown = null;
    this.candidate = null;
  }
}
