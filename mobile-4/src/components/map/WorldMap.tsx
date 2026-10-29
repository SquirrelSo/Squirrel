/**
 * The Squirrel Social world map: a stylised game board (terrain, roads, buildings), territory
 * overlays coloured by backend state, places, the Squirrels around you (clustered), your own
 * marker and route. No map tiles — it's a game board, not Google Maps.
 *
 * Built for calm: the base and territories are quiet; names are one fixed size and appear by
 * importance as you zoom, never on top of each other (LabelLayer); only live things move; layers
 * can be switched off (`layers`). On the Map tab it opens around you, not on the whole campus.
 *
 * Performance: base + territories are SVG and never re-render during gestures (pan/zoom is an
 * Animated transform). Markers and labels are memoised native views that counter-scale;
 * clustering and label placement recompute only when a gesture (or the mouse wheel) ends. Your
 * GPS position lives in its own store, so a location update re-renders the "you" marker only.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, G, Polyline, Rect } from 'react-native-svg';
import { withCampusBase } from '@/api/campus/campusBaseMap';
import type { HeatCell, LatLng, MapFeatures, MapPlayer, Poi, Zone } from '@/api/campus/types';
import { displayStatus, RELATION_COLOR, relationOf, STATUS_UI } from '@/components/campus/territoryUi';
import { Icon, tap } from '@/components/ui';
import { fitOf, makeProjection, pts } from '@/components/map/geometry';
import { BaseLayer, ZoneShape } from '@/components/map/layers';
import { LabelLayer, type MapLabel } from '@/components/map/LabelLayer';
import { ClusterMarker, CurrentUserMarker, PlayerMarker, PoiMarker } from '@/components/map/markers';
import { HeatLayer } from '@/components/map/HeatLayer';
import { MAX_SCALE, PanZoom } from '@/components/map/PanZoom';
import { groupMarkers } from '@/logic/mapCluster';
import { PERSON_LABEL_MPP, placeLabel, sameName, zoneTier, type Obstacle } from '@/logic/mapLabels';
import { getLocationSnapshot, useLocation } from '@/state/locationStore';
import { useAllTerritories } from '@/state/territoryStore';
import { alpha, colors, fonts, mapColors, radius } from '@/theme';

export type WorldMapHandle = {
  /** Centre on your position; false when there's no position to centre on. */
  recenter: () => boolean;
  /**
   * Keep a selected place in view beside a card: slide the map (never zoom) only if the point sits
   * under the card — below `bottom` px from the bottom (phone sheet) or left of `left` px (desktop card).
   */
  reveal: (p: LatLng, inset: { bottom?: number; left?: number }) => void;
  reset: () => void;
};

/** What's drawn. Everything stays in the data; switching a layer off only stops drawing it. */
export type MapLayers = {
  /** People (and clusters). */
  people?: boolean;
  /** Only people who are live right now (running, walking, working out). */
  liveOnly?: boolean;
  /** Places (points of interest) and the small building / ground names close up. */
  places?: boolean;
  /** Territories as a quiet backdrop, or spelled out (Territories filter). */
  territories?: 'quiet' | 'strong';
};

export type WorldMapProps = {
  zones: Zone[];
  features?: MapFeatures | null;
  meId: string | null;
  selectedZoneId?: string | null;
  onSelectZone?: (zoneId: string) => void;
  /** Your own route (run screen). */
  route?: LatLng[];
  /** Your own position: 'watch' uses the shared location store; a LatLng pins it; null hides it. */
  me?: LatLng | 'watch' | null;
  players?: MapPlayer[];
  selectedPlayerId?: string | null;
  onSelectPlayer?: (userId: string) => void;
  /** A cluster the map can't split further (max zoom), or one you want listed. */
  onSelectCluster?: (players: MapPlayer[]) => void;
  pois?: Poi[];
  selectedPoiId?: string | null;
  onSelectPoi?: (poiId: string) => void;
  highlight?: string[];
  /** Aggregated activity cells from the backend (Map → Heat). */
  heat?: HeatCell[] | null;
  layers?: MapLayers;
  /** 'around' (Map tab): open filled and centred on you once your position is known. 'fit': the whole campus. */
  initialView?: 'fit' | 'around';
  interactive?: boolean;
  controls?: boolean;
  /** Adds a locate button to the controls. */
  onLocate?: () => void;
  /** Space kept free for overlays (header, sheets) when placing the controls. */
  controlsInset?: { top?: number; bottom?: number };
  style?: StyleProp<ViewStyle>;
};

type ClusterItem = { kind: 'player'; player: MapPlayer; x: number; y: number } | { kind: 'cluster'; id: string; players: MapPlayer[]; live: number; x: number; y: number };

/** "Around you": roughly 350–450 m across a phone screen. */
const AROUND_MPP = 1.15;

export const WorldMap = forwardRef<WorldMapHandle, WorldMapProps>(function WorldMap(props, ref) {
  const { zones, meId, selectedZoneId = null, onSelectZone, route, me = null, players, selectedPlayerId = null, onSelectPlayer, onSelectCluster, pois, selectedPoiId = null, onSelectPoi, highlight, heat, layers, initialView = 'fit', interactive = true, controls = interactive, onLocate, controlsInset, style } = props;
  const showPeople = layers?.people !== false;
  const showPlaces = layers?.places !== false;
  const emphasis = layers?.territories ?? 'quiet';
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [pz] = useState(() => new PanZoom());
  const [zoom, setZoom] = useState(1);
  useEffect(() => pz.setBox(box.w, box.h), [pz, box]);
  useEffect(() => pz.setInteractive(interactive), [pz, interactive]);
  useEffect(() => pz.onZoom((s) => setZoom((z) => (Math.abs(z - s) > 0.12 ? s : z))), [pz]);

  // A backend that serves zone outlines only still gets this campus's roads and buildings underneath.
  const features = useMemo(() => withCampusBase(props.features, zones), [props.features, zones]);
  const proj = useMemo(() => makeProjection(zones, features), [zones, features]);
  const fit = useMemo(() => (proj && box.w ? fitOf(proj, box.w, box.h) : null), [proj, box]);
  const view = useCallback((p: LatLng) => {
    const [x, y] = proj!.project(p);
    return { x: fit!.ox + x * fit!.k, y: fit!.oy + y * fit!.k };
  }, [proj, fit]);
  const mpp = fit ? 1 / (fit.k * zoom) : Infinity;

  // ---- first framing: on a portrait phone the campus is a thin band at "fit", so 'around' fills
  // the screen; it then centres on you once (AroundYou) unless you've already moved the map.
  // (Your position can arrive first: the MeLayer is a child, so its effect runs before this one.)
  const fill = proj && fit ? Math.min(3, Math.max(1, (box.h * 0.62) / (proj.height * fit.k))) : 1;
  const framed = useRef(false);
  useEffect(() => {
    if (!proj || !fit || framed.current || initialView !== 'around') return;
    framed.current = true;
    pz.jump(fill);
  }, [proj, fit, fill, initialView, pz]);
  // A small static map about one zone (zone screen): frame that zone, not the whole campus.
  const focusZone = !interactive && selectedZoneId ? zones.find((z) => z.id === selectedZoneId) ?? null : null;
  useEffect(() => {
    if (!focusZone || !fit || !box.w) return;
    const v = view(focusZone.centroid);
    const s = Math.min(3.2, Math.max(1.6, fill * 1.8));
    pz.jump(s, -s * (v.x - box.w / 2), -s * (v.y - box.h / 2));
  }, [focusZone, fit, box.w, box.h, view, fill, pz]);
  const centeredOnMe = useRef(false);
  const aroundMe = useCallback(
    (p: LatLng) => {
      if (centeredOnMe.current || pz.userMoved || !fit || !proj) return;
      const v = view(p);
      // Only if you're on the map (a phone off campus keeps the campus view).
      if (v.x < fit.ox || v.y < fit.oy || v.x > fit.ox + proj.width * fit.k || v.y > fit.oy + proj.height * fit.k) return;
      centeredOnMe.current = true;
      framed.current = true;
      pz.centerOn(v.x, v.y, Math.max(fill, 1 / (AROUND_MPP * fit.k)));
    },
    [fit, proj, view, pz, fill],
  );

  // ---- mouse wheel (web): zoom about the cursor
  const wrapRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || !interactive) return;
    const el = wrapRef.current as unknown as HTMLElement | null;
    if (!el?.addEventListener) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      pz.zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    // Focusing an off-screen marker (keyboard Tab) makes the browser scroll this overflow-hidden box
    // to reveal it, sliding the world out from under the map. Movement belongs to pan / zoom only.
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.scrollTop || t.scrollLeft) {
        t.scrollTop = 0;
        t.scrollLeft = 0;
      }
    };
    el.addEventListener('scroll', onScroll, true);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', onScroll, true);
    };
  }, [pz, interactive, proj]);

  const territories = useAllTerritories();
  const shapes = useMemo(() => (proj ? zones.map((z) => ({ zone: z, points: pts(proj, z.polygon) })) : []), [zones, proj]);
  const routePts = useMemo(() => (proj && route && route.length > 1 ? pts(proj, route) : null), [route, proj]);

  // ---- people: filtered by layer, then clustered (screen-space grid; recomputed on zoom end / data change only)
  const shownPlayers = useMemo(() => (!showPeople ? [] : layers?.liveOnly ? (players ?? []).filter((p) => !!p.activity) : players ?? []), [players, showPeople, layers?.liveOnly]);
  const items = useMemo<ClusterItem[]>(() => {
    if (!fit || !shownPlayers.length) return [];
    // Grouped by distance on screen (logic/mapCluster.ts); positions back in unscaled view units.
    const byId = new Map(shownPlayers.map((p) => [p.user_id, p]));
    // Your dot stays uncovered. Read (not subscribed) when grouping reruns, so GPS updates never re-render the map.
    const mine = me === 'watch' ? getLocationSnapshot().position : me;
    const mv = mine ? view(mine) : null;
    const placed = groupMarkers(
      shownPlayers.map((p) => {
        const v = view(p.position);
        return { id: p.user_id, x: v.x * zoom, y: v.y * zoom };
      }),
      mv ? { x: mv.x * zoom, y: mv.y * zoom } : null,
    );
    return placed.map((g): ClusterItem => {
      if (g.kind === 'single') return { kind: 'player', player: byId.get(g.id)!, x: g.x / zoom, y: g.y / zoom };
      const players = g.ids.map((id) => byId.get(id)!);
      return { kind: 'cluster', id: g.key, players, live: players.filter((p) => !!p.activity).length, x: g.x / zoom, y: g.y / zoom };
    });
  }, [shownPlayers, fit, zoom, view, me]);
  const clusterById = useMemo(() => new Map(items.filter((i) => i.kind === 'cluster').map((i) => [(i as { id: string }).id, i])), [items]);

  // ---- labels: zones by importance; places and the base map's own names close up (deduplicated)
  const labels = useMemo<MapLabel[]>(() => {
    if (!fit || !proj) return [];
    const out: MapLabel[] = [];
    const byZone = new Map(territories.map((t) => [t.zone_id, t]));
    const sized = [...zones].sort((a, b) => b.polygon.length - a.polygon.length);
    for (const z of sized) {
      const t = byZone.get(z.id);
      const status = displayStatus(t);
      const rel = relationOf(t, meId);
      const fight = status === 'contested' || status === 'under_attack';
      const selected = z.id === selectedZoneId || !!highlight?.includes(z.id);
      const v = view(z.centroid);
      out.push({
        id: `z:${z.id}`,
        x: v.x,
        y: v.y,
        text: placeLabel(z.name, z.short_name),
        tier: zoneTier(z),
        pinned: selected || (interactive && (rel === 'mine' || fight)),
        dot: rel === 'mine' ? RELATION_COLOR.mine : t?.owner ? RELATION_COLOR.other : null,
        icon: fight ? STATUS_UI[status].icon : null,
        iconColor: fight ? STATUS_UI[status].color : undefined,
      });
    }
    // A small static map about one zone (or a run's zones) names just those.
    if (!interactive && (selectedZoneId || highlight?.length)) return out.filter((l) => l.pinned);
    if (showPlaces && features) {
      const taken = (name: string) => zones.some((z) => sameName(z.name, name)) || out.some((l) => sameName(l.text, name));
      for (const p of pois ?? []) {
        if (taken(p.name)) continue;
        const v = view(p.position);
        out.push({ id: `p:${p.id}`, x: v.x, y: v.y + 20 / zoom, text: placeLabel(p.name), tier: 3, pinned: p.id === selectedPoiId });
      }
      for (const b of features.buildings) {
        if (!b.label || taken(b.label)) continue;
        const n = b.polygon.length;
        const v = view([b.polygon.reduce((s, q) => s + q[0], 0) / n, b.polygon.reduce((s, q) => s + q[1], 0) / n]);
        out.push({ id: `b:${b.id}`, x: v.x, y: v.y, text: placeLabel(b.label), tier: 3 });
      }
      for (const tr of features.terrain) {
        if (!tr.label || taken(tr.label)) continue;
        const n = tr.polygon.length;
        const v = view([tr.polygon.reduce((s, q) => s + q[0], 0) / n, tr.polygon.reduce((s, q) => s + q[1], 0) / n]);
        out.push({ id: `t:${tr.id}`, x: v.x, y: v.y, text: placeLabel(tr.label), tier: 3 });
      }
    }
    return out;
  }, [fit, proj, zones, territories, meId, selectedZoneId, highlight, view, showPlaces, features, pois, selectedPoiId, zoom, interactive]);

  // Labels step aside for you, people and places. Your position is read when placement reruns
  // (zoom end), not subscribed to, so GPS updates never re-render the map.
  const obstacles = useMemo<Obstacle[]>(() => {
    if (!fit) return [];
    const o: Obstacle[] = items.map((it) => ({ x: it.x, y: it.y, r: it.kind === 'cluster' ? 22 : 17 }));
    if (showPlaces) for (const p of pois ?? []) o.push({ ...view(p.position), r: 13 });
    const mine = me === 'watch' ? getLocationSnapshot().position : me;
    if (mine) o.push({ ...view(mine), r: 14 });
    return o;
    // zoom: re-read your position whenever placement reruns
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, pois, showPlaces, view, me, fit, zoom]);

  const onCluster = useCallback(
    (id: string) => {
      const c = clusterById.get(id);
      if (!c || c.kind !== 'cluster') return;
      // Split it by zooming in; once close enough that it can't split, list who's there.
      if (pz.zoom < MAX_SCALE * 0.85) pz.centerOn(c.x, c.y, Math.min(MAX_SCALE, pz.zoom * 2.2));
      else onSelectCluster?.(c.players);
    },
    [clusterById, pz, onSelectCluster],
  );
  const onPlayer = useCallback((id: string) => onSelectPlayer?.(id), [onSelectPlayer]);
  const onPoi = useCallback((id: string) => onSelectPoi?.(id), [onSelectPoi]);
  const onZone = useCallback((id: string) => onSelectZone?.(id), [onSelectZone]);

  // A pinned position (run screen) is drawn in SVG; 'watch' uses the live store in <MeLayer>
  // so GPS updates re-render that marker only, not the map.
  const mePos = me === 'watch' ? null : me;

  useImperativeHandle(
    ref,
    () => ({
      recenter: () => {
        const p = me === 'watch' ? getLocationSnapshot().position : me;
        if (!p || !fit) return false;
        const v = view(p);
        pz.userMoved = true;
        pz.centerOn(v.x, v.y, Math.max(pz.zoom, 1 / (AROUND_MPP * fit.k)));
        return true;
      },
      reveal: (p, inset) => {
        if (!fit) return;
        const v = view(p);
        const at = pz.screenOf(v.x, v.y);
        const room = { top: 130, bottom: box.h - (inset.bottom ?? 0) - 24, left: (inset.left ?? 0) + 24, right: box.w - 70 };
        const dx = at.x < room.left ? (room.left + room.right) / 2 - at.x : 0;
        const dy = at.y > room.bottom || at.y < room.top ? (room.top + room.bottom) / 2 - at.y : 0;
        if (dx || dy) pz.panBy(dx, dy);
      },
      reset: () => pz.reset(),
    }),
    [me, fit, view, pz, box],
  );

  return (
    <View ref={wrapRef} style={[styles.wrap, style]} onLayout={(e) => {
        const { width: w, height: h } = e.nativeEvent.layout;
        pz.setBox(w, h); // now, not in an effect: a child may centre the map before effects run
        setBox({ w, h });
      }}>
      {proj && fit && (
        <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: pz.tx }, { translateY: pz.ty }, { scale: pz.scale }] }]} {...pz.responder.panHandlers}>
          <Svg width={box.w} height={box.h} viewBox={`0 0 ${proj.width.toFixed(0)} ${proj.height.toFixed(0)}`} preserveAspectRatio="xMidYMid meet">
            <Rect x={0} y={0} width={proj.width} height={proj.height} rx={36} fill={mapColors.ground} />
            {features && <BaseLayer features={features} proj={proj} />}
            {shapes.map((s) => (
              <ZoneShape key={s.zone.id} zone={s.zone} points={s.points} selected={s.zone.id === selectedZoneId || !!highlight?.includes(s.zone.id)} meId={meId} emphasis={emphasis} onSelect={onSelectZone ? onZone : undefined} />
            ))}
            {heat && heat.length > 0 && <HeatLayer cells={heat} proj={proj} />}
            {routePts && <Polyline points={routePts} fill="none" stroke={colors.primary} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />}
            {mePos && (
              <G>
                <Circle cx={proj.project(mePos)[0]} cy={proj.project(mePos)[1]} r={20} fill={colors.blue} opacity={0.18} />
                <Circle cx={proj.project(mePos)[0]} cy={proj.project(mePos)[1]} r={8} fill={colors.blue} stroke="#FFFFFF" strokeWidth={3} />
              </G>
            )}
          </Svg>
          <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            <LabelLayer labels={labels} zoom={zoom} metresPerPx={mpp} obstacles={obstacles} inverse={pz.inverse} />
            {showPlaces &&
              pois?.map((p) => {
                const v = view(p.position);
                return <PoiMarker key={p.id} poi={p} pos={v} inverse={pz.inverse} selected={p.id === selectedPoiId} onPress={onPoi} />;
              })}
            {/* With the heat layer on, people step back so the activity reads */}
            <View style={[StyleSheet.absoluteFill, heat?.length ? { opacity: 0.35 } : null]} pointerEvents="box-none">
              {items.map((it) =>
                it.kind === 'cluster' ? (
                  <ClusterMarker key={`c-${it.id}`} id={it.id} count={it.players.length} live={it.live} pos={{ x: it.x, y: it.y }} inverse={pz.inverse} onPress={onCluster} />
                ) : (
                  <PlayerMarker key={it.player.user_id} player={it.player} pos={{ x: it.x, y: it.y }} inverse={pz.inverse} selected={it.player.user_id === selectedPlayerId} showLabel={mpp <= PERSON_LABEL_MPP} onPress={onPlayer} />
                ),
              )}
            </View>
            {me === 'watch' && <MeLayer view={view} k={fit.k} inverse={pz.inverse} onFirstFix={initialView === 'around' ? aroundMe : undefined} />}
          </View>
        </Animated.View>
      )}
      {controls && proj && (
        <View style={[styles.controls, { bottom: (controlsInset?.bottom ?? 0) + 12 }]}>
          {onLocate && (
            <>
              <Pressable onPress={() => { tap(); onLocate(); }} style={styles.btn} accessibilityRole="button" accessibilityLabel="Show where I am">
                <Icon name="crosshairs-gps" size={19} color={colors.blue} />
              </Pressable>
              <View style={styles.divider} />
            </>
          )}
          <Pressable onPress={() => { tap(); pz.zoomBy(1.6); }} style={styles.btn} accessibilityRole="button" accessibilityLabel="Zoom in">
            <Icon name="plus" size={19} color={colors.text} />
          </Pressable>
          <View style={styles.divider} />
          <Pressable onPress={() => { tap(); pz.zoomBy(1 / 1.6); }} style={styles.btn} accessibilityRole="button" accessibilityLabel="Zoom out">
            <Icon name="minus" size={19} color={colors.text} />
          </Pressable>
        </View>
      )}
      {!interactive && <Text style={styles.north} accessibilityElementsHidden>N ↑</Text>}
    </View>
  );
});

function MeLayer({ view, k, inverse, onFirstFix }: { view: (p: LatLng) => { x: number; y: number }; k: number; inverse: PanZoom['inverse']; onFirstFix?: (p: LatLng) => void }) {
  const loc = useLocation();
  useEffect(() => {
    if (loc.position) onFirstFix?.(loc.position);
  }, [loc.position, onFirstFix]);
  if (!loc.position) return null;
  return <CurrentUserMarker pos={view(loc.position)} accuracyPx={(loc.accuracy_m ?? 20) * k} inverse={inverse} simulated={loc.simulated} />;
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', backgroundColor: mapColors.bg, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line },
  controls: { position: 'absolute', right: 12, borderRadius: 22, backgroundColor: alpha(colors.panel, 0.94), borderWidth: 1, borderColor: colors.lineHi, overflow: 'hidden' },
  btn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  divider: { height: 1, marginHorizontal: 10, backgroundColor: colors.line },
  north: { position: 'absolute', left: 12, top: 10, color: colors.dim, fontFamily: fonts.label, fontSize: 11, letterSpacing: 1 },
});
