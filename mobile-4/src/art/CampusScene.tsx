/**
 * <CampusScene /> — the campus at dusk: hostel blocks with lit windows, the lecture hall, a
 * floodlit sports ground, trees and a lamp-lit path running toward the viewer. Original vector
 * art (no third-party imagery). It fills its box with `slice`, anchored to the bottom, so the
 * sky stretches on tall screens and the ground stays put.
 */
import { memo } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Path, Polygon, RadialGradient, Rect, Stop } from 'react-native-svg';

const W = 390;
const H = 620;

/** Small deterministic PRNG so the windows are the same on every render and device. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Block = { x: number; y: number; w: number; h: number; tone: string; cols: number; rows: number; roof?: 'flat' | 'tank' | 'slope' };

// Back row: hostels and academic blocks on the horizon.
const BACK: Block[] = [
  { x: -10, y: 300, w: 78, h: 92, tone: '#1A0F2B', cols: 5, rows: 6, roof: 'tank' },
  { x: 60, y: 318, w: 58, h: 74, tone: '#1D1030', cols: 4, rows: 5 },
  { x: 250, y: 296, w: 70, h: 96, tone: '#1A0F2B', cols: 5, rows: 6, roof: 'tank' },
  { x: 314, y: 322, w: 86, h: 70, tone: '#1D1030', cols: 6, rows: 4, roof: 'slope' },
];
// Middle row: the lecture hall and a hostel, closer and brighter.
const MID: Block[] = [
  { x: 108, y: 330, w: 104, h: 70, tone: '#150B22', cols: 8, rows: 4, roof: 'flat' },
  { x: 205, y: 342, w: 52, h: 58, tone: '#170C26', cols: 3, rows: 4 },
];

function windows(b: Block, seed: number, warm: string, cool: string) {
  const r = rng(seed);
  const out: React.ReactElement[] = [];
  const gx = b.w / (b.cols + 1);
  const gy = (b.h - 14) / (b.rows + 0.5);
  for (let i = 0; i < b.cols; i++) {
    for (let j = 0; j < b.rows; j++) {
      const v = r();
      if (v < 0.42) continue; // dark rooms
      const color = v > 0.9 ? cool : warm;
      out.push(<Rect key={`${i}-${j}`} x={b.x + gx * (i + 0.7)} y={b.y + 10 + gy * j} width={gx * 0.55} height={gy * 0.45} fill={color} opacity={0.55 + (v - 0.42) * 0.8} />);
    }
  }
  return out;
}

function Building({ b, seed, warm = '#FFB45C', cool = '#C084FC' }: { b: Block; seed: number; warm?: string; cool?: string }) {
  return (
    <G>
      <Rect x={b.x} y={b.y} width={b.w} height={b.h} fill={b.tone} />
      {b.roof === 'tank' && (
        <G>
          <Rect x={b.x + b.w * 0.6} y={b.y - 14} width={16} height={14} fill={b.tone} />
          <Rect x={b.x + b.w * 0.6 - 2} y={b.y - 17} width={20} height={4} fill={b.tone} />
        </G>
      )}
      {b.roof === 'slope' && <Polygon points={`${b.x},${b.y} ${b.x + b.w / 2},${b.y - 16} ${b.x + b.w},${b.y}`} fill={b.tone} />}
      {b.roof === 'flat' && <Rect x={b.x - 4} y={b.y - 5} width={b.w + 8} height={5} fill={b.tone} />}
      {windows(b, seed, warm, cool)}
    </G>
  );
}

function Tree({ x, y, s = 1, tone = '#0C1410' }: { x: number; y: number; s?: number; tone?: string }) {
  return (
    <G>
      <Rect x={x - 1.5 * s} y={y - 6 * s} width={3 * s} height={10 * s} fill="#07090A" />
      <Ellipse cx={x} cy={y - 16 * s} rx={13 * s} ry={15 * s} fill={tone} />
      <Ellipse cx={x - 7 * s} cy={y - 10 * s} rx={9 * s} ry={9 * s} fill={tone} />
      <Ellipse cx={x + 8 * s} cy={y - 11 * s} rx={9 * s} ry={10 * s} fill={tone} />
    </G>
  );
}

/** A street lamp with a soft pool of light on the path. */
function Lamp({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <G>
      <Ellipse cx={x} cy={y + 2 * s} rx={30 * s} ry={8 * s} fill="url(#lampPool)" />
      <Rect x={x - 1.2 * s} y={y - 46 * s} width={2.4 * s} height={48 * s} fill="#0A0A0E" />
      <Rect x={x - 1.2 * s} y={y - 46 * s} width={12 * s} height={2.4 * s} fill="#0A0A0E" />
      <Circle cx={x + 11 * s} cy={y - 42 * s} r={9 * s} fill="url(#lampGlow)" />
      <Circle cx={x + 11 * s} cy={y - 43 * s} r={2.4 * s} fill="#FFE2A8" />
    </G>
  );
}

/** `frame`: 'ground' keeps the path in view (tall boxes); 'horizon' frames the skyline (short banners). */
function CampusSceneImpl({ style, frame = 'ground' }: { style?: StyleProp<ViewStyle>; frame?: 'ground' | 'horizon' }) {
  return (
    <Svg viewBox={frame === 'horizon' ? `0 200 ${W} 240` : `0 0 ${W} ${H}`} preserveAspectRatio={frame === 'horizon' ? 'xMidYMid slice' : 'xMidYMax slice'} style={style} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Defs>
        <LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#07060C" />
          <Stop offset="0.3" stopColor="#1A0B2E" />
          <Stop offset="0.43" stopColor="#4A1450" />
          <Stop offset="0.51" stopColor="#9C2A5E" />
          <Stop offset="0.57" stopColor="#E8634A" />
          <Stop offset="0.63" stopColor="#FF9A4C" />
        </LinearGradient>
        <RadialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#FFD9A0" stopOpacity="1" />
          <Stop offset="0.45" stopColor="#FF9A4C" stopOpacity="0.9" />
          <Stop offset="1" stopColor="#FF5C7A" stopOpacity="0" />
        </RadialGradient>
        <LinearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#0E0916" />
          <Stop offset="1" stopColor="#050507" />
        </LinearGradient>
        <LinearGradient id="path" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#2A1A2E" />
          <Stop offset="1" stopColor="#14101A" />
        </LinearGradient>
        <RadialGradient id="lampGlow" cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#FFD08A" stopOpacity="0.9" />
          <Stop offset="1" stopColor="#FF9A4C" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="lampPool" cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#FFB45C" stopOpacity="0.35" />
          <Stop offset="1" stopColor="#FFB45C" stopOpacity="0" />
        </RadialGradient>
        <LinearGradient id="flood" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#E9FFB0" stopOpacity="0.28" />
          <Stop offset="1" stopColor="#E9FFB0" stopOpacity="0" />
        </LinearGradient>
      </Defs>

      {/* Sky and sunset */}
      <Rect x={0} y={0} width={W} height={H} fill="url(#sky)" />
      {[[40, 60], [120, 30], [300, 48], [350, 110], [210, 90], [80, 150], [260, 170], [330, 20]].map(([x, y], i) => (
        <Circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 1.3 : 0.9} fill="#FFFFFF" opacity={0.5} />
      ))}
      {/* The sun sets behind the lecture hall */}
      <Circle cx={170} cy={318} r={96} fill="url(#sun)" />
      <Circle cx={170} cy={322} r={26} fill="#FFC48A" opacity={0.9} />
      {/* Thin cloud bands */}
      <Path d="M0 250 Q 90 240 180 252 T 390 246 L 390 256 Q 300 262 190 258 T 0 262 Z" fill="#2B0F3A" opacity={0.55} />
      <Path d="M30 300 Q 140 290 230 302 T 390 296 L 390 302 Q 280 308 200 306 T 30 306 Z" fill="#5C1A4E" opacity={0.45} />

      {/* Horizon: blocks, then floodlights over the sports ground */}
      {BACK.map((b, i) => <Building key={`b${i}`} b={b} seed={11 + i * 7} />)}
      <G>
        <Rect x={350} y={250} width={2.5} height={120} fill="#0B0714" />
        <Rect x={341} y={246} width={20} height={8} fill="#0B0714" />
        <Polygon points="341,254 361,254 390,380 300,380" fill="url(#flood)" />
        <Rect x={18} y={262} width={2.5} height={108} fill="#0B0714" />
        <Rect x={9} y={258} width={20} height={8} fill="#0B0714" />
        <Polygon points="9,266 29,266 70,380 0,380" fill="url(#flood)" />
      </G>
      {MID.map((b, i) => <Building key={`m${i}`} b={b} seed={41 + i * 5} warm="#FFC46B" />)}

      {/* Ground, sports ground track and the lamp-lit path */}
      <Rect x={0} y={392} width={W} height={H - 392} fill="url(#ground)" />
      <Ellipse cx={330} cy={418} rx={84} ry={16} fill="none" stroke="#FF2D9B" strokeOpacity={0.35} strokeWidth={2} />
      <Ellipse cx={330} cy={418} rx={70} ry={11} fill="none" stroke="#FF2D9B" strokeOpacity={0.2} strokeWidth={1.5} />
      <Path d="M186 400 L 206 400 L 300 620 L 90 620 Z" fill="url(#path)" />
      <Path d="M196 404 L 196 420 M196 440 L 196 468 M196 500 L 196 548 M196 590 L 196 620" stroke="#D7FF1F" strokeOpacity={0.35} strokeWidth={2} />

      {/* Trees and lamps line the path */}
      <Tree x={40} y={420} s={1.1} />
      <Tree x={92} y={410} s={0.8} />
      <Tree x={250} y={412} s={0.85} tone="#0A120E" />
      <Tree x={372} y={450} s={1.4} />
      <Tree x={16} y={500} s={1.8} tone="#080C0A" />
      <Lamp x={160} y={432} s={0.7} />
      <Lamp x={236} y={440} s={0.75} />
      <Lamp x={120} y={500} s={1.05} />
      <Lamp x={276} y={512} s={1.1} />
      {/* Foreground vignette */}
      <Rect x={0} y={560} width={W} height={60} fill="#050507" opacity={0.6} />
    </Svg>
  );
}

export const CampusScene = memo(CampusSceneImpl);
