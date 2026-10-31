/**
 * The map's words. Names are native text inside the pan/zoom transform that counter-scale, so they
 * stay one readable size at every zoom (SVG text grew with the map and piled up). Which ones show
 * is logic/mapLabels.ts: by tier for the current scale, pinned ones first, and never on top of
 * another label or of you / people. Recomputed when a gesture ends, never during one.
 */
import { memo, useEffect, useMemo, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { Icon, NATIVE } from '@/components/ui';
import { placeLabels, type LabelTier, type Obstacle } from '@/logic/mapLabels';
import { alpha, colors, fonts, mapColors } from '@/theme';

type IconName = React.ComponentProps<typeof Icon>['name'];

export type MapLabel = {
  id: string;
  /** Unscaled view coordinates (same space as markers). */
  x: number;
  y: number;
  text: string;
  tier: LabelTier;
  pinned?: boolean;
  /** Small coloured dot before the name (who holds it); never the only cue — `icon` / the card say it too. */
  dot?: string | null;
  icon?: IconName | null;
  iconColor?: string;
};

const SIZE: Record<LabelTier, number> = { 1: 12.5, 2: 11, 3: 10 };
const W = 240;

export const LabelLayer = memo(function LabelLayer({ labels, zoom, metresPerPx, obstacles, inverse }: { labels: MapLabel[]; zoom: number; metresPerPx: number; obstacles: Obstacle[]; inverse: Animated.AnimatedDivision<number> }) {
  const shown = useMemo(() => {
    const cands = labels.map((l) => ({ id: l.id, x: l.x * zoom, y: l.y * zoom, text: (l.dot || l.icon ? '  ' : '') + l.text, tier: l.tier, pinned: l.pinned, fontSize: SIZE[l.tier] }));
    const obs = obstacles.map((o) => ({ x: o.x * zoom, y: o.y * zoom, r: o.r }));
    return placeLabels(cands, metresPerPx, obs);
  }, [labels, zoom, metresPerPx, obstacles]);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {labels.map((l) => {
        const at = shown.get(l.id);
        return at ? <Label key={l.id} l={l} dx={at.dx} dy={at.dy} inverse={inverse} /> : null;
      })}
    </View>
  );
});

const Label = memo(function Label({ l, dx, dy, inverse }: { l: MapLabel; dx: number; dy: number; inverse: Animated.AnimatedDivision<number> }) {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE }).start();
  }, [v]);
  const size = SIZE[l.tier];
  const color = l.pinned ? colors.text : l.tier === 1 ? alpha(colors.text, 0.92) : l.tier === 2 ? colors.sub : colors.dim;
  return (
    <Animated.View style={[styles.wrap, { left: l.x - W / 2, top: l.y - 12, opacity: v, transform: [{ scale: inverse }, { translateX: dx }, { translateY: dy }] }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.row}>
        {l.icon ? <Icon name={l.icon} size={size} color={l.iconColor ?? color} /> : l.dot ? <View style={[styles.dot, { backgroundColor: l.dot }]} /> : null}
        <Text style={[styles.text, { fontSize: size, color, fontFamily: l.tier === 1 || l.pinned ? fonts.labelBold : fonts.label, letterSpacing: l.tier === 1 ? 1 : 0.8 }]} numberOfLines={1}>
          {l.text.toUpperCase()}
        </Text>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  wrap: { position: 'absolute', width: W, height: 24, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { textShadowColor: mapColors.labelHalo, textShadowRadius: 4, textShadowOffset: { width: 0, height: 0 } },
});
