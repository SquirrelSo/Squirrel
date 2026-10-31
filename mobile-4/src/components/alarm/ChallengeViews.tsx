/**
 * The views of a movement challenge, each driven by plain props (the ring screen owns the state):
 *   WakeIntro       "WAKE UP, SQUIRREL." + the challenge + START MOVING
 *   MovingView      live progress for any challenge (continuous seconds or reps)
 *   PermissionView  ask / denied / blocked / unsupported / detection failed — always with a way out
 *   CatchSquirrel   backup challenge when no sensor can work (tap the squirrel N times)
 *   DefeatedView    ALARM DEFEATED ✓
 */
import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Mascot } from '@/art/Mascot';
import { Button, Display, Icon, NATIVE, ProgressBar, Ring, Tagline, tap } from '@/components/ui';
import type { ChallengeDef } from '@/logic/movementChallenges';
import type { EngineState } from '@/logic/movementEngine';
import type { DetectorStatus } from '@/features/alarm/MovementDetectionService';
import { alpha, colors, DISPLAY_SKEW, fonts, radius } from '@/theme';

type IconName = React.ComponentProps<typeof Icon>['name'];
const unitText = (def: ChallengeDef, n: number) => (def.unit === 'sec' ? (n === 1 ? 'second' : 'seconds') : n === 1 ? 'rep' : 'reps');

/** A wobbly, slightly chaotic headline. */
function Shout({ children, color = colors.text, size = 52 }: { children: React.ReactNode; color?: string; size?: number }) {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 140, easing: Easing.linear, useNativeDriver: NATIVE }),
        Animated.timing(v, { toValue: -1, duration: 280, easing: Easing.linear, useNativeDriver: NATIVE }),
        Animated.timing(v, { toValue: 0, duration: 140, easing: Easing.linear, useNativeDriver: NATIVE }),
        Animated.delay(1400),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  const rotate = v.interpolate({ inputRange: [-1, 1], outputRange: ['-2.5deg', '2.5deg'] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Display size={size} color={color} style={{ textAlign: 'center', lineHeight: size * 1.02 }}>{children}</Display>
    </Animated.View>
  );
}

export function WakeIntro({ def, amount, label, practice, onStart }: { def: ChallengeDef; amount: number; label: string | null; practice: boolean; onStart: () => void }) {
  return (
    <View style={styles.center}>
      <Mascot pose="cheer" accessory="headphones" size={150} animated />
      <Shout>
        {practice ? 'Practice' : 'Wake up,'}
        {'\n'}
        <Text style={{ color: colors.primary }}>{practice ? 'round.' : 'squirrel.'}</Text>
      </Shout>
      <Text style={styles.sub}>{practice ? 'Try the challenge — nothing rings, nothing is recorded.' : 'No snoozing. You have to move.'}</Text>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={styles.ticket}>
        <Text style={styles.ticketKicker}>Movement challenge</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name={def.icon as IconName} size={30} color={colors.secondary} />
          <Text style={styles.ticketTitle}>{def.label}</Text>
        </View>
        <Text style={styles.ticketAmount}>
          {amount} <Text style={styles.ticketUnit}>{def.unit === 'sec' ? 'sec' : 'reps'}</Text>
        </Text>
        <Text style={styles.ticketHow}>{def.howTo}</Text>
      </View>
      <Button label="Start moving" iconLeft="run-fast" onPress={onStart} style={{ alignSelf: 'stretch', marginTop: 18 }} />
    </View>
  );
}

const STATUS_COPY: Record<EngineState['status'], { title: string; color: string }> = {
  waiting: { title: 'Start moving!', color: colors.text },
  moving: { title: 'Keep moving', color: colors.primary },
  stopped: { title: 'Keep moving, squirrel.', color: colors.secondary },
  done: { title: 'Done!', color: colors.primary },
};

export function MovingView({ def, state, simulated, onSimulate }: { def: ChallengeDef; state: EngineState; simulated: boolean; onSimulate?: (moving: boolean) => void }) {
  // "Back to zero" shows for 1.6 s after a reset (state.now advances with the 250 ms tick).
  const resetFlash = state.resetAt != null && state.now - state.resetAt < 1600;
  const [pop] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!state.progress) return;
    pop.setValue(1.14);
    Animated.spring(pop, { toValue: 1, friction: 4, useNativeDriver: NATIVE }).start();
  }, [state.progress, pop]);

  const copy = resetFlash ? { title: 'Back to zero. Go again!', color: colors.secondary } : STATUS_COPY[state.status];
  const pct = state.target ? state.progress / state.target : 0;
  const bars = 14;
  const level = Math.min(1, state.intensity / 6);
  return (
    <View style={styles.center}>
      <Text style={[styles.statusTitle, { color: copy.color }]} accessibilityLiveRegion="polite">{copy.title}</Text>
      <Text style={styles.sub}>{state.status === 'stopped' ? def.stopRule : def.howTo}</Text>
      <Animated.View style={{ transform: [{ scale: pop }], marginTop: 18 }}>
        <Ring progress={pct} size={210} stroke={16} color={state.status === 'stopped' ? colors.secondary : colors.primary} color2={colors.gold}>
          <View style={{ alignItems: 'center' }}>
            <Text style={styles.bigNum}>{state.progress}</Text>
            <Text style={styles.ofText}>/ {state.target} {unitText(def, state.target)}</Text>
          </View>
        </Ring>
      </Animated.View>
      <ProgressBar progress={pct} color={colors.primary} color2={colors.gold} height={10} style={{ alignSelf: 'stretch', marginTop: 18 }} />
      <Text style={styles.progressText} accessibilityLabel={`${state.progress} of ${state.target} ${unitText(def, state.target)}`}>
        {state.progress} / {state.target} {unitText(def, state.target)}
      </Text>
      {/* Live movement meter: what the sensor feels right now. */}
      <View style={styles.meter} accessibilityLabel={state.status === 'moving' ? 'Movement detected' : 'No movement detected'}>
        {Array.from({ length: bars }, (_, i) => {
          const on = i / bars < level;
          return <View key={i} style={[styles.meterBar, { height: 8 + i * 2.2, backgroundColor: on ? (i > bars * 0.7 ? colors.secondary : colors.primary) : colors.line }]} />;
        })}
      </View>
      <Mascot pose={state.status === 'moving' ? 'run' : state.status === 'stopped' ? 'sleep' : 'idle'} accessory="headphones" size={96} animated style={{ marginTop: 6 }} />
      {simulated && (
        <View style={styles.simBox}>
          <Text style={styles.simText}>DEVELOPMENT · Simulated movement, not real detection</Text>
          <Pressable
            onPressIn={() => onSimulate?.(true)}
            onPressOut={() => onSimulate?.(false)}
            style={({ pressed }) => [styles.simBtn, pressed && { backgroundColor: colors.violet }]}
            accessibilityRole="button"
            accessibilityLabel="Hold to simulate moving">
            <Text style={styles.simBtnText}>Hold to simulate moving</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

export type PermissionMode = 'ask' | 'denied' | 'blocked' | 'unsupported' | 'failed';

export function permissionModeOf(s: DetectorStatus): PermissionMode | null {
  if (s.state === 'ready') return null;
  if (s.state === 'needs-permission') return 'ask';
  if (s.state === 'denied') return s.canAskAgain ? 'denied' : 'blocked';
  return 'unsupported';
}

const PERM: Record<PermissionMode, { icon: IconName; title: string; color: string }> = {
  ask: { icon: 'motion-sensor', title: 'Time to get moving', color: colors.primary },
  denied: { icon: 'hand-back-left-off-outline', title: 'No sensor, no proof', color: colors.secondary },
  blocked: { icon: 'cog-outline', title: 'Motion access is off', color: colors.secondary },
  unsupported: { icon: 'cellphone-off', title: 'Can’t feel your moves here', color: colors.orange },
  failed: { icon: 'alert-octagon-outline', title: 'Lost the signal', color: colors.coral },
};

export function PermissionView({
  mode,
  why,
  reason,
  busy,
  onAllow,
  onOpenSettings,
  onRetry,
  onBackup,
  onSimulate,
}: {
  mode: PermissionMode;
  why: string;
  reason?: string | null;
  busy?: boolean;
  onAllow: () => void;
  onOpenSettings: () => void;
  onRetry: () => void;
  onBackup: () => void;
  onSimulate?: () => void;
}) {
  const p = PERM[mode];
  const body =
    mode === 'ask'
      ? why
      : mode === 'denied'
        ? 'Squirrel Social needs motion access to check you’re moving. Allow it, or beat the backup challenge instead.'
        : mode === 'blocked'
          ? 'Motion access was turned off for Squirrel Social. Turn it back on in Settings, or beat the backup challenge.'
          : mode === 'failed'
            ? `${reason ?? 'Movement detection stopped working.'} Try again, or beat the backup challenge.`
            : `${reason ?? 'This device can’t sense movement.'} You can still switch the alarm off with the backup challenge.`;
  return (
    <View style={styles.center}>
      <View style={[styles.permIcon, { backgroundColor: alpha(p.color, 0.14), borderColor: p.color }]}>
        <Icon name={p.icon} size={44} color={p.color} />
      </View>
      <Display size={40} style={{ textAlign: 'center', marginTop: 16 }}>{p.title}</Display>
      <Text style={[styles.sub, { marginTop: 10 }]}>{body}</Text>
      <View style={{ alignSelf: 'stretch', gap: 10, marginTop: 22 }}>
        {mode === 'ask' && <Button label={busy ? 'Asking…' : 'Allow access'} iconLeft="check" disabled={busy} onPress={onAllow} />}
        {mode === 'denied' && <Button label={busy ? 'Asking…' : 'Allow access'} iconLeft="refresh" disabled={busy} onPress={onAllow} />}
        {mode === 'blocked' && <Button label="Open Settings" iconLeft="cog-outline" onPress={onOpenSettings} />}
        {mode === 'blocked' && <Button label="I turned it on" variant="secondary" size="md" iconLeft="refresh" onPress={onRetry} />}
        {mode === 'failed' && <Button label="Try again" iconLeft="refresh" onPress={onRetry} />}
        {mode !== 'ask' && <Button label="Backup challenge" variant="secondary" size="md" iconLeft="gesture-tap" onPress={onBackup} />}
        {onSimulate && <Button label="Dev: simulate movement" variant="secondary" size="sm" iconLeft="flask-outline" onPress={onSimulate} />}
      </View>
    </View>
  );
}

/** Backup when no sensor works: catch the squirrel as it hops around. Needs you awake, not asleep. */
export function CatchSquirrel({ caught, target, onCatch }: { caught: number; target: number; onCatch: () => void }) {
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [pos, setPos] = useState({ x: 0.5, y: 0.5 });
  const size = 86;
  const hop = () => setPos({ x: Math.random(), y: Math.random() });
  const onLayout = (e: LayoutChangeEvent) => setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Tagline size={22} rotate={-3}>Backup challenge</Tagline>
      <Display size={38} style={{ textAlign: 'center', marginTop: 8 }}>Catch the squirrel</Display>
      <Text style={styles.sub}>Your phone can’t check movement, so catch it {target} times. It won’t sit still.</Text>
      <Text style={styles.progressText}>{caught} / {target} caught</Text>
      <ProgressBar progress={target ? caught / target : 0} color={colors.primary} color2={colors.gold} height={8} style={{ alignSelf: 'stretch', marginTop: 6 }} />
      <View style={styles.arena} onLayout={onLayout}>
        {area.w > 0 && (
          <Pressable
            onPress={() => {
              tap('impact');
              onCatch();
              hop();
            }}
            style={{ position: 'absolute', left: pos.x * Math.max(0, area.w - size), top: pos.y * Math.max(0, area.h - size), width: size, height: size }}
            accessibilityRole="button"
            accessibilityLabel={`Catch the squirrel, ${caught} of ${target}`}>
            <Mascot pose="run" size={size} animated />
          </Pressable>
        )}
      </View>
    </View>
  );
}

export function DefeatedView({ seconds, streak, practice, usedBackup, onContinue }: { seconds: number; streak: number | null; practice: boolean; usedBackup: boolean; onContinue: () => void }) {
  return (
    <View style={styles.center}>
      <Mascot pose="celebrate" accessory="crown" size={170} animated />
      <Shout color={colors.primary}>{practice ? 'Nailed it ✓' : 'Alarm\ndefeated ✓'}</Shout>
      <Text style={styles.sub}>{practice ? 'That’s how it goes at wake-up time.' : usedBackup ? 'Squirrel caught. You’re up.' : 'You moved. You’re up. Go get the day.'}</Text>
      <View style={styles.stats}>
        <View style={styles.stat}>
          <Text style={styles.statV}>{seconds}s</Text>
          <Text style={styles.statL}>to beat it</Text>
        </View>
        {streak != null && (
          <View style={styles.stat}>
            <Text style={[styles.statV, { color: colors.orange }]}>{streak}🔥</Text>
            <Text style={styles.statL}>day streak</Text>
          </View>
        )}
      </View>
      {/* XP is only shown when the server awards it; there's no alarm XP endpoint yet. */}
      {!practice && <Text style={styles.xpNote}>Alarm XP · Not live yet</Text>}
      <Button label="Continue" icon="arrow-right" onPress={onContinue} style={{ alignSelf: 'stretch', marginTop: 20 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', width: '100%' },
  sub: { color: colors.sub, fontFamily: fonts.medium, fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 8, maxWidth: 340 },
  label: { color: colors.secondary, fontFamily: fonts.label, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', marginTop: 6 },
  ticket: { alignSelf: 'stretch', marginTop: 20, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1.5, borderColor: colors.secondary, padding: 16, alignItems: 'center', gap: 4, transform: [{ rotate: '-1.5deg' }] },
  ticketKicker: { color: colors.dim, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase' },
  ticketTitle: { color: colors.text, fontFamily: fonts.display, fontSize: 40, textTransform: 'uppercase', transform: [{ skewX: DISPLAY_SKEW }] },
  ticketAmount: { color: colors.primary, fontFamily: fonts.display, fontSize: 48, lineHeight: 52 },
  ticketUnit: { fontSize: 22, color: colors.primary },
  ticketHow: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13, textAlign: 'center', lineHeight: 18 },
  statusTitle: { fontFamily: fonts.display, fontSize: 40, lineHeight: 44, textTransform: 'uppercase', textAlign: 'center', transform: [{ skewX: DISPLAY_SKEW }] },
  bigNum: { color: colors.text, fontFamily: fonts.display, fontSize: 72, lineHeight: 78 },
  ofText: { color: colors.dim, fontFamily: fonts.label, fontSize: 14, letterSpacing: 0.8, textTransform: 'uppercase' },
  progressText: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 16, letterSpacing: 1, marginTop: 8 },
  meter: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 44, marginTop: 14 },
  meterBar: { width: 7, borderRadius: 3 },
  simBox: { alignSelf: 'stretch', marginTop: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.violet, borderRadius: radius.md, padding: 10, gap: 8 },
  simText: { color: colors.violet, fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.8, textAlign: 'center' },
  simBtn: { backgroundColor: alpha(colors.violet, 0.25), borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' },
  simBtnText: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 14, letterSpacing: 1, textTransform: 'uppercase' },
  permIcon: { width: 96, height: 96, borderRadius: 30, borderWidth: 2, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-6deg' }] },
  arena: { alignSelf: 'stretch', flex: 1, minHeight: 300, marginTop: 14, borderRadius: radius.lg, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.line, backgroundColor: alpha(colors.primary, 0.04), overflow: 'hidden' },
  stats: { flexDirection: 'row', gap: 12, marginTop: 18 },
  stat: { minWidth: 110, alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingVertical: 12, paddingHorizontal: 14 },
  statV: { color: colors.primary, fontFamily: fonts.display, fontSize: 34 },
  statL: { color: colors.dim, fontFamily: fonts.label, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' },
  xpNote: { color: colors.dim, fontFamily: fonts.label, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', marginTop: 12, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, overflow: 'hidden' },
});
