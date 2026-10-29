import { Fragment, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { isThemeReload } from '@/components/ThemeToggle';
import { NATIVE } from '@/components/ui';
import { fonts } from '@/theme';

/**
 * Screen 2's lockups, exactly as supplied in the splash design (white-on-black versions, so they
 * sit on the splash's black without a frame) — displayed as-is, never redrawn or recoloured.
 */
const BACKED_BY = { name: 'Split Labs', logo: require('../../assets/brand/backers/splitlabs-lockup.png'), aspect: 496 / 389 };
const SUPPORTED_BY = { name: 'RISE Foundation', logo: require('../../assets/brand/backers/rise-foundation-dark.png'), aspect: 255 / 185 };

/** The full Squirrel Social artwork (squirrel over the graffiti wordmark), exactly as supplied. */
const WORDMARK = require('../../assets/brand/logo-wordmark.png');
const WORDMARK_ASPECT = 774 / 956;

/** Screen 1: the loading bar fills 0 → 100% over this long from launch. */
const BRAND_MS = 2000;
/** Screen 2 ("Backed by" / "Supported by") is on screen this long. */
const BACKERS_MS = 1000;
const CROSSFADE_MS = 250;
const FADE_OUT_MS = 300;
/** Minimum time the splash is on screen from app launch. Initialisation can make it longer, never shorter. */
export const SPLASH_MIN_MS = BRAND_MS + BACKERS_MS;

/** Both screens sit on black, whatever the theme, as in the design. */
const BLACK = '#000000';
const CREAM = '#F4ECDC';
const WHITE = '#FFFFFF';
const TRACK = '#262626';
const LIME = '#D7FF1F';

// Once per app launch: a remount (fast refresh, provider re-render) never shows it again, and a
// theme switch (which reloads the app) lands you straight back where you were — no second splash.
let shownThisLaunch = isThemeReload();
const launchedAt = Date.now();

/**
 * App-launch splash, two screens, then a fade into whatever the app's own startup flow picked:
 *   1. The Squirrel Social artwork, "THE PARAS MANI EFFECT" and a lime loading bar that fills
 *      over 2 s.
 *   2. "Backed by" Split Labs and "Supported by" RISE Foundation, for 1 s.
 * It's an overlay on the root layout, not a route, so it can't be navigated back to, and
 * routes/deep links mount underneath it.
 *
 * Screen 1 moves on once the bar is full AND `ready` is true (fonts loaded, auth restored): the
 * app's initialisation stays authoritative — on a slow start the full bar simply waits.
 */
export function LaunchSplash({ ready }: { ready: boolean }) {
  const { width, height } = useWindowDimensions();
  const [gone, setGone] = useState(shownThisLaunch);
  const [phase, setPhase] = useState<'brand' | 'backers'>('brand');
  const [barFull, setBarFull] = useState(() => Date.now() - launchedAt >= BRAND_MS);
  const [backersElapsed, setBackersElapsed] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [logo] = useState(() => new Animated.Value(0));
  const [lockup] = useState(() => new Animated.Value(0));
  const [progress] = useState(() => new Animated.Value(Math.min(1, (Date.now() - launchedAt) / BRAND_MS)));
  const [brand] = useState(() => new Animated.Value(1));
  const [backer] = useState(() => new Animated.Value(0));
  const [out] = useState(() => new Animated.Value(1));
  const leaving = useRef(false);
  const advancing = useRef(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotion)
      .catch(() => {});
  }, []);

  // Entrance, and the loading bar: a steady fill to 100% at BRAND_MS from launch (measured from
  // launch, not from this component's mount). Native-driven, so a busy JS thread can't stall it.
  useEffect(() => {
    if (gone) return;
    Animated.timing(logo, { toValue: 1, duration: reduceMotion ? 0 : 520, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE }).start();
    const left = Math.max(0, BRAND_MS - (Date.now() - launchedAt));
    const anim = Animated.timing(progress, { toValue: 1, duration: left, easing: Easing.linear, useNativeDriver: NATIVE });
    anim.start(({ finished }) => finished && setBarFull(true));
    return () => anim.stop();
  }, [gone, reduceMotion, logo, progress]);

  useEffect(() => {
    if (gone || !ready) return;
    Animated.timing(lockup, { toValue: 1, duration: reduceMotion ? 0 : 420, delay: reduceMotion ? 0 : 100, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE }).start();
  }, [gone, ready, reduceMotion, lockup]);

  // Screen 1 → 2: cross-fade to "Backed by".
  useEffect(() => {
    if (gone || phase !== 'brand' || !ready || !barFull || advancing.current) return;
    advancing.current = true;
    const d = reduceMotion ? 0 : 1;
    setPhase('backers');
    Animated.parallel([
      Animated.timing(brand, { toValue: 0, duration: CROSSFADE_MS * d, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE }),
      Animated.timing(backer, { toValue: 1, duration: CROSSFADE_MS * d, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE }),
    ]).start();
  }, [gone, phase, ready, barFull, reduceMotion, brand, backer]);

  // Screen 2's time on screen.
  useEffect(() => {
    if (gone || phase !== 'backers') return;
    const t = setTimeout(() => setBackersElapsed(true), BACKERS_MS);
    return () => clearTimeout(t);
  }, [gone, phase]);

  // Exit.
  useEffect(() => {
    if (gone || phase !== 'backers' || !backersElapsed || leaving.current) return;
    leaving.current = true;
    Animated.timing(out, { toValue: 0, duration: reduceMotion ? 0 : FADE_OUT_MS, easing: Easing.in(Easing.quad), useNativeDriver: NATIVE }).start(() => {
      shownThisLaunch = true;
      setGone(true);
    });
  }, [gone, phase, backersElapsed, reduceMotion, out]);

  if (gone) return null;

  const rise = (v: Animated.Value, from = 12) => ({ opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }] });
  // The artwork takes the room the lockup and bar leave, never wider than ~360pt.
  const artW = Math.min(width * 0.86, height * 0.52 * WORDMARK_ASPECT, 360);
  const barW = Math.min(width * 0.5, 220);
  const splitW = Math.min(width * 0.55, 220);
  const riseW = Math.min(width * 0.3, 116);

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.root, { opacity: out }]}
      pointerEvents={phase === 'backers' && backersElapsed ? 'none' : 'auto'}
      accessible
      accessibilityRole="header"
      accessibilityLabel={`Squirrel Social. The Paras Mani Effect. Backed by ${BACKED_BY.name}. Supported by ${SUPPORTED_BY.name}`}>
      {/* Screen 2 — Backed by / Supported by (underneath; revealed by the cross-fade). */}
      {phase === 'backers' && (
        <Animated.View style={[StyleSheet.absoluteFill, styles.backersScreen, { opacity: backer }]}>
          <View style={styles.backedBy}>
            <Text style={styles.backedByLabel}>BACKED BY</Text>
            <Image source={BACKED_BY.logo} style={{ width: splitW, height: splitW / BACKED_BY.aspect, marginTop: 44 }} resizeMode="contain" accessibilityIgnoresInvertColors />
          </View>
          <View style={styles.supportedBy}>
            <Text style={styles.supportedByLabel}>SUPPORTED BY</Text>
            <Image source={SUPPORTED_BY.logo} style={{ width: riseW, height: riseW / SUPPORTED_BY.aspect, marginTop: 10 }} resizeMode="contain" accessibilityIgnoresInvertColors />
          </View>
        </Animated.View>
      )}

      {/* Screen 1 — brand artwork, the lockup and the loading bar. */}
      <Animated.View style={[StyleSheet.absoluteFill, styles.brand, { opacity: brand }]} pointerEvents="none">
        <View style={styles.brandMain}>
          <Animated.View style={{ opacity: logo, transform: [{ scale: logo.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] }}>
            <Image source={WORDMARK} style={{ width: artW, height: artW / WORDMARK_ASPECT }} resizeMode="contain" accessibilityIgnoresInvertColors />
          </Animated.View>
          {ready && (
            <Animated.View style={[styles.lockup, rise(lockup, 8)]}>
              <Text style={styles.the}>THE</Text>
              <Text style={styles.paras} numberOfLines={1} adjustsFontSizeToFit>
                <SmallCaps text="PARAS MANI" />
              </Text>
              <Text style={styles.effect}>EFFECT</Text>
            </Animated.View>
          )}
        </View>
        <View
          style={[styles.track, { width: barW }]}
          accessibilityRole="progressbar"
          accessibilityLabel="Loading">
          {/* A full-width fill slid in from the left: transform-only, so it runs on the native driver. */}
          <Animated.View style={[styles.fill, { width: barW, transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [-barW, 0] }) }] }]} />
        </View>
      </Animated.View>
    </Animated.View>
  );
}

/** Classic small caps: each word's first letter full height, the rest a size down. */
function SmallCaps({ text }: { text: string }) {
  return (
    <>
      {text.split(' ').map((word, i) => (
        <Fragment key={`${word}-${i}`}>
          {i > 0 ? ' ' : ''}
          {word[0]}
          <Text style={styles.smallCap}>{word.slice(1)}</Text>
        </Fragment>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: BLACK, zIndex: 1000, elevation: 1000 },
  brand: { backgroundColor: BLACK, alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: 72, paddingBottom: 64 },
  brandMain: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  lockup: { alignItems: 'center', marginTop: 18 },
  the: { color: CREAM, fontFamily: fonts.serifBold, fontSize: 15, letterSpacing: 6, marginRight: -6 },
  paras: { color: CREAM, fontFamily: fonts.serif, fontSize: 46, lineHeight: 52, letterSpacing: 0.5, marginTop: 2 },
  smallCap: { fontSize: 36 },
  effect: { color: CREAM, fontFamily: fonts.serifBold, fontSize: 16, letterSpacing: 9, marginRight: -9, marginTop: 2 },
  track: { height: 6, borderRadius: 3, backgroundColor: TRACK, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: LIME },
  backersScreen: { backgroundColor: BLACK, alignItems: 'center', paddingHorizontal: 24, paddingBottom: 36 },
  // "Backed by" sits a little above centre, "Supported by" at the foot — as in the design.
  backedBy: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 40 },
  backedByLabel: { color: WHITE, fontFamily: fonts.semibold, fontSize: 17, letterSpacing: 11, marginRight: -11 },
  supportedBy: { alignItems: 'center' },
  supportedByLabel: { color: WHITE, fontFamily: fonts.medium, fontSize: 11, letterSpacing: 4.5, marginRight: -4.5, opacity: 0.9 },
});
