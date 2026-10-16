/**
 * "About you" — Exercise (EXPO_PUBLIC_EXERCISE_API_URL), for the signed-in user:
 *   GET /api/me/profile-details   the form as saved; before the first save, what the account already
 *                                 knows (name, sign-in email, phone, gender, date of birth) and null
 *                                 for the rest
 *   PUT /api/me/profile-details   save the whole form; 422 with per-field errors changes nothing
 * Age is never stored: Exercise works it out from the date of birth.
 */
import { api } from '@/api/client';
import { EXERCISE_API_CONFIGURED, EXERCISE_API_URL } from '@/api/config';
import type { detailsBody } from '@/logic/profileValidation';

export type SavedProfileDetails = {
  full_name: string | null;
  personal_email: string | null;
  /** The address you sign in with; it can't be changed here. */
  college_email: string | null;
  phone: string | null;
  gender: string | null;
  date_of_birth: string | null;
  age: number | null;
  course: string | null;
  cgpa: number | null;
};

export const PROFILE_DETAILS_CONFIGURED = EXERCISE_API_CONFIGURED;

export const profileDetailsApi = {
  get: () => api<SavedProfileDetails>('/api/me/profile-details', { base: EXERCISE_API_URL }),
  save: (body: ReturnType<typeof detailsBody>) => api<SavedProfileDetails>('/api/me/profile-details', { base: EXERCISE_API_URL, method: 'PUT', body }),
};
