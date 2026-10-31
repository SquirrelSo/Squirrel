/**
 * Map entities drawn as native views on top of the SVG. They live inside the pan/zoom
 * transform (so they move with the world) but counter-scale (so they stay the same size).
 * Everything is memoised; a relationship change re-renders just that player's marker.
 *
 * Hierarchy, quietest first: a place (small neutral icon) → a person (avatar) → a person who is
 * live right now (avatar + a soft pulse + an activity badge, so it never relies on colour alone)
 * → selected (larger, bright ring, name). You are a clean dot with an accuracy ring. Only live
 * things move; nothing else pulses.
 */
import { memo, useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import type { MapPlayer, Poi } from '@/api/campus/types';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { Icon, NATIVE, tap } from '@/components/ui';
import { useRelationship } from '@/state/socialStore';
import { alpha, colors, fonts, radius } from '@/theme';

type Pos = { x: number; y: number };
type Inverse = Animated.AnimatedInterpolation<number> | Animated.AnimatedDivision<number>;

/** Markers fade and settle in the first time they appear (once per marker, not on every pan). No bounce. */
function useAppear() {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE }).start();
  }, [v]);
  return v;
}
/** A slow, soft ring for things that are live. */
function usePulse(on: boolean, ms = 1800) {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!on) return;
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: ms, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE }));
    loop.start();
    return () => loop.stop();
  }, [v, on, ms]);
  return v;
}
const at = (p: Pos, size: number) => ({ left: p.x - size / 2, top: p.y - size / 2, width: size, height: size });

/** You: a dot with a white rim, a soft breathing halo and the accuracy ring (which scales with the map). */
export const CurrentUserMarker = memo(function CurrentUserMarker({ pos, accuracyPx, inverse, simulated }: { pos: Pos; accuracyPx: number; inverse: Inverse; simulated: boolean }) {
  const pulse = usePulse(true, 2400);
  const S = 44;
  const r = Math.max(10, Math.min(120, accuracyPx));
  return (
    <>
      <View pointerEvents="none" style={[styles.accuracy, { left: pos.x - r, top: pos.y - r, width: r * 2, height: r * 2, borderRadius: r }]} />
      <Animated.View pointerEvents="none" style={[styles.center, at(pos, S), { transform: [{ scale: inverse }], zIndex: 6 }]} accessibilityLabel={simulated ? 'You are here (demo location)' : 'You are here'}>
        <Animated.View style={[styles.meHalo, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.32, 0] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.5] }) }] }]} />
        <View style={styles.meDot} />
      </Animated.View>
    </>
  );
});

/** A first name on hover (desktop) — small, one line. */
function Tip({ text, show }: { text: string; show: boolean }) {
  if (!show) return null;
  return (
    <View style={styles.tip} pointerEvents="none">
      <Text style={styles.tipText} numberOfLines={1}>{text}</Text>
    </View>
  );
}

export const PlayerMarker = memo(function PlayerMarker({ player, pos, inverse, selected, showLabel, onPress }: { player: MapPlayer; pos: Pos; inverse: Inverse; selected: boolean; showLabel: boolean; onPress: (id: string) => void }) {
  const rel = useRelationship(player.user_id, player.relationship);
  const state = rel?.state ?? player.relationship;
  const live = !!player.activity;
  const ring = selected ? colors.text : live ? colors.green : state === 'friends' ? colors.primary : state === 'poked_you' ? colors.secondary : alpha(colors.text, 0.35);
  const S = selected ? 38 : 30;
  const appear = useAppear();
  const pulse = usePulse(live);
  const [hover, setHover] = useState(false);
  const first = player.display_name.split(' ')[0];
  return (
    <Animated.View style={[styles.center, at(pos, S), { opacity: appear, transform: [{ scale: Animated.multiply(inverse, appear.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] })) }] }, (selected || hover) && { zIndex: 5 }]}>
      {live && <Animated.View pointerEvents="none" style={[styles.livePulse, { width: S, height: S, borderRadius: S / 2, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8] }) }] }]} />}
      <Pressable
        onPress={() => {
          tap();
          onPress(player.user_id);
        }}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        hitSlop={10}
        style={hover && !selected ? { transform: [{ scale: 1.08 }] } : null}
        accessibilityRole="button"
        accessibilityLabel={`${player.display_name}, level ${player.level}${live ? `, ${player.activity === 'workout' ? 'working out' : `on a ${player.activity}`} now` : ''}${state === 'friends' ? ', friend' : state === 'poked_you' ? ', poked you' : ''}`}>
        <PersonAvatar person={player} size={S} ring={ring} link={false} />
        {live && (
          <View style={styles.liveBadge}>
            <Icon name={player.activity === 'walk' ? 'walk' : player.activity === 'workout' ? 'dumbbell' : 'run'} size={9} color={colors.onPrimary} />
          </View>
        )}
        {!live && state === 'friends' && (
          <View style={styles.badge}>
            <Icon name="account-heart" size={9} color={colors.onPrimary} />
          </View>
        )}
        {!live && state === 'poked_you' && (
          <View style={[styles.badge, { backgroundColor: colors.secondary }]}>
            <Text style={styles.wave}>👋</Text>
          </View>
        )}
      </Pressable>
      {showLabel || selected ? (
        <View style={styles.label} pointerEvents="none">
          <Text style={styles.labelText} numberOfLines={1}>{first}</Text>
        </View>
      ) : (
        <Tip text={first} show={hover} />
      )}
    </Animated.View>
  );
});

/** Several people in one spot: a clean count. A small live dot when any of them is live right now. */
export const ClusterMarker = memo(function ClusterMarker({ id, count, live, pos, inverse, onPress }: { id: string; count: number; live: number; pos: Pos; inverse: Inverse; onPress: (id: string) => void }) {
  const S = count >= 20 ? 46 : count >= 8 ? 40 : 34;
  const appear = useAppear();
  const [hover, setHover] = useState(false);
  return (
    <Animated.View style={[styles.center, at(pos, S), { opacity: appear, transform: [{ scale: Animated.multiply(inverse, appear.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] })) }] }]}>
      <Pressable
        onPress={() => {
          tap();
          onPress(id);
        }}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        hitSlop={6}
        style={[styles.cluster, { width: S, height: S, borderRadius: S / 2 }, hover && { borderColor: colors.primary, transform: [{ scale: 1.06 }] }]}
        accessibilityRole="button"
        accessibilityLabel={`${count} Squirrels here${live ? `, ${live} live now` : ''}. Zoom in`}>
        <Text style={[styles.clusterCount, count >= 20 && { fontSize: 17 }]}>{count}</Text>
        {live > 0 && <View style={styles.clusterLive} />}
      </Pressable>
    </Animated.View>
  );
});

const POI_ICON: Record<string, React.ComponentProps<typeof Icon>['name']> = { food: 'silverware-fork-knife', sports: 'run-fast', study: 'book-open-variant', hangout: 'coffee', gate: 'gate', event: 'calendar-star' };

/** A place: a small neutral icon. Its name shows close up (label layer) or on hover. */
export const PoiMarker = memo(function PoiMarker({ poi, pos, inverse, selected, onPress }: { poi: Poi; pos: Pos; inverse: Inverse; selected?: boolean; onPress: (id: string) => void }) {
  const S = 24;
  const [hover, setHover] = useState(false);
  return (
    <Animated.View style={[styles.center, at(pos, S), { transform: [{ scale: inverse }] }, (hover || selected) && { zIndex: 4 }]}>
      <Pressable
        onPress={() => {
          tap();
          onPress(poi.id);
        }}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        hitSlop={10}
        style={[styles.poi, (hover || selected) && { borderColor: colors.gold, transform: [{ scale: 1.1 }] }]}
        accessibilityRole="button"
        accessibilityLabel={`${poi.name}, place`}>
        <Icon name={POI_ICON[poi.kind] ?? 'map-marker'} size={12} color={hover || selected ? colors.gold : colors.sub} />
      </Pressable>
      <Tip text={poi.name} show={hover && !selected} />
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  center: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  accuracy: { position: 'absolute', backgroundColor: alpha(colors.blue, 0.08), borderWidth: 1, borderColor: alpha(colors.blue, 0.3) },
  meHalo: { position: 'absolute', width: 44, height: 44, borderRadius: 22, backgroundColor: colors.blue },
  meDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: colors.blue, borderWidth: 3, borderColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 3 },
  livePulse: { position: 'absolute', backgroundColor: colors.green },
  liveBadge: { position: 'absolute', right: -3, bottom: -3, width: 15, height: 15, borderRadius: 8, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.bg },
  badge: { position: 'absolute', right: -3, bottom: -3, width: 15, height: 15, borderRadius: 8, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.bg },
  wave: { fontSize: 8 },
  label: { position: 'absolute', top: '100%', marginTop: 3, backgroundColor: alpha(colors.panel, 0.88), borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 1, maxWidth: 96 },
  labelText: { color: colors.text, fontFamily: fonts.label, fontSize: 10, letterSpacing: 0.6 },
  tip: { position: 'absolute', bottom: '100%', marginBottom: 4, backgroundColor: colors.panel, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.lineHi, paddingHorizontal: 7, paddingVertical: 2, maxWidth: 140 },
  tipText: { color: colors.text, fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.5 },
  cluster: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panel, borderWidth: 1.5, borderColor: alpha(colors.primary, 0.55), shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  clusterCount: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 15, letterSpacing: 0.3 },
  clusterLive: { position: 'absolute', top: 1, right: 1, width: 9, height: 9, borderRadius: 5, backgroundColor: colors.green, borderWidth: 1.5, borderColor: colors.panel },
  poi: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(colors.panel, 0.92), borderWidth: 1, borderColor: colors.lineHi },
});
