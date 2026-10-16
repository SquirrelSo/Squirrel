/**
 * SVG layers of the world map: the base (terrain, roads, paths, buildings) and the territory shapes.
 * Both are deliberately quiet — the map is the stage, not the show. No text is drawn here: names
 * live in the label layer (LabelLayer.tsx), which keeps them a constant size and hides the ones
 * that would collide. The base is memoised as a whole; each territory subscribes to its own zone
 * in the store, so an ownership change repaints one polygon.
 */
import { memo } from 'react';
import { Circle, ClipPath, Defs, G, Line, Polygon, Polyline, Rect } from 'react-native-svg';
import { isPlaceholderZone } from '@/api/campus/campusShapes';
import type { LatLng, MapFeatures, Zone } from '@/api/campus/types';
import { displayStatus, RELATION_COLOR, relationOf, STATUS_UI } from '@/components/campus/territoryUi';
import { tap } from '@/components/ui';
import { inPolygon, type Projection } from '@/components/map/geometry';
import { useTerritory } from '@/state/territoryStore';
import { colors, mapColors } from '@/theme';

type XY = [number, number];
type Terrain = MapFeatures['terrain'][number];
type Building = MapFeatures['buildings'][number];

const ROOF: Record<string, string> = {
  hostel: mapColors.roofHostel,
  academic: mapColors.roofAcademic,
  food: mapColors.roofFood,
  sports: mapColors.roofSports,
  residential: mapColors.roofHome,
  service: mapColors.roofService,
};

const toStr = (xy: XY[]) => xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
const shift = (xy: XY[], dx: number, dy: number): XY[] => xy.map(([x, y]) => [x + dx, y + dy]);
const centerOf = (xy: XY[]): XY => [xy.reduce((a, p) => a + p[0], 0) / xy.length, xy.reduce((a, p) => a + p[1], 0) / xy.length];
function bboxOf(xy: XY[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of xy) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}
/** Deterministic 0..1 noise, so trees land in the same place on every render. */
const hash = (a: number, b: number) => {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/** Trees scattered through woods (dense) and big lawns (sparse), never on roads' worth of edge. */
function treesFor(t: Terrain, xy: XY[]): { x: number; y: number; r: number }[] {
  if (t.kind !== 'woods' && t.kind !== 'green') return [];
  const b = bboxOf(xy);
  const step = t.kind === 'woods' ? 24 : 46;
  if (t.kind === 'green' && b.w * b.h < 12_000) return [];
  const out: { x: number; y: number; r: number }[] = [];
  for (let gx = b.x0 + step / 2; gx < b.x1; gx += step)
    for (let gy = b.y0 + step / 2; gy < b.y1; gy += step) {
      const h1 = hash(gx, gy);
      if (t.kind === 'green' && h1 < 0.55) continue;
      const x = gx + (hash(gy, gx) - 0.5) * step * 0.8;
      const y = gy + (h1 - 0.5) * step * 0.8;
      if (inPolygon([x, y], xy)) out.push({ x, y, r: (t.kind === 'woods' ? 7 : 6) + hash(x, y) * 4 });
    }
  return out;
}

/**
 * The campus base, muted: flat ground, soft lawns and water, roads as clean pale strokes,
 * footpaths as hairlines, a sparse scatter of trees and flat roofs tinted by use. No textures,
 * ripples, stripes or captions — enough to read the layout, never enough to compete with what's
 * on top. Drawn once and memoised — it never re-renders during pan / zoom.
 */
export const BaseLayer = memo(function BaseLayer({ features, proj }: { features: MapFeatures; proj: Projection }) {
  const P = (list: LatLng[]): XY[] => list.map((p) => proj.project(p));
  const terrain = features.terrain.map((t) => ({ t, xy: P(t.polygon) }));
  const order: Record<string, number> = { woods: 0, green: 1, plaza: 2, parking: 3, water: 4, track: 5, field: 6, court: 7 };
  terrain.sort((a, b) => (order[a.t.kind] ?? 1) - (order[b.t.kind] ?? 1));
  const trees = terrain.flatMap(({ t, xy }) => treesFor(t, xy));
  const roads = features.roads.map((r) => ({ r, s: toStr(P(r.points)) }));
  const buildings = features.buildings
    .map((b: Building) => ({ b, xy: P(b.polygon) }))
    .sort((a, b) => bboxOf(a.xy).y1 - bboxOf(b.xy).y1);

  return (
    <G>
      <Defs>
        {terrain
          .filter(({ t }) => t.kind === 'field')
          .map(({ t, xy }) => (
            <ClipPath key={`clip-${t.id}`} id={`clip-${t.id}`}>
              <Polygon points={toStr(xy)} />
            </ClipPath>
          ))}
      </Defs>

      {terrain.map(({ t, xy }) => {
        const s = toStr(xy);
        const b = bboxOf(xy);
        const c = centerOf(xy);
        switch (t.kind) {
          case 'woods':
          case 'green':
            return <Polygon key={t.id} points={s} fill={t.kind === 'woods' ? mapColors.woods : mapColors.green} />;
          case 'water':
            return <Polygon key={t.id} points={s} fill={mapColors.water} stroke={mapColors.waterEdge} strokeWidth={1.5} strokeLinejoin="round" />;
          case 'track':
            return <Polygon key={t.id} points={s} fill={mapColors.track} opacity={0.7} />;
          case 'field':
            return (
              <G key={t.id}>
                <Polygon points={s} fill={mapColors.field} />
                <G clipPath={`url(#clip-${t.id})`} opacity={0.6}>
                  <Rect x={b.x0 + b.w * 0.14} y={b.y0 + b.h * 0.16} width={b.w * 0.72} height={b.h * 0.68} fill="none" stroke={mapColors.trackLine} strokeWidth={1} />
                  <Line x1={c[0]} y1={b.y0 + b.h * 0.16} x2={c[0]} y2={b.y0 + b.h * 0.84} stroke={mapColors.trackLine} strokeWidth={1} />
                  <Circle cx={c[0]} cy={c[1]} r={Math.min(b.w, b.h) * 0.13} fill="none" stroke={mapColors.trackLine} strokeWidth={1} />
                </G>
              </G>
            );
          case 'court':
            return <Polygon key={t.id} points={s} fill={mapColors.court} opacity={0.8} />;
          case 'parking':
            return <Polygon key={t.id} points={s} fill={mapColors.parking} />;
          case 'plaza':
            return <Polygon key={t.id} points={s} fill={mapColors.plaza} />;
          default:
            return <Polygon key={t.id} points={s} fill={mapColors.green} />;
        }
      })}

      {/* Roads: one soft casing, one clean surface. Footpaths: hairlines. */}
      {roads.filter(({ r }) => r.kind === 'road').map(({ r, s }) => (
        <Polyline key={`${r.id}-case`} points={s} fill="none" stroke={mapColors.roadCasing} strokeWidth={15} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {roads.filter(({ r }) => r.kind === 'road').map(({ r, s }) => (
        <Polyline key={r.id} points={s} fill="none" stroke={mapColors.road} strokeWidth={11} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {roads.filter(({ r }) => r.kind === 'path').map(({ r, s }) => (
        <Polyline key={r.id} points={s} fill="none" stroke={mapColors.path} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      ))}

      {trees.map((t, i) => (
        <Circle key={`tr${i}`} cx={t.x} cy={t.y} r={t.r * 0.8} fill={i % 3 ? mapColors.tree : mapColors.treeDark} opacity={0.75} />
      ))}

      {/* Buildings: a soft offset shadow and a flat roof tinted by use. */}
      {buildings.map(({ b, xy }) => (
        <G key={b.id}>
          <Polygon points={toStr(shift(xy, 2.5, 3))} fill={mapColors.shadow} />
          <Polygon points={toStr(xy)} fill={ROOF[b.kind ?? ''] ?? mapColors.building} stroke={mapColors.buildingLine} strokeWidth={1} strokeLinejoin="round" />
        </G>
      ))}
    </G>
  );
});

type ZoneShapeProps = { zone: Zone; points: string; selected: boolean; meId: string | null; emphasis: 'quiet' | 'strong'; onSelect?: (id: string) => void };

/** Dotted outline of a zone nobody has surveyed yet (geometry_source 'dev_placeholder'). */
const APPROX_DASH = '3 9';

/**
 * One territory, quiet by default: a hairline and a whisper of fill. It speaks up only when it
 * matters — yours (your colour), held by someone else (theirs), contested or under attack (a dash
 * and a stronger line, so it never relies on colour alone), selected (a bold outline and fill), or
 * with the Territories filter on (`emphasis: 'strong'`). Names and status live in the label layer
 * and the card, never inside the shape. A placeholder outline (not surveyed) stays dotted and lighter.
 */
export const ZoneShape = memo(function ZoneShape({ zone, points, selected, meId, emphasis, onSelect }: ZoneShapeProps) {
  const t = useTerritory(zone.id);
  const rel = relationOf(t, meId);
  const status = displayStatus(t);
  const mine = rel === 'mine';
  const approx = isPlaceholderZone(zone);
  const fight = status === 'contested' || status === 'under_attack';
  const held = status === 'controlled' || fight;
  const c = fight ? STATUS_UI[status].color : mine ? RELATION_COLOR.mine : held ? STATUS_UI[status].color : colors.text;
  const strong = emphasis === 'strong';
  const strength = t?.control ?? (t?.owner ? 0.6 : 0);
  const fillOpacity = selected ? 0.24 : !held ? (strong ? 0.1 : 0.035) : (strong ? 0.16 : 0.07) + strength * (strong ? 0.16 : 0.06);
  const strokeOpacity = selected ? 0.95 : fight ? 0.85 : held ? (strong ? 0.85 : 0.5) : strong ? 0.6 : 0.24;
  // Widths are in metres (1 SVG unit = 1 m): about 1.5–2 px at the usual zoom, thicker close up.
  const strokeWidth = selected ? 6 : fight ? 4 : held ? (strong ? 3.5 : 2.6) : strong ? 2.6 : 1.8;
  const press = onSelect
    ? () => {
        tap();
        onSelect(zone.id);
      }
    : undefined;
  return (
    <G onPress={press} accessibilityLabel={`${zone.name}: ${STATUS_UI[status].label}${t?.owner ? `, held by ${mine ? 'you' : t.owner.display_name}` : ''}${approx ? '. Approximate outline, not surveyed yet' : ''}`}>
      <Polygon
        points={points}
        fill={c}
        fillOpacity={approx ? fillOpacity * 0.6 : fillOpacity}
        stroke={c}
        strokeOpacity={approx ? strokeOpacity * 0.8 : strokeOpacity}
        strokeWidth={strokeWidth}
        strokeDasharray={approx ? APPROX_DASH : status === 'contested' ? '14 7' : status === 'under_attack' ? '6 5' : undefined}
        strokeLinecap={approx ? 'round' : undefined}
        strokeLinejoin="round"
      />
    </G>
  );
});
