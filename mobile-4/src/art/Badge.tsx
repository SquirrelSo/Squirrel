import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { art } from './palette';
import type { BadgeKind } from '@/types';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return '#' + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

function useUid(): string {
  return React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
}

type Pt = [number, number];
const f = (n: number) => n.toFixed(2);

function roundedPoly(pts: Pt[], rr: number): string {
  const n = pts.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const l0 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]);
    const l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const r0 = Math.min(rr, l0 / 2);
    const r2 = Math.min(rr, l2 / 2);
    const a: Pt = [p1[0] + ((p0[0] - p1[0]) / l0) * r0, p1[1] + ((p0[1] - p1[1]) / l0) * r0];
    const b: Pt = [p1[0] + ((p2[0] - p1[0]) / l2) * r2, p1[1] + ((p2[1] - p1[1]) / l2) * r2];
    d += `${i === 0 ? 'M' : 'L'}${f(a[0])} ${f(a[1])} Q${f(p1[0])} ${f(p1[1])} ${f(b[0])} ${f(b[1])} `;
  }
  return d + 'Z';
}

function regular(cx: number, cy: number, r: number, n: number, startDeg: number, sx = 1, sy = 1): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((startDeg + (360 / n) * i) * Math.PI) / 180;
    pts.push([cx + Math.cos(a) * r * sx, cy + Math.sin(a) * r * sy]);
  }
  return pts;
}

function polar(cx: number, cy: number, fn: (a: number) => number, steps = 120): string {
  let d = '';
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r = fn(a);
    d += `${i === 0 ? 'M' : 'L'}${f(cx + Math.cos(a) * r)} ${f(cy + Math.sin(a) * r)} `;
  }
  return d + 'Z';
}

function circ(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
}

function star(cx: number, cy: number, R: number, r: number, n = 5, rot = -90): string {
  const pts: Pt[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = ((rot + (180 / n) * i) * Math.PI) / 180;
    const rad = i % 2 === 0 ? R : r;
    pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
  }
  return 'M' + pts.map((p) => `${f(p[0])} ${f(p[1])}`).join(' L') + ' Z';
}

function heart(cx: number, cy: number, s: number): string {
  const p = (x: number, y: number) => `${f(cx + x * s)} ${f(cy + y * s)}`;
  return `M${p(0, 0.95)} C${p(-1.3, 0.1)} ${p(-1.15, -1)} ${p(-0.52, -1)} C${p(-0.2, -1)} ${p(0, -0.75)} ${p(0, -0.5)} C${p(0, -0.75)} ${p(0.2, -1)} ${p(0.52, -1)} C${p(1.15, -1)} ${p(1.3, 0.1)} ${p(0, 0.95)} Z`;
}

function leaves(cx: number, cy: number, r: number, fromDeg: number, toDeg: number, count: number, len: number, wid: number): string {
  let d = '';
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const deg = fromDeg + (toDeg - fromDeg) * t;
    const a = (deg * Math.PI) / 180;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    // tangent direction pointing toward "to"
    const dir = Math.sign(toDeg - fromDeg) || 1;
    const tx = -Math.sin(a) * dir;
    const ty = Math.cos(a) * dir;
    // leaf leans outward / inward alternately
    const side = i % 2 === 0 ? 1 : -1;
    const ox = Math.cos(a) * side;
    const oy = Math.sin(a) * side;
    const ux = tx * 0.75 + ox * 0.65;
    const uy = ty * 0.75 + oy * 0.65;
    const ul = Math.hypot(ux, uy);
    const vx = ux / ul;
    const vy = uy / ul;
    const nx = -vy;
    const ny = vx;
    const bx = px + vx * len;
    const by = py + vy * len;
    const mx = px + vx * len * 0.5;
    const my = py + vy * len * 0.5;
    d += `M${f(px)} ${f(py)} Q${f(mx + nx * wid)} ${f(my + ny * wid)} ${f(bx)} ${f(by)} Q${f(mx - nx * wid)} ${f(my - ny * wid)} ${f(px)} ${f(py)} Z `;
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* shapes                                                              */
/* ------------------------------------------------------------------ */

type ShapeKind = 'hex' | 'hexTall' | 'shield' | 'circle' | 'diamond' | 'octagon' | 'stamp' | 'rosette' | 'pentagon' | 'star8' | 'squircle' | 'medal';

const CX = 60;

function shapePath(kind: ShapeKind, cy: number, r: number): string {
  switch (kind) {
    case 'hex':
      return roundedPoly(regular(CX, cy, r, 6, 0, 1.02, 0.98), r * 0.14);
    case 'hexTall':
      return roundedPoly(regular(CX, cy, r, 6, -90, 0.98, 1.04), r * 0.14);
    case 'octagon':
      return roundedPoly(regular(CX, cy, r, 8, 22.5), r * 0.12);
    case 'diamond':
      return roundedPoly(regular(CX, cy, r * 1.08, 4, -90, 0.95, 1.05), r * 0.18);
    case 'pentagon':
      return roundedPoly(regular(CX, cy + r * 0.05, r * 1.04, 5, -90), r * 0.16);
    case 'star8': {
      const pts: Pt[] = [];
      for (let i = 0; i < 16; i++) {
        const a = ((-90 + 22.5 * i) * Math.PI) / 180;
        const rad = i % 2 === 0 ? r * 1.05 : r * 0.84;
        pts.push([CX + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
      }
      return roundedPoly(pts, r * 0.09);
    }
    case 'shield': {
      const k = r / 44;
      const p = (x: number, y: number): Pt => [CX + x * k, cy + y * k];
      return roundedPoly([p(-40, -38), p(0, -46), p(40, -38), p(40, 4), p(0, 48), p(-40, 4)], r * 0.16);
    }
    case 'squircle':
      return roundedPoly(
        [
          [CX - r * 0.9, cy - r * 0.9],
          [CX + r * 0.9, cy - r * 0.9],
          [CX + r * 0.9, cy + r * 0.9],
          [CX - r * 0.9, cy + r * 0.9],
        ],
        r * 0.42,
      );
    case 'stamp':
      return polar(CX, cy, (a) => r * (0.97 + 0.035 * Math.cos(a * 18)), 144);
    case 'rosette':
      return polar(CX, cy, (a) => r * (0.94 + 0.07 * Math.cos(a * 8 + Math.PI / 2)), 128);
    case 'circle':
    case 'medal':
    default:
      return circ(CX, cy, r);
  }
}

/* ------------------------------------------------------------------ */
/* badge definitions                                                   */
/* ------------------------------------------------------------------ */

type EmblemColors = { main: string; detail: string; deep: string };

type BadgeDef = {
  shape: ShapeKind;
  color: string;
  cy?: number;
  R?: number;
  emblem: (c: EmblemColors, cy: number) => React.ReactElement;
};

const BADGES: Record<BadgeKind, BadgeDef> = {
  'night-owl': {
    shape: 'shield',
    color: art.purple,
    emblem: ({ main, detail }, cy) => (
      <G transform={`translate(0 ${cy - 56})`}>
        <Path d="M66 34 a22 22 0 1 0 14 36 a18 18 0 1 1 -14 -36 Z" fill={main} />
        <Path d={`${star(44, 42, 4.5, 1.8, 4, 0)} ${star(50, 58, 3, 1.2, 4, 0)} ${star(38, 66, 3.5, 1.4, 4, 0)}`} fill={detail} />
      </G>
    ),
  },
  'park-regular': {
    shape: 'circle',
    color: art.green,
    emblem: ({ main, detail }, cy) => (
      <G transform={`translate(0 ${cy - 56})`}>
        <Path d={`${circ(60, 44, 13)} ${circ(49, 54, 10)} ${circ(71, 54, 10)}`} fill={main} />
        <Path d="M58 58 H62 V76 H58 Z" fill={main} />
        <Path d="M34 76 Q60 70 86 76" stroke={detail} strokeWidth={3} strokeLinecap="round" fill="none" />
        <Path d="M36 80 Q60 75 84 80" stroke={main} strokeWidth={2} strokeDasharray="3 4" strokeLinecap="round" fill="none" opacity={0.7} />
      </G>
    ),
  },
  'founding-squirrel': {
    shape: 'rosette',
    color: art.lime,
    emblem: ({ main, detail }, cy) => (
      <G transform={`translate(0 ${cy - 56})`}>
        <Path d="M44 46 C44 38 52 34 60 34 C68 34 76 38 76 46 Z" fill={main} />
        <Path d="M60 34 C60 30 62 28 65 27" stroke={main} strokeWidth={3} strokeLinecap="round" fill="none" />
        <Path d="M46 48 H74 C74 64 68 76 60 78 C52 76 46 64 46 48 Z" fill={detail} />
        <Path d={star(60, 60, 8, 3.4)} fill={main} />
      </G>
    ),
  },
  city: {
    shape: 'hex',
    color: art.pink,
    emblem: ({ main, detail }, cy) => (
      <G transform={`translate(0 ${cy - 56})`}>
        <Path d="M38 76 V60 H44 V52 H50 V64 H54 V42 H59 V36 H61 V42 H66 V58 H70 V50 H77 V62 H82 V76 Z" fill={main} />
        <Path d="M56 47 h2.5 v2.5 h-2.5 Z M61.5 47 h2.5 v2.5 h-2.5 Z M56 53 h2.5 v2.5 h-2.5 Z M61.5 59 h2.5 v2.5 h-2.5 Z M56 65 h2.5 v2.5 h-2.5 Z M46 57 h2.5 v2.5 h-2.5 Z M72 55 h2.5 v2.5 h-2.5 Z M72 61 h2.5 v2.5 h-2.5 Z M40.5 66 h2.5 v2.5 h-2.5 Z M78 67 h2.5 v2.5 h-2.5 Z" fill={detail} />
        <Path d="M44 34 a7 7 0 1 0 7 9 a5.5 5.5 0 1 1 -7 -9 Z" fill={main} />
      </G>
    ),
  },
  streak: {
    shape: 'shield',
    color: art.orange,
    emblem: ({ main, detail }, cy) => (
      <G transform={`translate(0 ${cy - 56})`}>
        <Path d="M60 32 C63 42 76 47 76 62 C76 72 69 79 60 79 C51 79 44 72 44 62 C44 54 49 50 51 44 C53 50 55 52 57 52 C55 44 56 38 60 32 Z" fill={main} />
        <Path d="M60 55 C62 60 68 63 68 69 C68 74 64 77 60 77 C56 77 52 74 52 69 C52 65 55 63 56 59 C57 62 58 63 59.5 63 C58.5 60 58.5 57.5 60 55 Z" fill={detail} />
      </G>
    ),
  },
  'early-bird': {
    shape: 'circle',
    color: art.amber,
    emblem: ({ main, detail }, cy) => (
      <G transform={`translate(0 ${cy - 56})`}>
        <Path d="M43 68 A17 17 0 0 1 77 68 Z" fill={main} />
        <Path d="M49 62 H71 M46 66 H74" stroke={detail} strokeWidth={2} strokeLinecap="round" />
        <Path d="M58.5 45 L60 40 L61.5 45 Z M44.5 51 L41 47 L46.8 48.6 Z M75.5 51 L79 47 L73.2 48.6 Z M38 60 L33 59 L38.5 57 Z M82 60 L87 59 L81.5 57 Z" fill={main} stroke={main} strokeWidth={2} strokeLinejoin="round" />
        <Path d="M36 71 H84" stroke={main} strokeWidth={3.5} strokeLinecap="round" />
        <Path d="M40 76 H56 M64 76 H80" stroke={main} strokeWidth={2.2} strokeLinecap="round" opacity={0.7} />
        <Path d="M60 36 Q64 31 68 35 Q72 31 76 36 Q72 34 68 38 Q64 34 60 36 Z" fill={main} stroke={main} strokeWidth={1.6} strokeLinejoin="round" />
      </G>
    ),
  },
  'steps-10k': {
    shape: 'diamond',
    color: art.cyan,
    emblem: ({ main }, cy) => {
      const foot =
        'M-6 -3 C-6 -11 6 -11 6 -3 C6 4 3 8 3 13 C3 17 -3 17 -3 13 C-3 8 -6 4 -6 -3 Z ' +
        `${circ(-5, -14, 2)} ${circ(-1.3, -16.3, 2.3)} ${circ(2.6, -16, 2)} ${circ(5.6, -13.4, 1.7)}`;
      return (
        <G transform={`translate(0 ${cy - 56})`}>
          <G transform="translate(51 64) rotate(-14)">
            <Path d={foot} fill={main} />
          </G>
          <G transform="translate(70 48) rotate(14) scale(-1 1)">
            <Path d={foot} fill={main} />
          </G>
        </G>
      );
    },
  },
  crew: {
    shape: 'octagon',
    color: art.purple,
    emblem: ({ main, detail }, cy) => (
      <G transform={`translate(0 ${cy - 56})`}>
        <Path d={`${circ(43, 51, 6)} M31 73 C31 61 55 61 55 73 Z ${circ(77, 51, 6)} M65 73 C65 61 89 61 89 73 Z`} fill={detail} />
        <Path d={`${circ(60, 46, 8.5)} M44 75 C44 58 76 58 76 75 Z`} fill={main} />
      </G>
    ),
  },
  'first-run': {
    shape: 'stamp',
    color: art.coral,
    emblem: ({ main, detail }, cy) => (
      <G transform={`translate(0 ${cy - 56})`}>
        <Path d="M42 66 L42 52 C42 47.5 46 45.5 50 47.5 L55 50 C58 45.5 61 43.5 65 43.5 L68 44.5 C71 49.5 77 53 82 55 C86 57 87 61 87 66 Z" fill={main} />
        <Path d="M40 66 H88 C89 70 87 74 83 74 H44 C40 74 39 70 40 66 Z" fill={detail} />
        <Path d="M57 52 L61 50 M59.5 55.5 L63.5 53.5 M62.5 58.5 L66.5 56.5" stroke={detail} strokeWidth={2} strokeLinecap="round" />
        <Path d="M28 54 H37 M25 60 H37 M29 66 H36" stroke={main} strokeWidth={2.5} strokeLinecap="round" opacity={0.75} />
      </G>
    ),
  },
  hydration: {
    shape: 'hexTall',
    color: '#3D9BFF',
    emblem: ({ main, detail }, cy) => (
      <G transform={`translate(0 ${cy - 56})`}>
        <Path d="M60 32 C66 44 77 52 77 63 C77 73 69 80 60 80 C51 80 43 73 43 63 C43 52 54 44 60 32 Z" fill={main} />
        <Path d="M45 66 C50 62 55 70 60 66 C65 62 70 70 75 66 C74 74 68 78 60 78 C52 78 46 74 45 66 Z" fill={detail} />
        <Path d="M51 60 C51 54 54 50 56 47" stroke={detail} strokeWidth={2.6} strokeLinecap="round" fill="none" opacity={0.6} />
      </G>
    ),
  },
  yoga: {
    shape: 'rosette',
    color: art.violet,
    emblem: ({ main, detail }, cy) => (
      <G transform={`translate(0 ${cy - 56})`}>
        <Path d="M60 71 C49 71 38 67 34 58 C45 55 54 62 60 71 Z M60 71 C71 71 82 67 86 58 C75 55 66 62 60 71 Z" fill={detail} />
        <Path d="M60 70 C51 67 45 59 45 47 C54 50 59 58 60 70 Z M60 70 C69 67 75 59 75 47 C66 50 61 58 60 70 Z" fill={main} />
        <Path d="M60 36 C67 45 67 60 60 70 C53 60 53 45 60 36 Z" fill={main} />
        <Path d="M40 76 Q60 81 80 76" stroke={main} strokeWidth={3} strokeLinecap="round" fill="none" />
      </G>
    ),
  },
  lifter: {
    shape: 'pentagon',
    color: art.yellow,
    emblem: ({ main, detail }, cy) => (
      <G transform={`translate(0 ${cy - 56}) rotate(-22 60 57)`}>
        <Path d="M38 54.5 H82 V59.5 H38 Z" fill={detail} />
        <Path d="M44 42 h7 c1.5 0 2 0.5 2 2 v26 c0 1.5 -0.5 2 -2 2 h-7 c-1.5 0 -2 -0.5 -2 -2 v-26 c0 -1.5 0.5 -2 2 -2 Z M69 42 h7 c1.5 0 2 0.5 2 2 v26 c0 1.5 -0.5 2 -2 2 h-7 c-1.5 0 -2 -0.5 -2 -2 v-26 c0 -1.5 0.5 -2 2 -2 Z" fill={main} />
        <Path d="M36 47 h5 c1 0 1.5 0.5 1.5 1.5 v17 c0 1 -0.5 1.5 -1.5 1.5 h-5 c-1 0 -1.5 -0.5 -1.5 -1.5 v-17 c0 -1 0.5 -1.5 1.5 -1.5 Z M79 47 h5 c1 0 1.5 0.5 1.5 1.5 v17 c0 1 -0.5 1.5 -1.5 1.5 h-5 c-1 0 -1.5 -0.5 -1.5 -1.5 v-17 c0 -1 0.5 -1.5 1.5 -1.5 Z" fill={main} />
      </G>
    ),
  },
  explorer: {
    shape: 'star8',
    color: art.green,
    emblem: ({ main, detail }, cy) => (
      <G transform={`translate(0 ${cy - 56})`}>
        <Path d="M38 76 C44 70 50 74 56 71" stroke={main} strokeWidth={2.4} strokeDasharray="3 3" strokeLinecap="round" fill="none" />
        <Path d="M62 32 C71 32 78 39 78 48 C78 60 62 76 62 76 C62 76 46 60 46 48 C46 39 53 32 62 32 Z" fill={main} />
        <Path d={circ(62, 48, 6.5)} fill={detail} />
        <Path d="M62 44 L63.5 48 L62 52 L60.5 48 Z" fill={main} />
      </G>
    ),
  },
  social: {
    shape: 'squircle',
    color: art.pinkHi,
    emblem: ({ main, detail }, cy) => (
      <G transform={`translate(0 ${cy - 56})`}>
        <Path d="M40 38 H80 C83.5 38 86 40.5 86 44 V64 C86 67.5 83.5 70 80 70 H59 L47 79 L49 70 H40 C36.5 70 34 67.5 34 64 V44 C34 40.5 36.5 38 40 38 Z" fill={main} />
        <Path d={heart(60, 55, 11)} fill={detail} />
      </G>
    ),
  },
  'half-marathon': {
    shape: 'medal',
    color: '#FFC83D',
    cy: 50,
    R: 40,
    emblem: ({ main, detail }, cy) => (
      <G>
        <Path d={`M${f(60 + Math.cos(2.06) * 25.5)} ${f(cy + Math.sin(2.06) * 25.5)} A25.5 25.5 0 0 1 ${f(60 + Math.cos(4.36) * 25.5)} ${f(cy + Math.sin(4.36) * 25.5)} M${f(60 + Math.cos(1.08) * 25.5)} ${f(cy + Math.sin(1.08) * 25.5)} A25.5 25.5 0 0 0 ${f(60 + Math.cos(-1.22) * 25.5)} ${f(cy + Math.sin(-1.22) * 25.5)}`} stroke={main} strokeWidth={2} fill="none" strokeLinecap="round" />
        <Path d={leaves(60, cy, 25.5, 118, 250, 6, 11, 3.6)} fill={main} />
        <Path d={leaves(60, cy, 25.5, 62, -70, 6, 11, 3.6)} fill={main} />
        <Path d={star(60, cy - 1, 14, 6)} fill={main} />
        <Path d={circ(60, cy - 1, 3)} fill={detail} />
      </G>
    ),
  },
};

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */

const INK = '#140A20';

export const BadgeArt = React.memo(function BadgeArt(props: {
  kind: BadgeKind;
  size?: number;
  locked?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { kind, size = 96, locked = false, style } = props;
  const uid = useUid();
  const def = BADGES[kind] ?? BADGES.city;
  const cy = def.cy ?? 56;
  const R = def.R ?? 46;
  const col = locked ? '#6F6780' : def.color;
  const pinkish = !locked && (def.color === art.pink || def.color === art.pinkHi || def.color === art.coral);
  const rim = locked ? '#A69EB4' : pinkish ? art.cyan : art.pink;

  const outer = shapePath(def.shape, cy, R);
  const inner = shapePath(def.shape, cy, R - 9);

  const colors: EmblemColors = locked
    ? { main: '#CFC8D9', detail: '#6F6780', deep: '#2A2433' }
    : { main: '#FFF8FC', detail: mix(col, INK, 0.08), deep: mix(col, '#1C0C2E', 0.7) };
  if (!locked && (kind === 'streak' || kind === 'first-run')) colors.detail = art.yellow;
  if (!locked && kind === 'crew') colors.detail = art.violet;
  if (!locked && kind === 'social') colors.detail = art.pink;
  if (!locked && kind === 'half-marathon') colors.detail = art.pink;
  if (!locked && kind === 'hydration') colors.detail = art.cyan;
  if (!locked && kind === 'yoga') colors.detail = art.pinkHi;
  const shadowColors: EmblemColors = { main: colors.deep, detail: colors.deep, deep: colors.deep };

  const ribbon = def.shape === 'medal';

  return (
    <Svg width={size} height={size} viewBox="0 0 120 120" style={style}>
      <Defs>
        <RadialGradient id={`${uid}sh`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#000000" stopOpacity={0.5} />
          <Stop offset="1" stopColor="#000000" stopOpacity={0} />
        </RadialGradient>
        <LinearGradient id={`${uid}rim`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={mix(col, '#FFFFFF', 0.7)} />
          <Stop offset="0.3" stopColor={col} />
          <Stop offset="0.55" stopColor={mix(col, INK, 0.5)} />
          <Stop offset="0.78" stopColor={col} />
          <Stop offset="1" stopColor={mix(col, '#FFFFFF', 0.45)} />
        </LinearGradient>
        <RadialGradient id={`${uid}face`} cx="0.4" cy="0.3" r="0.8">
          <Stop offset="0" stopColor={mix(col, '#FFFFFF', 0.12)} />
          <Stop offset="0.5" stopColor={mix(col, '#2A0B45', 0.35)} />
          <Stop offset="1" stopColor={mix(col, '#1C0C2E', 0.72)} />
        </RadialGradient>
        <ClipPath id={`${uid}co`}>
          <Path d={outer} />
        </ClipPath>
        <ClipPath id={`${uid}ci`}>
          <Path d={inner} />
        </ClipPath>
      </Defs>

      <G opacity={locked ? 0.78 : 1}>
        <Ellipse cx={60} cy={110} rx={36} ry={6} fill={`url(#${uid}sh)`} />

        {ribbon ? (
          <G>
            <Path d="M46 80 L36 112 L44 107 L51 113 L60 84 Z" fill={locked ? '#58506A' : art.pink} stroke={INK} strokeWidth={2} strokeLinejoin="round" />
            <Path d="M74 80 L84 112 L76 107 L69 113 L60 84 Z" fill={locked ? '#4A4359' : art.cyan} stroke={INK} strokeWidth={2} strokeLinejoin="round" />
            <Path d="M46 80 L42 93 L50 96 L54 83 Z M74 80 L78 93 L70 96 L66 83 Z" fill="#000000" opacity={0.25} />
          </G>
        ) : null}

        {/* glow halo */}
        {!locked ? <Path d={outer} fill="none" stroke={col} strokeOpacity={0.18} strokeWidth={9} strokeLinejoin="round" /> : null}

        {/* metallic rim */}
        <Path d={outer} fill={`url(#${uid}rim)`} />
        <G clipPath={`url(#${uid}co)`}>
          <Path d={outer} transform="translate(2.2 2.2)" fill="none" stroke={rim} strokeWidth={3.6} strokeLinejoin="round" />
          <Path d={outer} transform="translate(-2 -2)" fill="none" stroke="#FFFFFF" strokeOpacity={0.5} strokeWidth={3} strokeLinejoin="round" />
        </G>
        <Path d={outer} fill="none" stroke={INK} strokeWidth={2.5} strokeLinejoin="round" />

        {/* inner face */}
        <Path d={inner} fill={`url(#${uid}face)`} />
        <G clipPath={`url(#${uid}ci)`}>
          <Path d={inner} transform="translate(0 3)" fill="none" stroke="#000000" strokeOpacity={0.35} strokeWidth={6} strokeLinejoin="round" />
          <Ellipse cx={52} cy={cy - R * 0.62} rx={R * 0.95} ry={R * 0.5} fill="#FFFFFF" opacity={0.1} />
          <G transform="translate(0 2.5)">{def.emblem(shadowColors, cy)}</G>
          {def.emblem(colors, cy)}
        </G>
        <Path d={inner} fill="none" stroke={mix(col, INK, 0.6)} strokeWidth={1.6} strokeLinejoin="round" />

        {/* sparkle */}
        {!locked ? (
          <Path
            d={`M${CX - R * 0.62} ${cy - R * 0.72} l1.6 4.4 l4.4 1.6 l-4.4 1.6 l-1.6 4.4 l-1.6 -4.4 l-4.4 -1.6 l4.4 -1.6 Z`}
            fill="#FFFFFF"
          />
        ) : null}
      </G>

      {locked ? (
        <G>
          <Path d="M81 90 V83 C81 76 95 76 95 83 V90" fill="none" stroke={INK} strokeWidth={7} strokeLinecap="round" />
          <Path d="M81 90 V83 C81 76 95 76 95 83 V90" fill="none" stroke="#BDB5CA" strokeWidth={3.5} strokeLinecap="round" />
          <Rect x={75} y={87} width={26} height={21} rx={5} fill="#3B3448" stroke={INK} strokeWidth={2.2} />
          <Rect x={77} y={89} width={22} height={4} rx={2} fill="#FFFFFF" opacity={0.18} />
          <Circle cx={88} cy={96} r={2.8} fill="#15101C" />
          <Path d="M86.8 97 h2.4 l0.6 5 h-3.6 Z" fill="#15101C" />
        </G>
      ) : null}
    </Svg>
  );
});

export default BadgeArt;
