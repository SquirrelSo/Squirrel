import React, { useId } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { View } from 'react-native';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { art, hairColors, skinTones } from './palette';
import type { AvatarLook, CharacterPose, HairStyle } from '@/types';

/**
 * Parametric human fitness avatars. Drawn in a 120x260 box, feet at y≈255,
 * centred on x=60. Flat cel-shaded with a pink rim light on the right edge.
 */

type Pt = readonly [number, number];

const f = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// colour + geometry helpers
// ---------------------------------------------------------------------------

function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** amt < 0 mixes toward black, amt > 0 toward white. */
function shade(hex: string, amt: number): string {
  const [r, g, b] = parseHex(hex);
  const t = amt < 0 ? 0 : 255;
  const k = Math.abs(amt);
  const mix = (c: number) => Math.round(c + (t - c) * k).toString(16).padStart(2, '0');
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

function luma(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** A readable cel-shadow for any fabric colour (dark fabrics get lifted instead). */
function clothShade(hex: string): string {
  const l = luma(hex);
  if (l < 0.14) return shade(hex, 0.12);
  return shade(hex, l > 0.85 ? -0.14 : -0.24);
}

function capsule(a: Pt, b: Pt, ra: number, rb: number): string {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  return (
    `M${f(a[0] + nx * ra)},${f(a[1] + ny * ra)}` +
    `L${f(b[0] + nx * rb)},${f(b[1] + ny * rb)}` +
    `A${f(rb)},${f(rb)} 0 0 0 ${f(b[0] - nx * rb)},${f(b[1] - ny * rb)}` +
    `L${f(a[0] - nx * ra)},${f(a[1] - ny * ra)}` +
    `A${f(ra)},${f(ra)} 0 0 0 ${f(a[0] + nx * ra)},${f(a[1] + ny * ra)}Z`
  );
}

function rightNormal(a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  if (nx < 0 || (nx === 0 && ny > 0)) {
    nx = -nx;
    ny = -ny;
  }
  return [nx, ny];
}

const add = (p: Pt, v: Pt, k = 1): Pt => [p[0] + v[0] * k, p[1] + v[1] * k];
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Smooth path through points (Catmull-Rom -> cubic bezier). Returns segment commands only. */
function smooth(pts: Pt[]): string {
  let d = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return d;
}

// ---------------------------------------------------------------------------
// body geometry
// ---------------------------------------------------------------------------

type Geo = {
  sh: number; // half shoulder width
  ch: number; // half chest width
  wh: number; // half waist width
  hh: number; // half hip width
  neck: number;
  /** shoulder, elbow, forearm bulge, wrist */
  arm: [number, number, number, number];
  hand: number;
  /** hip, knee, calf bulge, ankle */
  leg: [number, number, number, number];
  hipX: number;
};

const GEO: Record<'female' | 'male', Geo> = {
  female: { sh: 16.5, ch: 15, wh: 11.2, hh: 17.5, neck: 4.3, arm: [5.8, 4.3, 4.8, 3.2], hand: 4.2, leg: [9.4, 6.2, 6.7, 3.5], hipX: 8.2 },
  male: { sh: 21.5, ch: 19.5, wh: 15, hh: 16.2, neck: 5.6, arm: [7, 5.2, 5.8, 3.9], hand: 4.8, leg: [10, 7, 7.5, 4.1], hipX: 8.4 },
};

const NECK_Y = 58;

function widthAt(g: Geo, y: number): number {
  const table: [number, number][] = [
    [NECK_Y, g.neck + 2.5],
    [63, g.sh - 5],
    [67, g.sh - 0.8],
    [72, g.sh],
    [84, g.ch],
    [110, g.wh],
    [126, g.hh - 1],
    [134, g.hh],
    [160, g.hh],
  ];
  if (y <= table[0][0]) return table[0][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [y0, w0] = table[i];
    const [y1, w1] = table[i + 1];
    if (y <= y1) return w0 + ((w1 - w0) * (y - y0)) / (y1 - y0);
  }
  return table[table.length - 1][1];
}

type GarmentOpts = {
  top: number;
  hem: number;
  extra?: number;
  dip?: number;
  /** When set, the upper part narrows into straps: [strapHalfWidth, armholeBottomY, exponent]. */
  straps?: [number, number, number];
};

function garmentPath(g: Geo, o: GarmentOpts): string {
  const extra = o.extra ?? 0;
  const ys = [o.top, 63, 67, 72, 84, 96, 110, 122, 134, 150].filter((y) => y > o.top && y < o.hem);
  const all = [o.top, ...ys, o.hem];
  const w = (y: number) => {
    const base = widthAt(g, y) + extra;
    if (!o.straps) return base;
    const [sw, yb, ex] = o.straps;
    if (y >= yb) return base;
    const t = Math.max(0, (y - o.top) / (yb - o.top));
    return sw + (widthAt(g, yb) + extra - sw) * Math.pow(t, ex);
  };
  const left: Pt[] = all.map((y) => [60 - w(y), y]);
  const right: Pt[] = [...all].reverse().map((y) => [60 + w(y), y]);
  const dip = o.dip ?? 5;
  const l0 = left[0];
  return (
    `M${f(l0[0])},${f(l0[1])}` +
    smooth(left) +
    `Q60,${f(o.hem + 1.5)} ${f(right[0][0])},${f(right[0][1])}` +
    smooth(right) +
    `Q60,${f(o.top + dip * 2)} ${f(l0[0])},${f(l0[1])}Z`
  );
}

// ---------------------------------------------------------------------------
// poses
// ---------------------------------------------------------------------------

type HandKind = 'relaxed' | 'fist' | 'open' | 'palm';
type ArmPose = { e: Pt; h: Pt; hand: HandKind; abs?: boolean };
type LegPose = { k: Pt; a: Pt; rot: number; dir: number };
type Expr = 'smile' | 'grin' | 'open' | 'calm';

type PoseSpec = {
  dy: number;
  lean: number;
  tilt: number;
  face: number; // horizontal shift of facial features (3/4 turn)
  expr: Expr;
  arms: [ArmPose, ArmPose];
  legs: [LegPose, LegPose];
  flexArms?: boolean;
  /** arms drawn in front of the head (raised arms) */
  armsOverHead?: boolean;
  dumbbells?: boolean;
};

const POSES: Record<CharacterPose, PoseSpec> = {
  stand: {
    dy: 0, lean: 0, tilt: -3, face: 0, expr: 'smile',
    arms: [
      { e: [-6, 29], h: [-1, 28], hand: 'relaxed' },
      { e: [13, 25], h: [-10, 21], hand: 'fist' },
    ],
    legs: [
      { k: [1, 55], a: [1, 53], rot: 0, dir: -0.6 },
      { k: [7, 54], a: [4, 53], rot: 0, dir: 1 },
    ],
  },
  run: {
    dy: 12, lean: 8, tilt: 3, face: 2.5, expr: 'open',
    arms: [
      { e: [-15, 21], h: [-4, 22], hand: 'fist' },
      { e: [10, 23], h: [17, -13], hand: 'fist' },
    ],
    legs: [
      { k: [-9, 52], a: [-22, 40], rot: -38, dir: 1 },
      { k: [20, 42], a: [-4, 46], rot: 12, dir: 1 },
    ],
  },
  wave: {
    dy: 0, lean: -2, tilt: 5, face: 0, expr: 'grin',
    arms: [
      { e: [-6, 29], h: [-1, 28], hand: 'relaxed' },
      { e: [20, -18], h: [4, -26], hand: 'open' },
    ],
    legs: [
      { k: [-2, 55], a: [-1, 53], rot: 0, dir: -0.8 },
      { k: [3, 55], a: [2, 53], rot: 0, dir: 0.8 },
    ],
  },
  lift: {
    dy: 0, lean: 0, tilt: 0, face: 0, expr: 'grin', dumbbells: true,
    arms: [
      { e: [-17, -15], h: [-2, -27], hand: 'fist' },
      { e: [17, -15], h: [2, -27], hand: 'fist' },
    ],
    legs: [
      { k: [-5, 55], a: [-2, 53], rot: 0, dir: -1 },
      { k: [5, 55], a: [2, 53], rot: 0, dir: 1 },
    ],
  },
  yoga: {
    dy: 0, lean: 0, tilt: 0, face: 0, expr: 'calm', armsOverHead: true,
    arms: [
      { e: [-10, -29], h: [58.2, 9], hand: 'palm', abs: true },
      { e: [10, -29], h: [61.8, 9], hand: 'palm', abs: true },
    ],
    legs: [
      { k: [2.5, 55], a: [4, 53], rot: 0, dir: 0 },
      { k: [24, 34], a: [-26, 22], rot: 90, dir: 1 },
    ],
  },
  flex: {
    dy: 0, lean: 0, tilt: 0, face: 0, expr: 'grin', flexArms: true,
    arms: [
      { e: [-22, 2], h: [1, -23], hand: 'fist' },
      { e: [22, 2], h: [-1, -23], hand: 'fist' },
    ],
    legs: [
      { k: [-6, 55], a: [-2, 53], rot: 0, dir: -1 },
      { k: [6, 55], a: [2, 53], rot: 0, dir: 1 },
    ],
  },
};

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/** A multi-joint limb drawn in passes (rim, base, shade) so joints show no seams. */
function LimbChain({ pts, radii, fill, dark, rim = true }: { pts: Pt[]; radii: number[]; fill: string; dark: string; rim?: boolean }) {
  const segs = pts.slice(0, -1).map((a, i) => ({ a, b: pts[i + 1], ra: radii[i], rb: radii[i + 1], n: rightNormal(a, pts[i + 1]) }));
  return (
    <>
      {rim ? segs.map((sg, i) => <Path key={`r${i}`} d={capsule(add(sg.a, sg.n, 1), add(sg.b, sg.n, 1), sg.ra, sg.rb)} fill={art.pink} />) : null}
      {segs.map((sg, i) => (
        <Path key={`b${i}`} d={capsule(sg.a, sg.b, sg.ra, sg.rb)} fill={fill} />
      ))}
      {segs.map((sg, i) => (
        <Path key={`d${i}`} d={capsule(add(sg.a, sg.n, sg.ra * 0.45), add(sg.b, sg.n, sg.rb * 0.45), sg.ra * 0.55, sg.rb * 0.55)} fill={dark} />
      ))}
    </>
  );
}

function Sneaker({ x, y, dir, rot, color }: { x: number; y: number; dir: number; rot: number; color: string }) {
  const o = dir * 2.2;
  const dark = clothShade(color);
  return (
    <G transform={rot ? `rotate(${rot} ${x} ${y})` : undefined}>
      <Path
        d={`M${f(x - 9.5 + o)},${y - 4.5} C${f(x - 9.5 + o)},${y - 11} ${f(x - 4 + o)},${y - 13} ${f(x + o)},${y - 13} C${f(x + 5 + o)},${y - 13} ${f(x + 9.5 + o)},${y - 10} ${f(x + 10 + o)},${y - 4.5}Z`}
        fill={color}
      />
      <Path d={`M${f(x + 2 + o)},${y - 12.6} C${f(x + 7 + o)},${y - 12} ${f(x + 10 + o)},${y - 8} ${f(x + 10 + o)},${y - 4.5} L${f(x + 5 + o)},${y - 4.5}Z`} fill={dark} />
      <Ellipse cx={f(x - 0.5 + o * 0.5)} cy={y - 12} rx={3.4} ry={1.5} fill={dark} />
      <Rect x={f(x - 10.5 + o)} y={y - 5.5} width={21} height={5.5} rx={2.4} fill="#F2ECF7" />
      <Path d={`M${f(x - 10 + o)},${y - 2.2} L${f(x + 10.2 + o)},${y - 2.2}`} stroke="#C9BCD6" strokeWidth={0.9} />
      <Path d={`M${f(x - 6 + o)},${y - 8} Q${f(x + o)},${y - 5.5} ${f(x + 6.5 + o)},${y - 8.6}`} stroke={art.white} strokeWidth={1.3} strokeLinecap="round" fill="none" opacity={0.85} />
    </G>
  );
}

function HandShape({ p, r: r0, kind, skin, dark, dir }: { p: Pt; r: number; kind: HandKind; skin: string; dark: string; dir: number }) {
  const [x, y] = p;
  let r = r0;
  if (kind === 'open') {
    r = r0 * 1.2;
    return (
      <G>
        <Ellipse cx={x} cy={y - 1} rx={r * 1.05} ry={r * 1.35} fill={skin} />
        <Path d={`M${f(x - r * 0.5)},${f(y - r * 1.9)} L${f(x - r * 0.5)},${f(y - r * 0.6)} M${f(x + r * 0.1)},${f(y - r * 2.2)} L${f(x + r * 0.1)},${f(y - r * 0.6)} M${f(x + r * 0.7)},${f(y - r * 1.9)} L${f(x + r * 0.7)},${f(y - r * 0.6)}`} stroke={skin} strokeWidth={r * 0.62} strokeLinecap="round" />
        <Path d={`M${f(x - r * 1)},${f(y)} L${f(x - r * 1.7)},${f(y - r * 0.9)}`} stroke={skin} strokeWidth={r * 0.62} strokeLinecap="round" />
        <Ellipse cx={x + r * 0.35} cy={y} rx={r * 0.5} ry={r * 0.8} fill={dark} opacity={0.5} />
      </G>
    );
  }
  if (kind === 'palm') {
    return <Ellipse cx={x + dir * r * 0.5} cy={y} rx={r * 0.7} ry={r * 1.45} fill={skin} />;
  }
  return (
    <G>
      <Circle cx={x} cy={y} r={r} fill={skin} />
      <Circle cx={x + r * 0.35} cy={y + r * 0.2} r={r * 0.55} fill={dark} opacity={0.55} />
    </G>
  );
}

function Dumbbell({ p }: { p: Pt }) {
  const [x, y] = p;
  return (
    <G>
      <Path d={`M${x - 11},${y} L${x + 11},${y}`} stroke={art.steel} strokeWidth={2.4} strokeLinecap="round" />
      <Rect x={x - 13} y={y - 6} width={5} height={12} rx={1.6} fill="#241238" />
      <Rect x={x + 8} y={y - 6} width={5} height={12} rx={1.6} fill="#241238" />
      <Rect x={x - 9.6} y={y - 6} width={1.6} height={12} rx={0.8} fill={art.pink} />
      <Rect x={x + 11.4} y={y - 6} width={1.6} height={12} rx={0.8} fill={art.cyan} />
    </G>
  );
}

// ---------------------------------------------------------------------------
// hair
// ---------------------------------------------------------------------------

const SLEEK_CAP = 'M44.5,32 C43.5,17 51,10 60,10 C69,10 76.5,17 75.5,32 C74,25 70.5,20 65,18.5 C59,20.5 52,21 47.5,24.5 C46,27 45,29.5 44.5,32Z';

function ring(cx: number, cy: number, rx: number, ry: number, from: number, to: number, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((from + ((to - from) * i) / (n - 1)) * Math.PI) / 180;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

const CURLY_BACK = ring(60, 29, 20, 21, -215, 35, 15);
const AFRO_BACK = ring(60, 26, 23.5, 23.5, -180, 180, 16).slice(0, 15);

function HairBack({ style, c, dark, hidden }: { style: HairStyle; c: string; dark: string; hidden: boolean }) {
  switch (style) {
    case 'long':
      return (
        <G>
          <Path d="M40,34 C37,14 48,7.5 60,7.5 C72,7.5 83,14 80,34 L83.5,90 C76,95 67,93 62,89 L58,89 C53,93 44,95 36.5,90Z" fill={c} />
          <Path d="M72,40 C76,56 78,74 80,90 C76,93 71,93 67,91 C70,76 72,58 72,40Z" fill={dark} />
        </G>
      );
    case 'bob':
      return (
        <G>
          <Path d="M41,52 C38,30 42,9.5 60,9.5 C78,9.5 82,30 79,52 C75.5,55 70,55 67,53 L53,53 C50,55 44.5,55 41,52Z" fill={c} />
          <Path d="M73,34 C76,40 77,47 76.5,53.5 C73.5,54.8 70.5,54.6 68,53.2Z" fill={dark} />
        </G>
      );
    case 'ponytail':
      return (
        <G>
          <Path d="M69,12 C84,7 93,22 89,40 C86.5,53 91,67 84,84 C79,71 74.5,58 76,44 C77.5,31 76,22 68,17Z" fill={c} />
          <Path d="M84,30 C86,44 83,56 86,70 C84,76 83,80 84,84 C79,71 76,58 78,44Z" fill={dark} />
          <Circle cx={72.5} cy={14.5} r={2.6} fill={art.pink} />
        </G>
      );
    case 'bun':
      if (hidden) return null;
      return (
        <G>
          <Circle cx={60} cy={7} r={7.2} fill={c} />
          <Path d="M60,0.5 C64,1.5 66.5,4.5 66.8,8 C64,5.5 62,4 60,0.5Z" fill={dark} />
          <Rect x={54.5} y={11.2} width={11} height={2.6} rx={1.3} fill={art.pink} />
        </G>
      );
    case 'curly':
      return (
        <G>
          <Ellipse cx={60} cy={30} rx={19.5} ry={20} fill={c} />
          {CURLY_BACK.map((p, i) => (
            <Circle key={i} cx={f(p[0])} cy={f(p[1])} r={6.4} fill={i % 3 === 0 ? dark : c} />
          ))}
        </G>
      );
    case 'afro':
      return (
        <G>
          <Circle cx={60} cy={26} r={23.5} fill={c} />
          {AFRO_BACK.map((p, i) => (
            <Circle key={i} cx={f(p[0])} cy={f(p[1])} r={6.2} fill={i > 2 && i < 9 ? dark : c} />
          ))}
          <Path d="M44,14 C48,8 55,4.5 62,4.5" stroke={shade(c, 0.35)} strokeWidth={2.2} strokeLinecap="round" fill="none" opacity={0.7} />
        </G>
      );
    default:
      return null;
  }
}

function HairFront({ style, c, dark, hi }: { style: HairStyle; c: string; dark: string; hi: string }) {
  const streak = (d: string) => <Path d={d} stroke={hi} strokeWidth={1.5} strokeLinecap="round" fill="none" opacity={0.85} />;
  switch (style) {
    case 'short':
      return (
        <G>
          <Path d="M44.6,34 C43,20 49,9.5 60,9 C71,8.5 77.5,19 75.4,34 L74,28 C73,24.5 71,22 68,21 L65,23 L62,20.5 L58,23.2 L54.5,21 L51,23.5 C48,24.5 46.5,27 46,30Z" fill={c} />
          <Path d="M66,9.6 C72,11 76.5,18 75.4,34 L74,28 C73,24.5 71,22 68,21 C70,17 69,12 66,9.6Z" fill={dark} />
          {streak('M50,15 Q57,10.5 65,12')}
        </G>
      );
    case 'buzz':
      return (
        <G>
          <Path d="M45,33 C44,19 51,11.5 60,11.5 C69,11.5 76,19 75,33 C74.2,27.5 73,24 70.5,22 C64,20.5 56,20.5 49.5,22 C47,24 45.8,27.5 45,33Z" fill={c} opacity={0.92} />
          {streak('M51,15.5 Q57,13 63,13.5')}
        </G>
      );
    case 'bob':
      return (
        <G>
          <Path d="M44.4,33 C43.5,17 50,10.5 60,10.5 C70,10.5 76.5,17 75.6,33 L75,26.5 C67,28 53,28 45,26.5Z" fill={c} />
          <Path d="M45,26 C43.8,36 44,46 47,53.5 L42,53 C40.5,44 41.5,32 45,26Z" fill={c} />
          <Path d="M75,26 C76.2,36 76,46 73,53.5 L78,53 C79.5,44 78.5,32 75,26Z" fill={dark} />
          {streak('M48.5,15 Q55,11.6 63,12')}
        </G>
      );
    case 'long':
      return (
        <G>
          <Path d="M44.4,31 C43.5,17 50,10.5 60,10.5 C70,10.5 76.5,17 75.6,31 C73,22 68,16.5 60,14 C52,16.5 47,22 44.4,31Z" fill={c} />
          <Path d="M60,11 C51,11 44.2,17 44.4,31 C44.5,42 43.5,52 40.5,60 L45,58 C46.5,48 47,36 50,26 C52.5,19 56,15 60,13Z" fill={c} />
          <Path d="M60,11 C69,11 75.8,17 75.6,31 C75.5,42 76.5,52 79.5,60 L75,58 C73.5,48 73,36 70,26 C67.5,19 64,15 60,13Z" fill={dark} />
          {streak('M47,24 Q50,15 57,12.5')}
        </G>
      );
    case 'ponytail':
    case 'bun':
      return (
        <G>
          <Path d={SLEEK_CAP} fill={c} />
          <Path d="M65,10.8 C71,12.5 76.5,19 75.5,32 C74,25 70.5,20 65,18.5 C67,15.5 66.5,12.8 65,10.8Z" fill={dark} />
          {streak('M48,20 Q54,12.5 63,11.8')}
        </G>
      );
    case 'curly':
      return (
        <G>
          {[
            [47.5, 21, 4.6],
            [53.5, 17.2, 4.8],
            [60, 16, 4.8],
            [66.5, 17.2, 4.8],
            [72.5, 21, 4.6],
            [45.5, 27, 3.4],
            [74.5, 27, 3.4],
          ].map(([x, y, r], i) => (
            <Circle key={i} cx={x} cy={y} r={r} fill={i === 3 || i === 4 || i === 6 ? dark : c} />
          ))}
          {streak('M50,17 Q53,13.5 57,13.4')}
          {streak('M58.5,13.5 Q61,12 64,13')}
        </G>
      );
    case 'afro':
      return (
        <G>
          <Path d="M44.8,31 C44.5,19 51,15 60,15 C69,15 75.5,19 75.2,31 C73,24 67,21 60,21 C53,21 47,24 44.8,31Z" fill={c} />
        </G>
      );
  }
}

// ---------------------------------------------------------------------------
// clothing
// ---------------------------------------------------------------------------

type TopProps = { look: AvatarLook; g: Geo; uid: string };

function TopGarment({ look, g, uid }: TopProps) {
  const c = look.topColor;
  const dark = clothShade(c);
  const female = look.body === 'female';
  const cid = `${uid}top`;
  let d: string;
  let extras: React.ReactNode = null;
  switch (look.top) {
    case 'hoodie':
      d = garmentPath(g, { top: NECK_Y - 1, hem: 138, extra: 1.6, dip: 3 });
      extras = (
        <>
          <Path d={`M${60 - g.wh - 1},${130.5} Q60,133.5 ${60 + g.wh + 1},${130.5}`} stroke={dark} strokeWidth={1.3} fill="none" />
          <Path d={`M${60 - 10},${112} Q60,109.5 ${60 + 10},${112} L${60 + 12},${127} Q60,129 ${60 - 12},${127}Z`} fill={dark} opacity={0.75} />
          <Path d="M57,62 L56.3,78 M63,62 L63.8,76" stroke={art.white} strokeWidth={1.1} strokeLinecap="round" />
          <Circle cx={56.3} cy={79} r={1.1} fill={art.white} />
          <Circle cx={63.8} cy={77} r={1.1} fill={art.white} />
        </>
      );
      break;
    case 'tee':
      d = garmentPath(g, { top: NECK_Y, hem: 128, extra: 0.8, dip: 4.5 });
      extras = <Path d={`M${60 - g.neck - 2.4},${NECK_Y + 0.3} Q60,${NECK_Y + 10} ${60 + g.neck + 2.4},${NECK_Y + 0.3}`} stroke={dark} strokeWidth={1.2} fill="none" />;
      break;
    case 'tank':
      d = garmentPath(g, { top: NECK_Y + 1, hem: 128, extra: 0.8, dip: female ? 7 : 6, straps: [female ? g.neck + 3.2 : g.neck + 4, 86, female ? 2.4 : 2.8] });
      break;
    case 'crop':
      d = female
        ? garmentPath(g, { top: NECK_Y + 1, hem: 100, extra: 0.6, dip: 6, straps: [g.neck + 4, 82, 1.8] })
        : garmentPath(g, { top: NECK_Y, hem: 128, extra: 0.8, dip: 4.5, straps: [g.neck + 7, 84, 1.4] });
      extras = female ? (
        <Path d={`M${60 - widthAt(g, 97)},97.4 Q60,100 ${60 + widthAt(g, 97)},97.4`} stroke={dark} strokeWidth={3} fill="none" />
      ) : null;
      break;
    case 'jacket':
    default:
      d = garmentPath(g, { top: NECK_Y - 1, hem: 134, extra: 1.8, dip: 3 });
      extras = (
        <>
          <Path d={`M56,${NECK_Y + 2} L64,${NECK_Y + 2} L65.5,134 L54.5,134Z`} fill="#F4ECF8" />
          <Path d={`M56,${NECK_Y + 3} L54.5,134 M64,${NECK_Y + 3} L65.5,134`} stroke={dark} strokeWidth={1.1} />
          <Path d={`M${60 - g.hh - 2},${129.5} L${60 + g.hh + 2},${129.5}`} stroke={dark} strokeWidth={5} />
          <Path d={`M${60 - g.hh},${129.5} L${60 + g.hh},${129.5}`} stroke={art.pink} strokeWidth={0.9} strokeDasharray="1.5 1.5" opacity={0.8} />
          <Path d={`M${60 - g.neck - 3},${NECK_Y} Q60,${NECK_Y + 7} ${60 + g.neck + 3},${NECK_Y}`} stroke={dark} strokeWidth={2.6} fill="none" />
        </>
      );
      break;
  }
  return (
    <G>
      <Defs>
        <ClipPath id={cid}>
          <Path d={d} />
        </ClipPath>
      </Defs>
      <Path d={d} fill={art.pink} transform="translate(1,0)" />
      <Path d={d} fill={dark} />
      <G clipPath={`url(#${cid})`}>
        <Path d={d} fill={c} transform="translate(-5.5,-1)" />
        <Path d={d} fill={shade(c, 0.14)} opacity={0.45} transform="translate(-19,-4)" />
      </G>
      {extras}
    </G>
  );
}

// ---------------------------------------------------------------------------
// face
// ---------------------------------------------------------------------------

function Face({ look, expr, fx, skinDark, uid }: { look: AvatarLook; expr: Expr; fx: number; skinDark: string; uid: string }) {
  const female = look.body === 'female';
  const face = female
    ? 'M45,31 C45,18 52,13 60,13 C68,13 75,18 75,31 C75,42 70,51 60,53 C50,51 45,42 45,31Z'
    : 'M44.6,31 C44.6,17 52,13 60,13 C68,13 75.4,17 75.4,31 C75.4,42 72,50.5 60,53.6 C48,50.5 44.6,42 44.6,31Z';
  const cid = `${uid}face`;
  const browC = shade(look.hairColor, -0.2);
  const eye = '#1B1116';
  const skinIdx = (skinTones as readonly string[]).indexOf(look.skin);
  const light = skinIdx >= 0 ? skinIdx < 3 : luma(look.skin) > 0.6;
  const lip = female ? '#B23A5A' : '#8E2C44';
  const bw = female ? 1.1 : 1.6;
  return (
    <G>
      <Ellipse cx={44.6} cy={35} rx={2.6} ry={3.8} fill={look.skin} />
      <Ellipse cx={75.4} cy={35} rx={2.6} ry={3.8} fill={skinDark} />
      <Defs>
        <ClipPath id={cid}>
          <Path d={face} />
        </ClipPath>
      </Defs>
      <Path d={face} fill={art.pink} transform="translate(0.9,0)" />
      <Path d={face} fill={look.skin} />
      <G clipPath={`url(#${cid})`}>
        <Path d={face} fill={skinDark} transform="translate(9,3)" />
        <Ellipse cx={57 + fx * 0.3} cy={29} rx={13.5} ry={16} fill={look.skin} />
      </G>
      <G transform={fx ? `translate(${fx},0)` : undefined}>
        {light ? (
          <>
            <Ellipse cx={51} cy={41.5} rx={2.8} ry={1.5} fill={art.pink} opacity={0.28} />
            <Ellipse cx={69} cy={41.5} rx={2.8} ry={1.5} fill={art.pink} opacity={0.28} />
          </>
        ) : null}
        {/* brows */}
        <Path d="M50.2,30.6 Q53.8,28.6 57.2,30" stroke={browC} strokeWidth={bw} strokeLinecap="round" fill="none" />
        <Path d="M62.8,30 Q66.2,28.6 69.8,30.6" stroke={browC} strokeWidth={bw} strokeLinecap="round" fill="none" />
        {/* eyes */}
        {expr === 'calm' ? (
          <>
            <Path d="M50.8,35.2 Q54,37.4 57.2,35.2" stroke={eye} strokeWidth={1.2} strokeLinecap="round" fill="none" />
            <Path d="M62.8,35.2 Q66,37.4 69.2,35.2" stroke={eye} strokeWidth={1.2} strokeLinecap="round" fill="none" />
          </>
        ) : (
          <>
            <Path d="M50.6,35.4 Q54,31.6 57.4,35 Q54,37.8 50.6,35.4Z" fill={eye} />
            <Path d="M62.6,35 Q66,31.6 69.4,35.4 Q66,37.8 62.6,35Z" fill={eye} />
            <Circle cx={54.8} cy={34.2} r={0.85} fill={art.white} />
            <Circle cx={66.8} cy={34.2} r={0.85} fill={art.white} />
            {female ? (
              <Path d="M50.8,35.2 L49.3,33.9 M69.2,35.2 L70.7,33.9" stroke={eye} strokeWidth={0.9} strokeLinecap="round" />
            ) : null}
          </>
        )}
        {/* nose */}
        <Path d="M60.4,37.5 Q62,41 59.6,41.6" stroke={skinDark} strokeWidth={1.1} strokeLinecap="round" fill="none" />
        {/* mouth */}
        {expr === 'grin' ? (
          <>
            <Path d="M55.6,44.6 Q60,44 64.4,44.6 Q62.6,49.4 60,49.4 Q57.4,49.4 55.6,44.6Z" fill="#5A1628" />
            <Path d="M56.4,45 Q60,44.5 63.6,45 L63.1,46.2 Q60,45.8 56.9,46.2Z" fill={art.white} />
          </>
        ) : expr === 'open' ? (
          <Ellipse cx={60} cy={46.4} rx={2.2} ry={2} fill="#5A1628" />
        ) : (
          <Path d="M56.3,45 Q60,48.6 63.7,45 Q60,46.2 56.3,45Z" fill={lip} stroke={lip} strokeWidth={0.8} strokeLinejoin="round" />
        )}
      </G>
    </G>
  );
}

// ---------------------------------------------------------------------------
// accessories
// ---------------------------------------------------------------------------

function Accessory({ look, fx }: { look: AvatarLook; fx: number }) {
  switch (look.accessory) {
    case 'shades':
      return (
        <G transform={fx ? `translate(${fx},0)` : undefined}>
          <Path d="M45,33 L49,33 M71,33 L75,33" stroke={art.pink} strokeWidth={1} />
          <Path d="M48.6,32 L58,32 Q58.4,32 58.3,32.6 L57.6,37 Q57.2,39 55,39 L51.6,39 Q49.4,39 49,37 L48.3,32.6 Q48.3,32 48.6,32Z" fill="#150A20" stroke={art.pink} strokeWidth={1.1} />
          <Path d="M71.4,32 L62,32 Q61.6,32 61.7,32.6 L62.4,37 Q62.8,39 65,39 L68.4,39 Q70.6,39 71,37 L71.7,32.6 Q71.7,32 71.4,32Z" fill="#150A20" stroke={art.pink} strokeWidth={1.1} />
          <Path d="M58.2,32.8 Q60,31.6 61.8,32.8" stroke={art.pink} strokeWidth={1.1} fill="none" />
          <Path d="M50.5,37.5 L53.5,33 M63.5,37.5 L66.5,33" stroke={art.cyan} strokeWidth={1} strokeLinecap="round" opacity={0.8} />
        </G>
      );
    case 'cap': {
      const capC = luma(look.topColor) > 0.85 ? '#16101E' : look.topColor;
      const dark = clothShade(capC);
      return (
        <G>
          <Path d="M43.6,27.5 C43,13 50.5,7.8 60,7.8 C69.5,7.8 77,13 76.4,27.5Z" fill={capC} />
          <Path d="M62,8 C70,8.8 77,14 76.4,27.5 L68,27.5 C68,19 66,12 62,8Z" fill={dark} />
          <Path d="M41.5,27 Q60,21.6 78.5,27 Q79.6,31 60,30.6 Q40.4,31 41.5,27Z" fill={dark} />
          <Path d="M43,27.6 Q60,23.2 77,27.6" stroke={shade(capC, 0.25)} strokeWidth={0.9} fill="none" />
          <Circle cx={60} cy={8.2} r={1.4} fill={dark} />
          <Circle cx={60} cy={19} r={2.4} fill={capC === look.topColor && luma(capC) > 0.4 ? art.ink : art.pink} />
        </G>
      );
    }
    case 'headphones':
      return (
        <G>
          <Path d="M44.5,33 C42,4 78,4 75.5,33" stroke="#16101E" strokeWidth={2.8} fill="none" strokeLinecap="round" />
          <Path d="M47,20 C49,13 54,10 59,9.5" stroke="#3A2D4A" strokeWidth={1} fill="none" strokeLinecap="round" />
          <Rect x={40.2} y={29.5} width={7} height={12} rx={3.2} fill={art.pink} />
          <Rect x={72.8} y={29.5} width={7} height={12} rx={3.2} fill={art.pink} />
          <Rect x={41.5} y={31.5} width={2.2} height={8} rx={1.1} fill={art.pinkHi} />
          <Rect x={77} y={31.5} width={1.8} height={8} rx={0.9} fill={art.magenta} />
        </G>
      );
    case 'headband':
      return (
        <G>
          <Path d="M44.3,22.5 Q60,16.5 75.7,22.5 L75.9,27.2 Q60,21.2 44.1,27.2Z" fill={art.pink} />
          <Path d="M44.3,24.8 Q60,18.8 75.8,24.8" stroke={art.white} strokeWidth={0.9} fill="none" opacity={0.85} />
        </G>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// figure
// ---------------------------------------------------------------------------

type CharacterFigureProps = {
  look: AvatarLook;
  pose?: CharacterPose;
  x?: number;
  y?: number;
  scale?: number;
  flip?: boolean;
};

export const CharacterFigure = React.memo(function CharacterFigure({ look, pose = 'stand', x = 0, y = 0, scale = 1, flip = false }: CharacterFigureProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const g = GEO[look.body];
  const spec = POSES[pose];
  const skin = look.skin;
  const skinDark = shade(skin, -0.2);
  const hairDark = shade(look.hairColor, -0.3);
  const hairHi = shade(look.hairColor, luma(look.hairColor) < 0.2 ? 0.35 : 0.4);
  const transform = flip
    ? `translate(${x + 120 * scale},${y}) scale(${-scale},${scale})`
    : `translate(${x},${y}) scale(${scale})`;

  // --- joints ---------------------------------------------------------------
  const sA: Pt = [60 - g.sh + 2.6, 69];
  const sB: Pt = [60 + g.sh - 2.6, 69];
  const hA: Pt = [60 - g.hipX, 136];
  const hB: Pt = [60 + g.hipX, 136];
  const armJoints = (s: Pt, ap: ArmPose): [Pt, Pt, Pt] => {
    const e = add(s, ap.e);
    const h: Pt = ap.abs ? ap.h : add(e, ap.h);
    return [s, e, h];
  };
  const [aS, aE, aH] = armJoints(sA, spec.arms[0]);
  const [bS, bE, bH] = armJoints(sB, spec.arms[1]);
  const legJoints = (hip: Pt, lp: LegPose): [Pt, Pt, Pt] => {
    const k = add(hip, lp.k);
    return [hip, k, add(k, lp.a)];
  };
  const legs = [legJoints(hA, spec.legs[0]), legJoints(hB, spec.legs[1])];

  // --- clothing flags -------------------------------------------------------
  const top = look.top;
  const longSleeve = top === 'hoodie' || top === 'jacket';
  const shortSleeve = top === 'tee';
  const topC = look.topColor;
  const topDark = clothShade(topC);
  const botC = look.bottomColor;
  const botDark = clothShade(botC);
  const hideBun = look.accessory === 'cap';

  const renderLeg = (j: [Pt, Pt, Pt], lp: LegPose, i: number) => {
    const [hip, knee, ankle] = j;
    const b = look.bottom;
    const extra = b === 'joggers' ? 1.5 : b === 'leggings' ? 0.3 : 0;
    const legC = b === 'shorts' ? skin : botC;
    const legD = b === 'shorts' ? skinDark : botDark;
    const L = g.leg;
    const calf = lerp(knee, ankle, 0.3);
    const ground: Pt = lp.rot === 90 ? [ankle[0] - 9, ankle[1] + 6] : [ankle[0], ankle[1] + 11];
    const side = i ? 1 : -1;
    return (
      <G key={`leg${i}`}>
        <LimbChain pts={[hip, knee, calf, ankle]} radii={[L[0] + extra, L[1] + extra, L[2] + extra, L[3] + extra * 1.3]} fill={legC} dark={legD} />
        {b === 'shorts' ? (
          <LimbChain pts={[hip, lerp(hip, knee, 0.52)]} radii={[L[0] + 1.8, L[0] * 0.78 + 1.6]} fill={botC} dark={botDark} />
        ) : null}
        {b === 'joggers' ? (
          <>
            <Path d={capsule(lerp(knee, ankle, 0.84), lerp(knee, ankle, 0.97), L[3] + 2.4, L[3] + 2.4)} fill={botDark} />
            <Path
              d={`M${f(hip[0] + side * (L[0] - 0.5))},${f(hip[1] + 2)} L${f(knee[0] + side * (L[1] + 0.9))},${f(knee[1])} L${f(calf[0] + side * (L[2] + 0.9))},${f(calf[1])} L${f(lerp(knee, ankle, 0.82)[0] + side * (L[3] + 2.2))},${f(lerp(knee, ankle, 0.82)[1])}`}
              stroke={art.white}
              strokeWidth={1.1}
              strokeLinejoin="round"
              fill="none"
              opacity={0.8}
            />
          </>
        ) : null}
        <Sneaker x={ground[0]} y={ground[1]} dir={lp.dir} rot={lp.rot} color={look.shoeColor} />
      </G>
    );
  };

  const renderArm = (s: Pt, e: Pt, h: Pt, ap: ArmPose, side: number) => {
    const r = g.arm;
    const bicep = spec.flexArms ? 1.6 : 0;
    const sl = longSleeve ? 1 : 0;
    const armC = longSleeve ? topC : skin;
    const armD = longSleeve ? topDark : skinDark;
    const fore = lerp(e, h, 0.3);
    const mid = lerp(s, e, 0.5);
    return (
      <G>
        <LimbChain pts={[s, e, fore, h]} radii={[r[0] + bicep + sl, r[1] + sl, r[2] + sl, r[3] + sl * 1.3]} fill={armC} dark={armD} />
        {spec.flexArms ? (
          <Ellipse cx={f(mid[0] - side * 0.5)} cy={f(mid[1] - r[0] * 0.75)} rx={r[0] * 1.15} ry={r[0] * 0.85} fill={armC} />
        ) : null}
        {longSleeve ? <Path d={capsule(lerp(e, h, 0.8), lerp(e, h, 0.92), r[3] + 2, r[3] + 2)} fill={topDark} /> : null}
        {shortSleeve ? <LimbChain pts={[s, lerp(s, e, 0.42)]} radii={[r[0] + 1.3, r[0] + 0.9]} fill={topC} dark={topDark} /> : null}
        {spec.dumbbells ? <Dumbbell p={h} /> : null}
        <HandShape p={h} r={g.hand} kind={ap.hand} skin={skin} dark={skinDark} dir={side} />
      </G>
    );
  };

  const upper = `translate(0,${spec.dy})${spec.lean ? ` rotate(${spec.lean} 60 136)` : ''}`;
  const headT = spec.tilt ? `rotate(${spec.tilt} 60 56)` : undefined;

  return (
    <G transform={transform}>
      <Ellipse cx={60} cy={255.5} rx={26} ry={3.2} fill={art.ink} opacity={0.35} />
      {/* hair behind everything */}
      <G transform={upper}>
        <G transform={headT}>
          <HairBack style={look.hair} c={look.hairColor} dark={hairDark} hidden={hideBun} />
        </G>
      </G>

      <G transform={`translate(0,${spec.dy})`}>
        {renderLeg(legs[0], spec.legs[0], 0)}
        {renderLeg(legs[1], spec.legs[1], 1)}
        {/* pelvis / waistband */}
        <Path
          d={`M${f(60 - g.wh - 2)},118 L${f(60 + g.wh + 2)},118 C${f(60 + g.hh + 1.5)},126 ${f(60 + g.hh + 1.8)},136 ${f(60 + g.hh + 0.5)},146 L62,153 L58,153 L${f(60 - g.hh - 0.5)},146 C${f(60 - g.hh - 1.8)},136 ${f(60 - g.hh - 1.5)},126 ${f(60 - g.wh - 2)},118Z`}
          fill={botC}
        />
        <Path d={`M${f(60 + 2)},120 C${f(60 + g.hh)},126 ${f(60 + g.hh + 1.8)},136 ${f(60 + g.hh + 0.5)},146 L62,153Z`} fill={botDark} opacity={0.6} />
        <Path d={`M${f(60 - g.wh - 2)},119.5 L${f(60 + g.wh + 2)},119.5`} stroke={botDark} strokeWidth={3.2} />
      </G>

      <G transform={upper}>
        {top === 'hoodie' ? (
          <Path d={`M${60 - g.sh + 3},66 C${60 - g.sh + 1},49 ${60 + g.sh - 1},49 ${60 + g.sh - 3},66Z`} fill={topDark} />
        ) : null}
        {/* neck */}
        <Path d={`M${60 - g.neck},44 L${60 + g.neck},44 L${60 + g.neck + 0.6},${NECK_Y + 6} L${60 - g.neck - 0.6},${NECK_Y + 6}Z`} fill={skin} />
        <Path d={`M${60 - g.neck},50 Q60,56 ${60 + g.neck},50 L${60 + g.neck},46 L${60 - g.neck},46Z`} fill={skinDark} />
        {/* bare torso under clothes */}
        <Path d={garmentPath(g, { top: NECK_Y + 1, hem: 124, dip: 4 })} fill={skin} />
        {look.top === 'crop' && look.body === 'female' ? (
          <Path d="M60,104 L60,114" stroke={skinDark} strokeWidth={0.9} strokeLinecap="round" opacity={0.7} />
        ) : null}
        <TopGarment look={look} g={g} uid={uid} />

        {spec.armsOverHead ? null : renderArm(aS, aE, aH, spec.arms[0], 1)}
        {spec.armsOverHead ? null : renderArm(bS, bE, bH, spec.arms[1], -1)}

        <G transform={headT}>
          <Face look={look} expr={spec.expr} fx={spec.face} skinDark={skinDark} uid={uid} />
          <HairFront style={look.hair} c={look.hairColor} dark={hairDark} hi={hairHi} />
          <Accessory look={look} fx={spec.face} />
        </G>
        {spec.armsOverHead ? renderArm(aS, aE, aH, spec.arms[0], 1) : null}
        {spec.armsOverHead ? renderArm(bS, bE, bH, spec.arms[1], -1) : null}
      </G>
    </G>
  );
});

// ---------------------------------------------------------------------------
// wrappers
// ---------------------------------------------------------------------------

type CharacterProps = { look: AvatarLook; pose?: CharacterPose; height?: number; style?: StyleProp<ViewStyle> };

export function Character({ look, pose = 'stand', height = 300, style }: CharacterProps) {
  const width = (height * 120) / 260;
  return (
    <View style={[{ width, height }, style]}>
      <Svg width={width} height={height} viewBox="0 0 120 260">
        <CharacterFigure look={look} pose={pose} />
      </Svg>
    </View>
  );
}

type PortraitProps = { look: AvatarLook; size?: number; ring?: string | false; bg?: string; style?: StyleProp<ViewStyle> };

export function Portrait({ look, size = 56, ring, bg, style }: PortraitProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const ringColor = ring === false ? null : ring ?? art.pink;
  // ~2.5px ring regardless of rendered size, expressed in the 100-unit viewBox
  const ringW = ringColor ? Math.min(9, (2.5 * 100) / size) : 0;
  const gap = ringColor ? Math.min(4, (1.5 * 100) / size) : 0;
  const r = 50 - ringW - gap;
  const clip = `${uid}pclip`;
  const grad = `${uid}pbg`;
  const s = 1.3;
  return (
    <View style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          <ClipPath id={clip}>
            <Circle cx={50} cy={50} r={r} />
          </ClipPath>
          <RadialGradient id={grad} cx="50%" cy="38%" r="65%">
            <Stop offset="0" stopColor={bg ?? art.dusk} />
            <Stop offset="1" stopColor={bg ? shade(bg, -0.35) : art.night2} />
          </RadialGradient>
          <LinearGradient id={`${grad}rim`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={art.pink} stopOpacity={0} />
            <Stop offset="1" stopColor={art.pink} stopOpacity={0.55} />
          </LinearGradient>
        </Defs>
        {ringColor ? <Circle cx={50} cy={50} r={50 - ringW / 2} stroke={ringColor} strokeWidth={ringW} fill="none" /> : null}
        <G clipPath={`url(#${clip})`}>
          <Rect x={0} y={0} width={100} height={100} fill={`url(#${grad})`} />
          <CharacterFigure look={look} pose="stand" x={50 - 60 * s} y={43 - 33 * s} scale={s} />
        </G>
        <Circle cx={50} cy={50} r={r - 0.8} stroke={`url(#${grad}rim)`} strokeWidth={1.6} fill="none" />
      </Svg>
    </View>
  );
}

// ---------------------------------------------------------------------------
// demo looks
// ---------------------------------------------------------------------------

export const demoLooks: AvatarLook[] = [
  { body: 'female', skin: skinTones[1], hair: 'ponytail', hairColor: hairColors[5], top: 'crop', topColor: '#16101E', bottom: 'leggings', bottomColor: '#16101E', shoeColor: art.pink, accessory: 'shades' },
  { body: 'male', skin: skinTones[4], hair: 'short', hairColor: hairColors[0], top: 'hoodie', topColor: art.purple, bottom: 'joggers', bottomColor: '#1C1428', shoeColor: art.cyan, accessory: 'headphones' },
  { body: 'female', skin: skinTones[5], hair: 'afro', hairColor: hairColors[0], top: 'tank', topColor: art.cyan, bottom: 'shorts', bottomColor: '#16101E', shoeColor: art.white, accessory: 'headband' },
  { body: 'male', skin: skinTones[0], hair: 'buzz', hairColor: hairColors[4], top: 'tee', topColor: art.white, bottom: 'shorts', bottomColor: art.pink, shoeColor: '#16101E', accessory: 'cap' },
  { body: 'female', skin: skinTones[0], hair: 'long', hairColor: hairColors[4], top: 'jacket', topColor: art.pink, bottom: 'leggings', bottomColor: '#16101E', shoeColor: art.white, accessory: 'none' },
  { body: 'male', skin: skinTones[3], hair: 'curly', hairColor: hairColors[1], top: 'tank', topColor: art.orange, bottom: 'joggers', bottomColor: '#2A2036', shoeColor: art.yellow, accessory: 'none' },
  { body: 'female', skin: skinTones[2], hair: 'bun', hairColor: hairColors[2], top: 'tee', topColor: art.purple, bottom: 'shorts', bottomColor: art.cyan, shoeColor: art.pink, accessory: 'headphones' },
  { body: 'male', skin: skinTones[5], hair: 'afro', hairColor: hairColors[6], top: 'jacket', topColor: '#16101E', bottom: 'joggers', bottomColor: '#16101E', shoeColor: art.pink, accessory: 'shades' },
  { body: 'female', skin: skinTones[3], hair: 'bob', hairColor: hairColors[0], top: 'hoodie', topColor: art.pink, bottom: 'joggers', bottomColor: '#3A0F4F', shoeColor: art.white, accessory: 'none' },
  { body: 'male', skin: skinTones[2], hair: 'short', hairColor: hairColors[3], top: 'crop', topColor: art.green, bottom: 'shorts', bottomColor: '#16101E', shoeColor: art.orange, accessory: 'cap' },
];
