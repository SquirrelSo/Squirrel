/**
 * Poke → Poke back → Friends service. The backend decides everything (validity, mutual poke,
 * friendship); these just call it. UI state lives in state/socialStore.ts.
 */
import { campusApi, featureUnavailable } from '@/api/campus';
import { CAMPUS_ON_SOCIAL } from '@/api/config';
import { notificationPrefsApi, notificationPrefsLive } from '@/api/notificationPrefs';

const key = (kind: string, userId: string) => `${kind}:${userId}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const getPokeStatus = (userId: string) => campusApi.pokeStatus(userId);
export const sendPoke = (userId: string) => campusApi.sendPoke(userId, key('poke', userId));
export const pokeBack = (userId: string) => campusApi.pokeBack(userId, key('poke-back', userId));
export const getIncomingPokes = () => campusApi.incomingPokes();
export const getFriendshipStatus = (userId: string) => campusApi.friendshipStatus(userId);
export const getNotifications = (cursor?: string | null) => campusApi.notifications(cursor);
export const markNotificationsRead = (ids: string[]) => campusApi.markNotificationsRead(ids);

/** Social's own read routes, when it's the service serving the list (ids from elsewhere aren't its). */
const ownReadRoutes = () => CAMPUS_ON_SOCIAL && notificationPrefsLive();

/** One row read: POST /v1/notifications/{id}/read; not deployed yet → the bulk call with that one id. */
export async function markNotificationRead(id: string): Promise<{ unread: number }> {
  if (ownReadRoutes()) {
    try {
      return await notificationPrefsApi.markRead(id);
    } catch (e) {
      if (!featureUnavailable(e)) throw e;
    }
  }
  return campusApi.markNotificationsRead([id]);
}

/** Everything read: POST /v1/notifications/read-all; not deployed yet → the bulk call (empty = all). */
export async function markAllNotificationsRead(): Promise<{ unread: number }> {
  if (ownReadRoutes()) {
    try {
      return await notificationPrefsApi.markAllRead();
    } catch (e) {
      if (!featureUnavailable(e)) throw e;
    }
  }
  return campusApi.markNotificationsRead([]);
}
