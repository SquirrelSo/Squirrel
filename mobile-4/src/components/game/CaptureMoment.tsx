/**
 * The short game moment after the backend confirms a territory action: a stamp slides in
 * ("ZONE CLAIMED"), holds for a beat and clears itself. Tap to dismiss early. It never blocks
 * for long and never appears for an optimistic or failed action.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { Display, Icon, NATIVE } from '@/components/ui';
import { alpha, colors, fonts, radius } from '@/theme';

export type CaptureKind = 'claim' | 'steal' | 'defend';
type Moment = { id: number; kind: CaptureKind; zoneName: string };

let current: Moment | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function showCapture(kind: CaptureKind, zoneName: string) {
  current = { id: ++seq, kind, zoneName };
  emit();
}
function clear(id: number) {
  if (current?.id !== id) return;
  current = null;
  emit();
}

const UI: Record<CaptureKind, { title: string; sub: string; color: string; icon: React.ComponentProps<typeof Icon>['name'] }> = {
  claim: { title: 'Zone claimed', sub: 'It’s yours. Hold it.', color: colors.primary, icon: 'flag-checkered' },
  steal: { title: 'Zone stolen', sub: 'They’ll want it back.', color: colors.secondary, icon: 'sword-cross' },
  defend: { title: 'Defended', sub: 'Your hold just got stronger.', color: colors.gold, icon: 'shield-check' },
};

export function CaptureMomentHost() {
  const m = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
  return m ? <CaptureStamp key={m.id} m={m} /> : null;
}

function CaptureStamp({ m }: { m: Moment }) {
  const [v] = useState(() => new Animated.Value(0));
  const ui = UI[m.kind];
  useEffect(() => {
    const a = Animated.sequence([
      Animated.spring(v, { toValue: 1, useNativeDriver: NATIVE, speed: 16, bounciness: 9 }),
      Animated.delay(1300),
      Animated.timing(v, { toValue: 2, duration: 260, easing: Easing.in(Easing.quad), useNativeDriver: NATIVE }),
    ]);
    a.start(({ finished }) => finished && clear(m.id));
    return () => a.stop();
  }, [v, m.id]);
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <Pressable onPress={() => clear(m.id)} accessibilityRole="alert" accessibilityLabel={`${ui.title}: ${m.zoneName}`}>
        <Animated.View
          style={[
            styles.stamp,
            { borderColor: ui.color },
            {
              opacity: v.interpolate({ inputRange: [0, 0.4, 1, 2], outputRange: [0, 1, 1, 0] }),
              transform: [
                { rotate: '-4deg' },
                { scale: v.interpolate({ inputRange: [0, 1, 2], outputRange: [1.35, 1, 0.96] }) },
                { translateY: v.interpolate({ inputRange: [0, 1, 2], outputRange: [0, 0, -18] }) },
              ],
            },
          ]}>
          <View style={[styles.icon, { backgroundColor: ui.color }]}>
            <Icon name={ui.icon} size={20} color={colors.onPrimary} />
          </View>
          <View style={{ flexShrink: 1 }}>
            <Display size={30} color={ui.color}>{ui.title}</Display>
            <Text style={styles.zone} numberOfLines={1}>{m.zoneName}</Text>
            <Text style={styles.sub}>{ui.sub}</Text>
          </View>
        </Animated.View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  stamp: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: alpha(colors.panel, 0.95), borderWidth: 2, borderRadius: radius.lg, paddingVertical: 14, paddingHorizontal: 18, maxWidth: 360 },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  zone: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 17, letterSpacing: 1, textTransform: 'uppercase', marginTop: -2 },
  sub: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, marginTop: 2 },
});
