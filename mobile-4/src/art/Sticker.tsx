import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';
import { art } from './palette';
import type { StickerKind } from '@/types';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const INK = '#1A0D26';

function useUid(): string {
  return React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
}

const f = (n: number) => n.toFixed(2);

function circ(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
}

function ell(cx: number, cy: number, rx: number, ry: number): string {
  return `M${cx - rx} ${cy} a${rx} ${ry} 0 1 0 ${2 * rx} 0 a${rx} ${ry} 0 1 0 ${-2 * rx} 0 Z`;
}

function heart(cx: number, cy: number, s: number): string {
  const p = (x: number, y: number) => `${f(cx + x * s)} ${f(cy + y * s)}`;
  return `M${p(0, 0.95)} C${p(-1.3, 0.1)} ${p(-1.15, -1)} ${p(-0.52, -1)} C${p(-0.2, -1)} ${p(0, -0.75)} ${p(0, -0.5)} C${p(0, -0.75)} ${p(0.2, -1)} ${p(0.52, -1)} C${p(1.15, -1)} ${p(1.3, 0.1)} ${p(0, 0.95)} Z`;
}

function burst(cx: number, cy: number, R: number, r: number, n: number, rot = -90): string {
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const a = ((rot + (180 / n) * i) * Math.PI) / 180;
    const rad = i % 2 === 0 ? R : r;
    d += `${i === 0 ? 'M' : 'L'}${f(cx + Math.cos(a) * rad)} ${f(cy + Math.sin(a) * rad)} `;
  }
  return d + 'Z';
}

function flame(cx: number, top: number, s: number): string {
  const p = (x: number, y: number) => `${f(cx + x * s)} ${f(top + y * s)}`;
  return (
    `M${p(0, 0)} C${p(6, 18)} ${p(28, 28)} ${p(28, 54)} C${p(28, 76)} ${p(14, 90)} ${p(-2, 90)} ` +
    `C${p(-20, 90)} ${p(-30, 76)} ${p(-30, 60)} C${p(-30, 46)} ${p(-22, 38)} ${p(-18, 28)} ` +
    `C${p(-14, 40)} ${p(-10, 44)} ${p(-6, 44)} C${p(-10, 30)} ${p(-8, 14)} ${p(0, 0)} Z`
  );
}

/** flat fill + cel shade band + highlight + ink outline */
function Shaded({ id, d, fill, shade, hi = '#FFFFFF', s = 1, outline = INK }: { id: string; d: string; fill: string; shade: string; hi?: string; s?: number; outline?: string }) {
  return (
    <G>
      <Defs>
        <ClipPath id={id}>
          <Path d={d} />
        </ClipPath>
      </Defs>
      <Path d={d} fill={fill} />
      <G clipPath={`url(#${id})`}>
        <Path d={d} transform={`translate(${7 * s} ${6 * s})`} fill="none" stroke={shade} strokeOpacity={0.8} strokeWidth={13 * s} strokeLinejoin="round" />
        <Path d={d} transform={`translate(${-3 * s} ${-3 * s})`} fill="none" stroke={hi} strokeOpacity={0.45} strokeWidth={6 * s} strokeLinejoin="round" />
      </G>
      <Path d={d} fill="none" stroke={outline} strokeWidth={2.4} strokeLinejoin="round" />
    </G>
  );
}

/* ------------------------------------------------------------------ */
/* sticker definitions                                                 */
/* ------------------------------------------------------------------ */

type Def = {
  tilt: number;
  /** outline used for the white die-cut border */
  sil: string;
  /** where the little shine streak goes */
  shine: [number, number];
  draw: (uid: string) => React.ReactElement;
};

const CAL_BODY = 'M24 30 H96 C99 30 101 32 101 35 V94 C101 97 99 99 96 99 H24 C21 99 19 97 19 94 V35 C19 32 21 30 24 30 Z';
const SQ_TAIL = 'M34 86 C14 88 4 66 10 48 C14 36 24 32 22 20 C36 24 42 42 34 54 C28 62 32 74 40 78 Z';
const SQ_HEAD = circ(52, 62, 26);
const SQ_EARS = 'M31 47 L27 22 L45 38 Z M59 38 L74 20 L75 46 Z';
const SQ_ARM = 'M68 86 C80 94 96 92 102 84 C107 76 106 62 103 52 L91 52 C92 60 92 66 90 70 C86 60 76 60 70 72 Z';
const SQ_FIST = circ(97, 46, 9.5);
const CROWN = 'M20 42 L40 62 L60 30 L80 62 L100 42 L93 86 H27 Z';
const SUN_RAYS = burst(60, 60, 50, 33, 12);
const DROP = 'M60 12 C70 32 92 48 92 70 C92 90 78 104 60 104 C42 104 28 90 28 70 C28 48 50 32 60 12 Z';
const SIGN = 'M60 8 C62 8 63.5 9 65 10.5 L99.5 45 C102 47.5 102 51.5 99.5 54 L65 88.5 C62.5 91 57.5 91 55 88.5 L20.5 54 C18 51.5 18 47.5 20.5 45 L55 10.5 C56.5 9 58 8 60 8 Z';

const STICKERS: Record<StickerKind, Def> = {
  'no-days-off': {
    tilt: -6,
    sil: `${CAL_BODY} M33 20 h8 v18 h-8 Z M79 20 h8 v18 h-8 Z`,
    shine: [26, 40],
    draw: (uid) => (
      <G>
        <Shaded id={`${uid}a`} d={CAL_BODY} fill={art.cloud} shade="#C9B8DA" />
        <Path d="M19 35 C19 32 21 30 24 30 H96 C99 30 101 32 101 35 V48 H19 Z" fill={art.pink} stroke={INK} strokeWidth={2.4} strokeLinejoin="round" />
        <Path d="M22 33 H98" stroke={art.pinkHi} strokeWidth={2.5} strokeLinecap="round" />
        <Path
          d="M27 55 h9 v7 h-9 Z M40 55 h9 v7 h-9 Z M84 55 h9 v7 h-9 Z M27 66 h9 v7 h-9 Z M84 66 h9 v7 h-9 Z M27 77 h9 v7 h-9 Z M84 77 h9 v7 h-9 Z M27 88 h9 v5 h-9 Z M40 88 h9 v5 h-9 Z M71 88 h9 v5 h-9 Z M84 88 h9 v5 h-9 Z M71 55 h9 v7 h-9 Z"
          fill="#D9CCE6"
        />
        <Path d="M33 20 h8 v18 h-8 Z M79 20 h8 v18 h-8 Z" fill="#3B2F4A" stroke={INK} strokeWidth={2} strokeLinejoin="round" />
        <Path d="M35 22 v14 M81 22 v14" stroke="#FFFFFF" strokeOpacity={0.35} strokeWidth={1.6} />
        <Shaded id={`${uid}b`} d={flame(61, 50, 0.5)} fill={art.orange} shade={art.coral} hi={art.sunTop} s={0.5} />
        <Path d={flame(60, 70, 0.26)} fill={art.yellow} />
      </G>
    ),
  },

  'squirrel-flex': {
    tilt: 5,
    sil: `${SQ_TAIL} ${SQ_HEAD} ${SQ_EARS} ${SQ_ARM} ${SQ_FIST}`,
    shine: [36, 42],
    draw: (uid) => (
      <G>
        <Shaded id={`${uid}t`} d={SQ_TAIL} fill={art.furLight} shade={art.fur} s={0.8} />
        <Path d="M20 30 C28 38 30 48 24 58 M16 50 C18 62 22 72 30 80" stroke={art.fur} strokeWidth={2.2} fill="none" strokeLinecap="round" />
        <Shaded id={`${uid}e`} d={SQ_EARS} fill={art.fur} shade={art.furDark} s={0.4} />
        <Path d="M32 44 L30 30 L40 39 Z M62 39 L71 29 L71 43 Z" fill={art.pinkHi} opacity={0.8} />
        <Shaded id={`${uid}r`} d={SQ_ARM} fill={art.fur} shade={art.furDark} s={0.6} />
        <Path d="M76 70 C80 66 86 66 88 70" stroke={art.furLight} strokeWidth={2.5} fill="none" strokeLinecap="round" />
        <Shaded id={`${uid}f`} d={SQ_FIST} fill={art.fur} shade={art.furDark} s={0.45} />
        <Path d="M90 44 H101 M90 48.5 H102" stroke={art.furDark} strokeWidth={1.8} strokeLinecap="round" />
        <Shaded id={`${uid}h`} d={SQ_HEAD} fill={art.fur} shade={art.furDark} />
        <Shaded id={`${uid}m`} d={ell(52, 75, 15, 11)} fill={art.belly} shade="#E9C597" s={0.4} />
        <Path d={ell(52, 69, 4.5, 3.2)} fill={art.nose} />
        <Path d="M46 77 Q52 83 58 77" stroke={art.nose} strokeWidth={2.2} fill="none" strokeLinecap="round" />
        <Path d="M49 78 h6 v4 c0 1.5 -1 2 -3 2 c-2 0 -3 -0.5 -3 -2 Z" fill="#FFFFFF" stroke={art.nose} strokeWidth={1} />
        {/* sunglasses */}
        <Path d="M26 54 H78" stroke={INK} strokeWidth={5} strokeLinecap="round" />
        <Path d="M26 54 H78" stroke={art.pink} strokeWidth={2.6} strokeLinecap="round" />
        <Path d="M30 52 H49 C50 52 50.5 53 50.5 54 C50 60 46 64 40 64 C34 64 30 60 29 55 C29 53 29.5 52 30 52 Z M55 52 H74 C74.5 52 75 53 75 55 C74 60 70 64 64 64 C58 64 54 60 53.5 54 C53.5 53 54 52 55 52 Z" fill={art.pink} stroke={INK} strokeWidth={2} strokeLinejoin="round" />
        <Path d="M33 55 H47 C46.5 59 44 61 40 61 C36 61 33.5 59 33 55 Z M57 55 H71 C70.5 59 68 61 64 61 C60 61 57.5 59 57 55 Z" fill="#241238" />
        <Path d="M36 56 L39 56 L36.5 60 Z M60 56 L63 56 L60.5 60 Z" fill="#FFFFFF" opacity={0.8} />
      </G>
    ),
  },

  'neon-heart': {
    tilt: -8,
    sil: heart(60, 64, 44),
    shine: [26, 40],
    draw: (uid) => (
      <G>
        <Defs>
          <RadialGradient id={`${uid}bg`} cx="0.5" cy="0.45" r="0.6">
            <Stop offset="0" stopColor="#4A1250" />
            <Stop offset="1" stopColor={art.night2} />
          </RadialGradient>
        </Defs>
        <Path d={heart(60, 64, 42)} fill={`url(#${uid}bg)`} stroke={INK} strokeWidth={2.4} strokeLinejoin="round" />
        <Path d={heart(60, 64, 29)} fill={art.pink} opacity={0.14} />
        <Path d={heart(60, 64, 29)} fill="none" stroke={art.pink} strokeOpacity={0.18} strokeWidth={16} strokeLinejoin="round" />
        <Path d={heart(60, 64, 29)} fill="none" stroke={art.pink} strokeOpacity={0.35} strokeWidth={9} strokeLinejoin="round" />
        <Path d={heart(60, 64, 29)} fill="none" stroke={art.pink} strokeWidth={4.5} strokeLinejoin="round" />
        <Path d={heart(60, 64, 29)} fill="none" stroke="#FFE3F4" strokeWidth={1.6} strokeLinejoin="round" />
        <Path d={heart(60, 64, 15)} fill="none" stroke={art.cyan} strokeOpacity={0.3} strokeWidth={8} strokeLinejoin="round" />
        <Path d={heart(60, 64, 15)} fill="none" stroke={art.cyan} strokeWidth={3} strokeLinejoin="round" />
        <Path d={heart(60, 64, 15)} fill="none" stroke="#E6FBFF" strokeWidth={1.1} strokeLinejoin="round" />
        <Path d="M34 52 m0 -4 l1.2 3 l3 1 l-3 1 l-1.2 3 l-1.2 -3 l-3 -1 l3 -1 Z" fill="#FFFFFF" />
      </G>
    ),
  },

  crown: {
    tilt: 6,
    sil: `${CROWN} M26 80 H94 V96 H26 Z ${circ(20, 40, 6)} ${circ(60, 28, 6.5)} ${circ(100, 40, 6)}`,
    shine: [30, 60],
    draw: (uid) => (
      <G>
        <Defs>
          <LinearGradient id={`${uid}g`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={art.sunTop} />
            <Stop offset="0.6" stopColor={art.yellow} />
            <Stop offset="1" stopColor={art.amber} />
          </LinearGradient>
        </Defs>
        <Shaded id={`${uid}c`} d={CROWN} fill={`url(#${uid}g)`} shade="#E0901F" hi="#FFFBE0" />
        <Shaded id={`${uid}b`} d="M26 80 H94 V96 H26 Z" fill={art.amber} shade="#C9701A" hi="#FFF1B8" s={0.4} />
        <Path d={`${circ(20, 40, 5.5)} ${circ(60, 28, 6)} ${circ(100, 40, 5.5)}`} fill={art.yellow} stroke={INK} strokeWidth={2.2} />
        <Path d={`${circ(18.5, 38.5, 1.8)} ${circ(58.3, 26.3, 2)} ${circ(98.5, 38.5, 1.8)}`} fill="#FFFFFF" opacity={0.8} />
        <Path d="M60 50 L67 60 L60 70 L53 60 Z" fill={art.pink} stroke={INK} strokeWidth={2} strokeLinejoin="round" />
        <Path d="M60 52 L63 58 H57 Z" fill="#FFFFFF" opacity={0.7} />
        <Path d={`${circ(40, 88, 4.5)} ${circ(80, 88, 4.5)}`} fill={art.cyan} stroke={INK} strokeWidth={1.8} />
        <Path d={circ(60, 88, 5)} fill={art.purple} stroke={INK} strokeWidth={1.8} />
      </G>
    ),
  },

  fire: {
    tilt: -5,
    sil: flame(62, 10, 1.06),
    shine: [44, 48],
    draw: (uid) => (
      <G>
        <Defs>
          <LinearGradient id={`${uid}g`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={art.orange} />
            <Stop offset="1" stopColor={art.coral} />
          </LinearGradient>
          <LinearGradient id={`${uid}h`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={art.amber} />
            <Stop offset="1" stopColor={art.yellow} />
          </LinearGradient>
        </Defs>
        <Shaded id={`${uid}a`} d={flame(62, 10, 1.06)} fill={`url(#${uid}g)`} shade={art.magenta} hi={art.sunTop} />
        <Path d={flame(62, 42, 0.66)} fill={`url(#${uid}h)`} stroke={INK} strokeWidth={1.6} strokeOpacity={0.35} />
        <Path d={flame(62, 68, 0.34)} fill="#FFF6D6" />
      </G>
    ),
  },

  'good-vibes': {
    tilt: 7,
    sil: SUN_RAYS,
    shine: [34, 34],
    draw: (uid) => (
      <G>
        <Defs>
          <RadialGradient id={`${uid}g`} cx="0.4" cy="0.35" r="0.7">
            <Stop offset="0" stopColor={art.sunTop} />
            <Stop offset="0.7" stopColor={art.yellow} />
            <Stop offset="1" stopColor={art.amber} />
          </RadialGradient>
        </Defs>
        <Shaded id={`${uid}r`} d={SUN_RAYS} fill={art.orange} shade={art.coral} hi={art.amber} s={0.5} />
        <Shaded id={`${uid}f`} d={circ(60, 60, 30)} fill={`url(#${uid}g)`} shade="#F2A43A" hi="#FFFBE0" />
        <Path d={`${ell(40, 70, 5, 3.4)} ${ell(80, 70, 5, 3.4)}`} fill={art.pink} opacity={0.55} />
        <Path d="M46 72 Q60 86 74 72" stroke={INK} strokeWidth={3.2} fill="none" strokeLinecap="round" />
        <Path d="M36 54 H84" stroke={INK} strokeWidth={3.2} strokeLinecap="round" />
        <Path d="M36 51 H57 C57 60 53 65 46 65 C39 65 36 60 36 51 Z M63 51 H84 C84 60 81 65 74 65 C67 65 63 60 63 51 Z" fill={art.pink} stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />
        <Path d="M40 54 H54 C53 59 50 61.5 46.5 61.5 C43 61.5 40.5 59 40 54 Z M66 54 H80 C79 59 76.5 61.5 73 61.5 C69.5 61.5 67 59 66 54 Z" fill={art.purple} />
        <Path d="M43 55 L46 55 L43.5 59 Z M69 55 L72 55 L69.5 59 Z" fill="#FFFFFF" opacity={0.85} />
      </G>
    ),
  },

  'one-more-km': {
    tilt: -4,
    sil: `${SIGN} M55 86 h10 v24 h-10 Z`,
    shine: [44, 26],
    draw: (uid) => (
      <G>
        <Path d="M55 84 h10 v25 c0 1.5 -1 2 -2 2 h-6 c-1 0 -2 -0.5 -2 -2 Z" fill={art.steel} stroke={INK} strokeWidth={2.2} />
        <Path d="M57 86 v22" stroke="#FFFFFF" strokeOpacity={0.4} strokeWidth={1.6} />
        <Shaded id={`${uid}s`} d={SIGN} fill={art.yellow} shade={art.amber} hi="#FFFBE0" />
        <Path d="M60 16 L92 49.5 L60 83 L28 49.5 Z" fill="none" stroke={INK} strokeWidth={2.6} strokeLinejoin="round" />
        <Path d={circ(52, 36, 4.6)} fill={INK} />
        <Path
          d="M50.5 43 L46 58 M39 50 L45 45 L53 46 L57 52 M46 58 L54 63 L52 72 M46 58 L41 65 L33 65"
          stroke={INK}
          strokeWidth={4.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <Path d="M74 66 V40 M66 48 L74 40 L82 48" stroke={art.pink} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </G>
    ),
  },

  hydrate: {
    tilt: 5,
    sil: DROP,
    shine: [50, 34],
    draw: (uid) => (
      <G>
        <Defs>
          <LinearGradient id={`${uid}g`} x1="0" y1="0" x2="0.3" y2="1">
            <Stop offset="0" stopColor="#9BF1FF" />
            <Stop offset="0.5" stopColor={art.cyan} />
            <Stop offset="1" stopColor="#2A8BFF" />
          </LinearGradient>
        </Defs>
        <Shaded id={`${uid}d`} d={DROP} fill={`url(#${uid}g)`} shade="#2A6BFF" hi="#E6FDFF" />
        <Path d="M40 62 C40 52 46 42 52 36" stroke="#FFFFFF" strokeOpacity={0.75} strokeWidth={4} strokeLinecap="round" fill="none" />
        <Path d={`${ell(49, 72, 4.4, 6)} ${ell(71, 72, 4.4, 6)}`} fill={INK} />
        <Path d={`${circ(50.5, 69.5, 1.7)} ${circ(72.5, 69.5, 1.7)}`} fill="#FFFFFF" />
        <Path d={`${ell(41, 82, 5, 3)} ${ell(79, 82, 5, 3)}`} fill={art.pink} opacity={0.6} />
        <Path d="M53 83 Q60 91 67 83 Z" fill={INK} stroke={INK} strokeWidth={2.4} strokeLinejoin="round" />
        <Path d="M56.5 86.5 Q60 88.5 63.5 86.5" stroke={art.pink} strokeWidth={2} strokeLinecap="round" fill="none" />
        <Path d="M86 30 l1.6 4 l4 1.6 l-4 1.6 l-1.6 4 l-1.6 -4 l-4 -1.6 l4 -1.6 Z" fill="#FFFFFF" />
      </G>
    ),
  },
};

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */

export const StickerArt = React.memo(function StickerArt(props: { kind: StickerKind; size?: number; style?: StyleProp<ViewStyle> }) {
  const { kind, size = 96, style } = props;
  const uid = useUid();
  const def = STICKERS[kind] ?? STICKERS.fire;
  const [sx, sy] = def.shine;
  return (
    <Svg width={size} height={size} viewBox="0 0 120 120" style={style}>
      <Defs>
        <RadialGradient id={`${uid}sh`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#000000" stopOpacity={0.45} />
          <Stop offset="1" stopColor="#000000" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Ellipse cx={60} cy={112} rx={34} ry={5} fill={`url(#${uid}sh)`} />
      <G transform={`translate(60 60) scale(0.9) rotate(${def.tilt}) translate(-60 -60)`}>
        {/* drop shadow of the vinyl */}
        <Path d={def.sil} transform="translate(2 4)" fill="#000000" stroke="#000000" strokeWidth={14} strokeLinejoin="round" opacity={0.4} />
        {/* white die-cut border with a faint paper edge */}
        <Path d={def.sil} fill="#E4D9EE" stroke="#E4D9EE" strokeWidth={14.5} strokeLinejoin="round" />
        <Path d={def.sil} fill="#FFFFFF" stroke="#FFFFFF" strokeWidth={12} strokeLinejoin="round" />
        {def.draw(uid)}
        {/* shine */}
        <Path d={`M${sx} ${sy + 12} Q${sx} ${sy} ${sx + 12} ${sy - 4}`} stroke="#FFFFFF" strokeOpacity={0.85} strokeWidth={4} strokeLinecap="round" fill="none" />
        <Circle cx={sx + 17} cy={sy - 5.5} r={2} fill="#FFFFFF" opacity={0.85} />
      </G>
    </Svg>
  );
});

export default StickerArt;
