/**
 * Rows for Discover and the bubble: people, territory battles, zones and crews. Only what the server
 * sends: proximity as words (Very close / Nearby / On campus), never a coordinate or a distance.
 */
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { DiscoverBattle } from '@/api/campus';
import type { DiscoverCrew, DiscoverZone, PersonCard, PersonState } from '@/api/featureContracts';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { ModeChip } from '@/components/campus/Social';
import { shortTime, ZONE_ICON } from '@/components/campus/territoryUi';
import { Icon, PressScale } from '@/components/ui';
import { formatEventDate } from '@/logic/format';
import { STATE_LABEL } from '@/logic/bubble';
import { ACTIVITY_WORDS, BATTLE_STATUS_WORDS, proximityWords, RELATION_WORDS, zoneLine } from '@/logic/discover';
import { alpha, colors, fonts, radius } from '@/theme';

const ACT_ICON: Record<string, React.ComponentProps<typeof Icon>['name']> = { run: 'run-fast', walk: 'walk', workout: 'arm-flex' };
const openUser = (id: string) => router.push({ pathname: '/user/[id]', params: { id } });

/** One person: name, avatar, hostel, level, activity, proximity in words, zone. Tap → their profile. */
export function PersonRow({ c, showStates }: { c: PersonCard; showStates?: boolean }) {
  const p = c.person;
  const near = proximityWords(c.proximity);
  const act = c.activity ? `${ACTIVITY_WORDS[c.activity.type] ?? c.activity.type}${c.activity.started_at ? ` · started ${shortTime(c.activity.started_at)}` : ''}` : null;
  const states = showStates ? c.states.filter((s): s is Exclude<PersonState, 'same_campus' | 'nearby'> => s !== 'same_campus' && s !== 'nearby') : [];
  return (
    <PressScale onPress={() => openUser(p.user_id)} style={styles.row} scaleTo={0.985} accessibilityLabel={`${p.display_name}${near ? `, ${near}` : ''}. Open profile`}>
      <View>
        <PersonAvatar person={p} size={46} link={false} ring={c.activity ? colors.green : undefined} />
        {c.activity && (
          <View style={styles.actBadge}>
            <Icon name={ACT_ICON[c.activity.type] ?? 'run-fast'} size={11} color={colors.onPrimary} />
          </View>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.name} numberOfLines={1}>{p.display_name}</Text>
          {p.level != null && <Text style={styles.level}>Lv {p.level}</Text>}
          <ModeChip mode={p.connection_mode} />
        </View>
        <Text style={styles.meta} numberOfLines={1}>{[p.hostel, act ?? 'Not moving right now'].filter(Boolean).join(' · ')}</Text>
        {(near || c.zone) && (
          <Text style={[styles.meta, { color: colors.primary }]} numberOfLines={1}>{[near, c.zone?.name].filter(Boolean).join(' · ')}</Text>
        )}
        {states.length > 0 && (
          <View style={styles.states}>
            {states.map((s) => (
              <Text key={s} style={styles.state}>{STATE_LABEL[s]}</Text>
            ))}
          </View>
        )}
      </View>
      <Icon name="chevron-right" size={20} color={colors.mute} />
    </PressScale>
  );
}

/** A battle you're part of. Opens its zone (where the battle and its actions live). */
export function BattleRow({ b }: { b: DiscoverBattle }) {
  const zone = b.zone;
  const tags = [RELATION_WORDS[b.relation], b.near_you ? 'Near you' : null, b.zone_qualified ? 'You qualify here' : null].filter(Boolean);
  return (
    <PressScale onPress={zone ? () => router.push({ pathname: '/zone/[id]', params: { id: zone.id } }) : undefined} disabled={!zone} style={styles.row} scaleTo={0.985} accessibilityLabel={`${b.type_label}${zone ? ` at ${zone.name}` : ''}`}>
      <View style={[styles.iconBox, { borderColor: alpha(colors.secondary, 0.5) }]}>
        <Icon name="sword-cross" size={20} color={colors.secondary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.name} numberOfLines={1}>{b.type_label}{zone ? ` · ${zone.name}` : ''}</Text>
        <Text style={styles.meta} numberOfLines={1}>{tags.join(' · ')}</Text>
        <Text style={[styles.meta, { color: colors.dim }]} numberOfLines={1}>{BATTLE_STATUS_WORDS[b.status] ?? b.status} · {formatEventDate(b.starts_at)}</Text>
      </View>
      {zone && <Icon name="chevron-right" size={20} color={colors.mute} />}
    </PressScale>
  );
}

export function ZoneRow({ z }: { z: DiscoverZone }) {
  return (
    <PressScale onPress={() => router.push({ pathname: '/zone/[id]', params: { id: z.zone.id } })} style={styles.row} scaleTo={0.985} accessibilityLabel={z.zone.name}>
      <View style={[styles.iconBox, z.contested && { borderColor: alpha(colors.gold, 0.6) }]}>
        <Icon name={ZONE_ICON[z.zone.kind ?? ''] ?? 'map-marker-outline'} size={20} color={z.contested ? colors.gold : colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.name} numberOfLines={1}>{z.zone.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>{zoneLine(z)}</Text>
      </View>
      <Icon name="chevron-right" size={20} color={colors.mute} />
    </PressScale>
  );
}

export function CrewRow({ c }: { c: DiscoverCrew }) {
  const name = c.crew.name || 'Crew name unavailable';
  return (
    <PressScale onPress={() => router.push({ pathname: '/crew/[id]', params: { id: c.crew.id } })} style={styles.row} scaleTo={0.985} accessibilityLabel={`${name}, ${c.zones_held} zones held`}>
      <View style={[styles.iconBox, c.crew.color ? { borderColor: c.crew.color } : null]}>
        <Icon name="account-group-outline" size={20} color={c.crew.color ?? colors.blue} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.name, !c.crew.name && { color: colors.dim }]} numberOfLines={1}>{name}</Text>
        <Text style={styles.meta}>{c.zones_held} {c.zones_held === 1 ? 'zone' : 'zones'} held</Text>
      </View>
      <Icon name="chevron-right" size={20} color={colors.mute} />
    </PressScale>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12 },
  actBadge: { position: 'absolute', right: -3, bottom: -3, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.card },
  iconBox: { width: 46, height: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.cardHi, alignItems: 'center', justifyContent: 'center' },
  name: { color: colors.text, fontFamily: fonts.bold, fontSize: 15, flexShrink: 1 },
  level: { color: colors.violet, fontFamily: fonts.labelBold, fontSize: 12, letterSpacing: 0.6 },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11, marginTop: 2 },
  states: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 5 },
  state: { color: colors.sub, fontFamily: fonts.label, fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase', borderWidth: 1, borderColor: colors.lineHi, borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden' },
});
