import type { IconName } from '@/data/icons';

/**
 * PARTNER HUNT copy for the locked screen (LOCKED.partnerHunt). The feature itself runs on Exercise:
 * api/partnerHunt.ts (contract), logic/partnerHunt.ts (rules), app/partner-hunt/* (screens).
 */

export type PartnerHuntStep = { id: 'find' | 'preferences' | 'matching' | 'profiles' | 'connect'; title: string; body: string; icon: IconName };

export const PARTNER_HUNT_FLOW: PartnerHuntStep[] = [
  { id: 'find', title: 'Find your buddy', body: 'Say you’re up for a training partner.', icon: 'account-search-outline' },
  { id: 'preferences', title: 'Set your vibe', body: 'Campus, interests, when you train, what you’re chasing.', icon: 'tune-variant' },
  { id: 'matching', title: 'Get matched', body: 'We line you up with people who move like you.', icon: 'lightning-bolt' },
  { id: 'profiles', title: 'Check buddy profiles', body: 'Levels, streaks and favourite workouts.', icon: 'card-account-details-outline' },
  { id: 'connect', title: 'Connect & train', body: 'Say hi, plan a session, earn XP together.', icon: 'handshake-outline' },
];

/** What matching will be based on. */
export type MatchFactor = { id: 'campus' | 'interests' | 'activities' | 'availability' | 'goals'; label: string; icon: IconName };
export const MATCH_FACTORS: MatchFactor[] = [
  { id: 'campus', label: 'Campus', icon: 'school-outline' },
  { id: 'interests', label: 'Interests', icon: 'heart-outline' },
  { id: 'activities', label: 'Activities', icon: 'run-fast' },
  { id: 'availability', label: 'Availability', icon: 'calendar-clock' },
  { id: 'goals', label: 'Goals', icon: 'flag-checkered' },
];
