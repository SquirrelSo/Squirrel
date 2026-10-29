/**
 * Everything about one zone: owner, territory status, stats, history and the Claim / Steal /
 * Defend actions the backend currently allows. Used in the map's bottom panel and /zone/[id].
 */
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { campusApi, type ZoneDetail } from '@/api/campus';
import { isPlaceholderZone } from '@/api/campus/campusShapes';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { ErrorState, LoadingRows } from '@/components/campus/States';
import { TerritoryActionButton } from '@/components/campus/TerritoryAction';
import { RELATION_COLOR, RELATION_LABEL, relationOf, shortTime, UNDER_ATTACK, untilTime, ZONE_ICON, km } from '@/components/campus/territoryUi';
import { Button, Display, Icon, Kicker } from '@/components/ui';
import { useCampus } from '@/hooks/useCampus';
import { upsertTerritory, useTerritory } from '@/state/territoryStore';
import { colors, fonts, radius } from '@/theme';

const isFuture = (iso: string | null | undefined) => !!iso && Date.parse(iso) > Date.now();

const EVENT_TEXT: Record<string, string> = { claimed: 'claimed it', stolen: 'stole it', defended: 'defended it', released: 'released it', decayed: 'lost it to decay' };

export function ZonePanel({ zoneId, meId, showOpen = false }: { zoneId: string; meId: string | null; showOpen?: boolean }) {
  const detail = useCampus<ZoneDetail>(`zone:${zoneId}`, () => campusApi.zone(zoneId));
  const live = useTerritory(zoneId);
  const d = detail.data;
  // Seed the store from the detail (e.g. deep link before the map loaded).
  useEffect(() => {
    if (d) upsertTerritory(d.territory);
  }, [d]);
  // Ownership moved since we loaded the actions (realtime push) → re-read what's allowed now.
  const liveVersion = live?.version ?? 0;
  const loadedVersion = d?.territory.version ?? 0;
  const { reload } = detail;
  useEffect(() => {
    if (d && liveVersion > loadedVersion) reload();
  }, [liveVersion, loadedVersion, d, reload]);

  if (!d) {
    if (detail.error) return <ErrorState cause={detail.cause} onRetry={detail.reload} compact />;
    return <LoadingRows rows={2} height={70} />;
  }
  const t = live && live.version >= d.territory.version ? live : d.territory;
  const rel = relationOf(t, meId);
  const c = RELATION_COLOR[rel];
  const a = d.actions;
  const shielded = isFuture(t.shield_until);

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={[styles.kindIcon, { borderColor: c }]}>
          <Icon name={ZONE_ICON[d.zone.kind] ?? 'map-marker'} size={22} color={c} />
        </View>
        <View style={{ flex: 1 }}>
          <Kicker color={t.under_challenge ? UNDER_ATTACK : c}>{t.under_challenge ? (rel === 'mine' ? 'Under attack' : 'Contested') : rel === 'other' ? 'Enemy territory' : RELATION_LABEL[rel]}</Kicker>
          <Display size={28} numberOfLines={2} style={{ marginTop: 2 }}>{d.zone.name}</Display>
        </View>
      </View>

      {/* Owner */}
      <View style={styles.owner}>
        {t.owner ? (
          <>
            <PersonAvatar person={t.owner} size={38} ring={c} />
            <View style={{ flex: 1 }}>
              <Text style={styles.ownerName}>{rel === 'mine' ? 'You hold this zone' : `Held by ${t.owner.display_name}`}</Text>
              <Text style={styles.meta}>
                {[t.crew?.name, t.owner.hostel, t.claimed_at ? `since ${shortTime(t.claimed_at)}` : null].filter(Boolean).join(' · ')}
              </Text>
            </View>
          </>
        ) : (
          <>
            <View style={[styles.empty, { borderColor: colors.mute }]}>
              <Icon name="flag-outline" size={18} color={colors.dim} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.ownerName}>Nobody holds this zone yet</Text>
              <Text style={styles.meta}>Be active inside it, then claim it.</Text>
            </View>
          </>
        )}
      </View>

      <View style={styles.stats}>
        {[
          [String(t.defended_count), 'Defences'],
          [String(d.stats.runs_7d), 'Runs · 7d'],
          [String(d.stats.visitors_7d), 'Squirrels · 7d'],
          [String(d.stats.my_visits_7d), 'Your visits'],
        ].map(([v, l]) => (
          <View key={l} style={styles.stat}>
            <Text style={styles.statV}>{v}</Text>
            <Text style={styles.statL}>{l}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.meta}>{km(d.stats.distance_7d_m)} moved here this week{shielded ? ` · shielded for ${untilTime(t.shield_until)}` : ''}</Text>

      {/* An unsurveyed outline: say so beside the actions, but never block them. */}
      {isPlaceholderZone(d.zone) && <ApproximateNote />}

      {/* Actions — only what the backend allows right now */}
      {rel === 'unclaimed' && <TerritoryActionButton zoneId={zoneId} zoneName={d.zone.name} action="claim" availability={a.claim} onDone={() => detail.reload()} onFailed={detail.reload} />}
      {rel === 'mine' && (
        <View style={{ gap: 8 }}>
          <View style={[styles.yours, t.under_challenge && { borderColor: UNDER_ATTACK, backgroundColor: colors.cardHi }]}>
            <Icon name={t.under_challenge ? 'shield-alert' : 'crown'} size={18} color={t.under_challenge ? UNDER_ATTACK : colors.onPrimary} />
            <Text style={[styles.yoursText, t.under_challenge && { color: UNDER_ATTACK }]}>{t.under_challenge ? 'Your territory is under attack' : 'Your Territory'}</Text>
          </View>
          {(a.defend.allowed || t.under_challenge) && <TerritoryActionButton zoneId={zoneId} zoneName={d.zone.name} action="defend" availability={a.defend} onDone={() => detail.reload()} onFailed={detail.reload} />}
        </View>
      )}
      {rel === 'other' && (
        <View style={{ gap: 8 }}>
          <TerritoryActionButton zoneId={zoneId} zoneName={d.zone.name} action="steal" availability={a.steal} ownerName={t.owner?.display_name} onDone={() => detail.reload()} onFailed={detail.reload} />
          {t.owner && (
            <Button
              label={`Challenge ${t.owner.display_name.split(' ')[0]}`}
              iconLeft="sword-cross"
              variant="secondary"
              size="sm"
              onPress={() => router.push({ pathname: '/invite/new', params: { userId: t.owner!.user_id, zoneId } })}
            />
          )}
        </View>
      )}
      {rel !== 'mine' && !a.claim.allowed && !a.steal.allowed && (
        <Button label="Start a run to earn it" iconLeft="run-fast" variant="secondary" size="sm" onPress={() => router.push('/run')} />
      )}

      {/* History */}
      {d.history.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={styles.label}>Territory history</Text>
          {d.history.slice(0, 5).map((h) => (
            <View key={h.id} style={styles.hist}>
              <Icon name={h.type === 'stolen' ? 'sword-cross' : h.type === 'defended' ? 'shield-check' : 'flag-variant'} size={14} color={h.type === 'stolen' ? colors.secondary : h.type === 'defended' ? colors.gold : colors.dim} />
              <Text style={styles.histText} numberOfLines={1}>
                <Text style={{ color: colors.text }}>{h.actor ? (h.actor.user_id === meId ? 'You' : h.actor.display_name) : 'Someone'}</Text> {EVENT_TEXT[h.type] ?? h.type}
                {h.previous_owner ? ` from ${h.previous_owner.user_id === meId ? 'you' : h.previous_owner.display_name}` : ''}
              </Text>
              <Text style={styles.meta}>{shortTime(h.at)}</Text>
            </View>
          ))}
        </View>
      )}
      {showOpen && <Button label="Open zone" variant="ghost" size="sm" icon="arrow-right" onPress={() => router.push({ pathname: '/zone/[id]', params: { id: zoneId } })} />}
    </View>
  );
}

/** Shown wherever a zone's outline is a placeholder (geometry_source 'dev_placeholder'). */
export function ApproximateNote({ compact = false }: { compact?: boolean }) {
  return (
    <View style={[styles.approx, compact && styles.approxCompact]} accessible accessibilityLabel="Approximate outline, not surveyed yet. Claiming still works.">
      <Icon name="vector-polygon" size={compact ? 14 : 16} color={colors.gold} />
      <View style={{ flex: 1 }}>
        <Text style={styles.approxTitle}>Approximate outline — not surveyed yet</Text>
        {!compact && <Text style={styles.meta}>The shape on the map is a rough stand-in. Claim, steal and defend work as usual; the outline may change once it’s mapped.</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  approx: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.gold, padding: 10 },
  approxCompact: { alignItems: 'center', paddingVertical: 6, paddingHorizontal: 8 },
  approxTitle: { color: colors.gold, fontFamily: fonts.label, fontSize: 13, letterSpacing: 0.4 },
  kindIcon: { width: 44, height: 44, borderRadius: 14, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardHi },
  owner: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 10 },
  empty: { width: 38, height: 38, borderRadius: 19, borderWidth: 1.5, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  ownerName: { color: colors.text, fontFamily: fonts.bold, fontSize: 14 },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11 },
  stats: { flexDirection: 'row', borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line, paddingVertical: 10 },
  stat: { flex: 1, alignItems: 'center' },
  statV: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 20 },
  statL: { color: colors.dim, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 0.6, textTransform: 'uppercase' },
  yours: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.primary, borderRadius: radius.md, borderWidth: 2, borderColor: colors.primary, paddingHorizontal: 12, paddingVertical: 10 },
  yoursText: { color: colors.onPrimary, fontFamily: fonts.labelBold, fontSize: 15, letterSpacing: 1, textTransform: 'uppercase' },
  label: { color: colors.dim, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  hist: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  histText: { flex: 1, color: colors.sub, fontFamily: fonts.regular, fontSize: 12 },
});
