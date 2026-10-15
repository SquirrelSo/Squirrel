import React, { useEffect } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NATIVE } from '@/components/ui';
import { colors, MAX_WIDTH, radius } from '@/theme';
import { useAnimatedValue } from '@/hooks/useAnimatedValue';

/**
 * Bottom-sheet chrome for routes presented as `transparentModal`.
 * Tapping the backdrop dismisses (router.back()).
 */
export function Sheet({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  const insets = useSafeAreaInsets();
  const v = useAnimatedValue(0);
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE }).start();
  }, [v]);
  const close = () => {
    Animated.timing(v, { toValue: 0, duration: 200, easing: Easing.in(Easing.quad), useNativeDriver: NATIVE }).start(() => (onClose ? onClose() : router.back()));
  };
  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.backdrop, opacity: v }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close" />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: insets.bottom + 18, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [500, 0] }) }] },
        ]}>
        <View style={styles.grip} />
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, alignSelf: 'center', width: '100%', maxWidth: MAX_WIDTH, backgroundColor: colors.bg2, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 16, paddingTop: 10 },
  grip: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: colors.lineHi, marginBottom: 12 },
});
