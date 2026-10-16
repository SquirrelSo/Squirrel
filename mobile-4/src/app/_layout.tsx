import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import '@/logic/runTracking'; // Register the background GPS task before Expo Router loads routes.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { Anton_400Regular } from '@expo-google-fonts/anton';
import {
  BarlowCondensed_500Medium,
  BarlowCondensed_600SemiBold,
  BarlowCondensed_700Bold,
  BarlowCondensed_700Bold_Italic,
  BarlowCondensed_800ExtraBold_Italic,
} from '@expo-google-fonts/barlow-condensed';
import { CormorantGaramond_600SemiBold, CormorantGaramond_700Bold } from '@expo-google-fonts/cormorant-garamond';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_900Black } from '@expo-google-fonts/inter';
import { AppStateProvider } from '@/state/AppState';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { LaunchSplash } from '@/components/LaunchSplash';
import { ToastHost } from '@/components/Toast';
import { SocialHost } from '@/components/social/SocialHost';
import { useAlarmTriggers } from '@/features/alarm/useAlarmTriggers';
import { colors, statusBarStyle } from '@/theme';

const sheet = { presentation: 'transparentModal', animation: 'fade', contentStyle: { backgroundColor: 'transparent' } } as const;

export default function RootLayout() {
  const [loaded] = useFonts({
    Anton_400Regular,
    BarlowCondensed_500Medium,
    BarlowCondensed_600SemiBold,
    BarlowCondensed_700Bold,
    BarlowCondensed_700Bold_Italic,
    BarlowCondensed_800ExtraBold_Italic,
    CormorantGaramond_600SemiBold,
    CormorantGaramond_700Bold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_900Black,
  });
  const [authReady, setAuthReady] = useState(false);
  // Re-registers alarms at start-up and opens the challenge when one goes off (once the navigator is up).
  useAlarmTriggers(loaded);

  // The launch splash overlays everything until the fonts are loaded and auth has restored the
  // saved session (and at least SPLASH_MIN_MS have passed, across its two screens). It stays mounted at one place in the
  // tree so its animation isn't restarted when the app mounts underneath it.
  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {loaded && (
      <AuthProvider>
      <AuthReady onReady={setAuthReady} />
      <AppStateProvider>
        <StatusBar style={statusBarStyle} />
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'slide_from_right' }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="welcome" options={{ animation: 'fade' }} />
            <Stack.Screen name="sign-in" options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
            <Stack.Screen name="run" options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="level-up" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
            <Stack.Screen name="highlight/[id]" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
            <Stack.Screen name="create" options={sheet} />
            <Stack.Screen name="exercise/select" options={sheet} />
            <Stack.Screen name="exercise/train/[key]" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom', gestureEnabled: false }} />
            <Stack.Screen name="city" options={sheet} />
            <Stack.Screen name="item/[id]" options={sheet} />
            <Stack.Screen name="compose" options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="alarm/ring/[id]" options={{ presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }} />
            <Stack.Screen name="alarm/edit" options={{ animation: 'slide_from_bottom' }} />
          </Stack>
          <SocialHost />
          <ToastHost />
        </View>
      </AppStateProvider>
      </AuthProvider>
      )}
      <LaunchSplash ready={loaded && authReady} />
      </View>
    </SafeAreaProvider>
  );
}

/** Tells the root layout once the saved session has been restored (the splash waits for it). */
function AuthReady({ onReady }: { onReady: (ready: boolean) => void }) {
  const { mode } = useAuth();
  useEffect(() => {
    if (mode !== 'loading') onReady(true);
  }, [mode, onReady]);
  return null;
}
