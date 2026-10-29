/**
 * WELCOME — the title screen. It should read like a game's opening screen in two seconds:
 * SQUIRREL SOCIAL → YOUR CAMPUS. YOUR GAME. → the campus at dusk with the squirrel → ENTER.
 * The one live line (people moving right now) comes from GET /v1/campus/stats and the
 * realtime channel; it's hidden when the backend isn't reachable. Nothing is hardcoded.
 */
import { useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { CampusScene } from '@/art/CampusScene';
import { Mascot } from '@/art/Mascot';
import { campusApi, type LaunchStats } from '@/api/campus';
import { useAuth } from '@/auth/AuthProvider';
import { Wordmark } from '@/components/Brand';
import { SourceBadge } from '@/components/campus/States';
import { Button, Display, FadeIn, Pulse } from '@/components/ui';
import { useCampus, useConfig, useRealtime } from '@/hooks/useCampus';
import { colors, fonts, MAX_WIDTH } from '@/theme';

export default function Welcome() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { continueDemo } = useAuth();
  const config = useConfig();
  const stats = useCampus<LaunchStats>('stats', () => campusApi.stats(), { needsAuth: false });
  const [pushed, setPushed] = useState<LaunchStats | null>(null);
  useRealtime((m) => {
    if (m.type === 'stats.updated') setPushed(m.data);
  });
  const s = pushed && (!stats.data || pushed.updated_at >= stats.data.updated_at) ? pushed : stats.data;
  const campusName = config.data?.campus.name ?? 'IISER Kolkata';
  const w = Math.min(width, MAX_WIDTH);
  const h1 = Math.min(68, w * 0.16, height * 0.085);
  const mascot = Math.min(170, w * 0.4, height * 0.2);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <CampusScene style={StyleSheet.absoluteFill} />
      {/* Keep the title and the buttons readable over the scene */}
      <LinearGradient colors={['rgba(5,5,7,0.85)', 'rgba(5,5,7,0)']} style={[styles.fade, { top: 0, height: height * 0.34 }]} pointerEvents="none" />
      <LinearGradient colors={['rgba(5,5,7,0)', 'rgba(5,5,7,0.92)', '#050507']} locations={[0, 0.45, 1]} style={[styles.fade, { bottom: 0, height: height * 0.42 }]} pointerEvents="none" />

      <View style={[styles.content, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 18 }]}>
        <View style={styles.top}>
          <Wordmark size={22} color={colors.onImage} />
          <SourceBadge />
        </View>

        <FadeIn from={24} style={{ marginTop: height * 0.04 }}>
          <Display size={h1} color={colors.onImage} style={styles.title}>Your campus.</Display>
          <Display size={h1} color={colors.primary} style={[styles.title, { marginTop: -h1 * 0.12 }]}>Your game.</Display>
        </FadeIn>

        {/* The squirrel stands on the lamp-lit path */}
        <View style={styles.stage} pointerEvents="none">
          <FadeIn delay={250} from={18}>
            <Mascot pose="wave" size={mascot} animated />
          </FadeIn>
        </View>

        <FadeIn delay={450} style={{ gap: 10 }}>
          <View style={styles.place}>
            <Text style={styles.placeText}>{campusName}</Text>
            {s && s.users_active_now > 0 && (
              <View style={styles.live} accessibilityLabel={`${s.users_active_now} moving on campus right now`}>
                <View style={styles.dot}>
                  <Pulse size={7} color={colors.green} />
                </View>
                <Text style={styles.liveText}>{s.users_active_now} moving right now</Text>
              </View>
            )}
          </View>
          <Button label={`Enter ${campusName}`} icon="arrow-right" onPress={() => router.push({ pathname: '/sign-in', params: { mode: 'join' } })} />
          <Button
            label="Look around first"
            variant="secondary"
            size="md"
            onPress={() => {
              continueDemo();
              router.push('/onboarding');
            }}
          />
          <Text style={styles.signIn} onPress={() => router.push('/sign-in')} accessibilityRole="link">
            Already a Squirrel? <Text style={{ color: colors.onImage, fontFamily: fonts.semibold }}>Sign in</Text>
          </Text>
        </FadeIn>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#050507', overflow: 'hidden' },
  fade: { position: 'absolute', left: 0, right: 0 },
  content: { flex: 1, paddingHorizontal: 22, width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { transform: [{ rotate: '-3deg' }] },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 6 },
  place: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 2 },
  placeText: { color: colors.onImage, fontFamily: fonts.labelBold, fontSize: 16, letterSpacing: 3, textTransform: 'uppercase' },
  live: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
  liveText: { color: colors.onImageSub, fontFamily: fonts.label, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase' },
  signIn: { color: colors.onImageSub, fontFamily: fonts.regular, fontSize: 13, textAlign: 'center', paddingVertical: 6 },
});
