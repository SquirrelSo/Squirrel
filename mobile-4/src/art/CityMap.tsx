import React from 'react';
import { Animated } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { art } from './palette';

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

type P = { x: number; y: number };
type Cubic = [P, P, P, P];

const AnimatedPath = Animated.createAnimatedComponent(Path);

function useUid(): string {
  return React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n: number) => n.toFixed(1);

function bez(c: Cubic, t: number): P {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const cc = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * c[0].x + b * c[1].x + cc * c[2].x + d * c[3].x, y: a * c[0].y + b * c[1].y + cc * c[2].y + d * c[3].y };
}

/** Build cubic segments from a flat list: start, then [c1, c2, end] triples. */
function chain(start: [number, number], rest: [number, number][]): Cubic[] {
  const segs: Cubic[] = [];
  let prev: P = { x: start[0], y: start[1] };
  for (let i = 0; i + 2 < rest.length; i += 3) {
    const c1 = { x: rest[i][0], y: rest[i][1] };
    const c2 = { x: rest[i + 1][0], y: rest[i + 1][1] };
    const end = { x: rest[i + 2][0], y: rest[i + 2][1] };
    segs.push([prev, c1, c2, end]);
    prev = end;
  }
  return segs;
}

function chainToPath(segs: Cubic[]): string {
  if (!segs.length) return '';
  let d = `M${f(segs[0][0].x)} ${f(segs[0][0].y)}`;
  for (const s of segs) d += ` C${f(s[1].x)} ${f(s[1].y)} ${f(s[2].x)} ${f(s[2].y)} ${f(s[3].x)} ${f(s[3].y)}`;
  return d;
}

/** Evenly-ish sampled points with cumulative arc length. */
function sampleChain(segs: Cubic[], perSeg = 40): { pts: P[]; cum: number[]; total: number } {
  const pts: P[] = [];
  segs.forEach((s, si) => {
    for (let i = si === 0 ? 0 : 1; i <= perSeg; i++) pts.push(bez(s, i / perSeg));
  });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, cum, total: cum[cum.length - 1] };
}

function pointAt(s: { pts: P[]; cum: number[]; total: number }, frac: number): P {
  const target = Math.max(0, Math.min(1, frac)) * s.total;
  let i = 1;
  while (i < s.cum.length - 1 && s.cum[i] < target) i++;
  const seg = s.cum[i] - s.cum[i - 1] || 1;
  const t = (target - s.cum[i - 1]) / seg;
  return { x: s.pts[i - 1].x + (s.pts[i].x - s.pts[i - 1].x) * t, y: s.pts[i - 1].y + (s.pts[i].y - s.pts[i - 1].y) * t };
}

function circ(cx: number, cy: number, r: number): string {
  return `M${f(cx - r)} ${f(cy)} a${r} ${r} 0 1 0 ${f(2 * r)} 0 a${r} ${r} 0 1 0 ${f(-2 * r)} 0 Z`;
}

/** Subscribe to an Animated.Value (or pass a number through). */
function useProgressNumber(progress: Animated.Value | number | undefined, fallback: number): number {
  const isAnim = progress instanceof Animated.Value;
  const initial = isAnim
    ? ((progress as unknown as { __getValue?: () => number }).__getValue?.() ?? fallback)
    : typeof progress === 'number'
      ? progress
      : fallback;
  const [val, setVal] = React.useState<number>(initial);
  React.useEffect(() => {
    if (!(progress instanceof Animated.Value)) return undefined;
    const id = progress.addListener(({ value }) => {
      const r = Math.round(value * 400) / 400;
      setVal((prev) => (prev === r ? prev : r));
    });
    return () => progress.removeListener(id);
  }, [progress]);
  return isAnim ? val : typeof progress === 'number' ? progress : fallback;
}

/* ------------------------------------------------------------------ */
/* City map                                                            */
/* ------------------------------------------------------------------ */

export const MAP_VIEWBOX = { width: 400, height: 600 };

const RIVER = chain(
  [-40, 446],
  [
    [70, 420],
    [120, 335],
    [200, 322],
    [280, 309],
    [320, 250],
    [440, 222],
  ],
);
const RIVER_S = sampleChain(RIVER, 30);
const RIVER_HALF = (i: number) => 25 + 5 * Math.sin(i * 0.21);

type Park = { cx: number; cy: number; rx: number; ry: number; seed: number };
const PARKS: Park[] = [
  { cx: 96, cy: 150, rx: 72, ry: 56, seed: 11 },
  { cx: 300, cy: 452, rx: 62, ry: 50, seed: 23 },
  { cx: 336, cy: 104, rx: 42, ry: 34, seed: 37 },
];
const POND = { cx: 62, cy: 128, rx: 17, ry: 10 };

const ROUTE = chain(
  [300, 478],
  [
    [282, 446],
    [252, 424],
    [230, 406],
    [214, 394],
    [206, 382],
    [204, 368],
    [202, 340],
    [200, 305],
    [199, 284],
    [197, 266],
    [176, 290],
    [150, 302],
    [124, 314],
    [96, 328],
    [74, 318],
    [50, 306],
    [44, 262],
    [56, 234],
    [66, 206],
    [70, 186],
    [88, 176],
    [110, 164],
    [138, 176],
    [146, 150],
    [152, 128],
    [132, 108],
    [108, 110],
  ],
);
const ROUTE_D = chainToPath(ROUTE);
const ROUTE_S = sampleChain(ROUTE, 30);
const ROUTE_LEN = Math.ceil(ROUTE_S.total) + 2;

export const mapRoutePoints: { x: number; y: number }[] = [0, 0.14, 0.28, 0.42, 0.56, 0.7, 0.85, 1].map((t) => {
  const p = pointAt(ROUTE_S, t);
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
});

function inRiver(x: number, y: number, pad: number): boolean {
  const { pts } = RIVER_S;
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(pts[i].x - x, pts[i].y - y) < RIVER_HALF(i) + pad) return true;
  }
  return false;
}

function inPark(x: number, y: number, scale: number): boolean {
  return PARKS.some((p) => ((x - p.cx) / (p.rx * scale)) ** 2 + ((y - p.cy) / (p.ry * scale)) ** 2 < 1);
}

function riverPath(): { body: string; north: string; south: string } {
  const { pts } = RIVER_S;
  const left: P[] = [];
  const right: P[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l;
    const ny = dx / l;
    const w = RIVER_HALF(i);
    left.push({ x: pts[i].x + nx * w, y: pts[i].y + ny * w });
    right.push({ x: pts[i].x - nx * w, y: pts[i].y - ny * w });
  }
  const line = (arr: P[]) => arr.map((p, i) => `${i === 0 ? 'M' : 'L'}${f(p.x)} ${f(p.y)}`).join(' ');
  const body = line(left) + ' ' + right.slice().reverse().map((p) => `L${f(p.x)} ${f(p.y)}`).join(' ') + ' Z';
  return { body, north: line(right), south: line(left) };
}

function parkPath(p: Park): string {
  const rnd = mulberry32(p.seed);
  const k1 = rnd() * 6;
  const k2 = rnd() * 6;
  let d = '';
  const n = 48;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const wob = 1 + 0.06 * Math.sin(a * 3 + k1) + 0.04 * Math.sin(a * 5 + k2);
    d += `${i === 0 ? 'M' : 'L'}${f(p.cx + Math.cos(a) * p.rx * wob)} ${f(p.cy + Math.sin(a) * p.ry * wob)} `;
  }
  return d + 'Z';
}

type MapGeo = {
  river: { body: string; north: string; south: string };
  parks: string[];
  trees: [string, string];
  streets: string;
  blocks: [string, string, string];
  windows: [string, string, string];
  avenues: string[];
};

const THETA = (-14 * Math.PI) / 180;
const COS = Math.cos(THETA);
const SIN = Math.sin(THETA);
const toWorld = (u: number, v: number): P => ({ x: 200 + u * COS - v * SIN, y: 300 + u * SIN + v * COS });

function buildMap(seed: number): MapGeo {
  const rnd = mulberry32(seed * 7919 + 17);
  const EXT = 400;

  // grid lines in rotated (u, v) space
  const us: number[] = [];
  for (let u = -EXT; u <= EXT; u += 50) us.push(u + (rnd() - 0.5) * 12);
  const vs: number[] = [];
  for (let v = -EXT; v <= EXT; v += 44) vs.push(v + (rnd() - 0.5) * 10);

  let streets = '';
  for (const u of us) {
    const a = toWorld(u, -EXT);
    const b = toWorld(u, EXT);
    streets += `M${f(a.x)} ${f(a.y)} L${f(b.x)} ${f(b.y)} `;
  }
  for (const v of vs) {
    const a = toWorld(-EXT, v);
    const b = toWorld(EXT, v);
    streets += `M${f(a.x)} ${f(a.y)} L${f(b.x)} ${f(b.y)} `;
  }

  const blocks: [string, string, string] = ['', '', ''];
  const windows: [string, string, string] = ['', '', ''];
  const inset = 7;
  const quad = (u0: number, v0: number, u1: number, v1: number, bucket: number, lit: boolean) => {
    const j = () => (rnd() - 0.5) * 3;
    const c = [toWorld(u0 + j(), v0 + j()), toWorld(u1 + j(), v0 + j()), toWorld(u1 + j(), v1 + j()), toWorld(u0 + j(), v1 + j())];
    const cx = (c[0].x + c[2].x) / 2;
    const cy = (c[0].y + c[2].y) / 2;
    if (c.every((p) => p.x < -30 || p.x > 430 || p.y < -30 || p.y > 630)) return;
    if (c.some((p) => inRiver(p.x, p.y, 7)) || inRiver(cx, cy, 7)) return;
    if (c.some((p) => inPark(p.x, p.y, 1.1)) || inPark(cx, cy, 1.15)) return;
    blocks[bucket] += `M${f(c[0].x)} ${f(c[0].y)} L${f(c[1].x)} ${f(c[1].y)} L${f(c[2].x)} ${f(c[2].y)} L${f(c[3].x)} ${f(c[3].y)} Z `;
    if (lit) {
      const n = 2 + Math.floor(rnd() * 6);
      for (let k = 0; k < n; k++) {
        const pu = u0 + 3 + rnd() * (u1 - u0 - 6);
        const pv = v0 + 3 + rnd() * (v1 - v0 - 6);
        const p = toWorld(pu, pv);
        const r = rnd();
        const which = r < 0.55 ? 0 : r < 0.82 ? 1 : 2;
        windows[which] += `M${f(p.x)} ${f(p.y)} h1.8 v1.8 h-1.8 Z `;
      }
    }
  };

  for (let i = 0; i < us.length - 1; i++) {
    for (let k = 0; k < vs.length - 1; k++) {
      const u0 = us[i] + inset;
      const u1 = us[i + 1] - inset;
      const v0 = vs[k] + inset;
      const v1 = vs[k + 1] - inset;
      const bucket = Math.floor(rnd() * 3);
      const lit = rnd() < 0.5;
      const split = rnd();
      if (split < 0.3) {
        const m = (u0 + u1) / 2;
        quad(u0, v0, m - 2.5, v1, bucket, lit);
        quad(m + 2.5, v0, u1, v1, (bucket + 1) % 3, lit);
      } else if (split < 0.5) {
        const m = (v0 + v1) / 2;
        quad(u0, v0, u1, m - 2.5, bucket, lit);
        quad(u0, m + 2.5, u1, v1, (bucket + 2) % 3, lit);
      } else {
        quad(u0, v0, u1, v1, bucket, lit);
      }
    }
  }

  // trees
  const trees: [string, string] = ['', ''];
  PARKS.forEach((p) => {
    const tr = mulberry32(p.seed * 31 + seed);
    const count = Math.round((p.rx * p.ry) / 90);
    for (let i = 0; i < count; i++) {
      const a = tr() * Math.PI * 2;
      const r = Math.sqrt(tr()) * 0.86;
      const x = p.cx + Math.cos(a) * p.rx * r;
      const y = p.cy + Math.sin(a) * p.ry * r;
      if (((x - POND.cx) / (POND.rx + 4)) ** 2 + ((y - POND.cy) / (POND.ry + 4)) ** 2 < 1) continue;
      trees[tr() < 0.6 ? 0 : 1] += circ(x, y, 1.6 + tr() * 2.2) + ' ';
    }
  });

  // neon avenues (pink) along chosen grid lines
  const nearest = (arr: number[], target: number) => arr.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best), arr[0]);
  const avenues: string[] = [];
  const uA = nearest(us, -95);
  const uB = nearest(us, 150);
  const vA = nearest(vs, -130);
  const vB = nearest(vs, 205);
  for (const u of [uA, uB]) {
    const a = toWorld(u, -EXT);
    const b = toWorld(u, EXT);
    avenues.push(`M${f(a.x)} ${f(a.y)} L${f(b.x)} ${f(b.y)}`);
  }
  for (const v of [vA, vB]) {
    const a = toWorld(-EXT, v);
    const b = toWorld(EXT, v);
    avenues.push(`M${f(a.x)} ${f(a.y)} L${f(b.x)} ${f(b.y)}`);
  }

  return { river: riverPath(), parks: PARKS.map(parkPath), trees, streets, blocks, windows, avenues };
}

/** cyan boulevard crossing the river over the bridge */
const CYAN_AVE = 'M178 -10 C186 120 196 220 200 322 C204 420 212 520 222 612';
const BRIDGE_D = 'M190.5 270 L210 270 L212 376 L192.5 376 Z';

function Neon({ d, color, core = '#FFFFFF', w = 1 }: { d: string; color: string; core?: string; w?: number }) {
  return (
    <G>
      <Path d={d} stroke={color} strokeOpacity={0.1} strokeWidth={18 * w} fill="none" strokeLinecap="round" />
      <Path d={d} stroke={color} strokeOpacity={0.25} strokeWidth={8 * w} fill="none" strokeLinecap="round" />
      <Path d={d} stroke={color} strokeWidth={3 * w} fill="none" strokeLinecap="round" />
      <Path d={d} stroke={core} strokeOpacity={0.7} strokeWidth={1 * w} fill="none" strokeLinecap="round" />
    </G>
  );
}

export const CityMap = React.memo(function CityMap(props: {
  seed?: number;
  style?: StyleProp<ViewStyle>;
  route?: boolean;
  routeProgress?: Animated.Value | number;
}) {
  const { seed = 7, style, route = false, routeProgress } = props;
  const uid = useUid();
  const geo = React.useMemo(() => buildMap(seed), [seed]);

  const offset = React.useMemo<Animated.AnimatedInterpolation<number> | number>(() => {
    if (routeProgress instanceof Animated.Value) {
      return routeProgress.interpolate({ inputRange: [0, 1], outputRange: [ROUTE_LEN, 0], extrapolate: 'clamp' });
    }
    const p = typeof routeProgress === 'number' ? Math.max(0, Math.min(1, routeProgress)) : 1;
    return ROUTE_LEN * (1 - p);
  }, [routeProgress]);

  const start = ROUTE_S.pts[0];
  const end = ROUTE_S.pts[ROUTE_S.pts.length - 1];
  const dash = [ROUTE_LEN, ROUTE_LEN];

  return (
    <Svg width="100%" height="100%" viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice" style={style}>
      <Defs>
        <LinearGradient id={`${uid}park`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#0F3A2C" />
          <Stop offset="1" stopColor="#145A3E" />
        </LinearGradient>
        <LinearGradient id={`${uid}water`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#0B2F40" />
          <Stop offset="0.5" stopColor="#0D3B4E" />
          <Stop offset="1" stopColor="#0A2A3C" />
        </LinearGradient>
        <RadialGradient id={`${uid}vig`} cx="0.5" cy="0.5" r="0.75">
          <Stop offset="0.55" stopColor="#0B0A18" stopOpacity={0} />
          <Stop offset="1" stopColor="#05040C" stopOpacity={0.75} />
        </RadialGradient>
        <RadialGradient id={`${uid}glow`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor={art.purple} stopOpacity={0.22} />
          <Stop offset="1" stopColor={art.purple} stopOpacity={0} />
        </RadialGradient>
      </Defs>

      {/* base */}
      <Rect x={-20} y={-20} width={440} height={640} fill="#0B0A18" />
      <Ellipse cx={230} cy={300} rx={260} ry={300} fill={`url(#${uid}glow)`} />

      {/* streets + blocks */}
      <Path d={geo.streets} stroke="#2B2140" strokeWidth={1.6} fill="none" />
      <Path d={geo.blocks[0]} fill="#15122B" stroke="#15122B" strokeWidth={5} strokeLinejoin="round" />
      <Path d={geo.blocks[1]} fill="#1A1633" stroke="#1A1633" strokeWidth={5} strokeLinejoin="round" />
      <Path d={geo.blocks[2]} fill="#201A3D" stroke="#201A3D" strokeWidth={5} strokeLinejoin="round" />
      <Path d={geo.windows[0]} fill={art.amber} opacity={0.55} />
      <Path d={geo.windows[1]} fill={art.pinkHi} opacity={0.55} />
      <Path d={geo.windows[2]} fill={art.cyan} opacity={0.5} />

      {/* pink neon avenues */}
      {geo.avenues.map((d, i) => (
        <Neon key={i} d={d} color={art.pink} w={i < 2 ? 1 : 0.85} />
      ))}

      {/* parks */}
      {geo.parks.map((d, i) => (
        <G key={i}>
          <Path d={d} fill="#145A3E" opacity={0.25} stroke="#1E7A55" strokeOpacity={0.35} strokeWidth={6} strokeLinejoin="round" />
          <Path d={d} fill={`url(#${uid}park)`} stroke="#1E7A55" strokeWidth={1.2} strokeLinejoin="round" />
        </G>
      ))}
      <Path d={geo.trees[0]} fill="#1B6B49" />
      <Path d={geo.trees[1]} fill="#26875C" />
      <Ellipse cx={POND.cx} cy={POND.cy} rx={POND.rx} ry={POND.ry} fill="#0D3B4E" stroke="#1FA3B8" strokeOpacity={0.6} strokeWidth={1.5} />

      {/* water */}
      <Path d={geo.river.body} fill={`url(#${uid}water)`} />
      <Path d={geo.river.north} stroke="#1FA3B8" strokeOpacity={0.18} strokeWidth={7} fill="none" />
      <Path d={geo.river.south} stroke="#1FA3B8" strokeOpacity={0.18} strokeWidth={7} fill="none" />
      <Path d={geo.river.north} stroke="#27C3D6" strokeOpacity={0.7} strokeWidth={1.4} fill="none" />
      <Path d={geo.river.south} stroke="#27C3D6" strokeOpacity={0.7} strokeWidth={1.4} fill="none" />
      <Path
        d="M40 402 C70 392 90 380 100 368 M150 344 C170 336 186 332 196 331 M250 300 C270 296 290 284 305 270 M330 250 C350 243 370 238 392 234"
        stroke="#35DFFF"
        strokeOpacity={0.22}
        strokeWidth={1.2}
        strokeDasharray="6 8"
        fill="none"
      />

      {/* bridge + cyan boulevard */}
      <Path d={BRIDGE_D} transform="translate(2 3)" fill="#000000" opacity={0.5} />
      <Path d={BRIDGE_D} fill="#2A2246" stroke="#3E3363" strokeWidth={1.5} strokeLinejoin="round" />
      <Path d="M190.5 272 L192.5 374 M210 272 L212 374" stroke={art.violet} strokeWidth={1.4} strokeOpacity={0.9} />
      <Path d={`${circ(191, 290, 1.4)} ${circ(191.6, 312, 1.4)} ${circ(192, 334, 1.4)} ${circ(192.3, 356, 1.4)} ${circ(210.5, 290, 1.4)} ${circ(211, 312, 1.4)} ${circ(211.4, 334, 1.4)} ${circ(211.8, 356, 1.4)}`} fill={art.sunTop} />
      <Neon d={CYAN_AVE} color={art.cyan} w={0.9} />

      <Rect x={-20} y={-20} width={440} height={640} fill={`url(#${uid}vig)`} />

      {/* running route */}
      {route ? (
        <G>
          <Path d={ROUTE_D} stroke={art.lime} strokeOpacity={0.14} strokeWidth={3} fill="none" strokeDasharray="2 5" strokeLinecap="round" />
          <AnimatedPath d={ROUTE_D} stroke={art.lime} strokeOpacity={0.16} strokeWidth={16} fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} strokeDashoffset={offset} />
          <AnimatedPath d={ROUTE_D} stroke={art.lime} strokeOpacity={0.4} strokeWidth={8} fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} strokeDashoffset={offset} />
          <AnimatedPath d={ROUTE_D} stroke={art.lime} strokeWidth={4} fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} strokeDashoffset={offset} />
          <AnimatedPath d={ROUTE_D} stroke="#FFE1F3" strokeWidth={1.3} fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} strokeDashoffset={offset} />

          {/* start */}
          <Circle cx={start.x} cy={start.y} r={11} fill={art.lime} opacity={0.18} />
          <Circle cx={start.x} cy={start.y} r={8} fill="none" stroke="#FFFFFF" strokeWidth={1.8} strokeDasharray="3 2.5" />
          <Circle cx={start.x} cy={start.y} r={4} fill={art.lime} stroke="#FFFFFF" strokeWidth={1.4} />

          {/* finish flag */}
          <Circle cx={end.x} cy={end.y} r={10} fill={art.pink} opacity={0.18} />
          <Circle cx={end.x} cy={end.y} r={4.5} fill="#FFFFFF" stroke={art.lime} strokeWidth={2} />
          <Path d={`M${f(end.x)} ${f(end.y)} V${f(end.y - 22)}`} stroke="#FFFFFF" strokeWidth={1.8} strokeLinecap="round" />
          <Path
            d={`M${f(end.x)} ${f(end.y - 22)} h14 l-3.5 5 l3.5 5 h-14 Z`}
            fill={art.lime}
            stroke="#FFFFFF"
            strokeWidth={1.2}
            strokeLinejoin="round"
          />
          <Path d={`M${f(end.x + 3.5)} ${f(end.y - 22)} h3.5 v5 h-3.5 Z M${f(end.x + 7)} ${f(end.y - 17)} h3.5 v5 h-3.5 Z`} fill="#FFFFFF" opacity={0.85} />
        </G>
      ) : null}
    </Svg>
  );
});

/* ------------------------------------------------------------------ */
/* Run route (live running overlay)                                    */
/* ------------------------------------------------------------------ */

const HORIZON = 330;
const RUN_SEGS = chain(
  [58, 740],
  [
    [150, 660],
    [320, 612],
    [284, 546],
    [258, 498],
    [140, 484],
    [160, 432],
    [174, 396],
    [252, 392],
    [244, 362],
    [238, 344],
    [226, 338],
    [230, HORIZON],
  ],
);
const RUN_S = sampleChain(RUN_SEGS, 50);

export const RUN_ROUTE_HEAD = { x: 230, y: HORIZON };

function widthAt(y: number): number {
  const t = Math.max(0, Math.min(1, (y - HORIZON) / (740 - HORIZON)));
  return 1.6 + 44 * Math.pow(t, 1.45);
}

/** Tapered ribbon polygon covering arc-length fraction [a, b] of the run route. */
function ribbon(a: number, b: number, scale: number): string {
  const { pts, cum, total } = RUN_S;
  const from = a * total;
  const to = b * total;
  const sel: P[] = [pointAt(RUN_S, a)];
  for (let i = 0; i < pts.length; i++) if (cum[i] > from && cum[i] < to) sel.push(pts[i]);
  sel.push(pointAt(RUN_S, b));
  if (sel.length < 2) return '';
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i < sel.length; i++) {
    const p0 = sel[Math.max(0, i - 1)];
    const p1 = sel[Math.min(sel.length - 1, i + 1)];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const l = Math.hypot(dx, dy) || 1;
    // flatten the ribbon vertically a bit: it lies on the ground plane
    const nx = -dy / l;
    const ny = (dx / l) * 0.55;
    const w = (widthAt(sel[i].y) * scale) / 2;
    left.push(`${f(sel[i].x + nx * w)} ${f(sel[i].y + ny * w)}`);
    right.push(`${f(sel[i].x - nx * w)} ${f(sel[i].y - ny * w)}`);
  }
  return `M${left.join(' L')} L${right.reverse().join(' L')} Z`;
}

export const RunRoute = React.memo(function RunRoute(props: { progress?: Animated.Value | number; style?: StyleProp<ViewStyle> }) {
  const { progress, style } = props;
  const p = Math.max(0, Math.min(1, useProgressNumber(progress, 0.62)));
  const uid = useUid();

  const shapes = React.useMemo(() => {
    const full = ribbon(0, 1, 1);
    const done = p > 0.001 ? ribbon(0, p, 1) : '';
    const glow = p > 0.001 ? ribbon(0, p, 2.6) : '';
    const core = p > 0.001 ? ribbon(0, p, 0.3) : '';
    const ahead = p < 0.999 ? ribbon(p, 1, 0.25) : '';
    return { full, done, glow, core, ahead };
  }, [p]);

  const head = pointAt(RUN_S, p);
  const hw = Math.max(5, widthAt(head.y) * 0.42);

  return (
    <Svg width="100%" height="100%" viewBox="0 0 400 700" preserveAspectRatio="xMidYMid slice" style={style}>
      <Defs>
        <LinearGradient id={`${uid}fade`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={art.lime} stopOpacity={0.35} />
          <Stop offset="1" stopColor={art.lime} stopOpacity={1} />
        </LinearGradient>
        <RadialGradient id={`${uid}hg`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor={art.lime} stopOpacity={0.7} />
          <Stop offset="1" stopColor={art.lime} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {/* whole route, faint */}
      <Path d={shapes.full} fill={art.lime} opacity={0.2} />
      {shapes.ahead ? <Path d={shapes.ahead} fill={art.lime} opacity={0.6} /> : null}
      {/* completed part: glow + body + hot core */}
      {shapes.glow ? <Path d={shapes.glow} fill={art.lime} opacity={0.16} /> : null}
      {shapes.done ? <Path d={shapes.done} fill={`url(#${uid}fade)`} /> : null}
      {shapes.core ? <Path d={shapes.core} fill="#FFE6F5" opacity={0.85} /> : null}

      {/* current position */}
      <Ellipse cx={head.x} cy={head.y} rx={hw * 3.2} ry={hw * 2.2} fill={`url(#${uid}hg)`} />
      <Circle cx={head.x} cy={head.y} r={hw * 1.35} fill={art.lime} opacity={0.3} />
      <Circle cx={head.x} cy={head.y} r={hw} fill="#FFFFFF" />
      <Circle cx={head.x} cy={head.y} r={hw * 0.66} fill={art.purple} />
      <Circle cx={head.x - hw * 0.2} cy={head.y - hw * 0.22} r={hw * 0.2} fill="#FFFFFF" opacity={0.7} />
    </Svg>
  );
});

export default CityMap;
