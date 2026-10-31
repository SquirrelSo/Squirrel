/**
 * Everything drawn on top of the world map: header, status banners, the bottom sheet and its
 * contents (player card, territory, point of interest, nearby list with search).
 */
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Animated, FlatList, PanResponder, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import type { MapPlayer, PersonSummary, Poi, Zone } from '@/api/campus/types';
import { getZonePlayers, searchPeople } from '@/api/campus/map';
import { errorText } from '@/api/campus';
import { isPlaceholderZone } from '@/api/campus/campusShapes';
import { Avatar } from '@/components/Avatar';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { NotLiveYet } from '@/components/campus/States';
import { ApproximateNote } from '@/components/campus/ZonePanel';
import { displayStatus, relationOf, shortTime, STATUS_UI } from '@/components/campus/territoryUi';
import { NearbyUserCard } from '@/components/social/NearbyUserCard';
import { Button, Display, Icon, Kicker, NATIVE, ProgressBar, tap } from '@/components/ui';
import { useCampus } from '@/hooks/useCampus';
import { useUnread } from '@/state/socialStore';
import { useTerritory } from '@/state/territoryStore';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, MAX_WIDTH, radius } from '@/theme';

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/** `zonesHeld` is shown only when known (live territory state) — never a placeholder 0. */
export function MapHeader({ campus, where, zonesHeld, top }: { campus: string; where: string | null; zonesHeld: number | null; top: number }) {
  const { me, level, xp } = useApp();
  const unread = useUnread();
  return (
    <View style={[styles.header, { top }]} pointerEvents="box-none">
      <Pressable onPress={() => { tap(); router.push('/profile'); }} accessibilityRole="button" accessibilityLabel="Your profile">
        <Avatar user={me} size={38} ring={colors.primary} link={false} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={styles.campus} numberOfLines={1}>{campus}</Text>
        <Text style={styles.where} numberOfLines={1}>
          <Icon name="map-marker" size={11} color={colors.secondary} /> {where ?? 'Location off'}
        </Text>
      </View>
      <View style={styles.pill} accessibilityLabel={`Level ${level}, ${xp} XP${zonesHeld != null ? `, ${zonesHeld} zones held` : ''}`}>
        <Text style={styles.pillLv}>LV {level}</Text>
        {zonesHeld != null && <Text style={styles.pillSub}>{zonesHeld} zones</Text>}
      </View>
      <Pressable onPress={() => { tap(); router.push('/notifications'); }} style={styles.bell} accessibilityRole="button" accessibilityLabel={`Notifications${unread ? `, ${unread} unread` : ''}`}>
        <Icon name="bell-outline" size={20} color={colors.text} />
        {!!unread && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{unread > 9 ? '9+' : unread}</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

export function MapBanner({ icon, tone = 'info', text, action, onAction }: { icon: React.ComponentProps<typeof Icon>['name']; tone?: 'info' | 'warn' | 'error'; text: string; action?: string; onAction?: () => void }) {
  const c = tone === 'error' ? colors.coral : tone === 'warn' ? colors.gold : colors.sub;
  return (
    <View style={[styles.banner, { borderColor: `${c}66` }]} accessibilityRole="alert">
      <Icon name={icon} size={16} color={c} />
      <Text style={styles.bannerText}>{text}</Text>
      {action && onAction && (
        <Pressable onPress={onAction} hitSlop={8} accessibilityRole="button" accessibilityLabel={action}>
          <Text style={[styles.bannerAction, { color: tone === 'error' ? colors.coral : colors.primary }]}>{action}</Text>
        </Pressable>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Bottom sheet (in-screen; gestures here never reach the map beneath)
// ---------------------------------------------------------------------------

/** On a phone: a draggable bottom sheet. On a wide screen: a compact card floating at the left, so the map stays in view. */
export function MapSheet({ bottom, onClose, children, label }: { bottom: number; onClose: () => void; children: React.ReactNode; label: string }) {
  const { height, width } = useWindowDimensions();
  const wide = width >= 900;
  const [y] = useState(() => new Animated.Value(1));
  const [drag] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.spring(y, { toValue: 0, useNativeDriver: NATIVE, speed: 18, bounciness: 4 }).start();
  }, [y]);
  const close = () => Animated.timing(y, { toValue: 1, duration: 180, useNativeDriver: NATIVE }).start(onClose);
  const [responder] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 6,
      onPanResponderMove: (_, g) => drag.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_, g) => {
        if (g.dy > 70) close();
        else Animated.spring(drag, { toValue: 0, useNativeDriver: NATIVE }).start();
      },
    }),
  );
  return (
    <Animated.View
      style={[styles.sheet, wide && styles.sheetWide, { bottom, maxHeight: Math.max(260, height * (wide ? 0.7 : 0.55)), transform: [{ translateY: Animated.add(y.interpolate({ inputRange: [0, 1], outputRange: [0, 520] }), drag) }] }]}
      accessibilityViewIsModal={false}
      accessibilityLabel={label}>
      <View {...responder.panHandlers} style={styles.grabArea}>
        <View style={styles.grip} />
      </View>
      <Pressable onPress={close} style={styles.close} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
        <Icon name="close" size={18} color={colors.dim} />
      </Pressable>
      {children}
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Sheet contents
// ---------------------------------------------------------------------------

export function PlayerSheet({ player }: { player: MapPlayer }) {
  return (
    <View style={{ gap: 10 }}>
      <NearbyUserCard person={player} variant="card" />
      <Text style={styles.fine}>Shown near {player.proximity ? 'you' : 'campus'} · position approximate (±{player.precision_m} m) · seen {shortTime(player.last_seen_at)}</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label="View profile" variant="secondary" size="sm" iconLeft="account" onPress={() => router.push({ pathname: '/user/[id]', params: { id: player.user_id } })} style={{ flex: 1 }} />
        <Button label="Challenge" variant="ghost" size="sm" iconLeft="sword-cross" onPress={() => router.push({ pathname: '/invite/new', params: { userId: player.user_id } })} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

/** `baseMap`: the static IISER map is showing (campus backend not live) — the zone's state is unknown. */
export function TerritorySheet({ zone, meId, baseMap }: { zone: Zone; meId: string | null; baseMap?: boolean }) {
  const t = useTerritory(zone.id);
  const status = displayStatus(t);
  const ui = STATUS_UI[status];
  const mine = relationOf(t, meId) === 'mine';
  const [showPlayers, setShowPlayers] = useState(false);
  const players = useCampus<PersonSummary[]>(`zone-players:${zone.id}`, () => getZonePlayers(zone.id), { enabled: showPlayers && !baseMap });
  if (baseMap) {
    return (
      <View style={{ gap: 12 }}>
        <View>
          <Kicker>Zone · IISER Kolkata</Kicker>
          <Display size={26} style={{ marginTop: 2 }}>{zone.name}</Display>
        </View>
        <NotLiveYet name="Territory" compact body="Who controls this zone, claims, steals and defends switch on with the campus backend. This map is approximate." />
      </View>
    );
  }
  return (
    <View style={{ gap: 12 }}>
      <View>
        <Kicker>Territory</Kicker>
        <Display size={26} style={{ marginTop: 2 }}>{zone.name}</Display>
        <View style={[styles.status, { borderColor: ui.color }]}>
          <Icon name={ui.icon} size={13} color={ui.color} />
          <Text style={[styles.statusText, { color: ui.color }]}>{ui.label}</Text>
        </View>
      </View>
      {isPlaceholderZone(zone) && <ApproximateNote compact />}
      {t?.owner ? (
        <View style={styles.owner}>
          <PersonAvatar person={t.owner} size={40} ring={mine ? colors.primary : colors.secondary} link={false} />
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Controlled by</Text>
            <Text style={styles.ownerName}>{t.crew ? `🐿️ ${t.crew.name}` : mine ? 'You' : t.owner.display_name}</Text>
            <Text style={styles.fine}>{t.crew ? `${mine ? 'you' : t.owner.display_name} · ` : ''}since {shortTime(t.claimed_at)}</Text>
          </View>
        </View>
      ) : (
        <Text style={styles.body}>Nobody controls this zone. Move through it to become eligible, then claim it.</Text>
      )}
      {t?.owner && (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={styles.big}>{t.xp != null ? `${t.xp.toLocaleString('en-IN')} XP` : '—'}</Text>
            <Text style={[styles.big, { color: ui.color }]}>{t.control != null ? `${Math.round(t.control * 100)}% control` : ''}</Text>
          </View>
          {t.control != null && <ProgressBar progress={t.control} color={mine ? colors.primary : ui.color} height={8} />}
          <Text style={styles.fine}>Defended {t.defended_count}× · strength comes from the backend</Text>
        </View>
      )}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label={showPlayers ? 'Players' : 'View players'} variant="secondary" size="sm" iconLeft="account-group" onPress={() => setShowPlayers(true)} style={{ flex: 1 }} />
        <Button label="Enter territory" size="sm" icon="arrow-right" onPress={() => router.push({ pathname: '/zone/[id]', params: { id: zone.id } })} style={{ flex: 1 }} />
      </View>
      {showPlayers &&
        (players.error ? (
          <Text style={[styles.fine, { color: colors.coral }]}>{errorText(players.cause)}</Text>
        ) : !players.data ? (
          <ActivityIndicator color={colors.primary} />
        ) : players.data.length === 0 ? (
          <Text style={styles.body}>Nobody visible in {zone.short_name ?? zone.name} right now.</Text>
        ) : (
          <View style={{ gap: 8 }}>
            {players.data.map((p) => (
              <NearbyUserCard key={p.user_id} person={p} />
            ))}
          </View>
        ))}
    </View>
  );
}

export function PoiSheet({ poi, zones }: { poi: Poi; zones: Zone[] }) {
  const zone = poi.zone_id ? zones.find((z) => z.id === poi.zone_id) : null;
  return (
    <View style={{ gap: 10 }}>
      <Kicker color={colors.gold}>Point of interest</Kicker>
      <Display size={26}>{poi.name}</Display>
      {!!poi.description && <Text style={styles.body}>{poi.description}</Text>}
      {zone && <Button label={`In ${zone.name}`} variant="secondary" size="sm" iconLeft="flag-variant" onPress={() => router.push({ pathname: '/zone/[id]', params: { id: zone.id } })} />}
      <Button label="Walk here" size="sm" iconLeft="walk" onPress={() => router.push({ pathname: '/run', params: { type: 'walk' } })} />
    </View>
  );
}

/** Nearby list (or a cluster's members) with people search. */
export function NearbyUsersSheet({ players, title }: { players: MapPlayer[]; title: string }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const search = useCampus<PersonSummary[]>(`people-search:${term}`, () => searchPeople(term), { enabled: term.length >= 2 });
  const list = useMemo(() => (term.length >= 2 ? search.data ?? [] : players), [term, search.data, players]);
  return (
    <View style={{ gap: 10, flexShrink: 1 }}>
      <Text style={styles.sheetTitle}>{term.length >= 2 ? `Results for “${term}”` : title}</Text>
      <View style={styles.search}>
        <Icon name="magnify" size={18} color={colors.dim} />
        <TextInput value={q} onChangeText={setQ} placeholder="Find a Squirrel by name" placeholderTextColor={colors.mute} style={styles.searchInput} autoCapitalize="words" accessibilityLabel="Search people" />
      </View>
      {term.length >= 2 && search.loading && !search.data ? (
        <ActivityIndicator color={colors.primary} />
      ) : search.error && term.length >= 2 ? (
        <Text style={[styles.fine, { color: colors.coral }]}>{errorText(search.cause)}</Text>
      ) : list.length === 0 ? (
        <Text style={styles.body}>{term.length >= 2 ? 'Nobody by that name (or they’re hidden).' : 'Nobody nearby yet.'}</Text>
      ) : (
        <FlatList data={list} keyExtractor={(p) => p.user_id} renderItem={({ item }) => <NearbyUserCard person={item} />} contentContainerStyle={{ gap: 8, paddingBottom: 6 }} style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled" initialNumToRender={8} windowSize={5} />
      )}
    </View>
  );
}

export function EmptyNearby({ onWalk }: { onWalk: () => void }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyEmoji} accessibilityElementsHidden>🐿️</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.emptyTitle}>Nobody nearby yet.</Text>
        <Text style={styles.body}>Your next Squirrel might be closer than you think.</Text>
      </View>
      <Button label="Walk" size="sm" iconLeft="walk" onPress={onWalk} />
    </View>
  );
}

export const MAP_MAX_WIDTH = MAX_WIDTH;

const styles = StyleSheet.create({
  header: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: alpha(colors.panel, 0.9), borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 10, paddingVertical: 8, maxWidth: MAX_WIDTH, alignSelf: 'center' },
  campus: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 16, letterSpacing: 0.8, textTransform: 'uppercase' },
  where: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11 },
  pill: { alignItems: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: alpha(colors.primary, 0.35), paddingHorizontal: 8, paddingVertical: 3 },
  pillLv: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 0.6 },
  pillSub: { color: colors.dim, fontFamily: fonts.mono, fontSize: 9 },
  bell: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  badge: { position: 'absolute', top: -3, right: -3, minWidth: 17, height: 17, borderRadius: 9, backgroundColor: colors.secondary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3, borderWidth: 2, borderColor: colors.bg },
  badgeText: { color: colors.onSecondary, fontFamily: fonts.bold, fontSize: 9 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: alpha(colors.panel, 0.93), borderRadius: radius.md, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9 },
  bannerText: { flex: 1, color: colors.sub, fontFamily: fonts.regular, fontSize: 12, lineHeight: 16 },
  bannerAction: { fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase' },
  sheet: { position: 'absolute', left: 8, right: 8, alignSelf: 'center', maxWidth: MAX_WIDTH, backgroundColor: colors.bg2, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 16, paddingBottom: 16, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  sheetWide: { left: 16, right: undefined, width: 380, alignSelf: 'flex-start' },
  grabArea: { alignItems: 'center', paddingVertical: 10 },
  grip: { width: 44, height: 5, borderRadius: 3, backgroundColor: colors.lineHi },
  close: { position: 'absolute', right: 10, top: 10, zIndex: 3, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card },
  sheetTitle: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 18, letterSpacing: 0.8, textTransform: 'uppercase' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', borderWidth: 1.5, borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 3, marginTop: 6 },
  statusText: { fontFamily: fonts.label, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  owner: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 10 },
  label: { color: colors.dim, fontFamily: fonts.label, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' },
  ownerName: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  big: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 18 },
  body: { color: colors.sub, fontFamily: fonts.regular, fontSize: 13, lineHeight: 19 },
  fine: { color: colors.dim, fontFamily: fonts.mono, fontSize: 10 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12 },
  searchInput: { flex: 1, color: colors.text, fontFamily: fonts.regular, fontSize: 14, paddingVertical: 10 },
  empty: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: alpha(colors.panel, 0.94), borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12 },
  emptyEmoji: { fontSize: 28 },
  emptyTitle: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 15, letterSpacing: 0.6, textTransform: 'uppercase' },
});
