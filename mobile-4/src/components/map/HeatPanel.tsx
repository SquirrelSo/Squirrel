/**
 * Map → Heat: the control panel for the activity layer. Window, legend (colour + words), the
 * layer's state, and what the heat means: aggregated activity, never anyone's live position.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { errorText, featureUnavailable } from '@/api/campus';
import { HEAT_WINDOWS } from '@/api/campus/discovery';
import type { Heatmap, HeatLevel, HeatWindow } from '@/api/campus/types';
import { HEAT_UI } from '@/components/map/HeatLayer';
import { Icon, tap } from '@/components/ui';
import { alpha, colors, fonts, radius } from '@/theme';

const WINDOW_TEXT: Record<HeatWindow, string> = { '1h': 'Last hour', '24h': 'Today', '7d': 'This week' };

export function HeatPanel({ window, onWindow, data, loading, error, onRetry, onClose }: { window: HeatWindow; onWindow: (w: HeatWindow) => void; data: Heatmap | undefined; loading: boolean; error: unknown; onRetry: () => void; onClose: () => void }) {
  const counts = (data?.cells ?? []).reduce<Record<HeatLevel, number>>((a, c) => ({ ...a, [c.level]: a[c.level] + 1 }), { low: 0, active: 0, high: 0 });
  // Unavailable: keep the panel, disable only what depends on the endpoint (the window picker).
  const unavailable = !!error && !data && featureUnavailable(error);
  const status =
    error && !data
      ? featureUnavailable(error)
        ? { icon: 'progress-wrench' as const, text: 'Heatmap · Not live yet. Coming soon.', tone: colors.violet }
        : { icon: 'wifi-off' as const, text: `Heat didn’t load. ${errorText(error)}`, tone: colors.coral, retry: true }
      : !data
        ? null
        : !data.available
          ? { icon: 'eye-off-outline' as const, text: data.reason ?? 'The heatmap is unavailable right now.', tone: colors.dim }
          : data.cells.length === 0
            ? { icon: 'weather-night' as const, text: 'Nobody’s moving here right now.', tone: colors.dim }
            : null;

  return (
    <View style={styles.panel} accessibilityLabel="Activity heatmap">
      <View style={styles.top}>
        <Icon name="fire" size={16} color={colors.secondary} />
        <Text style={styles.title}>Activity heat</Text>
        <View style={{ flex: 1 }} />
        {HEAT_WINDOWS.map((w) => {
          const on = w === window;
          return (
            <Pressable key={w} disabled={unavailable} onPress={() => { tap(); onWindow(w); }} style={[styles.win, on && styles.winOn, unavailable && { opacity: 0.4 }]} accessibilityRole="button" accessibilityState={{ selected: on, disabled: unavailable }} accessibilityLabel={WINDOW_TEXT[w]}>
              <Text style={[styles.winText, on && { color: colors.primary }]}>{w}</Text>
            </Pressable>
          );
        })}
        <Pressable onPress={onClose} hitSlop={10} style={{ marginLeft: 4 }} accessibilityRole="button" accessibilityLabel="Hide heatmap">
          <Icon name="close" size={18} color={colors.dim} />
        </Pressable>
      </View>

      {loading && !data && !error ? (
        <View style={styles.status}>
          <ActivityIndicator size="small" color={colors.secondary} />
          <Text style={styles.statusText}>Reading the campus…</Text>
        </View>
      ) : status ? (
        <View style={styles.status}>
          <Icon name={status.icon} size={16} color={status.tone} />
          <Text style={[styles.statusText, { color: status.tone === colors.dim ? colors.sub : status.tone }]}>{status.text}</Text>
          {'retry' in status && status.retry && (
            <Text style={styles.retry} onPress={onRetry} accessibilityRole="button">Retry</Text>
          )}
        </View>
      ) : (
        <View style={styles.legend}>
          {(['low', 'active', 'high'] as HeatLevel[]).map((l) => (
            <View key={l} style={styles.key} accessibilityLabel={`${HEAT_UI[l].label}: ${counts[l]} areas`}>
              <View style={[styles.dot, { backgroundColor: HEAT_UI[l].color }]} />
              <Text style={styles.keyText}>{HEAT_UI[l].label}</Text>
              <Text style={styles.keyCount}>{counts[l]}</Text>
            </View>
          ))}
        </View>
      )}

      <Text style={styles.fine}>
        {WINDOW_TEXT[window]} · aggregated activity{data?.min_people_per_cell ? ` from ${data.min_people_per_cell}+ people per area` : ''}. Never anyone’s live position.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: alpha(colors.panel, 0.95), borderRadius: radius.lg, borderWidth: 1, borderColor: alpha(colors.secondary, 0.35), padding: 12, gap: 8 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 15, letterSpacing: 1, textTransform: 'uppercase' },
  win: { borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 9, paddingVertical: 3 },
  winOn: { borderColor: colors.primary, backgroundColor: alpha(colors.primary, 0.08) },
  winText: { color: colors.dim, fontFamily: fonts.labelBold, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 22 },
  statusText: { flex: 1, color: colors.sub, fontFamily: fonts.medium, fontSize: 13 },
  retry: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: 4 },
  legend: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
  key: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  keyText: { color: colors.sub, fontFamily: fonts.label, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase' },
  keyCount: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11 },
  fine: { color: colors.dim, fontFamily: fonts.regular, fontSize: 11, lineHeight: 15 },
});
