/**
 * Community services (Dev A): post-meetup ratings and the ambassador programme.
 * Eligibility, trust scores and application decisions all come from the backend.
 */
import { campusApi } from '@/api/campus';
import type { MeetupRatingInput } from '@/api/campus/types';

const key = (kind: string, id: string) => `${kind}:${id}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const getMeetupRating = (meetupId: string) => campusApi.meetupRating(meetupId);
/** One key per submission attempt: a retried request after a timeout can't double-count. */
export const submitMeetupRating = (meetupId: string, input: MeetupRatingInput, idempotencyKey = key('rating', meetupId)) => campusApi.rateMeetup(meetupId, input, idempotencyKey);

export const getAmbassador = () => campusApi.ambassador();
export const applyAmbassador = (answers: Record<string, string>, idempotencyKey = key('ambassador', 'me')) => campusApi.applyAmbassador(answers, idempotencyKey);
