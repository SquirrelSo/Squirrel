/**
 * The movement challenges an alarm can require. To add one: add an entry here (its rule drives the
 * engine in movementEngine.ts; its copy and icon drive the UI) — nothing else needs to change.
 * Pure data + logic (no React Native), unit-tested in movementEngine.test.mjs.
 */
import type { ChallengeRule } from './movementEngine.ts';

export type ChallengeId = 'dance' | 'squats' | 'jumping' | 'shake';

export type ChallengeDef = {
  id: ChallengeId;
  label: string; // "Dance"
  /** What to do, imperative: "Dance", "Do squats". */
  verb: string;
  /** Material Community icon name. */
  icon: string;
  unit: 'sec' | 'reps';
  amounts: number[];
  defaultAmount: number;
  /** One line under the title while moving. */
  howTo: string;
  /** What happens if you stop, said plainly on the setup and challenge screens. */
  stopRule: string;
  rule: (amount: number) => ChallengeRule;
};

export const CHALLENGES: ChallengeDef[] = [
  {
    id: 'dance',
    label: 'Dance',
    verb: 'Dance',
    icon: 'music-note',
    unit: 'sec',
    amounts: [10, 20, 30, 45],
    defaultAmount: 20,
    howTo: 'Phone in hand or pocket. Bop, wiggle, vibe — just don’t stop.',
    stopRule: 'Stop and the timer pauses until you move again.',
    rule: (target) => ({ kind: 'continuous', target, moveThreshold: 1.1, graceMs: 1200, onStop: 'pause' }),
  },
  {
    id: 'squats',
    label: 'Squats',
    verb: 'Do squats',
    icon: 'human-handsdown',
    unit: 'reps',
    amounts: [5, 10, 15, 20],
    defaultAmount: 10,
    howTo: 'Hold your phone against your chest. Down, up — that’s one.',
    stopRule: 'Every rep counts; nothing is taken away if you pause.',
    rule: (target) => ({ kind: 'reps', target, peak: 2.4, settle: 0.9, minGapMs: 900, nudgeAfterMs: 6000 }),
  },
  {
    id: 'jumping',
    label: 'Jumps',
    verb: 'Jump',
    icon: 'arrow-up-bold-circle-outline',
    unit: 'reps',
    amounts: [5, 10, 15, 20],
    defaultAmount: 10,
    howTo: 'Hold your phone tight. Each jump and landing is one.',
    stopRule: 'Every jump counts; nothing is taken away if you pause.',
    rule: (target) => ({ kind: 'reps', target, peak: 7, settle: 2.2, minGapMs: 380, nudgeAfterMs: 5000 }),
  },
  {
    id: 'shake',
    label: 'Shake it',
    verb: 'Shake it',
    icon: 'vibrate',
    unit: 'sec',
    amounts: [10, 15, 20, 30],
    defaultAmount: 15,
    howTo: 'Shake your phone (and yourself) without stopping.',
    stopRule: 'Stop for 3 seconds and it starts over.',
    rule: (target) => ({ kind: 'continuous', target, moveThreshold: 2.2, graceMs: 900, onStop: 'reset', resetAfterMs: 3000 }),
  },
];

export const challengeById = (id: string): ChallengeDef => CHALLENGES.find((c) => c.id === id) ?? CHALLENGES[0];

/** "Dance · 20 sec" */
export const challengeSummary = (id: string, amount: number) => {
  const c = challengeById(id);
  return `${c.label} · ${amount} ${c.unit === 'sec' ? 'sec' : amount === 1 ? 'rep' : 'reps'}`;
};
