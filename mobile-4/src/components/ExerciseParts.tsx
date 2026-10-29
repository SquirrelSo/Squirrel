import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { formScoreColor } from '@/api/exercise';
import { Icon, Ring, tap } from '@/components/ui';
import { alpha, colors, fonts, radius } from '@/theme';

/** Loading / error row for a remote section. Renders nothing once data is in and fresh. */
export function RemoteStatus({ loading, error, hasData, onRetry, label }: { loading: boolean; error: string | null; hasData: boolean; onRetry: () => void; label: string }) {
  if (error) {
    return (
      <View style={styles.err}>
        <Icon name="cloud-off-outline" size={18} color={colors.coral} />
        <Text style={styles.errText} numberOfLines={3}>
          {hasData ? `Showing saved ${label}. ` : `Couldn't load ${label}. `}
          {error}
        </Text>
        <Pressable onPress={() => { tap(); onRetry(); }} hitSlop={8} accessibilityLabel={`Retry loading ${label}`}>
          <Text style={styles.retry}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (loading && !hasData) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.loadingText}>Loading {label}…</Text>
      </View>
    );
  }
  return null;
}

/** − value + control, clamped to [min, max]. */
export function Stepper({ label, value, unit, min, max, step, onChange }: { label: string; value: number; unit?: string; min: number; max: number; step: number; onChange: (v: number) => void }) {
  const set = (v: number) => {
    const c = Math.min(max, Math.max(min, v));
    if (c !== value) {
      tap();
      onChange(c);
    }
  };
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepLabel}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable onPress={() => set(value - step)} disabled={value <= min} style={[styles.stepBtn, value <= min && { opacity: 0.35 }]} accessibilityLabel={`Decrease ${label}`}>
          <Icon name="minus" size={18} color={colors.text} />
        </Pressable>
        <Text style={styles.stepValue}>
          {value}
          {unit ? <Text style={styles.stepUnit}> {unit}</Text> : null}
        </Text>
        <Pressable onPress={() => set(value + step)} disabled={value >= max} style={[styles.stepBtn, value >= max && { opacity: 0.35 }]} accessibilityLabel={`Increase ${label}`}>
          <Icon name="plus" size={18} color={colors.text} />
        </Pressable>
      </View>
    </View>
  );
}

export function StatTile({ value, label, color = colors.text }: { value: string; label: string; color?: string }) {
  return (
    <View style={styles.tile}>
      <Text style={[styles.tileValue, { color }]} numberOfLines={1}>{value}</Text>
      <Text style={styles.tileLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export const scoreColor = (s: number | null | undefined) => formScoreColor(s, { good: colors.green, mid: colors.gold, poor: colors.coral, none: colors.mute });

export function ScoreRing({ score, size = 76, label = 'form' }: { score: number | null | undefined; size?: number; label?: string }) {
  const c = scoreColor(score);
  return (
    <Ring progress={score == null ? 0 : score / 100} size={size} stroke={7} color={c}>
      <Text style={[styles.ringValue, { color: score == null ? colors.dim : colors.text, fontSize: size * 0.3 }]}>{score == null ? '—' : Math.round(score)}</Text>
      <Text style={styles.ringLabel}>{label}</Text>
    </Ring>
  );
}

const styles = StyleSheet.create({
  err: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: alpha(colors.coral, 0.08), borderColor: alpha(colors.coral, 0.35), borderWidth: 1, borderRadius: radius.md, padding: 10, marginBottom: 10 },
  errText: { flex: 1, color: colors.text, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  retry: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14 },
  loadingText: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
  stepLabel: { color: colors.text, fontFamily: fonts.label, fontSize: 15, letterSpacing: 1, textTransform: 'uppercase' },
  stepBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardHi, borderWidth: 1, borderColor: colors.line },
  stepValue: { color: colors.text, fontFamily: fonts.display, fontSize: 24, minWidth: 64, textAlign: 'center' },
  stepUnit: { color: colors.dim, fontFamily: fonts.label, fontSize: 13 },
  tile: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingVertical: 10, paddingHorizontal: 10 },
  tileValue: { fontFamily: fonts.display, fontSize: 22 },
  tileLabel: { color: colors.dim, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 2 },
  ringValue: { fontFamily: fonts.display },
  ringLabel: { color: colors.dim, fontFamily: fonts.mono, fontSize: 9, textTransform: 'uppercase', marginTop: -2 },
});
