import React, { useEffect, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient as SvgGradient, Stop } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { alpha, colors, DISPLAY_SKEW, fonts, gradients, isLightTheme, MAX_WIDTH, radius } from '@/theme';
import type { IconName } from '@/data/icons';
import { useAnimatedValue } from '@/hooks/useAnimatedValue';

export const Icon = MaterialCommunityIcons;
export const NATIVE = Platform.OS !== 'web';

export const tap = (kind: 'select' | 'impact' | 'success' = 'select') => {
  if (!NATIVE) return;
  const p =
    kind === 'impact'
      ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      : kind === 'success'
        ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        : Haptics.selectionAsync();
  p.catch(() => {});
};

/** Space reserved at the bottom of tab screens for the floating tab bar. */
export const TAB_BAR_SPACE = 104;

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/** Fade + rise on mount. Stagger lists with `index`. */
export function FadeIn({ children, index = 0, delay = 0, style, from = 14 }: { children: React.ReactNode; index?: number; delay?: number; style?: StyleProp<ViewStyle>; from?: number }) {
  const v = useAnimatedValue(0);
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 420, delay: delay + Math.min(index, 10) * 55, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE }).start();
  }, [v, index, delay]);
  return (
    <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Pressable that springs down slightly when touched. */
export function PressScale({ children, style, scaleTo = 0.97, haptic = true, onPress, accessibilityLabel, accessibilityRole = 'button', accessibilityState, ...rest }: Omit<PressableProps, 'style'> & { children: React.ReactNode; style?: StyleProp<ViewStyle>; scaleTo?: number; haptic?: boolean }) {
  const s = useAnimatedValue(1);
  const to = (v: number) => Animated.spring(s, { toValue: v, useNativeDriver: NATIVE, speed: 40, bounciness: 6 }).start();
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={() => to(scaleTo)}
      onPressOut={() => to(1)}
      onPress={(e) => {
        if (haptic) tap();
        onPress?.(e);
      }}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
      style={[style, { transform: [{ scale: s }] }]}>
      {children}
    </AnimatedPressable>
  );
}

/** Looping pulse ring, used for map markers and live indicators. */
export function Pulse({ size = 40, color = colors.primary, style }: { size?: number; color?: string; style?: StyleProp<ViewStyle> }) {
  const v = useAnimatedValue(0);
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1800, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE }));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: color },
        style,
        { opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] }), transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.6] }) }] },
      ]}
    />
  );
}

/** Number that counts up/down to its value. */
export function AnimatedNumber({ value, style, format = (n) => Math.round(n).toLocaleString('en-IN') }: { value: number; style?: StyleProp<TextStyle>; format?: (n: number) => string }) {
  const v = useAnimatedValue(value);
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const id = v.addListener(({ value: n }) => setShown(n));
    Animated.timing(v, { toValue: value, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    return () => v.removeListener(id);
  }, [value, v]);
  return <Text style={style}>{format(shown)}</Text>;
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export function Display({ children, size = 34, color = colors.text, style, numberOfLines }: { children: React.ReactNode; size?: number; color?: string; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  return (
    <Text numberOfLines={numberOfLines} style={[{ fontFamily: fonts.display, fontSize: size, lineHeight: size * 1.14, color, letterSpacing: 0.4, textTransform: 'uppercase', transform: [{ skewX: DISPLAY_SKEW }] }, style]}>
      {children}
    </Text>
  );
}

/** Marker scribble, as on the website ("SAME PARKS. DIFFERENT PEOPLE."). Use sparingly. */
export function Tagline({ children, size = 20, color = colors.text, rotate = -6, glow = false, style }: { children: React.ReactNode; size?: number; color?: string; rotate?: number; glow?: boolean; style?: StyleProp<TextStyle> }) {
  return (
    <Text
      style={[
        { fontFamily: fonts.script, fontSize: size, lineHeight: size * 1.18, color, transform: [{ rotate: `${rotate}deg` }] },
        { textTransform: 'uppercase' },
        glow && { textShadowColor: alpha(colors.primary, 0.6), textShadowRadius: 12, textShadowOffset: { width: 0, height: 0 } },
        style,
      ]}>
      {children}
    </Text>
  );
}

export function Label({ children, style, color = colors.dim }: { children: React.ReactNode; style?: StyleProp<TextStyle>; color?: string }) {
  return <Text style={[{ color, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase' }, style]}>{children}</Text>;
}

/**
 * Shared text primitives: one definition per recurring type style, so a palette/type change
 * happens here instead of in every screen.
 */
export const textStyles = StyleSheet.create({
  /** Small caps line drawn over artwork ("PASHAN LAKE · 2.4 KM LOOP"). */
  overlayKicker: { color: colors.primarySoft, fontFamily: fonts.bold, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  /** Secondary line drawn over artwork. */
  overlaySub: { color: colors.onImageSub, fontFamily: fonts.medium, fontSize: 12 },
  /** Uppercase condensed title of a feature row ("START EXERCISE", "PARTNER HUNT"). */
  rowTitle: { color: colors.text, fontFamily: fonts.label, fontSize: 17, letterSpacing: 1, textTransform: 'uppercase' },
  /** Dim one-liner under a row title. */
  rowSub: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, marginTop: 1 },
});

type TextProps = { children: React.ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number };
export const OverlayKicker = ({ children, style, numberOfLines }: TextProps) => <Text style={[textStyles.overlayKicker, style]} numberOfLines={numberOfLines}>{children}</Text>;
export const OverlaySub = ({ children, style, numberOfLines }: TextProps) => <Text style={[textStyles.overlaySub, style]} numberOfLines={numberOfLines}>{children}</Text>;
export const RowTitle = ({ children, style, numberOfLines }: TextProps) => <Text style={[textStyles.rowTitle, style]} numberOfLines={numberOfLines}>{children}</Text>;
export const RowSub = ({ children, style, numberOfLines = 1 }: TextProps) => <Text style={[textStyles.rowSub, style]} numberOfLines={numberOfLines}>{children}</Text>;

/** Website-style section kicker: a short lime rule + Space Mono caps ("— 02 — HOW DOES IT WORK?"). */
export function Kicker({ children, color = colors.primary, style }: { children: React.ReactNode; color?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8 }, style]}>
      <View style={{ width: 22, height: 2, backgroundColor: color }} />
      <Text style={{ color, fontFamily: fonts.monoBold, fontSize: 11, letterSpacing: 1.6, textTransform: 'uppercase' }}>{children}</Text>
    </View>
  );
}

export function SectionHeader({ title, action, onAction, style, kicker }: { title: string; action?: string; onAction?: () => void; style?: StyleProp<ViewStyle>; kicker?: string }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 28, marginBottom: 12 }, style]}>
      <View style={{ flexShrink: 1 }}>
        {kicker && <Kicker style={{ marginBottom: 6 }}>{kicker}</Kicker>}
        <Display size={24}>{title}</Display>
      </View>
      {action && (
        <Pressable hitSlop={10} onPress={() => { tap(); onAction?.(); }} style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ color: colors.primary, fontFamily: fonts.label, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' }}>{action}</Text>
          <Icon name="chevron-right" size={18} color={colors.primary} />
        </Pressable>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'accent' | 'gold';

export function Button({ label, onPress, icon, iconLeft, variant = 'primary', size = 'lg', style, disabled, accessibilityLabel }: { label: string; onPress?: () => void; icon?: IconName; iconLeft?: IconName; variant?: BtnVariant; size?: 'sm' | 'md' | 'lg'; style?: StyleProp<ViewStyle>; disabled?: boolean; accessibilityLabel?: string }) {
  const pad = size === 'lg' ? 16 : size === 'md' ? 12 : 8;
  const fs = size === 'lg' ? 17 : size === 'md' ? 15 : 12;
  const filled = variant === 'primary' || variant === 'accent' || variant === 'gold';
  // Filled lime is always the neon (primaryFill); in light mode it gets an ink outline so it doesn't wash out.
  const fill = variant === 'accent' ? colors.secondary : variant === 'gold' ? gradients.gold[1] : colors.primaryFill;
  const fg = !filled ? colors.text : variant === 'accent' ? colors.onSecondary : colors.onPrimary;
  const content = (
    <>
      {iconLeft && <Icon name={iconLeft} size={fs + 2} color={fg} style={{ marginRight: 8 }} />}
      <Text style={{ fontFamily: fonts.label, fontSize: fs, color: fg, letterSpacing: size === 'sm' ? 0.6 : 1.2, textTransform: 'uppercase' }}>{label}</Text>
      {icon && <Icon name={icon} size={fs + 2} color={fg} style={{ marginLeft: 8 }} />}
    </>
  );
  return (
    <PressScale
      disabled={disabled}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={[
        { borderRadius: radius.pill, opacity: disabled ? 0.45 : 1 },
        filled && variant === 'primary' && !disabled && styles.glow,
        style,
      ]}>
      {filled ? (
        <View style={[styles.btn, { paddingVertical: pad, backgroundColor: fill }, isLightTheme && variant === 'primary' && { borderWidth: 1.5, borderColor: colors.text, paddingVertical: pad - 1.5 }]}>{content}</View>
      ) : (
        <View style={[styles.btn, { paddingVertical: pad - 1.5 }, variant === 'secondary' ? styles.btnSecondary : styles.btnGhost]}>{content}</View>
      )}
    </PressScale>
  );
}

export function IconButton({ icon, onPress, size = 22, color = colors.text, badge, style, label }: { icon: IconName; onPress?: () => void; size?: number; color?: string; badge?: number; style?: StyleProp<ViewStyle>; label?: string }) {
  return (
    <PressScale accessibilityLabel={label} hitSlop={8} onPress={onPress} style={[styles.iconBtn, style]}>
      <Icon name={icon} size={size} color={color} />
      {!!badge && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
        </View>
      )}
    </PressScale>
  );
}

/** Small toggle button: "Join" → "Joined", "Follow" → "Following". */
export function TogglePill({ on, onPress, labelOff, labelOn, color = colors.primary, style, accessibilityLabel }: { on: boolean; onPress: () => void; labelOff: string; labelOn: string; color?: string; style?: StyleProp<ViewStyle>; accessibilityLabel?: string }) {
  return (
    <PressScale onPress={onPress} accessibilityLabel={accessibilityLabel} accessibilityRole="button" accessibilityState={{ selected: on }} style={[styles.pill, on ? styles.pillOn : { backgroundColor: color }, style]}>
      {on && <Icon name="check" size={14} color={colors.sub} style={{ marginRight: 4 }} />}
      <Text style={[styles.pillText, { color: on ? colors.sub : colors.onPrimary }]}>{on ? labelOn : labelOff}</Text>
    </PressScale>
  );
}

// ---------------------------------------------------------------------------
// Inputs / selectors
// ---------------------------------------------------------------------------

export function SearchBar({ placeholder, value, onChangeText, right }: { placeholder: string; value?: string; onChangeText?: (t: string) => void; right?: React.ReactNode }) {
  return (
    <View style={styles.search}>
      <Icon name="magnify" size={20} color={colors.dim} />
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.dim} style={styles.searchInput} returnKeyType="search" />
      {!!value && <IconButton icon="close-circle" size={18} color={colors.dim} onPress={() => onChangeText?.('')} style={{ width: 28, height: 28 }} />}
      {right}
    </View>
  );
}

export function Chips<T extends string>({ items, value, onChange, icons, style }: { items: readonly T[]; value: T; onChange: (v: T) => void; icons?: Partial<Record<T, IconName>>; style?: StyleProp<ViewStyle> }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[{ flexGrow: 0 }, style]} contentContainerStyle={{ gap: 8, paddingVertical: 12 }}>
      {items.map((i) => {
        const on = i === value;
        const ic = icons?.[i];
        return (
          <PressScale key={i} onPress={() => { tap(); onChange(i); }} accessibilityLabel={i} accessibilityRole="button" accessibilityState={{ selected: on }} style={[styles.chip, on && styles.chipOn]}>
            {ic && <Icon name={ic} size={15} color={on ? colors.primary : colors.dim} style={{ marginRight: 5 }} />}
            <Text style={[styles.chipText, on && { color: colors.primary }]}>{i}</Text>
          </PressScale>
        );
      })}
    </ScrollView>
  );
}

export function Segmented<T extends string>({ items, value, onChange, accent = 'primary', style, labels }: { items: readonly T[]; value: T; onChange: (v: T) => void; accent?: 'primary' | 'secondary'; style?: StyleProp<ViewStyle>; labels?: Partial<Record<T, string>> }) {
  const [w, setW] = useState(0);
  const idx = Math.max(0, items.indexOf(value));
  const x = useAnimatedValue(idx);
  useEffect(() => {
    Animated.spring(x, { toValue: idx, useNativeDriver: NATIVE, speed: 18, bounciness: 5 }).start();
  }, [idx, x]);
  const seg = w > 0 ? (w - 8) / items.length : 0;
  return (
    <View style={[styles.seg, style]} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {seg > 0 && (
        <Animated.View style={[styles.segThumb, { width: seg, transform: [{ translateX: x.interpolate({ inputRange: [0, Math.max(1, items.length - 1)], outputRange: [0, seg * Math.max(1, items.length - 1)] }) }] }]}>
          {/* Neon is a signal, not a surface: a raised tab with an accent underline */}
          <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.cardHi, borderWidth: 1, borderColor: colors.lineHi, borderRadius: radius.pill }]} />
          <View style={[styles.segBar, { backgroundColor: accent === 'secondary' ? colors.secondary : colors.primary }]} />
        </Animated.View>
      )}
      {items.map((i) => {
        const on = i === value;
        return (
          <PressScale key={i} onPress={() => { tap(); onChange(i); }} accessibilityLabel={i} accessibilityRole="button" accessibilityState={{ selected: on }} style={styles.segItem}>
            <Text numberOfLines={1} style={[styles.segText, on && { color: colors.text, fontFamily: fonts.labelBold }]}>{labels?.[i] ?? i}</Text>
          </PressScale>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export function ProgressBar({ progress, color = colors.primary, color2, height = 6, style, animated = true }: { progress: number; color?: string; color2?: string; height?: number; style?: StyleProp<ViewStyle>; animated?: boolean }) {
  const p = Math.max(0, Math.min(1, progress));
  const v = useAnimatedValue(animated ? 0 : p);
  useEffect(() => {
    Animated.timing(v, { toValue: p, duration: 800, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [p, v]);
  return (
    <View style={[{ height, borderRadius: height, backgroundColor: colors.line, overflow: 'hidden' }, style]}>
      <Animated.View style={{ width: v.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }), height: '100%', borderRadius: height, overflow: 'hidden' }}>
        <LinearGradient colors={[color, color2 ?? color]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
    </View>
  );
}

export function XPBar({ value, max, style, showLabel = true, onImage }: { value: number; max: number; style?: StyleProp<ViewStyle>; showLabel?: boolean; onImage?: boolean }) {
  return (
    <View style={style}>
      <ProgressBar progress={value / max} color={colors.primary} color2={colors.violet} height={8} />
      {showLabel && (
        <Text style={{ color: onImage ? colors.onImageSub : colors.dim, fontFamily: fonts.semibold, fontSize: 11, marginTop: 4 }}>
          <Text style={{ color: onImage ? colors.onImage : colors.text }}>{value.toLocaleString('en-IN')}</Text> / {max.toLocaleString('en-IN')} XP
        </Text>
      )}
    </View>
  );
}

/** Circular progress ring (activity rings on Home). */
export function Ring({ progress, size = 64, stroke = 7, color = colors.primary, color2, children }: { progress: number; size?: number; stroke?: number; color?: string; color2?: string; children?: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const id = React.useId().replace(/:/g, '');
  const p = Math.max(0, Math.min(1, progress));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgGradient id={`rg${id}`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={color} />
            <Stop offset="1" stopColor={color2 ?? color} />
          </SvgGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.line} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={`url(#rg${id})`}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * p} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Surfaces & badges
// ---------------------------------------------------------------------------

export function Card({ children, style, glow }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; glow?: string }) {
  return (
    <View style={[styles.card, glow && { borderColor: `${glow}66`, shadowColor: glow, shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } }, style]}>
      <LinearGradient colors={gradients.card} start={{ x: 0, y: 0 }} end={{ x: 0.4, y: 1 }} style={[StyleSheet.absoluteFill, { borderRadius: radius.lg }]} />
      {children}
    </View>
  );
}

export function IconBadge({ icon, color, size = 44, solid }: { icon: IconName; color: string; size?: number; solid?: boolean }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.32, backgroundColor: solid ? color : `${color}1F`, borderWidth: 1, borderColor: `${color}55`, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={size * 0.54} color={solid ? colors.onSecondary : color} />
    </View>
  );
}

export function CoinIcon({ size = 18 }: { size?: number }) {
  return (
    <LinearGradient colors={gradients.gold} style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#FFF1B0' }}>
      <Icon name="star-four-points" size={size * 0.55} color="#9A5A00" />
    </LinearGradient>
  );
}

export function Coins({ amount, size = 15, animated = true, style }: { amount: number; size?: number; animated?: boolean; style?: StyleProp<ViewStyle> }) {
  const textStyle = { color: colors.text, fontFamily: fonts.bold, fontSize: size };
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 6 }, style]}>
      <CoinIcon size={size + 5} />
      {animated ? <AnimatedNumber value={amount} style={textStyle} /> : <Text style={textStyle}>{amount.toLocaleString('en-IN')}</Text>}
    </View>
  );
}

export function LevelBadge({ level, size = 'md' }: { level: number; size?: 'sm' | 'md' | 'lg' }) {
  const d = size === 'lg' ? 52 : size === 'md' ? 34 : 24;
  return (
    <LinearGradient colors={gradients.purple} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ minWidth: d, height: d, borderRadius: d * 0.3, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.primarySoft }}>
      <Text style={{ color: colors.onPrimary, fontFamily: fonts.display, fontSize: d * 0.5, lineHeight: d * 0.62 }}>{level}</Text>
    </LinearGradient>
  );
}

export function Tag({ label, icon, color = colors.primary }: { label: string; icon?: IconName; color?: string }) {
  return (
    <View style={styles.tag}>
      {icon && <Icon name={icon} size={13} color={color} />}
      <Text style={styles.tagText}>{label}</Text>
    </View>
  );
}

export function Scrim({ style, strong }: { style?: StyleProp<ViewStyle>; strong?: boolean }) {
  return <LinearGradient pointerEvents="none" colors={strong ? ['rgba(6,6,6,0.1)', 'rgba(6,6,6,0.75)', 'rgba(6,6,6,0.96)'] : gradients.scrim} style={[StyleSheet.absoluteFill, style]} />;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Header({ title, back, right, subtitle }: { title: string; back?: boolean; right?: React.ReactNode; subtitle?: string }) {
  return (
    <View style={styles.header}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
        {back && <IconButton icon="chevron-left" size={28} onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))} style={{ marginRight: 8 }} label="Back" />}
        <View style={{ flex: 1 }}>
          <Display size={30} numberOfLines={1}>{title}</Display>
          {subtitle && <Text style={{ color: colors.dim, fontFamily: fonts.medium, fontSize: 13, marginTop: 1 }}>{subtitle}</Text>}
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{right}</View>
    </View>
  );
}

/** Screen scaffold: dark gradient bg, safe-area padding, centred max-width column. */
export function Screen({ children, scroll = true, padded = true, tabBar = true, style, bg }: { children: React.ReactNode; scroll?: boolean; padded?: boolean; tabBar?: boolean; style?: StyleProp<ViewStyle>; bg?: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const inner = { paddingTop: insets.top + 8, paddingHorizontal: padded ? 16 : 0, width: '100%' as const, maxWidth: MAX_WIDTH, alignSelf: 'center' as const };
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <LinearGradient colors={gradients.screen} style={StyleSheet.absoluteFill} />
      {bg}
      {scroll ? (
        <ScrollView contentContainerStyle={[inner, { paddingBottom: (tabBar ? TAB_BAR_SPACE : 28) + insets.bottom }, style]} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[inner, { flex: 1 }, style]}>{children}</View>
      )}
    </View>
  );
}

export function EmptyState({ title, body, art, action, onAction }: { title: string; body: string; art?: React.ReactNode; action?: string; onAction?: () => void }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 28, paddingHorizontal: 20 }}>
      {art}
      <Display size={22} style={{ marginTop: 10, textAlign: 'center' }}>{title}</Display>
      <Text style={{ color: colors.dim, fontFamily: fonts.regular, textAlign: 'center', marginTop: 6, lineHeight: 20 }}>{body}</Text>
      {action && <Button label={action} size="md" onPress={onAction} style={{ marginTop: 16, alignSelf: 'stretch' }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  glow: { shadowColor: colors.primary, shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10 },
  btn: { borderRadius: radius.pill, paddingHorizontal: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  btnSecondary: { borderWidth: 1.5, borderColor: colors.lineHi, backgroundColor: colors.bg },
  btnGhost: { backgroundColor: colors.cardHi, borderWidth: 1, borderColor: colors.line },
  iconBtn: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  badge: { position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderWidth: 2, borderColor: colors.bg },
  badgeText: { color: colors.onPrimary, fontSize: 9, fontFamily: fonts.bold },
  pill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 8, minWidth: 82 },
  pillOn: { backgroundColor: colors.cardHi, borderWidth: 1, borderColor: colors.lineHi },
  pillText: { fontFamily: fonts.label, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  search: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.glass, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingLeft: 14, paddingRight: 6, height: 48 },
  searchInput: { flex: 1, color: colors.text, marginLeft: 8, fontFamily: fonts.regular, fontSize: 14, height: '100%' },
  chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  chipOn: { backgroundColor: alpha(colors.primary, 0.08), borderColor: colors.primary },
  chipText: { color: colors.sub, fontFamily: fonts.label, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase' },
  seg: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: radius.pill, padding: 4, borderWidth: 1, borderColor: colors.line, marginVertical: 12 },
  segThumb: { position: 'absolute', top: 4, bottom: 4, left: 4, borderRadius: radius.pill, overflow: 'hidden' },
  segBar: { position: 'absolute', left: '30%', right: '30%', bottom: 3, height: 2.5, borderRadius: 2 },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  segText: { color: colors.sub, fontFamily: fonts.label, fontSize: 14, letterSpacing: 0.8, textTransform: 'uppercase' },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 14 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, borderRadius: radius.pill, paddingHorizontal: 11, paddingVertical: 6 },
  tagText: { color: colors.text, fontSize: 12, fontFamily: fonts.label, letterSpacing: 0.8, textTransform: 'uppercase' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 50, gap: 8 },
});
