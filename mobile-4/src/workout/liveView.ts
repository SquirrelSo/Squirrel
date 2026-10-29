/**
 * What the live workout screen shows, derived from the coaching session's state (pure).
 * Wording follows the browser coach: "hold still for tracking" when the body can't be read,
 * "turn side-on" when a rule says the camera angle makes the reading meaningless (push-up).
 */

import type { CoachState } from './coach';
import type { TrackerStatus } from './tracker/types';
import type { WSRepTrain } from './protocol/types';
import type { WSTimedTrainContract } from './protocol/timedContract';

export type LiveView = {
  /** One line under the counter: what the user should do right now. */
  status: string;
  /** The coach's correction, when there is one. */
  cue: string | null;
  skeleton: 'green' | 'red' | 'white';
  /** Rep exercises: reps done / target. Timed: seconds left / set length. */
  count: number;
  target: number;
  timed: boolean;
  /** 0..1 for the progress ring. */
  progress: number;
  /** Latest Workout Score for this set (0–100), when the server has scored one. */
  score: number | null;
  /** Setup capture progress (0..1) while holding still. */
  capture: number | null;
  /** Seconds left to get into position, while getting ready. */
  getReady: number | null;
};

const isTimed = (t: CoachState['train']): t is WSTimedTrainContract =>
  !!t && (t as WSTimedTrainContract).set?.movement_type === 'time';

export function liveView(s: CoachState | null, tracker: TrackerStatus, targetReps: number, targetSeconds: number): LiveView {
  const timedPlan = s?.measure === 'time';
  const base: LiveView = {
    status: '', cue: null, skeleton: 'white', count: 0, target: timedPlan ? targetSeconds : targetReps,
    timed: timedPlan, progress: 0, score: null, capture: null, getReady: null,
  };
  if (tracker === 'loading') return { ...base, status: 'Starting body tracking…' };
  if (!s) return { ...base, status: 'Getting your workout ready…' };

  // Framing (framing.ts) says the one thing to change about where the person stands; it follows
  // the person instead of asking everyone to step far back.
  const framing = s.framing;
  const framingProblem = framing && !framing.ok ? framing.message : null;

  if (s.phase === 'getready') {
    return {
      ...base,
      getReady: s.getReadyLeft,
      status: framingProblem ?? (framing ? framing.message : 'Step into view'),
      skeleton: s.inView ? 'green' : 'red',
    };
  }

  if (s.phase === 'setup') {
    const d = s.setup;
    if (!s.connected || !d) return { ...base, status: 'Connecting to your coach…' };
    const failure = d.failures[0] ?? null;
    const bad = d.missing.length > 0 || !!failure || !!framingProblem;
    // Where to stand comes first: the server can still see joints the model placed outside the
    // picture, or a sideways body, and would only say the position is wrong.
    const status = framingProblem ?? (d.missing.length > 0
      ? 'Show your full body'
      : d.phase === 'collecting' ? 'Hold still…'
        : d.phase === 'validating' ? 'Checking your position…'
          : d.phase === 'ready' ? 'Ready!'
            : 'Get into your starting position');
    return {
      ...base,
      status,
      cue: failure?.cue ?? d.cue?.text ?? null,
      skeleton: bad ? 'red' : d.phase === 'collecting' || d.phase === 'validating' ? 'green' : 'white',
      capture: d.phase === 'collecting' || d.phase === 'validating' ? d.capture.progress : null,
    };
  }
  if (s.phase === 'starting') return { ...base, status: 'Go!', skeleton: 'green' };
  if (s.phase === 'rest') return { ...base, status: `Set ${s.set} done` };
  if (s.phase === 'done') return { ...base, status: 'Workout done' };

  // training
  const t = s.train;
  if (!t) return { ...base, status: 'Go!', skeleton: 'green' };
  if (isTimed(t)) {
    const redIssue = t.issues.some((i) => i.skeleton_color === 'red');
    return {
      ...base,
      timed: true,
      status: !t.tracking.available ? 'Hold still for tracking' : `${t.movement.counted_lifts} knee lifts`,
      cue: t.cue?.text ?? null,
      skeleton: !t.tracking.available ? 'white' : redIssue ? 'red' : 'green',
      count: Math.ceil(t.set.remaining_ms / 1000),
      target: Math.round(t.set.target_duration_ms / 1000),
      progress: t.set.target_duration_ms ? Math.min(1, t.set.elapsed_ms / t.set.target_duration_ms) : 0,
      score: t.score.score == null ? null : Math.round(t.score.score),
    };
  }
  const r = t as WSRepTrain;
  const redIssue = r.issues.some((i) => i.skeleton_color === 'red');
  // Only controlled reps count; the rest are tallied so the number never looks stuck. Shallow reps
  // count with a warning, and are tallied too.
  const notCounted = r.counters.not_counted.shallow + r.counters.not_counted.too_fast;
  const tallies = [
    r.counters.shallow > 0 ? `${r.counters.shallow} shallow` : null,
    notCounted > 0 ? `${notCounted} not counted` : null,
  ].filter(Boolean);
  const status = r.tracking.invalidated_by.length > 0
    ? 'Turn side-on to the camera'
    : !r.tracking.available ? 'Hold still for tracking'
      : ['Live coaching', ...tallies].join(' · ');
  const score = r.last_rep?.score ?? r.set.average_score;
  return {
    ...base,
    timed: false,
    status,
    cue: r.cue?.text ?? null,
    skeleton: !r.tracking.available ? 'white' : redIssue ? 'red' : 'green',
    count: r.set.completed_reps,
    target: r.set.target_reps,
    progress: r.set.target_reps ? Math.min(1, r.set.completed_reps / r.set.target_reps) : 0,
    score: score == null ? null : Math.round(score),
  };
}
