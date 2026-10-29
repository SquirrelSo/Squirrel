/**
 * Runs one movement challenge: detector samples → engine → React state, with haptics on progress.
 * The screen calls start(detector) / credit() and renders `state`; it hears about the outcome
 * through `onDone` / `onFail` (called from the sensor callbacks, not from effects).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createEngine, type EngineState } from '@/logic/movementEngine';
import { challengeById } from '@/logic/movementChallenges';
import { tap } from '@/components/ui';
import type { MovementDetector } from '@/features/alarm/MovementDetectionService';

type Options = { onDone?: (startedAt: number, doneAt: number) => void; onFail?: (error: unknown) => void };

export function useMovementChallenge(challengeId: string, amount: number, { onDone, onFail }: Options = {}) {
  const def = challengeById(challengeId);
  const [engine] = useState(() => createEngine(def.rule(amount)));
  const [state, setState] = useState<EngineState>(() => engine.tick(Date.now()));
  const [running, setRunning] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const startedAt = useRef<number | null>(null);
  const finished = useRef(false);
  const last = useRef({ progress: 0, status: state.status as EngineState['status'], ui: 0 });
  const cbs = useRef({ onDone, onFail });
  useEffect(() => {
    cbs.current = { onDone, onFail };
  });

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setRunning(false);
  }, []);

  const apply = useCallback(
    (s: EngineState, force = false) => {
      const l = last.current;
      // Haptics: a tick per second / rep, a buzz when you stop or it resets, a celebration when done.
      if (s.progress > l.progress) tap(s.status === 'done' ? 'success' : 'select');
      if ((s.status === 'stopped' && l.status === 'moving') || s.wasReset) tap('impact');
      const changed = s.progress !== l.progress || s.status !== l.status || s.wasReset;
      l.progress = s.progress;
      l.status = s.status;
      // Re-render on every change, and at most ~8×/s for the live intensity meter.
      if (force || changed || s.now - l.ui > 120) {
        l.ui = s.now;
        setState(s);
      }
      if (s.status === 'done' && !finished.current) {
        finished.current = true;
        stop();
        cbs.current.onDone?.(startedAt.current ?? s.now, s.now);
      }
    },
    [stop],
  );

  const start = useCallback(
    (detector: MovementDetector) => {
      if (stopRef.current || finished.current) return;
      startedAt.current ??= Date.now();
      setRunning(true);
      const fail = (e: unknown) => {
        stop();
        cbs.current.onFail?.(e);
      };
      try {
        stopRef.current = detector.start((sample) => apply(engine.push(sample)), fail);
      } catch (e) {
        fail(e);
      }
    },
    [apply, engine, stop],
  );

  // Sensors can go quiet when the phone is perfectly still: keep the clock moving for stop / reset rules.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => apply(engine.tick(Date.now()), true), 250);
    return () => clearInterval(t);
  }, [running, apply, engine]);

  useEffect(() => () => stopRef.current?.(), []);

  /** Backup challenge (no sensor): one catch = one rep / second. */
  const credit = useCallback(() => {
    startedAt.current ??= Date.now();
    apply(engine.credit(Date.now()), true);
  }, [apply, engine]);

  return { def, state, running, start, stop, credit };
}
