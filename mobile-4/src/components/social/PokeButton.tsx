/**
 * POKE 👋 → POKED → (they poke back) → FRIENDS 🎉, or POKE BACK 👋 when they poked first.
 * The label always shows words (not just colour) and follows the backend's relationship state.
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { RelationshipState } from '@/api/campus/types';
import { errorText } from '@/api/campus';
import { Icon, NATIVE, tap } from '@/components/ui';
import { pokeUser, useRelationship, type Friend } from '@/state/socialStore';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';

const UI: Record<RelationshipState | 'loading' | 'sending_back', { label: string; icon?: React.ComponentProps<typeof Icon>['name']; fg: string; bg: string; border: string }> = {
  // Pink = social interaction; lime = confirmation (friends). POKE BACK is the solid, urgent one.
  none: { label: 'Poke 👋', fg: colors.secondary, bg: alpha(colors.secondary, 0.1), border: colors.secondary },
  poked: { label: 'Poked', icon: 'check', fg: colors.dim, bg: 'transparent', border: colors.lineHi },
  poked_you: { label: 'Poke back 👋', fg: colors.onSecondary, bg: colors.secondary, border: colors.secondary },
  friends: { label: 'Friends 🎉', icon: 'account-heart', fg: colors.primary, bg: alpha(colors.primary, 0.08), border: alpha(colors.primary, 0.55) },
  loading: { label: '…', fg: colors.dim, bg: colors.cardHi, border: colors.line },
  sending_back: { label: 'Poking back…', fg: colors.onSecondary, bg: colors.secondary, border: colors.secondary },
};

export function PokeButton({
  user,
  seed,
  size = 'md',
  onPoked,
  style,
}: {
  user: Friend;
  /** Relationship hint from a list response (avoids a status request per row). */
  seed?: RelationshipState;
  size?: 'sm' | 'md';
  /** Lets the card animate its avatar ("the squirrel reacts"). */
  onPoked?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { toast } = useApp();
  const rel = useRelationship(user.user_id, seed);
  const [ripple] = useState(() => new Animated.Value(0));
  const [hand] = useState(() => new Animated.Value(0));
  const [press] = useState(() => new Animated.Value(1));
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  const key: keyof typeof UI = !rel ? 'loading' : rel.pending === 'poke_back' ? 'sending_back' : rel.state;
  const ui = UI[key];
  const disabled = !rel || !!rel.pending || rel.state === 'poked' || rel.state === 'friends' || !rel.can_poke;
  const name = user.display_name.split(' ')[0];

  const burst = () => {
    ripple.setValue(0);
    hand.setValue(0);
    Animated.parallel([
      Animated.timing(ripple, { toValue: 1, duration: 420, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE }),
      Animated.sequence([
        Animated.timing(hand, { toValue: 1, duration: 110, useNativeDriver: NATIVE }),
        Animated.timing(hand, { toValue: -0.6, duration: 110, useNativeDriver: NATIVE }),
        Animated.timing(hand, { toValue: 0, duration: 120, useNativeDriver: NATIVE }),
      ]),
    ]).start();
  };

  const onPress = async () => {
    if (disabled || !rel) return;
    tap('impact');
    Animated.sequence([
      Animated.timing(press, { toValue: 0.92, duration: 70, useNativeDriver: NATIVE }),
      Animated.spring(press, { toValue: 1, useNativeDriver: NATIVE, speed: 22, bounciness: 10 }),
    ]).start();
    burst();
    onPoked?.();
    const back = rel.state === 'poked_you';
    const r = await pokeUser(user);
    if (!mounted.current) return;
    if (r.ok) {
      tap('success');
      if (!r.friends) toast(back ? `Poked ${name} back` : `You poked ${name}`, 'hand-wave', colors.secondary);
    } else {
      toast(`Poke didn’t go through · ${errorText(r.error)}`, 'alert-circle-outline', colors.coral);
    }
  };

  const small = size === 'sm';
  return (
    <View style={style}>
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.ripple,
          { borderColor: key === 'friends' ? colors.primary : colors.secondary, opacity: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }), transform: [{ scale: ripple.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }) }] },
        ]}
      />
      <Animated.View style={{ transform: [{ scale: press }] }}>
        <Pressable
          onPress={onPress}
          disabled={disabled}
          style={[styles.btn, small && styles.btnSm, { backgroundColor: ui.bg, borderColor: ui.border }, disabled && key === 'none' && { opacity: 0.45 }]}
          accessibilityRole="button"
          accessibilityLabel={key === 'poked_you' ? `Poke ${user.display_name} back` : key === 'none' ? `Poke ${user.display_name}` : `${ui.label.replace(/[^\w\s…]/g, '').trim()} — ${user.display_name}`}
          accessibilityState={{ disabled, busy: !!rel?.pending }}
          accessibilityHint={key === 'poked_you' ? 'Poking back makes you friends' : key === 'none' ? 'Sends a nudge. If they poke back, you become friends.' : undefined}>
          {key === 'loading' || key === 'sending_back' ? (
            <ActivityIndicator size="small" color={ui.fg} />
          ) : ui.icon ? (
            <Icon name={ui.icon} size={small ? 13 : 15} color={ui.fg} />
          ) : null}
          <Animated.Text
            style={[
              styles.label,
              small && styles.labelSm,
              { color: ui.fg, transform: [{ rotate: hand.interpolate({ inputRange: [-1, 1], outputRange: ['-8deg', '8deg'] }) }] },
            ]}
            numberOfLines={1}>
            {ui.label}
          </Animated.Text>
        </Pressable>
      </Animated.View>
      {!small && rel && !rel.pending && rel.state === 'none' && !rel.can_poke && !!rel.reason && <Text style={styles.reason}>{rel.reason}</Text>}
    </View>
  );
}

/** Words for the relationship (so state never relies on colour alone). */
export const RELATION_TEXT: Record<RelationshipState, string> = { none: '', poked: 'You poked', poked_you: 'Poked you', friends: 'Friends' };

const styles = StyleSheet.create({
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minWidth: 116, borderRadius: radius.pill, borderWidth: 1.5, paddingHorizontal: 16, paddingVertical: 10 },
  btnSm: { minWidth: 86, paddingHorizontal: 12, paddingVertical: 6 },
  label: { fontFamily: fonts.labelBold, fontSize: 15, letterSpacing: 1, textTransform: 'uppercase' },
  labelSm: { fontSize: 12, letterSpacing: 0.8 },
  ripple: { borderRadius: radius.pill, borderWidth: 2 },
  reason: { color: colors.dim, fontFamily: fonts.regular, fontSize: 11, marginTop: 4, textAlign: 'center' },
});
