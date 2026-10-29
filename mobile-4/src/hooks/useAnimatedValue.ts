import { useState } from 'react';
import { Animated } from 'react-native';

/**
 * An Animated.Value created once for the component's lifetime. React Native has a hook of this
 * name, but react-native-web (the web build) does not: importing it from 'react-native' crashes
 * every screen on the web. A lazy state initialiser gives the same once-only value on every platform.
 */
export function useAnimatedValue(initial: number): Animated.Value {
  const [value] = useState(() => new Animated.Value(initial));
  return value;
}
