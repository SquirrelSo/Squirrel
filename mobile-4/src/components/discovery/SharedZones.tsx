/**
 * Shared-zone building blocks. Everything shown is a zone-level fact from the backend (Dev B's
 * overlap API) — never a route, a time, or where anyone is right now.
 */
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { SharedContext } from '@/api/campus/types';
import { Icon, PressScale } from '@/components/ui';
import { alpha, colors, fonts, radius } from '@/theme';

export type SharedZone = SharedContext['shared_zones'][number];

export const RELATION_TEXT: Record<string, string> = {
  both_ran: 'You both ran here',
  both_claim: 'You’ve both claimed it',
  you_own_they_ran: 'You hold it · they ran here',
  they_own_you_ran: 'They hold it · you ran here',
};
export const relationText = (r: string) => RELATION_TEXT[r] ?? 'You’ve both been here';

export const PRIVACY_LINE = 'Zone-level only. Nobody sees anyone’s routes, times or live location.';

export function SharedZoneRow({ zone, index }: { zone: SharedZone; index: number }) {
  const owned = zone.relation === 'you_own_they_ran' || zone.relation === 'they_own_you_ran';
  return (
    <PressScale
      onPress={() => router.push({ pathname: '/zone/[id]', params: { id: zone.zone_id } })}
      style={styles.row}
      scaleTo={0.985}
      accessibilityRole="button"
      accessibilityLabel={`${zone.zone_name}. ${relationText(zone.relation)}. Open zone`}>
      <Text style={styles.idx}>{String(index + 1).padStart(2, '0')}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.name} numberOfLines={1}>{zone.zone_name}</Text>
        <View style={styles.relRow}>
          <Icon name={owned ? 'flag-variant' : 'run-fast'} size={12} color={owned ? colors.secondary : colors.primary} />
          <Text style={[styles.rel, { color: owned ? colors.secondary : colors.primary }]}>{relationText(zone.relation)}</Text>
        </View>
        {zone.activity_count != null && zone.activity_count > 0 && <Text style={styles.count}>{zone.activity_count} of your activities crossed it</Text>}
      </View>
      <Icon name="chevron-right" size={20} color={colors.dim} />
    </PressScale>
  );
}

/** Compact entry point on someone's profile: "3 shared zones →". */
/** `unchecked`: the server couldn't check this time, so there's no count to show (never "none yet"). */
export function SharedZonesEntry({ userId, zones, unchecked = false }: { userId: string; zones: SharedZone[]; unchecked?: boolean }) {
  const n = unchecked ? 0 : zones.length;
  return (
    <PressScale
      onPress={() => router.push({ pathname: '/shared/[id]', params: { id: userId } })}
      style={styles.entry}
      scaleTo={0.985}
      accessibilityRole="button"
      accessibilityLabel={unchecked ? 'Shared zones. Couldn’t check right now. Open' : n ? `${n} shared zones. Open` : 'Shared zones. None yet. Open'}>
      <View style={styles.entryIcon}>
        <Icon name="map-marker-radius" size={18} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.entryTitle}>{n ? `${n} shared zone${n === 1 ? '' : 's'}` : 'Shared zones'}</Text>
        <Text style={styles.entrySub} numberOfLines={1}>{unchecked ? 'Couldn’t check right now' : n ? zones.map((z) => z.zone_name).join(' · ') : 'No common ground yet'}</Text>
      </View>
      <Icon name="chevron-right" size={20} color={colors.dim} />
    </PressScale>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingVertical: 12, paddingHorizontal: 14 },
  idx: { color: colors.mute, fontFamily: fonts.display, fontSize: 22, width: 30 },
  name: { color: colors.text, fontFamily: fonts.display, fontSize: 20, letterSpacing: 0.4, textTransform: 'uppercase' },
  relRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  rel: { fontFamily: fonts.labelBold, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  count: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, marginTop: 3 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12 },
  entryIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(colors.primary, 0.08), borderWidth: 1, borderColor: alpha(colors.primary, 0.35) },
  entryTitle: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 16, letterSpacing: 0.8, textTransform: 'uppercase' },
  entrySub: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, marginTop: 1 },
});
