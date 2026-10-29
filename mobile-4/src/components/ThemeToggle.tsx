/**
 * Appearance: Dark / Light. The choice is saved on the device (SecureStore on phones,
 * localStorage on web) and the app reloads once so every screen, sheet and map layer is
 * rebuilt with the new palette — no half-themed screens. You land back where you were.
 */
import { useState } from 'react';
import { ActivityIndicator, Modal, Platform, StyleSheet, Text, View } from 'react-native';
import { reloadAppAsync } from 'expo';
import { Icon, Segmented, tap } from '@/components/ui';
import { colors, fonts, radius, saveThemePreference, THEME, type ThemeName } from '@/theme';

const LABELS = { Dark: 'dark', Light: 'light' } as const;
const RETURN_KEY = 'squirrel.theme.return';

/** Remember where to come back to after the reload (web: sessionStorage; native: in-memory is lost, so use the route param). */
function rememberReturn(path: string) {
  try {
    if (Platform.OS === 'web' && typeof sessionStorage !== 'undefined') sessionStorage.setItem(RETURN_KEY, path);
  } catch {
    // Not critical: without it you land on Home.
  }
}
/** True right after a theme-switch reload (without consuming it) — the launch splash skips itself then. */
export function isThemeReload(): boolean {
  try {
    return Platform.OS === 'web' && typeof sessionStorage !== 'undefined' && sessionStorage.getItem(RETURN_KEY) != null;
  } catch {
    return false;
  }
}
export function takeThemeReturn(): string | null {
  try {
    if (Platform.OS !== 'web' || typeof sessionStorage === 'undefined') return null;
    const v = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return v;
  } catch {
    return null;
  }
}

export function ThemeToggle({ returnTo = '/profile' }: { returnTo?: string }) {
  const [switching, setSwitching] = useState<ThemeName | null>(null);
  const change = async (label: keyof typeof LABELS) => {
    const next = LABELS[label];
    if (next === THEME || switching) return;
    tap('impact');
    setSwitching(next);
    saveThemePreference(next);
    rememberReturn(returnTo);
    // Let the overlay paint, then rebuild the app with the new palette.
    setTimeout(() => {
      if (Platform.OS === 'web') window.location.reload();
      else reloadAppAsync('Theme changed').catch(() => setSwitching(null));
    }, 250);
  };
  return (
    <View style={styles.box} accessibilityLabel="Appearance">
      <View style={styles.head}>
        <Icon name={THEME === 'light' ? 'white-balance-sunny' : 'weather-night'} size={18} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Appearance</Text>
          <Text style={styles.sub}>Dark is the classic night-campus look. Light is the daytime twin.</Text>
        </View>
      </View>
      <Segmented items={['Dark', 'Light'] as const} value={THEME === 'light' ? 'Light' : 'Dark'} onChange={change} style={{ marginVertical: 0, marginTop: 10 }} />
      <Modal visible={!!switching} transparent animationType="fade">
        <View style={styles.overlay} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.overlayText}>Switching to {switching} mode…</Text>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { color: colors.text, fontFamily: fonts.semibold, fontSize: 14 },
  sub: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, marginTop: 1 },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: colors.backdrop },
  overlayText: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 16, letterSpacing: 1, textTransform: 'uppercase', backgroundColor: colors.card, paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.pill, overflow: 'hidden' },
});
