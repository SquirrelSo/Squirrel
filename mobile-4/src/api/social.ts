/**
 * Profile + Social service (social-backend/). Same `api()` client, bearer token and ApiError as
 * the Run Module; only the base URL differs (EXPO_PUBLIC_SOCIAL_API_URL; unset, the social screens
 * show "Not connected" — there is no sample data).
 *
 *   GET    /v1/users/me/profile                       → Profile
 *   PATCH  /v1/users/me/profile                       UpdateProfileRequest → Profile
 *   GET    /v1/users/username/:username/availability  → UsernameAvailability
 *   GET    /v1/users/:id/profile                      → PublicProfile
 *   GET    /v1/users/:id/posts?cursor                 → Page<Post>
 *   POST   /v1/users/:id/follow · DELETE              → FollowResult (idempotent)
 *   GET    /v1/users/:id/follow-status                → FollowStatus
 *   GET    /v1/users/:id/followers|following?cursor   → Page<Follower>
 *   GET    /v1/users/me/follow-requests · POST|DELETE /v1/users/me/follow-requests/:id
 *   GET    /v1/users/search?q · /v1/users/suggestions → Page<Follower>
 *   GET    /v1/users/me/saved?cursor                  → Page<Post>
 *   GET    /v1/feed?feed=for_you|following|nearby&city&cursor&limit → FeedResponse
 *   POST   /v1/posts  CreatePostRequest → Post (201) · GET|DELETE /v1/posts/:id
 *   POST|DELETE /v1/posts/:id/like → LikeResult · POST|DELETE /v1/posts/:id/save → SaveResult
 *   GET|POST /v1/posts/:id/comments → CommentPage | Comment · DELETE /v1/comments/:id
 *   POST   /v1/media/uploads → UploadTicket · POST /v1/media/:id/complete → MediaStatus
 *
 * Errors: `{ detail, code }`, so ApiError.message is the server's human-readable detail.
 */
import { api, ApiError } from '@/api/client';
import { SOCIAL_API_URL } from '@/api/config';
import { withRetry } from '@/api/endpoints';
import type { AvatarLook, SceneKind } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Page<T> = { items: T[]; next_cursor: string | null };

export type PostSticker = 'one-more-km' | 'fire' | 'good-vibes' | 'neon-heart' | 'squirrel-flex' | 'hydrate';
export type ActivityType = 'run' | 'ride' | 'workout' | 'yoga' | 'meal';
export type Visibility = 'public' | 'private';
export type FeedKind = 'for_you' | 'following' | 'nearby';

/** Author block on posts and comments: everything a row needs, nothing private. */
export type PostAuthor = {
  id: string;
  username: string;
  display_name: string;
  avatar_look: AvatarLook | null;
  avatar_url: string | null;
  level: number;
  verified: boolean;
};

/** Summary of a completed workout. `source` says who measured it; `verified` = measured, not self-reported. */
export type Activity = {
  id: string;
  type: ActivityType;
  source: 'run_module' | 'exercise' | 'manual';
  verified: boolean;
  name: string | null;
  distance_km: number | null;
  duration_minutes: number | null;
  pace: string | null;
  calories: number | null;
  started_at: string;
};

export type Post = {
  id: string;
  author: PostAuthor;
  caption: string;
  activity: Activity | null;
  city_id: string | null;
  area: string | null;
  backdrop: { scene: SceneKind; seed: number };
  media_url: string | null;
  sticker: PostSticker | null;
  crew_name: string | null;
  likes_count: number;
  comments_count: number;
  liked_by_me: boolean;
  saved_by_me: boolean;
  is_mine: boolean;
  /** You follow the author (accepted) / asked to (private account). */
  following_author: boolean;
  requested_author: boolean;
  created_at: string;
};

export type FeedResponse = Page<Post>;

export type FollowStatus = { following: boolean; followed_by: boolean; requested: boolean };
export type FollowResult = FollowStatus & { followers: number; following_count: number };

/** A row in followers / following / search / suggestions, with the viewer's relationship. */
export type Follower = PostAuthor & {
  city_id: string | null;
  area: string | null;
  interests: string[];
  followed_at: string | null;
  following: boolean;
  requested: boolean;
  is_me: boolean;
};

export type ProfileUser = {
  id: string;
  username: string;
  display_name: string;
  avatar_look: AvatarLook | null;
  avatar_url: string | null;
  /** null on a private profile you can't see */
  bio: string | null;
  city_id: string | null;
  area: string | null;
  college: string | null;
  hostel: string | null;
  interests: string[];
  visibility: Visibility;
  verified: boolean;
  created_at: string;
};

export type ProfileStats = {
  /** Server figure, synced from the Run Module (never computed on the device). */
  xp: number;
  level: number;
  level_xp: number;
  xp_per_level: number;
  xp_synced_at: string | null;
  streak_days: number;
  followers: number;
  following: number;
  posts: number;
  activities: number;
  /** This local month's verified totals ("47 km this month"): runs the Run Module accepted, measured workouts. */
  month: string | null;
  month_km: number;
  month_runs: number;
  month_workouts: number;
};

/** A crew the user is in: since when, and how many members vouch for them there. */
export type ProfileCrew = { id: string; name: string; interest: string; role: 'owner' | 'member'; member_since: string; vouches: number };

export type Badge = { id: string; kind: string; title: string; description: string; awarded_at: string };

export type PublicProfile = {
  user: ProfileUser;
  stats: ProfileStats;
  badges: Badge[];
  crews: ProfileCrew[];
  recent_posts: Post[];
  recent_activities: Activity[];
  is_me: boolean;
  /** Private account you don't follow: identity and counts only. */
  restricted: boolean;
  relationship: FollowStatus | null;
  username_confirmed: boolean | null;
};

/** The signed-in user's own profile. */
export type Profile = PublicProfile & { is_me: true; relationship: null; username_confirmed: boolean };

export type UpdateProfileRequest = Partial<{
  username: string;
  display_name: string;
  bio: string;
  city_id: string | null;
  area: string | null;
  college: string | null;
  hostel: string | null;
  interests: string[];
  avatar_look: AvatarLook | null;
  avatar_media_id: string | null;
  visibility: Visibility;
}>;

export type UsernameAvailability = { username: string; available: boolean; reason: string | null };

/**
 * What a post can carry as its activity. Runs are referenced by the Run Module's `run_id` and
 * the server fetches the numbers; other modules publish activities the post references by id;
 * `manual` is self-reported and shown as unverified.
 */
export type ActivityInput =
  | { source: 'run'; run_id: string }
  | { source: 'activity'; activity_id: string }
  | { source: 'manual'; type: Exclude<ActivityType, 'run'>; name?: string; distance_km?: number; duration_minutes?: number; calories?: number };

export type CreatePostRequest = {
  caption: string;
  backdrop?: { scene: SceneKind; seed: number };
  sticker?: PostSticker | null;
  crew_name?: string | null;
  city_id?: string | null;
  area?: string | null;
  media_id?: string | null;
  activity?: ActivityInput | null;
};

export type LikeResult = { liked: boolean; likes_count: number };
export type SaveResult = { saved: boolean };

export type Comment = { id: string; post_id: string; author: PostAuthor; body: string; created_at: string; can_delete: boolean };
export type CommentPage = Page<Comment> & { total: number };

export type UploadTicket = { media_id: string; upload_url: string; method: 'PUT'; headers: Record<string, string>; expires_at: string };
/** What Social stores photos for (it refuses anything else with a 422). */
export type UploadPurpose = 'post' | 'avatar';
/** Social sends no `moderation` today; a missing verdict means nothing to wait for. */
export type MediaStatus = { media_id: string; status: 'pending' | 'ready'; url: string | null; moderation?: 'pending' | 'approved' | 'rejected' | null; rejection_reason?: string | null };

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const s = <T>(path: string, init: { method?: string; body?: unknown } = {}) => api<T>(path, { ...init, base: SOCIAL_API_URL });
/** Reads and idempotent writes retry (429 / network / 5xx); creates don't, so a retry can't double post. */
const safe = <T>(path: string, init: { method?: string; body?: unknown } = {}) => withRetry(() => s<T>(path, init));
const id = encodeURIComponent;

function qs(params: Record<string, string | number | null | undefined>) {
  const parts = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export const profileApi = {
  me: () => safe<Profile>('/v1/users/me/profile'),
  update: (body: UpdateProfileRequest) => s<Profile>('/v1/users/me/profile', { method: 'PATCH', body }),
  usernameAvailability: (username: string) => safe<UsernameAvailability>(`/v1/users/username/${id(username)}/availability`),
  get: (userId: string) => safe<PublicProfile>(`/v1/users/${id(userId)}/profile`),
  posts: (userId: string, cursor?: string | null) => safe<Page<Post>>(`/v1/users/${id(userId)}/posts${qs({ cursor })}`),
  saved: (cursor?: string | null) => safe<Page<Post>>(`/v1/users/me/saved${qs({ cursor })}`),
  search: (q: string) => safe<Page<Follower>>(`/v1/users/search${qs({ q })}`),
  suggestions: (limit = 10) => safe<Page<Follower>>(`/v1/users/suggestions${qs({ limit })}`),
};

export const followApi = {
  follow: (userId: string) => safe<FollowResult>(`/v1/users/${id(userId)}/follow`, { method: 'POST' }),
  unfollow: (userId: string) => safe<FollowResult>(`/v1/users/${id(userId)}/follow`, { method: 'DELETE' }),
  status: (userId: string) => safe<FollowStatus>(`/v1/users/${id(userId)}/follow-status`),
  followers: (userId: string, cursor?: string | null) => safe<Page<Follower>>(`/v1/users/${id(userId)}/followers${qs({ cursor })}`),
  following: (userId: string, cursor?: string | null) => safe<Page<Follower>>(`/v1/users/${id(userId)}/following${qs({ cursor })}`),
  requests: (cursor?: string | null) => safe<Page<Follower>>(`/v1/users/me/follow-requests${qs({ cursor })}`),
  accept: (userId: string) => safe<FollowStatus>(`/v1/users/me/follow-requests/${id(userId)}`, { method: 'POST' }),
  decline: (userId: string) => safe<FollowStatus>(`/v1/users/me/follow-requests/${id(userId)}`, { method: 'DELETE' }),
};

export const feedApi = {
  get: (feed: FeedKind, opts: { cursor?: string | null; city?: string | null; limit?: number } = {}) =>
    safe<FeedResponse>(`/v1/feed${qs({ feed, city: feed === 'nearby' ? opts.city : null, cursor: opts.cursor, limit: opts.limit })}`),
};

export const postsApi = {
  create: (body: CreatePostRequest) => s<Post>('/v1/posts', { body }),
  get: (postId: string) => safe<Post>(`/v1/posts/${id(postId)}`),
  remove: (postId: string) => s<void>(`/v1/posts/${id(postId)}`, { method: 'DELETE' }),
  like: (postId: string) => safe<LikeResult>(`/v1/posts/${id(postId)}/like`, { method: 'POST' }),
  unlike: (postId: string) => safe<LikeResult>(`/v1/posts/${id(postId)}/like`, { method: 'DELETE' }),
  save: (postId: string) => safe<SaveResult>(`/v1/posts/${id(postId)}/save`, { method: 'POST' }),
  unsave: (postId: string) => safe<SaveResult>(`/v1/posts/${id(postId)}/save`, { method: 'DELETE' }),
};

export const commentsApi = {
  list: (postId: string, cursor?: string | null) => safe<CommentPage>(`/v1/posts/${id(postId)}/comments${qs({ cursor })}`),
  create: (postId: string, body: string) => s<Comment>(`/v1/posts/${id(postId)}/comments`, { body: { body } }),
  remove: (commentId: string) => s<void>(`/v1/comments/${id(commentId)}`, { method: 'DELETE' }),
};

/**
 * Photo upload: ticket → PUT bytes straight to storage → complete → reference `media_id`.
 * No image bytes ever go through the JSON API.
 */
export const mediaApi = {
  createUpload: (purpose: UploadPurpose, contentType: string, byteSize: number) =>
    s<UploadTicket>('/v1/media/uploads', { body: { purpose, content_type: contentType, byte_size: byteSize } }),
  complete: (mediaId: string) => s<MediaStatus>(`/v1/media/${id(mediaId)}/complete`, { method: 'POST' }),
  async upload(purpose: UploadPurpose, file: Blob, contentType: string): Promise<MediaStatus> {
    const ticket = await mediaApi.createUpload(purpose, contentType, file.size);
    const res = await fetch(ticket.upload_url, { method: ticket.method, headers: ticket.headers, body: file });
    if (!res.ok) throw new ApiError(res.status, 'Upload failed. Try again.');
    return mediaApi.complete(ticket.media_id);
  },
};

// ---------------------------------------------------------------------------
// Error text
// ---------------------------------------------------------------------------

/** One user-facing sentence for any social API failure. */
export function socialErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong. Try again.';
  switch (e.status) {
    case 0:
      return e.message === 'Request timed out' ? 'That took too long. Check your connection and try again.' : "You're offline. Check your connection and try again.";
    case 401:
      return 'Your session expired. Sign in again.';
    case 403:
    case 409:
    case 422:
      return e.message;
    case 404:
      return e.message && e.message !== 'Not Found' ? e.message : "That's not here any more.";
    case 429:
      return 'Slow down a little and try again in a moment.';
    default:
      return e.status >= 500 ? 'Server hiccup. Try again in a moment.' : e.message;
  }
}

export const isAuthError = (e: unknown) => e instanceof ApiError && e.status === 401;
