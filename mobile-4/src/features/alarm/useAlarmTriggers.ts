/**
 * Mounted once in the root layout: re-registers alarms with the platform at start-up and opens
 * the challenge when an alarm goes off while the app is open. Taps on an alarm notification come
 * through notifications/push.ts (openRoute), which hands them to AlarmService.fire as well.
 */
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { router, type Href } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { AlarmService } from '@/features/alarm/AlarmService';

export function useAlarmTriggers(ready: boolean) {
  useEffect(() => {
    void AlarmService.resync();
  }, []);

  useEffect(() => {
    if (!ready) return;
    AlarmService.setFireHandler((route) => router.push(route as Href));
    return () => AlarmService.setFireHandler(null);
  }, [ready]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    // App in the foreground when the alarm rings: go straight to the challenge.
    const sub = Notifications.addNotificationReceivedListener((n) => {
      const id = AlarmService.alarmIdOf(n.request.content.data);
      if (id) AlarmService.fire(id);
    });
    return () => sub.remove();
  }, []);
}
