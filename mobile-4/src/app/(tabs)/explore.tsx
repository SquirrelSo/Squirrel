/**
 * MAP — Squirrel Social's persistent social world. See the campus, its territories, points of
 * interest and the Squirrels around you; tap someone → card → POKE 👋. Everything shown (who
 * appears, where roughly, who holds what, relationship state) comes from the backend.
 *
 * It opens around you (not on the whole campus), and the chips under the header thin it out:
 * All · Live · People · Territories · Places, plus the Heat layer. Filters only change what's
 * drawn — every zone, place and person is still there.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Linking, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Mascot } from '@/art/Mascot';
import { featureUnavailable } from '@/api/campus';
import type { Heatmap, HeatWindow, LatLng, MapPlayer, Zone } from '@/api/campus/types';
import { DEFAULT_HEAT_WINDOW, getHeatmap } from '@/api/campus/discovery';
import { ErrorState, SourceBadge } from '@/components/campus/States';
import { relationOf } from '@/components/campus/territoryUi';
import { EmptyNearby, MapBanner, MapHeader, MapSheet, NearbyUsersSheet, PlayerSheet, PoiSheet, TerritorySheet } from '@/components/map/MapChrome';
import { inPolygon, makeProjection } from '@/components/map/geometry';
import { WorldMap, type MapLayers, type WorldMapHandle } from '@/components/map/WorldMap';
import { HeatPanel } from '@/components/map/HeatPanel';
import { Icon, NATIVE, tap } from '@/components/ui';
import { useCampus, useConfig, useMe, useRefreshOnFocus, useTerritorySync } from '@/hooks/useCampus';
import { useMapWorld, useNearbyPlayers } from '@/hooks/useMap';
import { requestLocation, setPresenceReporting, startLocationWatch, useLocation } from '@/state/locationStore';
import { hiddenActionFor } from '@/api/campus/campusShapes';
import { withCampusBase } from '@/api/campus/campusBaseMap';
import { useAllTerritories } from '@/state/territoryStore';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, mapColors, radius } from '@/theme';

type Filter = 'all' | 'live' | 'people' | 'territories' | 'places';
const FILTERS: { id: Filter; label: string; icon: React.ComponentProps<typeof Icon>['name'] }[] = [
  { id: 'all', label: 'All', icon: 'layers-outline' },
  { id: 'live', label: 'Live', icon: 'access-point' },
  { id: 'people', label: 'People', icon: 'account-multiple-outline' },
  { id: 'territories', label: 'Territories', icon: 'flag-variant-outline' },
  { id: 'places', label: 'Places', icon: 'map-marker-outline' },
];
const LAYERS: Record<Filter, MapLayers> = {
  all: {},
  live: { liveOnly: true, places: false },
  people: { places: false },
  territories: { people: false, places: false, territories: 'strong' },
  places: { people: false },
};

type Sheet = { kind: 'player'; player: MapPlayer } | { kind: 'zone'; zone: Zone } | { kind: 'poi'; id: string } | { kind: 'list'; players: MapPlayer[]; title: string } | null;

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const { toast } = useApp();
  const me = useMe();
  const config = useConfig();
  const world = useMapWorld();
  const sync = useTerritorySync();
  const players = useNearbyPlayers();
  const hiddenAction = hiddenActionFor(players.data?.hidden_code);
  const territories = useAllTerritories();
  const mapRef = useRef<WorldMapHandle>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  // Map → Heat: an optional layer; fetched only while it's on.
  const [heatOn, setHeatOn] = useState(false);
  const [heatWindow, setHeatWindow] = useState<HeatWindow>(DEFAULT_HEAT_WINDOW);
  const [filter, setFilter] = useState<Filter>('all');
  const heat = useCampus<Heatmap>(`map:heat:${heatWindow}`, () => getHeatmap(heatWindow), { enabled: heatOn });
  useRefreshOnFocus(heat.reload, 60_000);
  const meId = me.data?.user_id ?? null;

  // Your location: watched only while the Map is on screen; presence reported (throttled) for discovery.
  useFocusEffect(
    useCallback(() => {
      const stop = startLocationWatch();
      setPresenceReporting(true);
      return () => {
        setPresenceReporting(false);
        stop();
      };
    }, []),
  );

  const zones = useMemo(() => world.data?.zones ?? [], [world.data]);
  // The same campus base the map draws (campus-service serves zone outlines only), so its places are tappable too.
  const features = useMemo(() => withCampusBase(world.data?.features, zones), [world.data, zones]);
  const list = useMemo(() => players.data?.players ?? [], [players.data]);
  const liveCount = useMemo(() => list.filter((p) => !!p.activity).length, [list]);
  const zonesHeld = useMemo(() => territories.filter((t) => relationOf(t, meId) === 'mine').length, [territories, meId]);

  const tabH = 64 + Math.max(insets.bottom, 10);
  const { width: winW, height: winH } = useWindowDimensions();
  // A card opened on something: keep it in view beside the card (phone: above the sheet; wide: right of it).
  const reveal = useCallback(
    (p: LatLng | null | undefined) => {
      if (p) setTimeout(() => mapRef.current?.reveal(p, winW >= 900 ? { left: 16 + 380 } : { bottom: tabH + Math.min(360, winH * 0.42) }), 60);
    },
    [winW, winH, tabH],
  );
  const onPlayer = useCallback(
    (id: string) => {
      const p = players.data?.players.find((x) => x.user_id === id);
      if (p) {
        setSheet({ kind: 'player', player: p });
        reveal(p.position);
      }
    },
    [players.data, reveal],
  );
  const onZone = useCallback(
    (id: string) => {
      const z = world.data?.zones.find((x) => x.id === id);
      if (z) {
        setSheet({ kind: 'zone', zone: z });
        reveal(z.centroid);
      }
    },
    [world.data, reveal],
  );
  const onPoi = useCallback(
    (id: string) => {
      setSheet({ kind: 'poi', id });
      reveal(features?.pois.find((p) => p.id === id)?.position);
    },
    [reveal, features],
  );
  const onCluster = useCallback((ps: MapPlayer[]) => setSheet({ kind: 'list', players: ps, title: `${ps.length} Squirrels here` }), []);

  const headerTop = insets.top + 8;
  const loaded = !!players.data;
  const showEmpty = loaded && list.length === 0 && !sheet && !heatOn && (filter === 'all' || filter === 'people' || filter === 'live');
  const showHeat = heatOn && !sheet;
  const poi = sheet?.kind === 'poi' ? features?.pois.find((p) => p.id === sheet.id) : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: mapColors.bg }}>
      {world.data ? (
        <WorldMap
          ref={mapRef}
          zones={zones}
          features={features}
          meId={meId}
          me="watch"
          players={list}
          pois={features?.pois}
          selectedPoiId={sheet?.kind === 'poi' ? sheet.id : null}
          layers={LAYERS[filter]}
          initialView="around"
          onLocate={() => {
            if (!mapRef.current?.recenter()) toast('No location yet — allow location to see where you are', 'crosshairs-question', colors.gold);
          }}
          selectedZoneId={sheet?.kind === 'zone' ? sheet.zone.id : null}
          selectedPlayerId={sheet?.kind === 'player' ? sheet.player.user_id : null}
          onSelectPlayer={onPlayer}
          onSelectZone={onZone}
          onSelectPoi={onPoi}
          onSelectCluster={onCluster}
          heat={heatOn && heat.data?.available ? heat.data.cells : null}
          controlsInset={{ bottom: tabH + (showEmpty ? 84 : 0) + (showHeat ? 118 : 0) }}
          style={styles.map}
        />
      ) : world.error ? (
        <View style={[styles.center, { paddingTop: headerTop + 80 }]}>
          <ErrorState cause={world.cause} onRetry={world.reload} title="The map didn’t load" />
        </View>
      ) : (
        <MapLoading />
      )}

      <LiveHeader zones={zones} campus={world.data?.source === 'base' ? 'IISER Kolkata · approx. map' : config.data?.campus.name ?? 'Your campus'} zonesHeld={world.data?.source === 'live' && !sync.error ? zonesHeld : null} top={headerTop} />

      {world.data && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.chips, { top: headerTop + 62 }]} contentContainerStyle={styles.chipsRow} accessibilityRole="tablist">
          {FILTERS.map((f) => {
            const on = filter === f.id;
            const count = f.id === 'live' ? liveCount : f.id === 'people' ? list.length : null;
            return (
              <Pressable key={f.id} onPress={() => { tap('select'); setFilter(f.id); }} style={[styles.chip, on && styles.chipOn]} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={`${f.label}${count != null ? `, ${count}` : ''}`}>
                {f.id === 'live' ? <View style={[styles.liveDot, !liveCount && { backgroundColor: colors.mute }]} /> : <Icon name={f.icon} size={14} color={on ? colors.onPrimary : colors.sub} />}
                <Text style={[styles.chipText, on && { color: colors.onPrimary }]}>{f.label}</Text>
                {count != null && loaded && <Text style={[styles.chipCount, on && { color: colors.onPrimary }]}>{count}</Text>}
              </Pressable>
            );
          })}
          <View style={styles.chipGap} />
          <Pressable onPress={() => { tap('select'); setHeatOn((v) => !v); }} style={[styles.chip, heatOn && { borderColor: colors.secondary, backgroundColor: alpha(colors.secondary, 0.14) }]} accessibilityRole="switch" accessibilityState={{ checked: heatOn }} accessibilityLabel="Activity heatmap">
            <Icon name="fire" size={14} color={heatOn ? colors.secondary : colors.sub} />
            <Text style={[styles.chipText, heatOn && { color: colors.secondary }]}>Heat</Text>
          </Pressable>
          <View style={styles.chipGap} />
          {/* Discover and your bubble: their own screens, the map stays as it is */}
          <Pressable onPress={() => { tap(); router.push('/discover'); }} style={styles.chip} accessibilityRole="button" accessibilityLabel="Discover">
            <Icon name="compass-outline" size={14} color={colors.sub} />
            <Text style={styles.chipText}>Discover</Text>
          </Pressable>
          <Pressable onPress={() => { tap(); router.push('/bubble'); }} style={styles.chip} accessibilityRole="button" accessibilityLabel="Your bubble">
            <Icon name="map-marker-radius-outline" size={14} color={colors.sub} />
            <Text style={styles.chipText}>Bubble</Text>
          </Pressable>
        </ScrollView>
      )}

      {/* Status banners: they never block or wipe the map */}
      <View style={[styles.banners, { top: headerTop + 108 }]} pointerEvents="box-none">
        <SourceBadge style={{ alignSelf: 'center' }} />
        {/* One banner at a time, most important first, so the map stays visible. */}
        {/* A feature with no backend yet is not an error: the map's own Not-live state covers it. */}
        {players.error && !featureUnavailable(players.cause) ? (
          <MapBanner icon="wifi-off" tone="error" text={loaded ? 'Couldn’t refresh nearby Squirrels. Showing the last update.' : 'Couldn’t load nearby Squirrels.'} action="Retry" onAction={players.reload} />
        ) : sync.error && !featureUnavailable(sync.error) ? (
          <MapBanner icon="flag-remove-outline" tone="error" text="Territories didn’t refresh." action="Retry" onAction={sync.reload} />
        ) : (
          <LocationBanner
            fallback={
              players.data?.hidden_reason && hiddenAction === 'retry' ? (
                // blocks_unreachable (or a code this app doesn't know): the list is empty fail-closed, often with visible: true
                <MapBanner icon="shield-alert-outline" tone="warn" text={players.data.hidden_reason} action="Retry" onAction={players.reload} />
              ) : players.data && !players.data.visible && !!players.data.hidden_reason ? (
                <MapBanner icon="eye-off-outline" tone="info" text={players.data.hidden_reason} action="Settings" onAction={() => router.push('/active')} />
              ) : world.data?.source === 'base' ? (
                <MapBanner icon="map-outline" tone="info" text="IISER Kolkata · approximate map. Live zones, owners and people switch on with the campus backend." />
              ) : null
            }
          />
        )}
      </View>

      {world.data && (
        <View style={[styles.controls, { bottom: tabH + 12 }]} pointerEvents="box-none">
          <Pressable
            onPress={() => {
              tap();
              setSheet({ kind: 'list', players: list, title: `${list.length} Squirrels nearby` });
            }}
            style={styles.nearby}
            accessibilityRole="button"
            accessibilityLabel={`${list.length} Squirrels nearby. Open list`}>
            <Text style={styles.nearbyEmoji} accessibilityElementsHidden>🐿️</Text>
            <Text style={styles.nearbyText}>{loaded ? `${list.length} nearby` : players.error && featureUnavailable(players.cause) ? 'Not live yet' : players.error ? 'Offline' : 'Finding…'}</Text>
          </Pressable>
        </View>
      )}

      {showHeat && (
        <View style={[styles.emptyWrap, { bottom: tabH + 64 }]}>
          <HeatPanel window={heatWindow} onWindow={setHeatWindow} data={heat.data} loading={heat.loading} error={heat.error ? heat.cause : null} onRetry={heat.reload} onClose={() => setHeatOn(false)} />
        </View>
      )}

      {showEmpty && (
        <View style={[styles.emptyWrap, { bottom: tabH + 64 }]}>
          <EmptyNearby onWalk={() => router.push({ pathname: '/run', params: { type: 'walk' } })} />
        </View>
      )}

      {sheet && (
        <MapSheet
          key={sheet.kind === 'player' ? sheet.player.user_id : sheet.kind === 'zone' ? sheet.zone.id : sheet.kind === 'poi' ? sheet.id : 'list'}
          bottom={tabH + 4}
          onClose={() => setSheet(null)}
          label={sheet.kind === 'player' ? `${sheet.player.display_name} card` : sheet.kind === 'zone' ? `${sheet.zone.name} territory` : sheet.kind === 'poi' ? 'Point of interest' : 'Nearby Squirrels'}>
          {sheet.kind === 'player' && <PlayerSheet player={sheet.player} />}
          {sheet.kind === 'zone' && <TerritorySheet zone={sheet.zone} meId={meId} baseMap={world.data?.source === 'base'} />}
          {sheet.kind === 'poi' && poi && <PoiSheet poi={poi} zones={zones} />}
          {sheet.kind === 'list' && <NearbyUsersSheet players={sheet.players} title={sheet.title} />}
        </MapSheet>
      )}
    </View>
  );
}

/** The header subscribes to your location itself, so GPS updates don't re-render the screen. */
function LiveHeader({ zones, campus, zonesHeld, top }: { zones: Zone[]; campus: string; zonesHeld: number | null; top: number }) {
  const loc = useLocation();
  const proj = useMemo(() => makeProjection(zones), [zones]);
  const where = useMemo(() => {
    if (!loc.position || !proj) return null;
    const p = proj.project(loc.position);
    const z = zones.find((zz) => inPolygon(p, zz.polygon.map((q) => proj.project(q))));
    return z ? `Near ${z.name}` : 'On campus';
  }, [loc.position, proj, zones]);
  // Location known but no campus geometry to place it in: just "On campus?" would be a guess.
  const place = where ?? (loc.position ? 'Location on' : loc.permission === 'checking' ? 'Finding you…' : null);
  return <MapHeader campus={campus} where={loc.simulated && where ? `${where} · demo location` : place} zonesHeld={zonesHeld} top={top} />;
}

function LocationBanner({ fallback }: { fallback: React.ReactNode }) {
  const loc = useLocation();
  if (loc.permission === 'granted' || loc.permission === 'checking') return <>{fallback}</>;
  // The header already says "demo location"; an actionable banner wins over this note.
  if (loc.simulated) return fallback ? <>{fallback}</> : <MapBanner icon="map-marker-question-outline" tone="info" text="No GPS here — showing a demo location. On your phone, allow location to see who’s around you." />;
  const text =
    loc.permission === 'services_off'
      ? 'Location services are off. Nearby discovery needs your location.'
      : loc.permission === 'unsupported'
        ? 'Nearby discovery needs the phone app’s GPS.'
        : 'Location permission is needed for nearby discovery. Others only ever see an approximate area.';
  const action = loc.permission === 'blocked' || loc.permission === 'services_off' ? 'Settings' : loc.permission === 'unsupported' ? undefined : 'Allow';
  return <MapBanner icon="map-marker-off-outline" tone="warn" text={text} action={action} onAction={action === 'Settings' ? () => void Linking.openSettings() : () => void requestLocation()} />;
}

/** Loading: the world "develops" while the wingman scouts. */
function MapLoading() {
  const [v] = useState(() => new Animated.Value(0));
  useFocusEffect(
    useCallback(() => {
      const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE }));
      loop.start();
      return () => loop.stop();
    }, [v]),
  );
  return (
    <View style={[StyleSheet.absoluteFill, styles.center]} accessibilityLabel="Loading the map" accessibilityRole="progressbar">
      <Animated.View style={[styles.scan, { opacity: v.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0.6, 0] }), transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [-240, 240] }) }] }]} />
      <Mascot pose="run" size={110} animated />
      <Text style={styles.loadingText}>Loading your world…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  map: { ...StyleSheet.absoluteFill, borderRadius: 0, borderWidth: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  banners: { position: 'absolute', left: 12, right: 12, gap: 6 },
  controls: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center' },
  nearby: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: alpha(colors.panel, 0.93), borderRadius: radius.pill, borderWidth: 1, borderColor: alpha(colors.primary, 0.4), paddingHorizontal: 14, paddingVertical: 9 },
  nearbyEmoji: { fontSize: 15 },
  nearbyText: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 14, letterSpacing: 0.8, textTransform: 'uppercase' },
  chips: { position: 'absolute', left: 0, right: 0, flexGrow: 0 },
  chipsRow: { paddingHorizontal: 12, gap: 6, alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 34, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: alpha(colors.panel, 0.92), borderWidth: 1, borderColor: colors.line },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.sub, fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase' },
  chipCount: { color: colors.dim, fontFamily: fonts.label, fontSize: 12 },
  chipGap: { width: 1, height: 18, backgroundColor: colors.lineHi, marginHorizontal: 4 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green },
  emptyWrap: { position: 'absolute', left: 12, right: 12 },
  scan: { position: 'absolute', left: 0, right: 0, height: 90, backgroundColor: alpha(colors.primary, 0.06) },
  loadingText: { color: colors.dim, fontFamily: fonts.label, fontSize: 14, letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 10 },
});
