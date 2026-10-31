import { useEffect, useState } from 'react';
import { Animated, Easing, Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { NATIVE } from '@/components/ui';
import { colors, fonts } from '@/theme';
import { useAnimatedValue } from '@/hooks/useAnimatedValue';

/** The Squirrel Social logo (assets/brand/logo.png — transparent cut-out of the brand artwork). */
export function Logo({ size = 32 }: { size?: number; color?: string }) {
  return <Image source={require('../../assets/brand/logo.png')} style={{ width: size, height: size }} resizeMode="contain" accessibilityLabel="Squirrel Social logo" />;
}

/** Logo + wordmark, as in the website's nav bar. */
export function Wordmark({ size = 28, showLogo = true, color = colors.text }: { size?: number; showLogo?: boolean; color?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {showLogo && <Logo size={size * 1.25} />}
      <Text style={{ color, fontFamily: showLogo ? fonts.label : fonts.display, fontSize: showLogo ? size * 0.62 : size * 0.72, letterSpacing: 1.2, textTransform: 'uppercase' }}>Squirrel Social</Text>
    </View>
  );
}

/**
 * The website's marquee "tape" strip: a tilted lime (or pink) band with scrolling caps.
 * Loops forever; motion is subtle and linear.
 */
export function Tape({ items, color = colors.primary, rotate = -3, style }: { items: string[]; color?: string; rotate?: number; style?: StyleProp<ViewStyle> }) {
  const x = useAnimatedValue(0);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!w) return;
    x.setValue(0);
    const loop = Animated.loop(Animated.timing(x, { toValue: -w, duration: w * 28, easing: Easing.linear, useNativeDriver: NATIVE }));
    loop.start();
    return () => loop.stop();
  }, [w, x]);
  const text = items.map((i) => `${i}  ✦  `).join('');
  const fg = color === colors.secondary ? colors.onSecondary : colors.onPrimary;
  return (
    <View style={[styles.tape, { backgroundColor: color, transform: [{ rotate: `${rotate}deg` }] }, style]} pointerEvents="none">
      <Animated.View style={{ flexDirection: 'row', transform: [{ translateX: x }] }}>
        <Text onLayout={(e) => setW(e.nativeEvent.layout.width)} style={[styles.tapeText, { color: fg }]} numberOfLines={1}>{text}</Text>
        <Text style={[styles.tapeText, { color: fg }]} numberOfLines={1}>{text}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  tape: { marginHorizontal: -40, paddingVertical: 9, overflow: 'hidden' },
  tapeText: { fontFamily: fonts.label, fontSize: 16, letterSpacing: 1.4, textTransform: 'uppercase' },
});
