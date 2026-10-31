/**
 * Shared cards. Only two kinds of thing appear here: artwork (scene images) and real data — a
 * progress-service daily goal, or a series of real numbers. There is no sample content.
 */
import React, { useEffect } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { DailyGoal } from '@/api/progress';
import { Scene } from '@/art/Scene';
import { SoonPill } from '@/components/Locked';
import { Icon, IconBadge, NATIVE, ProgressBar, Scrim } from '@/components/ui';
import type { IconName } from '@/data/icons';
import type { SceneKind } from '@/types';
import { alpha, colors, fonts, radius } from '@/theme';
import { useAnimatedValue } from '@/hooks/useAnimatedValue';

// ---------------------------------------------------------------------------
// Scene image (artwork)
// ---------------------------------------------------------------------------

export function SceneImage({ kind, seed, height, aspect, style, children, scrim = true }: { kind: SceneKind; seed?: number; height?: number; aspect?: number; style?: StyleProp<ViewStyle>; children?: React.ReactNode; scrim?: boolean | 'strong' }) {
  return (
    <View style={[{ height, aspectRatio: height ? undefined : aspect, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.bg2 }, style]}>
      <Scene kind={kind} seed={seed} aspect={aspect ?? 1.6} style={StyleSheet.absoluteFill} />
      {scrim && <Scrim strong={scrim === 'strong'} />}
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Daily goals (progress-service GET /v1/progress/daily → goals[])
// ---------------------------------------------------------------------------

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-IN') : n.toFixed(n % 1 === 0.5 ? 1 : 2).replace(/0$/, ''));

const GOAL_ART: Record<string, { icon: IconName; color: string; unit?: string }> = {
  steps: { icon: 'shoe-print', color: colors.green, unit: 'steps' },
  active: { icon: 'timer-outline', color: colors.secondary, unit: 'min' },
  active_minutes: { icon: 'timer-outline', color: colors.secondary, unit: 'min' },
  workout: { icon: 'arm-flex', color: colors.violet },
  workouts: { icon: 'arm-flex', color: colors.violet },
  distance: { icon: 'run-fast', color: colors.blue, unit: 'km' },
};
export const goalArt = (id: string) => GOAL_ART[id] ?? { icon: 'flag-checkered' as IconName, color: colors.primary };

/**
 * One of today's goals, exactly as the server reports it. Progress is counted by the server
 * from your runs and workouts — there's nothing to tap here to "log" it.
 */
export function GoalCard({ goal: g, compact }: { goal: DailyGoal; compact?: boolean }) {
  const art = goalArt(g.id);
  const done = g.completed || g.current >= g.target;
  const pop = useAnimatedValue(done ? 1 : 0);
  useEffect(() => {
    if (done) Animated.spring(pop, { toValue: 1, useNativeDriver: NATIVE, speed: 12, bounciness: 14 }).start();
  }, [done, pop]);
  return (
    <View style={[styles.goal, done && { borderColor: alpha(colors.green, 0.5) }]} accessibilityLabel={`${g.label}: ${fmt(g.current)} of ${fmt(g.target)}${done ? ', done' : ''}, ${g.xp} XP`}>
      <IconBadge icon={art.icon} color={art.color} size={compact ? 40 : 46} />
      <View style={{ flex: 1, marginHorizontal: 12 }}>
        <Text style={styles.gTitle} numberOfLines={1}>{g.label}</Text>
        <Text style={styles.gSub}>
          <Text style={{ color: done ? colors.green : colors.text, fontFamily: fonts.semibold }}>{fmt(g.current)}</Text> / {fmt(g.target)}
          {art.unit ? ` ${art.unit}` : ''}
        </Text>
        <ProgressBar progress={g.target ? g.current / g.target : 0} color={done ? colors.green : art.color} color2={done ? '#9CFFD2' : colors.primarySoft} style={{ marginTop: 7 }} height={5} />
      </View>
      <View style={{ alignItems: 'center', minWidth: 58 }}>
        {done ? (
          <Animated.View style={{ transform: [{ scale: pop }], alignItems: 'center' }}>
            <View style={[styles.doneDot, { backgroundColor: colors.green }]}>
              <Icon name="check-bold" size={16} color={colors.onSecondary} />
            </View>
            <Text style={[styles.xp, { color: colors.green }]}>+{g.xp} XP</Text>
          </Animated.View>
        ) : (
          <Text style={styles.xp}>+{g.xp} XP</Text>
        )}
      </View>
    </View>
  );
}

/** A goal whose feature isn't launched yet (e.g. meal & water). Never counted. */
export function LockedGoalCard({ title, icon }: { title: string; icon: IconName }) {
  return (
    <View style={[styles.goal, { opacity: 0.6 }]} accessibilityLabel={`${title}, coming soon`}>
      <IconBadge icon={icon} color={colors.mute} size={46} />
      <View style={{ flex: 1, marginHorizontal: 12 }}>
        <Text style={[styles.gTitle, { color: colors.sub }]} numberOfLines={1}>{title}</Text>
        <Text style={styles.gSub}>Not available yet</Text>
      </View>
      <SoonPill />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Bars (a series of real numbers)
// ---------------------------------------------------------------------------

export function MiniBars({ values, color, height = 44, highlightLast = true, barWidth = 7 }: { values: number[]; color: string; height?: number; highlightLast?: boolean; barWidth?: number }) {
  const max = Math.max(...values, 1);
  const spread = barWidth > 7;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 4, height, justifyContent: spread ? 'space-between' : 'flex-start' }}>
      {values.map((v, i) => (
        <GrowBar key={i} w={barWidth} h={4 + (v / max) * (height - 4)} color={color} opacity={highlightLast && i === values.length - 1 ? 1 : 0.35 + (i / values.length) * 0.45} delay={i * 45} />
      ))}
    </View>
  );
}

function GrowBar({ w, h, color, opacity, delay }: { w: number; h: number; color: string; opacity: number; delay: number }) {
  const v = useAnimatedValue(0);
  useEffect(() => {
    v.setValue(0);
    Animated.timing(v, { toValue: h, duration: 520, delay, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [h, delay, v]);
  return <Animated.View style={{ width: w, height: v, borderRadius: Math.min(4, w / 2), backgroundColor: color, opacity }} />;
}

const styles = StyleSheet.create({
  goal: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12, overflow: 'hidden' },
  gTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  gSub: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, marginTop: 2 },
  xp: { color: colors.gold, fontFamily: fonts.black, fontSize: 12, marginTop: 4 },
  doneDot: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
