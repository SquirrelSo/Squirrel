import { useCallback, useMemo } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Mascot } from '@/art/Mascot';
import { Button, Display, Header, Icon, Screen } from '@/components/ui';
import { COMING_SOON, isLocked, type Feature } from '@/data/features';
import { useApp } from '@/state/AppState';
import { colors, fonts, radius } from '@/theme';

/**
 * The one place UI asks "is this feature launched?".
 *   locked(f)        → boolean, from LOCKED
 *   notify(f)        → the feature's "Coming soon" toast
 *   guard(f, action) → a press handler: runs `action` when unlocked, otherwise notifies
 */
export function useLocks() {
  const { toast } = useApp();
  const notify = useCallback((f: Feature) => toast(COMING_SOON[f], 'lock', colors.dim), [toast]);
  return useMemo(
    () => ({
      locked: isLocked,
      notify,
      guard:
        (f: Feature, action: () => void) =>
        () =>
          isLocked(f) ? notify(f) : action(),
    }),
    [notify],
  );
}

/**
 * Renders `children` only when `feature` is launched; otherwise `fallback`
 * (default: the "Coming soon" pill). Works for inline UI and for whole routes.
 */
export function FeatureGate({ feature, fallback, children }: { feature: Feature; fallback?: React.ReactNode; children: React.ReactNode }) {
  if (isLocked(feature)) return <>{fallback ?? <SoonPill />}</>;
  return <>{children}</>;
}

/** Small "Coming soon" pill with a lock, for cards, tiles and buttons. */
export function SoonPill({ style, onImage }: { style?: StyleProp<ViewStyle>; onImage?: boolean }) {
  return (
    <View style={[styles.pill, onImage && { backgroundColor: colors.imageChip, borderColor: 'transparent' }, style]} accessibilityLabel="Coming soon">
      <Icon name="lock" size={11} color={onImage ? colors.onImage : colors.dim} />
      <Text style={[styles.pillText, onImage && { color: colors.onImage }]}>Coming soon</Text>
    </View>
  );
}

/** Banner that explains a locked feature, shown on top of its (disabled) UI. */
export function SoonBanner({ title, body, style }: { title: string; body: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.banner, style]}>
      <View style={styles.lockDot}>
        <Icon name="lock" size={18} color={colors.onPrimary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.bannerTitle}>{title}</Text>
        <Text style={styles.bannerBody}>{body}</Text>
      </View>
    </View>
  );
}

/** Full-screen locked state for a route that can't be entered yet. */
export function SoonScreen({ title, body, onBack }: { title: string; body: string; onBack: () => void }) {
  return (
    <Screen tabBar={false}>
      <Header back title="" />
      <View style={{ alignItems: 'center', paddingTop: 30, paddingHorizontal: 12 }}>
        <Mascot pose="sleep" size={150} />
        <View style={[styles.pill, { marginTop: 14 }]}>
          <Icon name="lock" size={12} color={colors.dim} />
          <Text style={styles.pillText}>Coming soon</Text>
        </View>
        <Display size={34} style={{ marginTop: 10, textAlign: 'center' }}>{title}</Display>
        <Text style={styles.screenBody}>{body}</Text>
        <Button label="Go back" variant="secondary" size="md" onPress={onBack} style={{ marginTop: 22, alignSelf: 'stretch' }} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', backgroundColor: colors.cardHi, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  pillText: { color: colors.dim, fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.lineHi, borderStyle: 'dashed', padding: 12, marginBottom: 12 },
  lockDot: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  bannerTitle: { color: colors.text, fontFamily: fonts.label, fontSize: 16, letterSpacing: 1, textTransform: 'uppercase' },
  bannerBody: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, marginTop: 2 },
  screenBody: { color: colors.dim, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8 },
});
