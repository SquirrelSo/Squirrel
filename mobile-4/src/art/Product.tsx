import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { art } from './palette';
import type { ProductKind } from '@/types';

/* ------------------------------------------------------------------ */
/* colour helpers                                                      */
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
  const out = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return '#' + out.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function hue(hex: string): { h: number; s: number } {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: d / (1 - Math.abs(max + min - 1) || 1) };
}

/** pink rim unless the body is itself pink/red, then cyan */
function rimFor(color: string): string {
  const { h, s } = hue(color);
  if (s > 0.25 && (h > 285 || h < 20)) return art.cyan;
  return art.pink;
}

function useUid(): string {
  return React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
}

/* ------------------------------------------------------------------ */
/* shading primitive                                                   */
/* ------------------------------------------------------------------ */

const INK = '#150A22';
const SHADOW_TINT = '#2A0B45';

type Tone = { fill: string; base: string; outline: string; shade: string; hi: string; rim: string; gradId: string };

function makeTone(base: string, rim: string, gradId: string): Tone {
  return {
    fill: `url(#${gradId})`,
    base,
    outline: mix(base, INK, 0.78),
    shade: mix(base, SHADOW_TINT, 0.42),
    hi: mix(base, '#FFFFFF', 0.62),
    rim,
    gradId,
  };
}

function ToneGradient({ t }: { t: Tone }) {
  return (
    <LinearGradient id={t.gradId} x1="0" y1="0" x2="0.35" y2="1">
      <Stop offset="0" stopColor={mix(t.base, '#FFFFFF', 0.16)} />
      <Stop offset="0.55" stopColor={t.base} />
      <Stop offset="1" stopColor={mix(t.base, SHADOW_TINT, 0.16)} />
    </LinearGradient>
  );
}

type PieceProps = {
  id: string;
  d: string;
  t: Tone;
  /** scale of the cel-shade bands (small parts use < 1) */
  s?: number;
  evenOdd?: boolean;
  rim?: boolean;
  children?: React.ReactNode;
};

/** A flat shape with 3-tone cel shading, top-left highlight, bottom-right rim light and ink outline. */
function Piece({ id, d, t, s = 1, evenOdd, rim = true, children }: PieceProps) {
  const rule = evenOdd ? 'evenodd' : 'nonzero';
  return (
    <G>
      <Defs>
        <ClipPath id={id}>
          <Path d={d} fillRule={rule} clipRule={rule} />
        </ClipPath>
      </Defs>
      <Path d={d} fill={t.fill} fillRule={rule} />
      <G clipPath={`url(#${id})`}>
        <Path
          d={d}
          transform={`translate(${7 * s} ${6 * s})`}
          fill="none"
          stroke={t.shade}
          strokeOpacity={0.75}
          strokeWidth={13 * s}
          strokeLinejoin="round"
        />
        <Path
          d={d}
          transform={`translate(${-3 * s} ${-3 * s})`}
          fill="none"
          stroke={t.hi}
          strokeOpacity={0.5}
          strokeWidth={6 * s}
          strokeLinejoin="round"
        />
        {children}
        {rim ? <Path d={d} transform="translate(2 2)" fill="none" stroke={t.rim} strokeWidth={3.4} strokeLinejoin="round" /> : null}
      </G>
      <Path d={d} fill="none" stroke={t.outline} strokeWidth={2.3} strokeLinejoin="round" strokeLinecap="round" />
    </G>
  );
}

function Seam({ d, color, w = 1.5, o = 0.6, dash }: { d: string; color: string; w?: number; o?: number; dash?: string }) {
  return (
    <Path
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={w}
      strokeOpacity={o}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={dash}
    />
  );
}

/** outlined cord (drawstrings, laces, straps) */
function Cord({ d, color, outline, w = 2.4 }: { d: string; color: string; outline: string; w?: number }) {
  return (
    <G>
      <Path d={d} fill="none" stroke={outline} strokeWidth={w + 2.2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d={d} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" />
    </G>
  );
}

/** squirrel-tail swoosh brand mark in a 20x20 box */
function tailMark(x: number, y: number, s: number): string {
  const p = (px: number, py: number) => `${(x + px * s).toFixed(1)} ${(y + py * s).toFixed(1)}`;
  return (
    `M${p(4, 19)} C${p(1, 13)} ${p(3, 5)} ${p(10, 3)} C${p(15, 1.5)} ${p(19.5, 5)} ${p(17.5, 10)} ` +
    `C${p(16.5, 12.5)} ${p(13, 12.5)} ${p(12.8, 10)} C${p(14.6, 9)} ${p(14, 6.2)} ${p(11, 7)} ` +
    `C${p(7, 8)} ${p(6.5, 13)} ${p(9, 19)} Z`
  );
}

function circ(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
}

function ell(cx: number, cy: number, rx: number, ry: number): string {
  return `M${cx - rx} ${cy} a${rx} ${ry} 0 1 0 ${2 * rx} 0 a${rx} ${ry} 0 1 0 ${-2 * rx} 0 Z`;
}

/* ------------------------------------------------------------------ */
/* defaults                                                            */
/* ------------------------------------------------------------------ */

export const productDefaults: Record<ProductKind, { color: string; accent: string }> = {
  hoodie: { color: art.purple, accent: art.pink },
  tee: { color: art.pink, accent: art.cyan },
  tank: { color: art.cyan, accent: art.pink },
  jacket: { color: '#2E2658', accent: art.pink },
  joggers: { color: '#3A3160', accent: art.pink },
  shorts: { color: art.orange, accent: art.pink },
  shoes: { color: art.pink, accent: art.cyan },
  hightops: { color: art.purple, accent: art.yellow },
  cap: { color: art.yellow, accent: art.pink },
  beanie: { color: art.coral, accent: art.yellow },
  headband: { color: art.cyan, accent: art.pink },
  bag: { color: art.violet, accent: art.pink },
  backpack: { color: art.green, accent: art.pink },
  bottle: { color: art.violet, accent: art.pink },
  sunglasses: { color: art.pink, accent: art.cyan },
  watch: { color: art.purple, accent: art.pink },
  earbuds: { color: art.cloud, accent: art.pink },
  socks: { color: art.cloud, accent: art.pink },
  gloves: { color: '#4A3D86', accent: art.pink },
  mat: { color: art.green, accent: art.purple },
  dumbbell: { color: '#2A2036', accent: art.pink },
  kettlebell: { color: '#16101E', accent: art.cyan },
  jumprope: { color: art.pink, accent: art.cloud },
  resistanceband: { color: art.green, accent: art.pink },
  basketball: { color: art.orange, accent: art.ink },
  football: { color: art.cloud, accent: art.pink },
  tennisracket: { color: art.yellow, accent: art.purple },
  chain: { color: art.yellow, accent: art.cloud },
  wristband: { color: art.pink, accent: art.cyan },
};

/* ------------------------------------------------------------------ */
/* item drawings                                                       */
/* ------------------------------------------------------------------ */

type Ctx = {
  uid: string;
  c: Tone; // body colour
  a: Tone; // accent / trim
  w: Tone; // white parts (soles, aglets)
  k: Tone; // dark parts (linings, rubber)
  rib: Tone; // darker body (ribbing)
};

const draw: Record<ProductKind, (x: Ctx) => React.ReactElement> = {
  hoodie: ({ uid, c, a, w, k }) => (
    <G>
      <Piece id={`${uid}h0`} t={c} d="M37 33 C33 16 45 6 60 6 C75 6 87 16 83 33 Z" />
      <Piece id={`${uid}h1`} t={c} d="M34 29 C24 31 19 38 17 50 L11 84 L26 87 L31 58 Z M86 29 C96 31 101 38 103 50 L109 84 L94 87 L89 58 Z" />
      <Piece id={`${uid}h2`} t={c} d="M33 29 C44 24 76 24 87 29 L91 90 L29 90 Z">
        <Seam d="M31 58 L33 88 M89 58 L87 88" color={c.outline} o={0.35} />
      </Piece>
      <Piece id={`${uid}h3`} t={k} s={0.5} rim={false} d="M45 30 C44 19 51 13 60 13 C69 13 76 19 75 30 C71 39 49 39 45 30 Z" />
      <Piece id={`${uid}h4`} t={c} s={0.6} rim={false} d="M42 63 H78 L86 86 H34 Z">
        <Seam d="M44 67 H76" color={c.hi} o={0.5} dash="2 2.5" />
      </Piece>
      <Seam d="M42 63 L37.5 80 M78 63 L82.5 80" color={c.outline} w={2} o={0.8} />
      <Piece
        id={`${uid}h5`}
        t={a}
        s={0.35}
        d="M28 87 H92 V97 C92 99 91 100 89 100 H31 C29 100 28 99 28 97 Z M10.5 83 L26.5 86 L25 95 L9 92 Z M109.5 83 L93.5 86 L95 95 L111 92 Z"
      >
        <Seam d="M34 89 V98 M40 89 V98 M46 89 V98 M52 89 V98 M58 89 V98 M64 89 V98 M70 89 V98 M76 89 V98 M82 89 V98 M88 89 V98" color={a.outline} w={1} o={0.35} />
      </Piece>
      <Cord d="M54 36 L52 53 M66 36 L68 53" color={w.base} outline={c.outline} w={2} />
      <Path d="M50.2 52 h3.6 v6 h-3.6 Z M66.2 52 h3.6 v6 h-3.6 Z" fill={a.base} stroke={a.outline} strokeWidth={1.3} />
      <Path d={tailMark(70, 42, 0.62)} fill={a.base} stroke={a.outline} strokeWidth={1} />
    </G>
  ),

  tee: ({ uid, c, a }) => (
    <G>
      <Piece id={`${uid}t0`} t={c} d="M36 25 C26 27 17 33 10 46 L23 58 L31 49 Z M84 25 C94 27 103 33 110 46 L97 58 L89 49 Z">
        <Seam d="M13 43 L26 54.5 M107 43 L94 54.5" color={a.base} w={3.2} o={1} />
      </Piece>
      <Piece id={`${uid}t1`} t={c} d="M36 25 C43 22 49 22 51 22 C53 30 67 30 69 22 C71 22 77 22 84 25 L89 49 L90 98 C90 99.5 89 100 88 100 H32 C31 100 30 99.5 30 98 L31 49 Z">
        <Path d="M42 62 H78 V70 H42 Z" fill={a.base} opacity={0.95} />
        <Path d="M42 73 H78 V76 H42 Z" fill={a.base} opacity={0.6} />
      </Piece>
      <Piece id={`${uid}t2`} t={a} s={0.3} rim={false} d="M49.5 21.5 C51 33 69 33 70.5 21.5 L67.5 21 C66 28.5 54 28.5 52.5 21 Z" />
      <Path d={tailMark(52, 37, 0.8)} fill={a.base} stroke={a.outline} strokeWidth={1.1} />
    </G>
  ),

  tank: ({ uid, c, a }) => (
    <G>
      <Piece
        id={`${uid}k0`}
        t={c}
        d="M40 12 L49 12 C50 28 70 28 71 12 L80 12 C80 28 82 38 88 46 C90 50 91 54 91 60 L91 98 C91 99.5 90 100 89 100 L31 100 C30 100 29 99.5 29 98 L29 60 C29 54 30 50 32 46 C38 38 40 28 40 12 Z"
      >
        <Path d="M60 44 L50 64 H59 L54 82 L71 58 H62 L67 44 Z" fill={a.base} />
        <Path d="M29 90 H91 V94 H29 Z" fill={a.base} opacity={0.8} />
      </Piece>
      <Seam d="M49 12 C50 28 70 28 71 12 M40 12 C40 28 38 38 32 46 M80 12 C80 28 82 38 88 46" color={a.base} w={3.2} o={1} />
      <Path d="M60 44 L50 64 H59 L54 82 L71 58 H62 L67 44 Z" fill="none" stroke={a.outline} strokeWidth={1.4} strokeLinejoin="round" />
    </G>
  ),

  jacket: ({ uid, c, a, rib }) => (
    <G>
      <Piece id={`${uid}j0`} t={c} d="M35 26 C23 28 17 37 15 50 L10 84 L27 87 L31 56 Z M85 26 C97 28 103 37 105 50 L110 84 L93 87 L89 56 Z">
        <Seam d="M20 58 L27 57" color={c.outline} w={2} o={0.8} />
      </Piece>
      <Piece id={`${uid}j1`} t={c} d="M34 26 C44 21 76 21 86 26 L91 88 L29 88 Z">
        <Seam d="M36 60 L44 72 M84 60 L76 72" color={c.outline} w={2} o={0.8} />
      </Piece>
      <Path d="M60 26 V88" stroke={INK} strokeWidth={3} />
      <Path d="M60 27 V88" stroke={art.steel} strokeWidth={1.8} strokeDasharray="1.4 1.4" />
      <Piece
        id={`${uid}j2`}
        t={rib}
        s={0.35}
        d="M28 86 H92 V97 C92 99 91 100 89 100 H31 C29 100 28 99 28 97 Z M9.5 83 L27.5 86 L26 96 L8 93 Z M110.5 83 L92.5 86 L94 96 L112 93 Z"
      >
        <Seam d="M28 90.5 H92 M28 94.5 H92 M9 87.5 L27 90.5 M111 87.5 L93 90.5" color={a.base} w={2} o={1} />
      </Piece>
      <Piece id={`${uid}j3`} t={rib} s={0.3} d="M42 25 C46 15 74 15 78 25 L73 31 C66 26 54 26 47 31 Z">
        <Seam d="M45 23 C50 18 70 18 75 23" color={a.base} w={2} o={1} />
      </Piece>
      <Path d="M57.5 30 h5 v9 h-5 Z" fill={art.cloud} stroke={INK} strokeWidth={1.2} />
      <Path d={tailMark(66, 36, 0.62)} fill={a.base} stroke={a.outline} strokeWidth={1} />
    </G>
  ),

  joggers: ({ uid, c, a, w, rib }) => (
    <G>
      <Piece id={`${uid}g0`} t={c} d="M33 18 H87 L91 40 L85 90 H65 L61 44 C60.6 42 59.4 42 59 44 L55 90 H35 L29 40 Z">
        <Seam d="M36 22 L43 36 M84 22 L77 36 M60 20 V42" color={c.outline} w={1.6} o={0.7} />
        <Seam d="M31.5 26 L37.5 90 M88.5 26 L82.5 90" color={a.base} w={3.4} o={1} />
      </Piece>
      <Piece id={`${uid}g1`} t={a} s={0.3} d="M32 10 H88 C89 10 90 11 90 12 V20 H30 V12 C30 11 31 10 32 10 Z" />
      <Piece id={`${uid}g2`} t={rib} s={0.3} d="M35 88 H55 L54 102 H36 Z M65 88 H85 L84 102 H66 Z">
        <Seam d="M39 90 V100 M43 90 V100 M47 90 V100 M51 90 V100 M69 90 V100 M73 90 V100 M77 90 V100 M81 90 V100" color={rib.outline} w={1} o={0.45} />
      </Piece>
      <Cord d="M60 17 C56 22 53 28 54 33 M60 17 C64 22 67 28 66 33" color={w.base} outline={c.outline} w={1.8} />
    </G>
  ),

  shorts: ({ uid, c, a, w }) => (
    <G>
      <Piece id={`${uid}s0`} t={c} d="M26 30 H94 L103 84 C93 88 77 90 66 88 L60 56 L54 88 C43 90 27 88 17 84 Z">
        <Seam d="M28 34 L19 80 M92 34 L101 80" color={a.base} w={4} o={1} />
        <Seam d="M19 78 C29 82 43 83 53 82 M101 78 C91 82 77 83 67 82" color={c.outline} o={0.5} dash="2 2" />
        <Seam d="M60 32 V54" color={c.outline} o={0.6} />
      </Piece>
      <Piece id={`${uid}s1`} t={a} s={0.3} d="M26 20 H94 C95 20 96 21 96 22 V31 H24 V22 C24 21 25 20 26 20 Z" />
      <Cord d="M60 26 C57 31 55 36 56 40 M60 26 C63 31 65 36 64 40" color={w.base} outline={c.outline} w={1.8} />
      <Path d={tailMark(74, 64, 0.7)} fill={art.white} stroke={c.outline} strokeWidth={1} />
    </G>
  ),

  shoes: ({ uid, c, a, w, k }) => (
    <G>
      <Piece id={`${uid}e0`} t={c} d="M18 76 L17 50 C17 42 23 37 31 39 L44 45 C49 39 53 35 59 34 L65 36 C71 45 81 52 93 57 C105 61 109 66 109 74 Z">
        <Seam d="M91 57 C97 63 99 69 98 74" color={c.outline} o={0.6} />
        <Seam d="M20 60 C30 62 36 64 40 72" color={c.outline} o={0.4} dash="2 2" />
      </Piece>
      <Piece id={`${uid}e1`} t={k} s={0.3} rim={false} d="M18.5 46 C21 40 27 39 32 41 L43 46.5 C38 49 27 50 18.5 48 Z" />
      <Piece id={`${uid}e2`} t={a} s={0.3} d="M28 67 L45 57 L44.5 62 L63 51 L52 67.5 L52.5 62.5 Z" />
      <Piece id={`${uid}e3`} t={a} s={0.3} d="M17 52 L11 47 C10 52 11 60 15 64 L17 64 Z" />
      <Cord d="M50 44 L57.5 39.5 M54 48.5 L61.5 44 M58.5 52 L66 47.5 M63.5 55 L71 51" color={w.base} outline={c.outline} w={2.2} />
      <Piece id={`${uid}e4`} t={w} s={0.5} d="M12 75 L110 71 C113 77 112 86 106 90 C102 92 98 92 94 92 L24 93 C16 93 12 89 12 82 Z">
        <Path d="M12 87 C15 92 19 93 24 93 L94 92 C100 92 106 91 109 87 L109 94 H12 Z" fill={k.base} />
        <Seam d="M14 80.5 L111.5 76.5" color={a.base} w={2.6} o={1} />
      </Piece>
    </G>
  ),

  hightops: ({ uid, c, a, w, k }) => (
    <G>
      <Piece id={`${uid}i0`} t={c} d="M22 76 L20 22 C20 16 24 13 30 13 L46 13 C50 13 52 16 51 22 L53 42 C61 48 76 54 92 58 C104 61 110 66 110 74 Z">
        <Seam d="M22 30 C30 34 42 34 51 32" color={c.outline} o={0.45} dash="2 2" />
      </Piece>
      <Piece id={`${uid}i1`} t={k} s={0.25} rim={false} d="M21 18 C24 12.5 45 12.5 49 17.5 C45 22 26 22 21 18 Z" />
      <Piece id={`${uid}i2`} t={w} s={0.4} d="M86 57 C100 60 110 65 110 74 L83 75 C81 68 82 62 86 57 Z" />
      <Piece id={`${uid}i3`} t={a} s={0.35} d={circ(34, 46, 9)}>
        <Path d="M34 39.5 L35.9 44 L40.6 44.2 L37 47.2 L38.2 51.8 L34 49.2 L29.8 51.8 L31 47.2 L27.4 44.2 L32.1 44 Z" fill={art.white} />
      </Piece>
      <Cord d="M41 22 L49 20 M42 28 L50 26 M43 34 L51 32 M45 40 L53 38 M51 45 L59 44" color={w.base} outline={c.outline} w={2.1} />
      <Piece id={`${uid}i4`} t={w} s={0.5} d="M14 74 H112 V86 C112 90 110 92 106 92 H20 C16 92 14 90 14 86 Z">
        <Seam d="M14 81 H112" color={a.base} w={2.8} o={1} />
        <Path d="M14 89 H112 V93 H14 Z" fill={k.base} />
      </Piece>
    </G>
  ),

  cap: ({ uid, c, a }) => (
    <G>
      <Piece id={`${uid}c0`} t={c} d="M18 74 C16 45 35 22 60 22 C87 22 103 42 101 72 C79 81 41 81 18 74 Z">
        <Seam d="M60 22 C50 38 45 56 47 78 M60 22 C71 38 78 56 79 77" color={c.outline} o={0.55} />
        <Path d="M30 36 a2 2 0 1 0 0.1 0 Z M88 38 a2 2 0 1 0 0.1 0 Z" fill={c.outline} opacity={0.6} />
      </Piece>
      <Piece id={`${uid}c1`} t={a} s={0.45} d="M50 74 C72 68 98 63 109 67 C117 71 115 84 102 86 C84 89 63 86 50 80 Z">
        <Seam d="M56 78 C72 81 90 81 104 78" color={a.outline} o={0.4} dash="2 2" />
      </Piece>
      <Circle cx={60} cy={22} r={4} fill={a.base} stroke={a.outline} strokeWidth={1.4} />
      <Path d={tailMark(55, 42, 1)} fill={a.base} stroke={a.outline} strokeWidth={1.2} />
    </G>
  ),

  beanie: ({ uid, c, a }) => (
    <G>
      <Piece id={`${uid}b0`} t={c} d="M24 64 C22 38 40 22 60 22 C80 22 98 38 96 64 Z">
        <Seam d="M42 28 C35 40 33 52 34 60 M60 22 V60 M78 28 C85 40 87 52 86 60" color={c.outline} o={0.4} />
      </Piece>
      <Piece
        id={`${uid}b1`}
        t={c}
        s={0.6}
        d="M20 62 C20 58 22 56 26 56 H94 C98 56 100 58 100 62 V88 C100 92 98 94 94 94 H26 C22 94 20 92 20 88 Z"
      >
        <Seam d="M27 60 V90 M33 60 V90 M39 60 V90 M81 60 V90 M87 60 V90 M93 60 V90" color={c.outline} w={1.8} o={0.4} />
      </Piece>
      <Piece id={`${uid}b2`} t={a} s={0.35} d="M45 64 H75 C77 64 78 65 78 67 V83 C78 85 77 86 75 86 H45 C43 86 42 85 42 83 V67 C42 65 43 64 45 64 Z">
        <Path d={tailMark(52, 65, 0.85)} fill={art.white} />
      </Piece>
      <Piece id={`${uid}b3`} t={a} s={0.5} d={circ(60, 17, 11)}>
        <Seam d="M53 13 L56 18 M58 10 L60 15 M64 11 L63 16 M67 15 L64 19 M55 21 L59 22 M62 22 L66 23" color={a.outline} o={0.35} />
      </Piece>
    </G>
  ),

  headband: ({ uid, c, a }) => (
    <G>
      <Piece id={`${uid}d0`} t={c} evenOdd d={`${ell(60, 62, 48, 27)} ${ell(60, 55, 39, 16)}`}>
        <Seam d="M13 64 C24 88 96 88 107 64" color={a.base} w={4.5} o={1} />
        <Seam d="M18 58 C30 74 90 74 102 58" color={c.outline} o={0.3} dash="1.5 2.5" />
      </Piece>
      <Path d={tailMark(52, 70, 0.8)} fill={art.white} stroke={c.outline} strokeWidth={1} />
    </G>
  ),

  bag: ({ uid, c, a, k }) => (
    <G>
      <Path d="M44 42 C44 16 76 16 76 42" fill="none" stroke={a.outline} strokeWidth={9} strokeLinecap="round" />
      <Path d="M44 42 C44 16 76 16 76 42" fill="none" stroke={a.base} strokeWidth={5.5} strokeLinecap="round" />
      <Piece id={`${uid}a0`} t={c} d="M14 54 C14 43 22 38 34 38 H86 C98 38 106 43 106 54 V88 C106 96 100 100 90 100 H30 C20 100 14 96 14 88 Z">
        <Seam d="M28 46 H92" color={INK} w={2.6} o={0.8} />
        <Seam d="M28 46 H92" color={art.steel} w={1.4} o={1} dash="1.3 1.3" />
      </Piece>
      <Piece id={`${uid}a1`} t={k} s={0.35} rim={false} d="M14 54 C14 43 22 38 30 38 V100 C20 100 14 96 14 88 Z M106 54 C106 43 98 38 90 38 V100 C100 100 106 96 106 88 Z" />
      <Piece id={`${uid}a2`} t={a} s={0.3} d="M41 38 h7 v62 h-7 Z M72 38 h7 v62 h-7 Z" />
      <Piece id={`${uid}a3`} t={c} s={0.5} rim={false} d="M50 62 H70 C72 62 73 63 73 65 V86 C73 88 72 89 70 89 H50 C48 89 47 88 47 86 V65 C47 63 48 62 50 62 Z">
        <Path d={tailMark(52, 66, 0.8)} fill={a.base} />
      </Piece>
      <Path d="M82 44 h5 v8 h-5 Z" fill={art.cloud} stroke={INK} strokeWidth={1.2} />
    </G>
  ),

  backpack: ({ uid, c, a, k }) => (
    <G>
      <Path d="M52 16 C52 5 68 5 68 16" fill="none" stroke={k.outline} strokeWidth={6.5} strokeLinecap="round" />
      <Path d="M52 16 C52 5 68 5 68 16" fill="none" stroke={k.base} strokeWidth={3.5} strokeLinecap="round" />
      <Piece id={`${uid}p0`} t={k} s={0.3} rim={false} d="M31 38 C22 50 22 82 30 98 L36 98 L36 38 Z M89 38 C98 50 98 82 90 98 L84 98 L84 38 Z" />
      <Piece id={`${uid}p1`} t={c} d="M30 36 C30 21 44 13 60 13 C76 13 90 21 90 36 V94 C90 100 86 103 80 103 H40 C34 103 30 100 30 94 Z">
        <Seam d="M35 38 C40 25 80 25 85 38" color={INK} w={2.6} o={0.8} />
        <Seam d="M35 38 C40 25 80 25 85 38" color={art.steel} w={1.4} o={1} dash="1.3 1.3" />
      </Piece>
      <Piece id={`${uid}p2`} t={a} s={0.5} d="M40 62 H80 C83 62 84 64 84 66 V92 C84 96 82 98 78 98 H42 C38 98 36 96 36 92 V66 C36 64 37 62 40 62 Z">
        <Seam d="M40 68 H80" color={INK} w={2.2} o={0.7} />
        <Path d={tailMark(52, 73, 0.85)} fill={art.white} />
      </Piece>
      <Path d="M78 65 h4 v8 h-4 Z M82 34 h4 v8 h-4 Z" fill={art.cloud} stroke={INK} strokeWidth={1.1} />
    </G>
  ),

  bottle: ({ uid, c, a, k }) => (
    <G>
      <Piece id={`${uid}o0`} t={a} s={0.5} d="M45 28 C45 14 75 14 75 28 Z">
        <Path d="M56 14 h8 v7 h-8 Z" fill={a.outline} opacity={0.35} />
      </Piece>
      <Circle cx={80} cy={25} r={5} fill="none" stroke={a.outline} strokeWidth={4.4} />
      <Circle cx={80} cy={25} r={5} fill="none" stroke={a.base} strokeWidth={2.2} />
      <Piece id={`${uid}o1`} t={k} s={0.3} rim={false} d="M42 27 H78 C79 27 80 28 80 29 V38 H40 V29 C40 28 41 27 42 27 Z" />
      <Piece id={`${uid}o2`} t={c} d="M40 36 H80 C84 36 86 39 86 43 V97 C86 103 82 107 76 107 H44 C38 107 34 103 34 97 V43 C34 39 36 36 40 36 Z">
        <Seam d="M34 52 H49 M71 52 H86 M34 92 H49 M71 92 H86" color={c.outline} w={1.8} o={0.5} />
      </Piece>
      <Defs>
        <ClipPath id={`${uid}ow`}>
          <Path d="M52 45 H68 C70 45 71 46 71 48 V96 C71 98 70 99 68 99 H52 C50 99 49 98 49 96 V48 C49 46 50 45 52 45 Z" />
        </ClipPath>
        <LinearGradient id={`${uid}of`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={art.cyan} />
          <Stop offset="1" stopColor="#2A7BFF" />
        </LinearGradient>
      </Defs>
      <Path d="M52 45 H68 C70 45 71 46 71 48 V96 C71 98 70 99 68 99 H52 C50 99 49 98 49 96 V48 C49 46 50 45 52 45 Z" fill="#1A1030" opacity={0.85} />
      <G clipPath={`url(#${uid}ow)`}>
        <Rect x={48} y={62} width={24} height={40} fill={`url(#${uid}of)`} />
        <Rect x={48} y={62} width={24} height={2.5} fill="#B8F6FF" />
        <Path d={`${circ(56, 78, 1.6)} ${circ(63, 86, 1.2)} ${circ(58, 91, 1)}`} fill="#DFFBFF" opacity={0.8} />
        <Rect x={51} y={45} width={3} height={55} fill="#FFFFFF" opacity={0.28} />
      </G>
      <Path d="M52 45 H68 C70 45 71 46 71 48 V96 C71 98 70 99 68 99 H52 C50 99 49 98 49 96 V48 C49 46 50 45 52 45 Z" fill="none" stroke={INK} strokeWidth={1.6} />
      <Seam d="M66 52 H70 M66 60 H70 M66 68 H70 M66 76 H70 M66 84 H70" color={art.white} w={1.2} o={0.7} />
    </G>
  ),

  sunglasses: ({ uid, c, a }) => {
    const L = 'M17 48 C17 43 20 41 28 41 H48 C53 41 55 44 54 48 L52 61 C50 71 44 75 35 75 C25 75 19 69 17 60 Z';
    const R = 'M103 48 C103 43 100 41 92 41 H72 C67 41 65 44 66 48 L68 61 C70 71 76 75 85 75 C95 75 101 69 103 60 Z';
    return (
      <G transform="rotate(-7 60 60)">
        <Defs>
          <LinearGradient id={`${uid}sl`} x1="0" y1="0" x2="0.4" y2="1">
            <Stop offset="0" stopColor={art.cyan} />
            <Stop offset="0.55" stopColor={art.violet} />
            <Stop offset="1" stopColor={art.purple} />
          </LinearGradient>
          <ClipPath id={`${uid}sc`}>
            <Path d={`${L} ${R}`} />
          </ClipPath>
        </Defs>
        <Path d="M11 44 L2 42 M109 44 L118 42" stroke={c.outline} strokeWidth={6} strokeLinecap="round" />
        <Path d="M11 44 L2 42 M109 44 L118 42" stroke={c.base} strokeWidth={3} strokeLinecap="round" />
        <Piece
          id={`${uid}s0`}
          t={c}
          s={0.5}
          d="M9 46 C9 38 15 34 27 34 H49 C55 34 57 37 60 37 C63 37 65 34 71 34 H93 C105 34 111 38 111 46 L109 62 C107 76 97 82 85 82 C73 82 66 76 64 64 L62.5 54 C62 51.5 58 51.5 57.5 54 L56 64 C54 76 47 82 35 82 C23 82 13 76 11 62 Z"
        />
        <Path d={`${L} ${R}`} fill={`url(#${uid}sl)`} stroke={c.outline} strokeWidth={1.8} />
        <G clipPath={`url(#${uid}sc)`}>
          <Path d="M20 70 L42 38 L49 38 L27 70 Z M31 74 L52 44 L55 44 L34 74 Z M74 70 L96 38 L103 38 L81 70 Z M85 74 L106 44 L109 44 L88 74 Z" fill="#FFFFFF" opacity={0.45} />
          <Path d={`${L} ${R}`} transform="translate(0 -5)" fill="none" stroke={art.pink} strokeWidth={3} opacity={0.5} />
        </G>
        <Path d="M22 45 l1.2 3 l3 1.2 l-3 1.2 l-1.2 3 l-1.2 -3 l-3 -1.2 l3 -1.2 Z" fill="#FFFFFF" />
        <Circle cx={12} cy={44} r={2.2} fill={a.base} stroke={c.outline} strokeWidth={1} />
        <Circle cx={108} cy={44} r={2.2} fill={a.base} stroke={c.outline} strokeWidth={1} />
      </G>
    );
  },

  watch: ({ uid, c, a, k }) => (
    <G>
      <Piece id={`${uid}w0`} t={c} s={0.6} d="M45 6 H75 L73 32 H47 Z M47 88 H73 L75 108 H45 Z">
        <Path d={`${circ(60, 95, 1.8)} ${circ(60, 102, 1.8)}`} fill={c.outline} opacity={0.7} />
        <Seam d="M47 14 H73" color={a.base} w={2.2} o={1} />
      </Piece>
      <Piece id={`${uid}w1`} t={k} s={0.6} d="M35 38 C35 31 40 26 47 26 H73 C80 26 85 31 85 38 V82 C85 89 80 94 73 94 H47 C40 94 35 89 35 82 Z" />
      <Path d="M84 50 h4 c1 0 1.5 0.5 1.5 1.5 v7 c0 1 -0.5 1.5 -1.5 1.5 h-4 Z" fill={a.base} stroke={INK} strokeWidth={1.2} />
      <Path d="M42 40 C42 36 44 33 48 33 H72 C76 33 78 36 78 40 V80 C78 84 76 87 72 87 H48 C44 87 42 84 42 80 Z" fill="#07050D" />
      <Circle cx={60} cy={55} r={13} fill="none" stroke={a.base} strokeOpacity={0.25} strokeWidth={4.5} />
      <Circle cx={60} cy={55} r={13} fill="none" stroke={a.base} strokeWidth={4.5} strokeDasharray="62 82" strokeLinecap="round" transform="rotate(-90 60 55)" />
      <Circle cx={60} cy={55} r={7.5} fill="none" stroke={art.cyan} strokeOpacity={0.25} strokeWidth={3.5} />
      <Circle cx={60} cy={55} r={7.5} fill="none" stroke={art.cyan} strokeWidth={3.5} strokeDasharray="30 48" strokeLinecap="round" transform="rotate(-90 60 55)" />
      <Path d="M46 77 H52 L54.5 72 L57.5 82 L61 69 L63.5 77 H74" fill="none" stroke={art.green} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <Path d="M45 36 C50 34 60 34 66 34" fill="none" stroke="#FFFFFF" strokeOpacity={0.35} strokeWidth={2} strokeLinecap="round" />
    </G>
  ),

  earbuds: ({ uid, c, a, k }) => {
    const bud = 'M-12.5 0 a12.5 12.5 0 1 0 25 0 a12.5 12.5 0 1 0 -25 0 Z M-6.5 6 L-6 22 C-6 28 6 28 6 22 L6.5 6 Z';
    const oneBud = (tf: string, id: string) => (
      <G transform={tf}>
        <Path d={ell(10, -4, 5.5, 6.5)} fill={k.base} stroke={c.outline} strokeWidth={1.6} />
        <Piece id={id} t={c} s={0.45} d={bud}>
          <Path d="M-6.5 16 H6.5 V19 H-6.5 Z" fill={a.base} />
        </Piece>
      </G>
    );
    return (
      <G>
        <Piece id={`${uid}r0`} t={c} s={0.6} d="M22 62 C22 52 30 48 42 48 H78 C90 48 98 52 98 62 C88 66 32 66 22 62 Z" />
        <Path d="M26 63 C40 59 80 59 94 63 C80 67 40 67 26 63 Z" fill={k.base} stroke={c.outline} strokeWidth={1.4} />
        {oneBud('translate(42 40) rotate(-16)', `${uid}r2`)}
        {oneBud('translate(78 40) rotate(16) scale(-1 1)', `${uid}r3`)}
        <Piece id={`${uid}r1`} t={c} d="M22 68 C22 64 30 62 42 62 H78 C90 62 98 64 98 68 V84 C98 97 88 104 76 104 H44 C32 104 22 97 22 84 Z">
          <Seam d="M22 71 C40 74 80 74 98 71" color={c.outline} o={0.5} />
        </Piece>
        <Circle cx={60} cy={86} r={5} fill={a.base} opacity={0.25} />
        <Circle cx={60} cy={86} r={2.4} fill={a.base} />
      </G>
    );
  },

  socks: ({ uid, c, a }) => {
    const sock = 'M30 12 H54 V58 C54 64 57 68 63 70 L84 78 C93 81 96 90 91 96 C87 101 79 101 71 98 L42 88 C34 85 30 78 30 70 Z';
    const inner = (
      <G>
        <Path d="M30 17 H54 V21 H30 Z M30 25 H54 V29 H30 Z" fill={a.base} />
        <Path d="M30 72 C30 82 34 86 44 89 L46 78 C40 76 36 74 30 68 Z M80 76 C92 80 96 90 90 96 C86 100 79 100 73 98 C77 92 79 84 80 76 Z" fill={a.base} />
      </G>
    );
    return (
      <G>
        <G transform="translate(16 -2)">
          <Piece id={`${uid}x0`} t={c} d={sock}>
            {inner}
          </Piece>
        </G>
        <G transform="translate(-4 6)">
          <Piece id={`${uid}x1`} t={c} d={sock}>
            {inner}
            <Seam d="M33 14 V32 M37 14 V32 M41 14 V32 M45 14 V32 M49 14 V32" color={c.outline} w={1} o={0.3} />
          </Piece>
        </G>
      </G>
    );
  },

  gloves: ({ uid, c, a, k }) => (
    <G>
      <Piece id={`${uid}v0`} t={c} s={0.4} d="M34 40 V28 C34 24 36.5 22 40.5 22 C44.5 22 47 24 47 28 V40 Z M47.5 40 V24 C47.5 20 50 18 54 18 C58 18 60.5 20 60.5 24 V40 Z M61 40 V25 C61 21 63.5 19 67.5 19 C71.5 19 74 21 74 25 V40 Z M74.5 40 V30 C74.5 26 77 24 81 24 C85 24 87.5 26 87.5 30 V40 Z">
        <Path d="M34 22 H88 V29 H34 Z" fill={k.base} opacity={0.35} />
      </Piece>
      <Piece id={`${uid}v1`} t={c} s={0.5} d="M32 58 C23 55 16 59 13 66 C11 72 15 77 22 75 L34 70 Z" />
      <Piece id={`${uid}v2`} t={c} d="M30 46 C30 40 34 36 40 36 H82 C88 36 90 40 90 46 V82 C90 90 86 94 78 94 H44 C36 94 30 88 30 80 Z">
        <Path d={`${circ(46, 66, 1.4)} ${circ(53, 66, 1.4)} ${circ(60, 66, 1.4)} ${circ(67, 66, 1.4)} ${circ(74, 66, 1.4)} ${circ(49.5, 72, 1.4)} ${circ(56.5, 72, 1.4)} ${circ(63.5, 72, 1.4)} ${circ(70.5, 72, 1.4)} ${circ(53, 78, 1.4)} ${circ(60, 78, 1.4)} ${circ(67, 78, 1.4)}`} fill={c.outline} opacity={0.55} />
      </Piece>
      <Piece id={`${uid}v3`} t={a} s={0.35} d="M36 40 H84 C86 40 87 41 87 43 V53 C87 55 86 56 84 56 H36 C34 56 33 55 33 53 V43 C33 41 34 40 36 40 Z">
        <Seam d="M48 40 V56 M60 40 V56 M72 40 V56" color={a.outline} o={0.5} />
      </Piece>
      <Piece id={`${uid}v4`} t={k} s={0.4} d="M27 86 H97 C100 86 101 88 101 90 V101 C101 103 100 105 97 105 H27 C25 105 24 103 24 101 V90 C24 88 25 86 27 86 Z">
        <Path d="M78 86 H101 V105 H78 Z" fill={a.base} />
      </Piece>
      <Path d={tailMark(82, 88, 0.75)} fill={art.white} />
    </G>
  ),

  mat: ({ uid, c, a }) => (
    <G>
      <Path d="M40 40 C42 14 70 14 72 40" fill="none" stroke={a.outline} strokeWidth={6.5} strokeLinecap="round" />
      <Path d="M40 40 C42 14 70 14 72 40" fill="none" stroke={a.base} strokeWidth={3.5} strokeLinecap="round" />
      <Piece id={`${uid}m0`} t={c} d="M26 38 H90 C82 38 76 50 76 62 C76 74 82 86 90 86 H26 C18 86 12 74 12 62 C12 50 18 38 26 38 Z">
        <Seam d="M16 50 H78 M15 62 H76 M16 74 H78" color={c.outline} o={0.18} w={1} />
      </Piece>
      <Piece id={`${uid}m1`} t={c} s={0.6} rim={false} d={ell(90, 62, 13, 24)}>
        <Path
          d="M90 62 C92 62 92 58 90 58 C87 58 86 64 90 66 C95 67 96 57 90 54 C84 52 81 66 88 70 C96 73 101 58 95 49 C89 42 78 52 80 66 C82 78 94 82 99 74"
          fill="none"
          stroke={c.outline}
          strokeWidth={1.6}
          strokeOpacity={0.75}
          strokeLinecap="round"
        />
      </Piece>
      <Piece id={`${uid}m2`} t={a} s={0.3} d="M36 36 h8 v52 h-8 Z M64 36 h8 v52 h-8 Z" />
    </G>
  ),

  dumbbell: ({ uid, c, a, k }) => (
    <G transform="rotate(-32 60 60)">
      <Piece id={`${uid}d0`} t={k} d={`${ell(38, 60, 10, 22)}`} />
      <Piece id={`${uid}d1`} t={c} s={0.6} d={`${ell(38, 60, 6, 15)}`} />
      <Piece id={`${uid}d2`} t={k} d={`${ell(82, 60, 10, 22)}`} />
      <Piece id={`${uid}d3`} t={c} s={0.6} d={`${ell(82, 60, 6, 15)}`} />
      <Piece id={`${uid}d4`} t={a} s={0.4} d="M44 54 H76 V66 H44 Z">
        <Seam d="M52 54 V66 M60 54 V66 M68 54 V66" color={a.outline} o={0.4} />
      </Piece>
    </G>
  ),

  kettlebell: ({ uid, c, a }) => (
    <G>
      <Piece id={`${uid}k0`} t={a} s={0.4} d="M46 26 C46 18 52 13 60 13 C68 13 74 18 74 26 V34 H64 V27 C64 24 62 22 60 22 C58 22 56 24 56 27 V34 H46 Z" />
      <Piece id={`${uid}k1`} t={c} d="M60 34 C82 34 92 52 92 70 C92 92 78 106 60 106 C42 106 28 92 28 70 C28 52 38 34 60 34 Z">
        <Path d="M42 46 C48 40 54 37 60 37" fill="none" stroke={c.hi} strokeOpacity={0.5} strokeWidth={4} strokeLinecap="round" />
      </Piece>
      <Path d={tailMark(52, 68, 0.9)} fill={a.base} stroke={a.outline} strokeWidth={1.2} />
    </G>
  ),

  jumprope: ({ uid, c, a, k }) => (
    <G>
      <Path d="M30 30 C10 50 10 90 40 96 C70 102 78 66 60 58 C46 52 40 70 54 74" fill="none" stroke={k.outline} strokeWidth={9} strokeLinecap="round" />
      <Path d="M30 30 C10 50 10 90 40 96 C70 102 78 66 60 58 C46 52 40 70 54 74" fill="none" stroke={c.base} strokeWidth={5.5} strokeLinecap="round" />
      <Piece id={`${uid}j0`} t={a} s={0.4} d="M18 16 C18 10 22 6 30 6 C38 6 40 12 36 16 L30 30 L22 26 Z" />
      <Piece id={`${uid}j1`} t={a} s={0.4} d="M46 74 C46 68 50 64 58 64 C66 64 68 70 64 74 L58 88 L50 84 Z" />
    </G>
  ),

  resistanceband: ({ uid, c, a }) => (
    <G>
      <Path d={ell(60, 60, 46, 30)} fill="none" stroke={c.outline} strokeWidth={13} />
      <Path d={ell(60, 60, 46, 30)} fill="none" stroke={c.base} strokeWidth={8.5} />
      <Path d="M20 60 C20 42 38 32 60 32" fill="none" stroke={a.base} strokeOpacity={0.55} strokeWidth={3} strokeLinecap="round" />
      <Circle cx={14} cy={60} r={9} fill={a.base} stroke={a.outline} strokeWidth={2} />
      <Circle cx={106} cy={60} r={9} fill={a.base} stroke={a.outline} strokeWidth={2} />
    </G>
  ),

  basketball: ({ uid, c, a }) => (
    <G>
      <Piece id={`${uid}b0`} t={c} d={circ(60, 62, 40)} />
      <Path d="M60 22 V102 M20 62 H100 M28 32 C40 46 40 78 28 92 M92 32 C80 46 80 78 92 92" fill="none" stroke={a.outline} strokeWidth={2.6} strokeLinecap="round" />
    </G>
  ),

  football: ({ uid, c, a }) => (
    <G>
      <Piece id={`${uid}f0`} t={c} d={ell(60, 62, 40, 28)} />
      <Path d="M22 62 H98 M40 50 L40 74 M50 46 L50 78 M70 46 L70 78 M80 50 L80 74" fill="none" stroke={a.outline} strokeWidth={2.4} strokeLinecap="round" />
      <Path d={`${circ(40, 50, 1.6)} ${circ(50, 46, 1.6)} ${circ(70, 46, 1.6)} ${circ(80, 50, 1.6)} ${circ(40, 74, 1.6)} ${circ(50, 78, 1.6)} ${circ(70, 78, 1.6)} ${circ(80, 74, 1.6)}`} fill={a.base} />
    </G>
  ),

  tennisracket: ({ uid, c, a, k }) => (
    <G transform="rotate(-24 60 60)">
      <Piece id={`${uid}r0`} t={c} d={ell(58, 40, 26, 32)} />
      <Piece id={`${uid}r1`} t={k} s={0.5} rim={false} d={ell(58, 40, 19, 25)} />
      <Path d="M39 40 H77 M58 15 V65 M45 22 L71 58 M71 22 L45 58" fill="none" stroke={a.base} strokeWidth={1.4} strokeOpacity={0.85} />
      <Piece id={`${uid}r2`} t={a} s={0.4} d="M53 68 H63 L68 108 C68 112 65 115 58 115 C51 115 48 112 48 108 Z" />
    </G>
  ),

  chain: ({ uid, a, k }) => (
    <G>
      <Path d={ell(60, 58, 40, 26)} fill="none" stroke={k.outline} strokeWidth={7} />
      <Path d={ell(60, 58, 40, 26)} fill="none" stroke={a.base} strokeWidth={4} strokeDasharray="6 4" />
      <Path d={tailMark(48, 68, 1.05)} fill={a.base} stroke={a.outline} strokeWidth={1.3} />
    </G>
  ),

  wristband: ({ uid, c, a }) => (
    <G>
      <Piece id={`${uid}wb0`} t={c} d="M24 46 H96 C100 46 102 50 102 60 C102 70 100 74 96 74 H24 C20 74 18 70 18 60 C18 50 20 46 24 46 Z">
        <Seam d="M24 52 H96 M24 68 H96" color={a.base} w={3} o={0.9} />
      </Piece>
    </G>
  ),
};

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */

export const ProductArt = React.memo(function ProductArt(props: {
  kind: ProductKind;
  color?: string;
  accent?: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { kind, size = 96, style } = props;
  const def = productDefaults[kind] ?? productDefaults.tee;
  const color = props.color ?? def.color;
  const accent = props.accent ?? def.accent ?? art.pink;
  const uid = useUid();

  const ctx = React.useMemo<Ctx>(() => {
    const rim = rimFor(color);
    return {
      uid,
      c: makeTone(color, rim, `${uid}gc`),
      a: makeTone(accent, rimFor(accent), `${uid}ga`),
      w: makeTone('#F6F1FA', rim, `${uid}gw`),
      k: makeTone(mix(color, '#120A1C', 0.72), rim, `${uid}gk`),
      rib: makeTone(mix(color, '#120A1C', 0.3), rim, `${uid}gr`),
    };
  }, [uid, color, accent]);

  const Draw = draw[kind] ?? draw.tee;

  return (
    <Svg width={size} height={size} viewBox="0 0 120 120" style={style}>
      <Defs>
        <RadialGradient id={`${uid}sh`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#000000" stopOpacity={0.55} />
          <Stop offset="0.6" stopColor="#000000" stopOpacity={0.25} />
          <Stop offset="1" stopColor="#000000" stopOpacity={0} />
        </RadialGradient>
        <ToneGradient t={ctx.c} />
        <ToneGradient t={ctx.a} />
        <ToneGradient t={ctx.w} />
        <ToneGradient t={ctx.k} />
        <ToneGradient t={ctx.rib} />
      </Defs>
      <Ellipse cx={60} cy={110} rx={42} ry={6.5} fill={`url(#${uid}sh)`} />
      {Draw(ctx)}
    </Svg>
  );
});

export default ProductArt;
