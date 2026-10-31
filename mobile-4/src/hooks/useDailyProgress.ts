/**
 * Today's progress from the Run Module (GET /v1/progress/daily): steps, active minutes,
 * calories, workouts, the day's goals and your streak. One cached request shared by Home and
 * Today's goals.
 *
 *   state 'not_configured'  no EXPO_PUBLIC_API_URL in this build
 *   state 'signed_out'      configured, but there's no session to read it with
 *   state 'ready'           `data` is the server's answer (which may be all zeros — that's real)
 * Loading / error come from the request itself. Nothing is ever filled in locally.
 */
import { PROGRESS_READS_CONFIGURED, progressApi, progressReadsLive, type DailyProgress } from '@/api/progress';
import { useRemote } from '@/api/useRemote';
import { useAuth } from '@/auth/AuthProvider';

export type DailyProgressState = 'not_configured' | 'signed_out' | 'ready';

export function useDailyProgress() {
  const { mode } = useAuth();
  const live = progressReadsLive(mode);
  const r = useRemote<DailyProgress>(live ? 'progress:daily' : null, () => progressApi.daily());
  const state: DailyProgressState = !PROGRESS_READS_CONFIGURED ? 'not_configured' : !live ? 'signed_out' : 'ready';
  return { ...r, state };
}
