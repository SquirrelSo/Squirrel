import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { EXERCISE_API_CONFIGURED } from '@/api/config';
import { exerciseApi } from '@/api/exercise';
import { invalidateRemote, useRemote } from '@/api/useRemote';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Exercise data hooks. Cache keys are shared, so screens reading the same resource
 * (e.g. Progress and the Exercise hub both read /progress) reuse one response.
 */

/** Exercise identity, or null when the backend isn't configured or no profile exists yet. */
export function useExerciseUser() {
  const { exerciseUser } = useAuth();
  return EXERCISE_API_CONFIGURED ? exerciseUser : null;
}

const k = (uid: string | undefined, what: string) => (EXERCISE_API_CONFIGURED && uid ? `ex:${uid}:${what}` : null);

export const useExerciseCatalog = () => useRemote(EXERCISE_API_CONFIGURED ? 'ex:catalog' : null, exerciseApi.catalog);
export const useExerciseProfile = (uid?: string) => useRemote(k(uid, 'profile'), () => exerciseApi.getProfile(uid!));
export const useExerciseSkill = (uid?: string) => useRemote(k(uid, 'skill'), () => exerciseApi.getSkill(uid!));
export const useExerciseProgress = (uid?: string) => useRemote(k(uid, 'progress'), () => exerciseApi.progress(uid!));
export const useExerciseSessions = (uid?: string) => useRemote(k(uid, 'sessions'), () => exerciseApi.sessions(uid!));
export const useExerciseActivity = (uid: string | undefined, year: number) => useRemote(k(uid, `activity:${year}`), () => exerciseApi.activity(uid!, year));
export const useSessionOverview = (uid: string | undefined, sid: string | undefined) =>
  useRemote(sid ? k(uid, `overview:${sid}`) : null, () => exerciseApi.overview(uid!, sid!));
export const useExerciseReport = (uid: string | undefined, sid: string, exerciseId: string | null) =>
  useRemote(exerciseId ? k(uid, `report:${sid}:${exerciseId}`) : null, () => exerciseApi.exerciseReport(uid!, sid, exerciseId!));

/** Drop a user's cached exercise data (after creating a session, switching profile…). */
export const invalidateExercise = (uid: string) => invalidateRemote(`ex:${uid}:`);

/** Re-run the given reloads whenever the screen regains focus (not on first mount). */
export function useReloadOnFocus(...reloads: (() => void)[]) {
  const first = useRef(true);
  const ref = useRef(reloads);
  useEffect(() => {
    ref.current = reloads;
  });
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      ref.current.forEach((r) => r());
    }, []),
  );
}
