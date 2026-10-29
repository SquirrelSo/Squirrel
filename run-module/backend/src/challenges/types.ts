export type ChallengeType = 'daily' | 'head_to_head' | 'group';
export type ChallengeState = 'pending' | 'active' | 'resolved' | 'cancelled';
export type ParticipantStatus = 'invited' | 'accepted' | 'declined';
export type Comparator = 'gte' | 'lte';

export interface Challenge {
  id: string;
  type: ChallengeType;
  title: string;
  metric: string;
  comparator: Comparator;
  threshold: number;
  startsAt: Date;
  endsAt: Date;
  xpReward: number;
  state: ChallengeState;
  createdBy: string;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface ChallengeParticipant {
  challengeId: string;
  userId: string;
  status: ParticipantStatus;
  joinedAt: Date;
  finalProgress: number | null;
  isWinner: boolean | null;
  xpAwarded: number | null;
}