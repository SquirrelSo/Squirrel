/**
 * Push notifications (expo-notifications): this device's Expo push token goes to the Social
 * service (POST /v1/me/push-tokens), which sends territory steals, challenges, crew and event news
 * and check-ins. Tapping a notification opens its screen (`data.route`).
 *
 * Phones only: the web build and simulators have no Expo push token. Getting one also needs the
 * EAS project id (app.json `extra.eas.projectId`, written by `npx eas-cli@latest init`); without
 * it registration is skipped and the in-app notification list still works.
 */
import { useEffect } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { notificationsApi } from '@/api/community';
import { SOCIAL_API_CONFIGURED } from '@/api/config';
import { kindRoute } from '@/logic/notificationPrefs';
import { appRoute } from '@/notifications/routes';
import { AlarmService } from '@/features/alarm/AlarmService';

const NATIVE = Platform.OS === 'ios' || Platform.OS === 'android';
let registered: string | null = null;

if (NATIVE) {
  // Shown while the app is open too.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return Constants.easConfig?.projectId ?? extra?.eas?.projectId;
}

/** Ask once for permission and send this device's token to the Social service. */
export async function registerForPush(): Promise<string | null> {
  if (!NATIVE || !Device.isDevice || !SOCIAL_API_CONFIGURED) return null;
  const id = projectId();
  if (!id) return null;
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', { name: 'Squirrel Social', importance: Notifications.AndroidImportance.DEFAULT });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return null;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
    await notificationsApi.registerPushToken(token, Platform.OS === 'ios' ? 'ios' : 'android');
    registered = token;
    return token;
  } catch {
    return null; // offline or not set up: the in-app list still works; next sign-in tries again
  }
}

/** On sign-out: this device stops getting the account's pushes. */
export async function unregisterPush(): Promise<void> {
  const token = registered;
  registered = null;
  if (token) await notificationsApi.removePushToken(token).catch(() => undefined);
}

function openRoute(data: unknown) {
  // Movement alarms open through AlarmService, which waits for the navigator and won't stack a
  // challenge that's already on screen.
  const alarmId = AlarmService.alarmIdOf(data);
  if (alarmId) return AlarmService.fire(alarmId);
  // The newer kinds open a fixed screen (their server route can point where the app has none).
  const d = data as Record<string, unknown> | null;
  const fixed = typeof d?.kind === 'string' ? kindRoute(d.kind, d) : undefined;
  const route = fixed === undefined ? appRoute(d?.route) : fixed && appRoute(fixed);
  if (route) router.push(route as Href);
}

/** Register while signed in, and open the screen a tapped notification points to. */
export function usePushNotifications(signedIn: boolean) {
  useEffect(() => {
    if (signedIn) registerForPush();
  }, [signedIn]);
  useEffect(() => {
    if (!NATIVE) return;
    const sub = Notifications.addNotificationResponseReceivedListener((r) => openRoute(r.notification.request.content.data));
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      openRoute(last.notification.request.content.data);
      // A defeated alarm mustn't ring again when this mounts again.
      if (AlarmService.alarmIdOf(last.notification.request.content.data)) Notifications.clearLastNotificationResponse();
    }
    return () => sub.remove();
  }, []);
}
