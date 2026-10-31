/**
 * After an activity: the zones it interacted with, and — only where the backend says so —
 * the Claim / Steal / Defend action for each. Passing through a zone is shown as exactly that.
 */
import { StyleSheet, Text, View } from 'react-native';
import { errorText, type ActivityZones, type TerritoryAction, type ZoneInteraction } from '@/api/campus';
import { LoadingInline } from '@/components/campus/States';
import { TerritoryActionButton } from '@/components/campus/TerritoryAction';
import { RELATION_COLOR, relationOf, UNDER_ATTACK } from '@/components/campus/territoryUi';
import { Button, Icon } from '@/components/ui';
import { colors, fonts, radius } from '@/theme';

const INTERACTION: Record<ZoneInteraction['interaction'], string> = { passed_through: 'Passed through', looped: 'Looped', visited: 'Visited' };
const dur = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

export type RunZonesState = { status: 'idle' | 'loading' | 'error' | 'ready' | 'unavailable'; data?: ActivityZones; error?: unknown; note?: string };

function pick(z: ZoneInteraction, meId: string | null): TerritoryAction | null {
  const rel = relationOf(z.territory, meId);
  if (rel === 'unclaimed') return 'claim';
  if (rel === 'other') return 'steal';
  if (rel === 'mine' && (z.actions.defend.allowed || z.territory.under_challenge)) return 'defend';
  return null;
}

export function RunZones({ state, meId, onRetry }: { state: RunZonesState; meId: string | null; onRetry: () => void }) {
  return (
    <View style={styles.box}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="map-marker-radius" size={16} color={colors.primary} />
        <Text style={styles.title}>Zones on this route</Text>
      </View>
      {state.status === 'loading' && <LoadingInline label="Checking zones with the server…" />}
      {state.status === 'unavailable' && <Text style={styles.note}>{state.note ?? 'Zone claiming isn’t available for this activity.'}</Text>}
      {state.status === 'error' && (
        <View style={{ gap: 8 }}>
          <Text style={[styles.note, { color: colors.coral }]}>{errorText(state.error)}</Text>
          <Button label="Retry" size="sm" variant="secondary" iconLeft="refresh" onPress={onRetry} />
        </View>
      )}
      {state.status === 'ready' && state.data && state.data.status === 'processing' && (
        <View style={{ gap: 8 }}>
          <Text style={styles.note}>{state.note ?? 'The server is still verifying this activity. Zone eligibility appears once it’s done.'}</Text>
          <Button label="Check again" size="sm" variant="secondary" iconLeft="refresh" onPress={onRetry} />
        </View>
      )}
      {state.status === 'ready' && state.data && state.data.status === 'rejected' && <Text style={styles.note}>This activity was rejected, so it can’t unlock zones.</Text>}
      {state.status === 'ready' && state.data && state.data.status !== 'processing' && state.data.status !== 'rejected' && (
        <>
          {state.data.zones.length === 0 ? (
            <Text style={styles.note}>You didn’t pass through any campus zones this time.</Text>
          ) : (
            state.data.zones.map((z) => {
              const rel = relationOf(z.territory, meId);
              const action = pick(z, meId);
              const c = z.territory.under_challenge && rel === 'mine' ? UNDER_ATTACK : RELATION_COLOR[rel];
              const eligible = z.actions.claim.allowed || z.actions.steal.allowed || z.actions.defend.allowed;
              return (
                <View key={z.zone_id} style={[styles.zone, { borderColor: eligible ? c : colors.line }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={[styles.dot, { backgroundColor: c }]} />
                    <Text style={styles.zoneName}>{z.zone_name}</Text>
                    {eligible && (
                      <View style={[styles.pill, { borderColor: c }]}>
                        <Text style={[styles.pillText, { color: c }]}>Eligible</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.meta}>
                    {INTERACTION[z.interaction]} · {z.distance_in_zone_m} m · {dur(z.time_in_zone_s)} ·{' '}
                    {rel === 'mine' ? 'your territory' : rel === 'other' ? `held by ${z.territory.owner?.display_name}` : 'unclaimed'}
                  </Text>
                  {action && <TerritoryActionButton zoneId={z.zone_id} zoneName={z.zone_name} action={action} availability={z.actions[action]} ownerName={z.territory.owner?.display_name} />}
                </View>
              );
            })
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignSelf: 'stretch', marginTop: 12, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 12, gap: 10 },
  title: { color: colors.text, fontFamily: fonts.label, fontSize: 14, letterSpacing: 1, textTransform: 'uppercase' },
  note: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  zone: { borderWidth: 1.5, borderRadius: radius.md, padding: 10, gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  zoneName: { flex: 1, color: colors.text, fontFamily: fonts.label, fontSize: 15, letterSpacing: 0.6, textTransform: 'uppercase' },
  pill: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 },
  pillText: { fontFamily: fonts.label, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11 },
});
