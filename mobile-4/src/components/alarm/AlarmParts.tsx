/**
 * Movement Alarm building blocks: the big clock, the time picker, the challenge picker, amount
 * chips and the alarm card. Built from the shared UI kit (components/ui) and theme tokens.
 */
import { StyleSheet, Switch, Text, View } from 'react-native';
import { formatClock, from24, to24, type ClockTime } from '@/logic/alarmTime';
import { CHALLENGES, challengeById, challengeSummary, type ChallengeId } from '@/logic/movementChallenges';
import type { Alarm } from '@/features/alarm/AlarmService';
import { Icon, PressScale, tap } from '@/components/ui';
import { alpha, colors, DISPLAY_SKEW, fonts, radius } from '@/theme';

type IconName = React.ComponentProps<typeof Icon>['name'];
const icon = (n: string) => n as IconName;

export function BigClock({ time, size = 76, dim }: { time: ClockTime; size?: number; dim?: boolean }) {
  const f = formatClock(time);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end' }} accessibilityLabel={f.full}>
      <Text style={[styles.clock, { fontSize: size, lineHeight: size * 1.08 }, dim && { color: colors.dim }]}>{f.time}</Text>
      <Text style={[styles.ampm, { fontSize: size * 0.3, marginBottom: size * 0.14 }, dim && { color: colors.dim }]}>{f.ampm}</Text>
    </View>
  );
}

/** Hours ±1, minutes ±5 (±1 with the small buttons), AM / PM. No native picker needed. */
export function TimePicker({ value, onChange }: { value: ClockTime; onChange: (t: ClockTime) => void }) {
  const p = from24(value);
  const set = (h12: number, minute: number, ampm: 'AM' | 'PM') => {
    tap();
    onChange(to24(((h12 - 1 + 12) % 12) + 1, ((minute % 60) + 60) % 60, ampm));
  };
  return (
    <View style={styles.picker}>
      <View style={styles.pickRow}>
        <Stepper
          label="Hour"
          value={String(p.h12).padStart(2, '0')}
          onUp={() => set(p.h12 + 1, p.minute, p.ampm)}
          onDown={() => set(p.h12 - 1, p.minute, p.ampm)}
        />
        <Text style={styles.colon}>:</Text>
        <Stepper
          label="Minute"
          value={String(p.minute).padStart(2, '0')}
          onUp={() => set(p.h12, p.minute + 5 - (p.minute % 5), p.ampm)}
          onDown={() => set(p.h12, p.minute % 5 ? p.minute - (p.minute % 5) : p.minute - 5, p.ampm)}
          fine={{ up: () => set(p.h12, p.minute + 1, p.ampm), down: () => set(p.h12, p.minute - 1, p.ampm) }}
        />
        <View style={{ gap: 8, marginLeft: 6 }}>
          {(['AM', 'PM'] as const).map((x) => (
            <PressScale key={x} onPress={() => set(p.h12, p.minute, x)} style={[styles.ampmBtn, p.ampm === x && styles.ampmOn]} scaleTo={0.94} accessibilityRole="radio" accessibilityState={{ selected: p.ampm === x }}>
              <Text style={[styles.ampmText, p.ampm === x && { color: colors.onPrimary }]}>{x}</Text>
            </PressScale>
          ))}
        </View>
      </View>
    </View>
  );
}

function Stepper({ label, value, onUp, onDown, fine }: { label: string; value: string; onUp: () => void; onDown: () => void; fine?: { up: () => void; down: () => void } }) {
  return (
    <View style={{ alignItems: 'center' }}>
      <PressScale onPress={onUp} style={styles.step} scaleTo={0.9} accessibilityLabel={`${label} up`} haptic={false}>
        <Icon name="chevron-up" size={26} color={colors.text} />
      </PressScale>
      <Text style={styles.stepValue} accessibilityLabel={`${label} ${value}`}>{value}</Text>
      <PressScale onPress={onDown} style={styles.step} scaleTo={0.9} accessibilityLabel={`${label} down`} haptic={false}>
        <Icon name="chevron-down" size={26} color={colors.text} />
      </PressScale>
      {fine && (
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
          <Text style={styles.fine} onPress={fine.down} accessibilityRole="button" accessibilityLabel="One minute earlier">−1</Text>
          <Text style={styles.fine} onPress={fine.up} accessibilityRole="button" accessibilityLabel="One minute later">+1</Text>
        </View>
      )}
    </View>
  );
}

const TILT = [-2.5, 2, -1.5, 2.5];
const TINT = [colors.secondary, colors.primary, colors.orange, colors.violet];

export function ChallengePicker({ value, onChange }: { value: ChallengeId; onChange: (c: ChallengeId) => void }) {
  return (
    <View style={styles.grid}>
      {CHALLENGES.map((c, i) => {
        const on = c.id === value;
        const tint = TINT[i % TINT.length];
        return (
          <PressScale
            key={c.id}
            onPress={() => onChange(c.id)}
            style={[styles.chal, on && { borderColor: tint, backgroundColor: alpha(tint, 0.1), transform: [{ rotate: `${TILT[i % TILT.length]}deg` }] }]}
            scaleTo={0.95}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${c.label}. ${c.howTo}`}>
            <View style={[styles.chalIcon, { backgroundColor: on ? tint : colors.cardHi }]}>
              <Icon name={icon(c.icon)} size={22} color={on ? colors.onPrimary : colors.sub} />
            </View>
            <Text style={[styles.chalLabel, on && { color: colors.text }]}>{c.label}</Text>
            <Text style={styles.chalUnit}>{c.unit === 'sec' ? 'keep moving' : 'count reps'}</Text>
          </PressScale>
        );
      })}
    </View>
  );
}

export function AmountPicker({ challenge, value, onChange }: { challenge: ChallengeId; value: number; onChange: (n: number) => void }) {
  const c = challengeById(challenge);
  return (
    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
      {c.amounts.map((n) => {
        const on = n === value;
        return (
          <PressScale key={n} onPress={() => { tap(); onChange(n); }} style={[styles.amount, on && { borderColor: colors.primary, backgroundColor: alpha(colors.primary, 0.1) }]} scaleTo={0.94} accessibilityRole="radio" accessibilityState={{ selected: on }}>
            <Text style={[styles.amountV, on && { color: colors.primary }]}>{n}</Text>
            <Text style={styles.amountU}>{c.unit === 'sec' ? 'sec' : 'reps'}</Text>
          </PressScale>
        );
      })}
    </View>
  );
}

export function AlarmCard({ alarm, onPress, onToggle }: { alarm: Alarm; onPress: () => void; onToggle: (on: boolean) => void }) {
  const c = challengeById(alarm.challenge);
  // The switch sits outside the pressable area, so flipping it never also opens the editor.
  return (
    <View style={[styles.card, !alarm.enabled && { opacity: 0.72 }]}>
      <PressScale onPress={onPress} style={{ flex: 1 }} scaleTo={0.98} accessibilityLabel={`${formatClock(alarm.time).full}, ${challengeSummary(alarm.challenge, alarm.amount)}, ${alarm.enabled ? 'active' : 'off'}. Edit`}>
        <BigClock time={alarm.time} size={40} dim={!alarm.enabled} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <Icon name={icon(c.icon)} size={14} color={alarm.enabled ? colors.secondary : colors.dim} />
          <Text style={styles.cardSub}>{challengeSummary(alarm.challenge, alarm.amount)}{alarm.label ? ` · ${alarm.label}` : ''}</Text>
        </View>
      </PressScale>
      <View style={{ alignItems: 'flex-end', gap: 8 }}>
        <Text style={[styles.status, { color: alarm.enabled ? colors.primary : colors.dim, borderColor: alarm.enabled ? colors.primary : colors.line }]}>{alarm.enabled ? 'Active' : 'Off'}</Text>
        <Switch
          value={alarm.enabled}
          onValueChange={onToggle}
          trackColor={{ false: colors.lineHi, true: colors.primaryDeep }}
          thumbColor={alarm.enabled ? colors.primary : colors.dim}
          accessibilityLabel={alarm.enabled ? 'Turn alarm off' : 'Turn alarm on'}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  clock: { color: colors.text, fontFamily: fonts.display, letterSpacing: 1, transform: [{ skewX: DISPLAY_SKEW }] },
  ampm: { color: colors.primary, fontFamily: fonts.labelBold, marginLeft: 6, letterSpacing: 1 },
  picker: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingVertical: 14, alignItems: 'center' },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  step: { width: 52, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardHi },
  stepValue: { color: colors.text, fontFamily: fonts.display, fontSize: 56, lineHeight: 64, minWidth: 78, textAlign: 'center', transform: [{ skewX: DISPLAY_SKEW }] },
  colon: { color: colors.dim, fontFamily: fonts.display, fontSize: 48, marginBottom: 6 },
  fine: { color: colors.dim, fontFamily: fonts.label, fontSize: 13, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  ampmBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.line },
  ampmOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  ampmText: { color: colors.sub, fontFamily: fonts.labelBold, fontSize: 15, letterSpacing: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chal: { width: '48%', flexGrow: 1, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1.5, borderColor: colors.line, padding: 12, gap: 6 },
  chalIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  chalLabel: { color: colors.sub, fontFamily: fonts.display, fontSize: 22, letterSpacing: 0.5, textTransform: 'uppercase', transform: [{ skewX: DISPLAY_SKEW }] },
  chalUnit: { color: colors.dim, fontFamily: fonts.medium, fontSize: 12 },
  amount: { minWidth: 70, alignItems: 'center', paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.card },
  amountV: { color: colors.text, fontFamily: fonts.display, fontSize: 24 },
  amountU: { color: colors.dim, fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 14, gap: 12 },
  cardSub: { color: colors.sub, fontFamily: fonts.medium, fontSize: 13 },
  status: { fontFamily: fonts.labelBold, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 3, overflow: 'hidden' },
});
