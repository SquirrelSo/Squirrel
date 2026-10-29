/**
 * <Scene kind="…" /> — cinematic neon-city vector backdrops.
 *
 * The viewBox is always 400 wide and 400/aspect tall; every composition is
 * laid out relative to that height so it works from wide banners (1.8) to
 * full phone screens (0.46). Geometry is seeded + memoised.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, Path, Rect } from 'react-native-svg';
import type { SceneKind } from '@/types';
import { art } from './palette';
import {
  circleD,
  clamp,
  Ctx,
  dotsD,
  ellipseD,
  f,
  Glow,
  lerp,
  lineD,
  makeRng,
  palmD,
  Person,
  type PoseName,
  polyD,
  type Pt,
  quad,
  rectD,
  type SkyResult,
  skyline,
  SkylineLayer,
  type Stops,
  treeD,
  type Hair,
} from './sceneParts';

type Node = React.ReactElement;

/* ================================================================ moods */

interface Mood {
  sky: Stops;
  far: readonly [string, string];
  mid: readonly [string, string];
  near: readonly [string, string];
  haze: string;
  water: Stops;
  win: ReadonlyArray<readonly [string, number]>;
  lit: number;
}

const SUNSET: Mood = {
  sky: [
    [0, art.night1],
    [0.25, art.dusk],
    [0.5, art.magenta],
    [0.72, art.coral],
    [0.88, art.orange],
    [1, art.amber],
  ],
  far: ['#5A2A78', '#A2407E'],
  mid: ['#2E1246', '#4C1A58'],
  near: ['#170A26', '#0D0617'],
  haze: '#FF6E7A',
  water: [
    [0, '#C23A72'],
    [0.2, '#6A1A5A'],
    [0.6, '#2A0C3A'],
    [1, art.night1],
  ],
  win: [
    [art.pinkHi, 3],
    [art.cyan, 2],
    [art.amber, 4],
  ],
  lit: 0.32,
};

const NIGHT: Mood = {
  sky: [
    [0, art.night0],
    [0.45, art.night1],
    [0.78, art.night2],
    [1, '#52165A'],
  ],
  far: ['#241238', '#3A1650'],
  mid: ['#22103A', '#2E1646'],
  near: ['#0D0718', '#0A0512'],
  haze: art.magenta,
  water: [
    [0, '#3A1048'],
    [0.4, '#1A0A28'],
    [1, art.night0],
  ],
  win: [
    [art.pinkHi, 3],
    [art.cyan, 3],
    [art.amber, 3],
    [art.violet, 1],
  ],
  lit: 0.58,
};

const DAWN: Mood = {
  sky: [
    [0, '#3B2C63'],
    [0.35, '#7B6AA8'],
    [0.62, '#C99BC6'],
    [0.84, '#FFBFA0'],
    [1, '#FFE3B8'],
  ],
  far: ['#A690C4', '#D2B2D2'],
  mid: ['#6E5A94', '#937AB0'],
  near: ['#3A2C56', '#46345F'],
  haze: '#FFF1E6',
  water: [
    [0, '#F4C2B4'],
    [0.3, '#A58BC0'],
    [1, '#3A2A58'],
  ],
  win: [
    [art.amber, 5],
    [art.sunTop, 2],
    [art.pinkHi, 1],
  ],
  lit: 0.07,
};

/* ============================================================ building blocks */

function skyEl(c: Ctx, stops: Stops, y2: number): Node {
  return <Rect x={-2} y={-2} width={404} height={y2 + 4} fill={c.lin(stops)} />;
}

function starsEl(c: Ctx, n: number, yMax: number, op = 0.85): Node {
  const small: Pt[] = [];
  const big: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p: Pt = [c.r() * 400, Math.pow(c.r(), 1.3) * yMax];
    (c.r() < 0.18 ? big : small).push(p);
  }
  return (
    <G opacity={op}>
      <Path d={dotsD(small)} stroke={art.cloud} strokeWidth={1.1} strokeLinecap="round" opacity={0.7} />
      <Path d={dotsD(big)} stroke={art.white} strokeWidth={4} strokeLinecap="round" opacity={0.18} />
      <Path d={dotsD(big)} stroke={art.white} strokeWidth={1.8} strokeLinecap="round" />
    </G>
  );
}

function sunEl(c: Ctx, cx: number, cy: number, R: number, o: { cut?: boolean; top?: string; bottom?: string; glow?: string; glowR?: number } = {}): Node {
  const top = o.top ?? art.sunTop;
  const bottom = o.bottom ?? art.sunBottom;
  const glow = c.rad([
    [0, o.glow ?? art.orange, 0.55],
    [0.35, o.glow ?? art.coral, 0.22],
    [1, o.glow ?? art.coral, 0],
  ]);
  const fill = c.lin([
    [0, top],
    [0.55, art.orange],
    [1, bottom],
  ]);
  let clip: string | undefined;
  if (o.cut) {
    const id = c.id();
    const parts: string[] = [rectD(cx - R - 2, cy - R - 2, 2 * R + 4, R * 1.02)];
    let y = cy + R * 0.02;
    let band = R * 0.16;
    let gap = R * 0.035;
    while (y < cy + R) {
      y += gap;
      parts.push(rectD(cx - R - 2, y, 2 * R + 4, band));
      y += band;
      band *= 0.78;
      gap *= 1.32;
    }
    c.add(
      <ClipPath key={id} id={id}>
        <Path d={parts.join('')} />
      </ClipPath>,
    );
    clip = `url(#${id})`;
  }
  const gR = R * (o.glowR ?? 2.6);
  return (
    <G>
      <Circle cx={cx} cy={cy} r={gR} fill={glow} />
      <Circle cx={cx} cy={cy} r={R} fill={fill} clipPath={clip} />
    </G>
  );
}

/** Long thin synthwave cloud streaks. */
function cloudsEl(c: Ctx, yA: number, yB: number, colors: readonly [string, string], n = 5): Node {
  const d: [string[], string[]] = [[], []];
  for (let i = 0; i < n; i++) {
    const y = lerp(yA, yB, (i + c.r() * 0.6) / n);
    const w = 80 + c.r() * 170;
    const x = -40 + c.r() * 380;
    const h = 2 + c.r() * 4;
    const rr = h / 2;
    d[i % 2].push(`M${f(x)} ${f(y)}h${f(w)}a${f(rr)} ${f(rr)} 0 0 1 0 ${f(h)}h${f(-w)}a${f(rr)} ${f(rr)} 0 0 1 0 ${f(-h)}z`);
  }
  return (
    <G>
      <Path d={d[0].join('')} fill={colors[0]} opacity={0.55} />
      <Path d={d[1].join('')} fill={colors[1]} opacity={0.45} />
    </G>
  );
}

interface City {
  el: Node;
  far: SkyResult;
  mid: SkyResult;
  near?: SkyResult;
  hmax: number;
}

function cityEl(
  c: Ctx,
  m: Mood,
  hy: number,
  o: { scale?: number; valley?: number; valleyX?: number; layers?: 2 | 3; lit?: number; x0?: number; x1?: number } = {},
): City {
  const hmax = clamp(hy * 0.72, 50, 200) * (o.scale ?? 1);
  const lit = o.lit ?? m.lit;
  const v = o.valley ?? 0.45;
  const base = { valleyX: o.valleyX, x0: o.x0, x1: o.x1 };
  const far = skyline(c.r, {
    ...base,
    base: hy,
    minH: hmax * 0.32,
    maxH: hmax * 0.85,
    wMin: 11,
    wMax: 26,
    valley: v,
    domes: true,
    win: { w: 1.2, h: 1.6, sx: 4, sy: 5, lit: lit * 0.22, palette: m.win },
  });
  const mid = skyline(c.r, {
    ...base,
    base: hy,
    minH: hmax * 0.18,
    maxH: hmax * 0.62,
    wMin: 15,
    wMax: 32,
    valley: v * 0.6,
    domes: true,
    win: { w: 1.7, h: 2.3, sx: 4.4, sy: 5.8, lit: lit * 0.6, palette: m.win },
  });
  const layers = o.layers ?? 3;
  const near =
    layers === 3
      ? skyline(c.r, {
          ...base,
          base: hy + 1,
          minH: hmax * 0.1,
          maxH: hmax * 0.4,
          wMin: 20,
          wMax: 42,
          valley: v * 0.7,
          win: { w: 2.3, h: 3.1, sx: 5.4, sy: 7.2, lit, palette: m.win },
        })
      : undefined;
  const haze = c.lin([
    [0, m.haze, 0],
    [1, m.haze, 0.38],
  ]);
  const el = (
    <G>
      <SkylineLayer sky={far} fill={c.lin([[0, m.far[0]], [1, m.far[1]]])} winOpacity={0.55} />
      <Rect x={-2} y={hy - hmax * 0.55} width={404} height={hmax * 0.55 + 1} fill={haze} />
      <SkylineLayer sky={mid} fill={c.lin([[0, m.mid[0]], [1, m.mid[1]]])} winOpacity={0.75} />
      {near && <Rect x={-2} y={hy - hmax * 0.25} width={404} height={hmax * 0.25 + 1} fill={haze} opacity={0.6} />}
      {near && <SkylineLayer sky={near} fill={c.lin([[0, m.near[0]], [1, m.near[1]]])} />}
    </G>
  );
  return { el, far, mid, near, hmax };
}

/** Mirror a skyline into water below the horizon. */
function reflectEl(sky: SkyResult, hy: number, fill: string, op: number, winOp = 0.35, squash = 0.55): Node {
  return (
    <G transform={`translate(0 ${f(hy)}) scale(1 ${-squash}) translate(0 ${f(-hy)})`}>
      <Path d={sky.body} fill={fill} opacity={op} />
      {sky.win.map(([col, d]) => (
        <Path key={col} d={d} fill={col} opacity={winOp} />
      ))}
    </G>
  );
}

/** Broken horizontal glitter streaks (sun on water). */
function streaksEl(c: Ctx, cx: number, w0: number, y1: number, y2: number, cols: readonly [string, string], spread = 1): Node {
  const a: string[] = [];
  const b: string[] = [];
  let y = y1 + 2;
  let i = 0;
  while (y < y2) {
    const t = (y - y1) / Math.max(1, y2 - y1);
    const half = w0 * lerp(0.75, 1.1 * spread, t) * (0.6 + c.r() * 0.5);
    const segs = 1 + Math.floor(c.r() * 3);
    for (let s = 0; s < segs; s++) {
      const len = half * (0.2 + c.r() * 0.55);
      const sx = cx - half + c.r() * (2 * half - len);
      (i % 2 ? a : b).push(`M${f(sx)} ${f(y)}h${f(len)}`);
    }
    y += 2.4 + t * 5 + c.r() * 1.5;
    i++;
  }
  return (
    <G>
      <Path d={a.join('')} stroke={cols[0]} strokeWidth={1.7} strokeLinecap="round" opacity={0.85} />
      <Path d={b.join('')} stroke={cols[1]} strokeWidth={1.3} strokeLinecap="round" opacity={0.75} />
    </G>
  );
}

function ripplesEl(c: Ctx, y1: number, y2: number, color: string, n = 16, op = 0.18): Node {
  const d: string[] = [];
  for (let i = 0; i < n; i++) {
    const y = lerp(y1, y2, Math.pow(c.r(), 0.8));
    d.push(`M${f(c.r() * 400 - 30)} ${f(y)}h${f(15 + c.r() * 60)}`);
  }
  return <Path d={d.join('')} stroke={color} strokeWidth={0.9} strokeLinecap="round" opacity={op} />;
}

function vignetteEl(c: Ctx, strength = 0.55): Node {
  const g = c.rad([
    [0, art.night0, 0],
    [0.62, art.night0, 0],
    [1, art.night0, strength],
  ], 0.5, 0.5, 0.75);
  return <Rect x={-2} y={-2} width={404} height={c.H + 4} fill={g} />;
}

function birdsEl(c: Ctx, cx: number, cy: number, n: number, sc: number, color: string): Node {
  const d: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = cx + (c.r() - 0.5) * 90 * sc;
    const y = cy + (c.r() - 0.5) * 40 * sc;
    const s = (2.5 + c.r() * 2.5) * sc;
    d.push(`M${f(x - s)} ${f(y - s * 0.4)}Q${f(x - s * 0.4)} ${f(y - s * 0.7)} ${f(x)} ${f(y)}Q${f(x + s * 0.4)} ${f(y - s * 0.7)} ${f(x + s)} ${f(y - s * 0.4)}`);
  }
  return <Path d={d.join('')} stroke={color} strokeWidth={1.1} fill="none" strokeLinecap="round" />;
}

/** Glowing lamp heads (radial) as circles sharing one gradient. */
function lampsEl(c: Ctx, heads: ReadonlyArray<readonly [number, number, number]>, color: string, core = art.white): Node {
  const g = c.rad([
    [0, color, 0.9],
    [0.25, color, 0.4],
    [1, color, 0],
  ]);
  return (
    <G>
      {heads.map(([x, y, r], i) => (
        <Circle key={i} cx={x} cy={y} r={r * 5} fill={g} />
      ))}
      <Path d={heads.map(([x, y, r]) => circleD(x, y, r)).join('')} fill={core} />
    </G>
  );
}

function moonEl(c: Ctx, cx: number, cy: number, r: number): Node {
  const g = c.rad([
    [0, art.violet, 0.4],
    [1, art.violet, 0],
  ]);
  const d = `M${f(cx)} ${f(cy - r)}A${f(r)} ${f(r)} 0 1 0 ${f(cx)} ${f(cy + r)}A${f(r * 1.25)} ${f(r * 1.25)} 0 0 1 ${f(cx)} ${f(cy - r)}Z`;
  return (
    <G>
      <Circle cx={cx - r * 0.4} cy={cy} r={r * 4} fill={g} />
      <Path d={d} fill={art.cloud} transform={`rotate(-25 ${f(cx)} ${f(cy)})`} />
    </G>
  );
}

/** Sun centre so its cut-lines clear the skyline valley. */
const sunY = (hy: number, hmax: number, R: number) => Math.max(R * 0.75, hy - hmax * 0.3 - R * 0.8);

/** Figure scale: people ~ this many units tall /100. */
const figScale = (c: Ctx) => clamp(c.H * 0.28, 60, 118) / 100;

const HAIRS: Hair[] = ['pony', 'short', 'bun', 'short', 'cap', 'pony'];
const hairFor = (c: Ctx): Hair => HAIRS[Math.floor(c.r() * HAIRS.length)];

/* ================================================================= scenes */

function palmsSides(c: Ctx, base: number, h: number, fill: string, count = 3): Node {
  const d: string[] = [palmD(c.r, 22, base, h, 20), palmD(c.r, 378, base, h * 0.92, -22)];
  if (count > 2) d.push(palmD(c.r, 62, base, h * 0.72, -8));
  if (count > 3) d.push(palmD(c.r, 342, base, h * 0.66, 10));
  return <Path d={d.join('')} fill={fill} />;
}

function citySunset(c: Ctx): Node {
  const { H } = c;
  const hy = H * 0.63;
  const R = clamp(hy * 0.38, 48, 118);
  const city = cityEl(c, SUNSET, hy, { valley: 0.6 });
  const sy = sunY(hy, city.hmax, R);
  const pTop = H - clamp(H * 0.12, 26, 80);
  const pal = clamp(H * 0.55, 110, 330);
  const lamps: [number, number, number][] = [];
  const poles: string[] = [];
  for (const x of [118, 200, 282]) {
    const lh = clamp(H * 0.09, 20, 60);
    poles.push(rectD(x - 0.9, pTop - lh, 1.8, lh + 2));
    lamps.push([x, pTop - lh, 1.8]);
  }
  return (
    <G>
      {skyEl(c, SUNSET.sky, hy)}
      {starsEl(c, 26, hy * 0.35, 0.6)}
      {sunEl(c, 200, sy, R, { cut: true })}
      {cloudsEl(c, sy - R * 0.9, sy + R * 0.4, [art.magenta, art.purple], 6)}
      {city.el}
      <Rect x={-2} y={hy} width={404} height={H - hy + 2} fill={c.lin(SUNSET.water)} />
      {city.near && reflectEl(city.near, hy + 1, '#12081E', 0.7)}
      {streaksEl(c, 200, R * 0.9, hy, pTop - 10, [art.sunTop, art.pinkHi])}
      {ripplesEl(c, hy + 4, pTop, art.pinkHi, 18)}
      <Rect x={-2} y={pTop} width={404} height={H - pTop + 2} fill={c.lin([[0, '#1C0C2C'], [1, art.night0]])} />
      <Path d={lineD([[-5, pTop - 9], [405, pTop - 9]]) + Array.from({ length: 21 }, (_, i) => `M${i * 20} ${f(pTop - 9)}v9`).join('')} stroke="#07030C" strokeWidth={1.4} />
      <Glow d={lineD([[-5, pTop - 10], [405, pTop - 10]])} color={art.pink} core={art.pinkHi} w={1.3} />
      <Path d={poles.join('')} fill="#07030C" />
      {lampsEl(c, lamps, art.amber, art.sunTop)}
      {palmsSides(c, H + 4, pal, '#07030C', 4)}
      {vignetteEl(c, 0.5)}
    </G>
  );
}

function cityNight(c: Ctx): Node {
  const { H } = c;
  const hy = H * 0.66;
  const city = cityEl(c, NIGHT, hy, { valley: 0.25, valleyX: 120, lit: 0.7 });
  const roadY = H - clamp(H * 0.17, 34, 120);
  const deck = clamp(H * 0.025, 5, 14);
  // neon signs on tallest near/mid towers
  const pool = [...(city.near?.towers ?? []), ...city.mid.towers].filter((t) => t.x > 10 && t.x + t.w < 390 && t.w > 18);
  pool.sort((a, b) => b.h - a.h);
  const pinkSign: string[] = [];
  const cyanSign: string[] = [];
  const signs = pool.slice(0, 3);
  const billboardLegs: string[] = [];
  signs.forEach((t, i) => {
    if (i === 0) {
      const sh = Math.min(12, t.h * 0.12);
      pinkSign.push(rectD(t.x + 3, t.y + 5, t.w - 6, sh));
      pinkSign.push(`M${f(t.x + 7)} ${f(t.y + 5 + sh / 2)}h${f(t.w - 14)}`);
    } else if (i === 1) {
      const sh = Math.min(40, t.h * 0.5);
      cyanSign.push(rectD(t.x + t.w - 3, t.y + 8, 6, sh));
      for (let k = 1; k < 5; k++) cyanSign.push(`M${f(t.x + t.w - 1)} ${f(t.y + 8 + (sh * k) / 5)}h2`);
    } else {
      const bw = Math.min(30, t.w + 6);
      const bx = t.x + t.w / 2 - bw / 2;
      cyanSign.push(rectD(bx, t.y - 16, bw, 11));
      pinkSign.push(`M${f(bx + 4)} ${f(t.y - 12.5)}h${f(bw * 0.55)}M${f(bx + 4)} ${f(t.y - 8.5)}h${f(bw * 0.35)}`);
      billboardLegs.push(`M${f(bx + 4)} ${f(t.y - 5)}v6M${f(bx + bw - 4)} ${f(t.y - 5)}v6`);
    }
  });
  // light trails
  const lanes: [string, string, number][] = [
    [art.pink, art.pinkHi, roadY - 5.5],
    [art.coral, art.pinkHi, roadY - 3.2],
    [art.cyan, '#CFF8FF', roadY - 1.2],
  ];
  const trailEls = lanes.map(([col, core, y], li) => {
    const d: string[] = [];
    let x = -30 + c.r() * 30;
    while (x < 420) {
      const len = 30 + c.r() * 110;
      d.push(`M${f(x)} ${f(y)}h${f(len)}`);
      x += len + 6 + c.r() * 40;
    }
    return <Glow key={li} d={d.join('')} color={col} core={core} w={1.1} />;
  });
  const pillars: string[] = [];
  for (let x = 30; x < 400; x += 90) pillars.push(rectD(x, roadY + deck, 9, H - roadY));
  const reflNeon: string[] = [];
  signs.forEach((t) => {
    for (let k = 0; k < 5; k++) reflNeon.push(`M${f(t.x + 4 + c.r() * (t.w - 8))} ${f(hy + 4 + k * 5 + c.r() * 3)}h${f(4 + c.r() * 8)}`);
  });
  return (
    <G>
      {skyEl(c, NIGHT.sky, hy)}
      {starsEl(c, 80, hy * 0.7)}
      {moonEl(c, 320, clamp(hy * 0.22, 40, 150), clamp(hy * 0.06, 11, 24))}
      <Rect x={-2} y={hy * 0.45} width={404} height={hy * 0.55} fill={c.lin([[0, art.magenta, 0], [1, art.pink, 0.28]])} />
      {city.el}
      <Path d={billboardLegs.join('')} stroke="#0A0512" strokeWidth={1.6} />
      <Glow d={pinkSign.join('')} color={art.pink} core={art.pinkHi} w={1.1} />
      <Glow d={cyanSign.join('')} color={art.cyan} core="#CFF8FF" w={1.1} />
      <Rect x={-2} y={hy} width={404} height={H - hy + 2} fill={c.lin(NIGHT.water)} />
      {city.near && reflectEl(city.near, hy + 1, '#07040C', 0.8, 0.45)}
      <Path d={reflNeon.join('')} stroke={art.pinkHi} strokeWidth={1.2} strokeLinecap="round" opacity={0.6} />
      {ripplesEl(c, hy + 3, roadY, art.cyan, 14, 0.16)}
      <Path d={pillars.join('')} fill="#07040C" />
      <Rect x={-2} y={roadY - 9} width={404} height={deck + 9} fill="#0B0614" />
      <Path d={lineD([[-2, roadY - 9], [404, roadY - 9]])} stroke={art.violet} strokeWidth={0.8} opacity={0.6} />
      {trailEls}
      <Rect x={-2} y={roadY} width={404} height={deck} fill="#140A22" />
      <Glow d={lineD([[-2, roadY + deck * 0.5], [404, roadY + deck * 0.5]])} color={art.purple} core={art.violet} w={0.8} op={0.8} />
      {vignetteEl(c, 0.5)}
    </G>
  );
}

function cityDawn(c: Ctx): Node {
  const { H } = c;
  const hy = H * 0.64;
  const R = clamp(hy * 0.3, 40, 95);
  const sunX = 250;
  const city = cityEl(c, DAWN, hy, { valley: 0.55, valleyX: sunX });
  const stepH = clamp(H * 0.045, 9, 28);
  const sTop = H - stepH * 3.2;
  const mist = c.lin([
    [0, art.white, 0],
    [0.5, art.white, 0.42],
    [1, art.white, 0],
  ]);
  return (
    <G>
      {skyEl(c, DAWN.sky, hy)}
      {sunEl(c, sunX, hy - city.hmax * 0.3 - R * 0.35, R, { top: '#FFF6D8', bottom: '#FFA98A', glow: '#FFD2A8', glowR: 3.2 })}
      {cloudsEl(c, hy * 0.25, hy * 0.7, ['#F7C4D8', '#B89AD8'], 5)}
      <G>
        <SkylineLayer sky={city.far} fill={c.lin([[0, DAWN.far[0]], [1, DAWN.far[1]]])} winOpacity={0.4} />
        <Rect x={-2} y={hy - city.hmax * 0.6} width={404} height={city.hmax * 0.5} fill={mist} />
        <SkylineLayer sky={city.mid} fill={c.lin([[0, DAWN.mid[0]], [1, DAWN.mid[1]]])} winOpacity={0.6} />
        <Rect x={-2} y={hy - city.hmax * 0.3} width={404} height={city.hmax * 0.34} fill={mist} />
        {city.near && <SkylineLayer sky={city.near} fill={c.lin([[0, DAWN.near[0]], [1, DAWN.near[1]]])} />}
      </G>
      <Rect x={-2} y={hy} width={404} height={H - hy + 2} fill={c.lin(DAWN.water)} />
      {city.near && reflectEl(city.near, hy + 1, '#5A4880', 0.55, 0.3)}
      <Rect x={-2} y={hy - 6} width={404} height={22} fill={mist} />
      {streaksEl(c, sunX, R * 0.8, hy, sTop, ['#FFF1D0', '#FFB9A0'], 0.8)}
      {ripplesEl(c, hy + 4, sTop, art.white, 14, 0.2)}
      {birdsEl(c, sunX - 70, hy * 0.45, 5, clamp(H / 400, 0.7, 1.4), '#3A2C56')}
      <Rect x={-2} y={sTop} width={404} height={stepH} fill="#6A5488" />
      <Rect x={-2} y={sTop + stepH} width={404} height={stepH} fill="#4E3C6C" />
      <Rect x={-2} y={sTop + stepH * 2} width={404} height={H} fill="#332650" />
      <Path d={`M-2 ${f(sTop)}h404M-2 ${f(sTop + stepH)}h404M-2 ${f(sTop + stepH * 2)}h404`} stroke="#FFD2B8" strokeWidth={0.8} opacity={0.45} />
      <Path d={palmD(c.r, 372, sTop + 2, clamp(H * 0.42, 90, 260), -16) + palmD(c.r, 30, sTop + 2, clamp(H * 0.3, 70, 190), 10)} fill="#2A1E44" />
      {vignetteEl(c, 0.3)}
    </G>
  );
}

function runScene(c: Ctx): Node {
  const { H } = c;
  const hy = H * 0.5;
  const R = clamp(hy * 0.4, 40, 105);
  const sunX = 250;
  const city = cityEl(c, SUNSET, hy, { valley: 0.6, valleyX: sunX, scale: 0.85 });
  // road centre line: bottom-left -> vanishing point on horizon (right)
  const P0: Pt = [-20, H * 0.93];
  const C1: Pt = [190, H * 0.9];
  const P1: Pt = [352, hy + 3];
  const near = clamp(H * 0.46, 96, 330);
  const top: Pt[] = [];
  const bot: Pt[] = [];
  const route: Pt[] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = quad(P0, C1, P1, t);
    const w = lerp(near, 2, Math.pow(t, 0.7));
    top.push([p[0], p[1] - w * 0.5]);
    bot.push([p[0] + w * 0.15, p[1] + w * 0.5]);
    route.push([p[0], p[1] + w * 0.18]);
  }
  const lamps: [number, number, number][] = [];
  const poles: string[] = [];
  for (let i = 1; i < 8; i++) {
    const t = i / 8;
    const k = Math.floor(t * N);
    const p = top[k];
    const w = lerp(near, 2, Math.pow(t, 0.7));
    const lh = w * 0.55;
    poles.push(rectD(p[0] - w * 0.012 - 0.3, p[1] - lh, w * 0.024 + 0.6, lh));
    lamps.push([p[0], p[1] - lh, Math.max(0.6, w * 0.02)]);
  }
  const s = figScale(c) * 1.15;
  const ts = [0.17, 0.26, 0.35, 0.44];
  const poses: PoseName[] = ['runA', 'runB', 'runC', 'runA'];
  const runners = ts.map((t, i) => {
    const p = quad(P0, C1, P1, t);
    const w = lerp(near, 2, Math.pow(t, 0.7));
    const k = lerp(1.08, 0.78, (t - 0.17) / 0.27);
    return (
      <Person
        key={i}
        x={p[0] + (c.r() - 0.5) * 8}
        y={p[1] + w * (i % 2 ? 0.08 : 0.22)}
        s={s * k}
        pose={poses[(i + Math.floor(c.r() * 4)) % 4]}
        hair={hairFor(c)}
        rim={i % 2 ? art.cyan : art.pinkHi}
      />
    );
  });
  return (
    <G>
      {skyEl(c, SUNSET.sky, hy)}
      {sunEl(c, sunX, sunY(hy, city.hmax, R), R, { cut: true })}
      {cloudsEl(c, hy * 0.3, hy * 0.8, [art.magenta, art.purple], 5)}
      {city.el}
      <Rect x={-2} y={hy} width={404} height={H - hy + 2} fill={c.lin(SUNSET.water)} />
      {city.near && reflectEl(city.near, hy + 1, '#12081E', 0.6)}
      {streaksEl(c, sunX, R * 0.8, hy, H, [art.sunTop, art.pinkHi], 1.4)}
      <Path d={polyD([...top, ...[...bot].reverse()])} fill={c.lin([[0, '#3A1646'], [0.5, '#1C0B28'], [1, '#0B0612']], [0.7, 0, 0.2, 1])} />
      <Path d={polyD([...top.map((p): Pt => [p[0], p[1] - 3]), ...[...top].reverse()])} fill="#0B0612" />
      <Glow d={lineD(top.map((p): Pt => [p[0], p[1] - 3]))} color={art.pink} core={art.pinkHi} w={0.9} op={0.8} />
      <Path d={poles.join('')} fill="#07030C" />
      {lampsEl(c, lamps, art.amber, art.sunTop)}
      <Glow d={lineD(route)} color={art.pink} core={art.pinkHi} w={2.2} />
      {runners}
      <Path d={palmD(c.r, 16, H + 6, clamp(H * 0.62, 120, 340), 22)} fill="#07030C" />
      {vignetteEl(c, 0.45)}
    </G>
  );
}

function yogaScene(c: Ctx): Node {
  const { H } = c;
  const hy = H * 0.64;
  const R = clamp(hy * 0.26, 32, 80);
  const sunX = 300;
  const sky: Stops = [
    [0, '#2A0E45'],
    [0.35, art.magenta],
    [0.65, art.coral],
    [0.86, art.orange],
    [1, art.sunTop],
  ];
  const golden: Mood = { ...SUNSET, far: ['#8A3A6E', '#D86A6A'], mid: ['#5A2258', '#8A3A62'], lit: 0.12 };
  const city = cityEl(c, golden, hy, { layers: 2, scale: 0.55, valley: 0.3, valleyX: sunX });
  const hc = H * 0.77;
  const hill = `M-10 ${f(hc + 8)}Q110 ${f(hc - 14)} 205 ${f(hc - 4)}Q300 ${f(hc + 6)} 410 ${f(hc - 2)}L410 ${f(H + 2)}L-10 ${f(H + 2)}Z`;
  const crest = `M-10 ${f(hc + 8)}Q110 ${f(hc - 14)} 205 ${f(hc - 4)}Q300 ${f(hc + 6)} 410 ${f(hc - 2)}`;
  const s = figScale(c) * 0.95;
  const gy = hc + (H - hc) * 0.42;
  const rays: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (200 + i * 22 + c.r() * 8) * (Math.PI / 180);
    const b = a + 0.06 + c.r() * 0.05;
    const L = 600;
    rays.push(polyD([[sunX, hy - R * 0.3], [sunX + Math.cos(a) * L, hy - R * 0.3 - Math.sin(a) * L * -1], [sunX + Math.cos(b) * L, hy - R * 0.3 - Math.sin(b) * L * -1]]));
  }
  const people: { x: number; pose: PoseName; mat: string; flip?: boolean }[] = [
    { x: 92, pose: 'downDog', mat: art.pink },
    { x: 170, pose: 'tree', mat: art.cyan },
    { x: 250, pose: 'warrior', mat: art.violet },
    { x: 326, pose: 'lungeUp', mat: art.yellow, flip: true },
  ];
  const treeH = clamp(H * 0.48, 110, 300);
  const farTree = treeD(c.r, 352, hc + 4, treeH * 0.6);
  const nearTree = treeD(c.r, 30, hc + 30, treeH);
  const tufts: string[] = [];
  for (let i = 0; i < 40; i++) {
    const x = c.r() * 400;
    const y = lerp(hc + 6, H, c.r());
    const h = 2 + c.r() * 4;
    tufts.push(`M${f(x)} ${f(y)}l-1 ${f(-h)}M${f(x + 1.5)} ${f(y)}l1 ${f(-h * 0.8)}`);
  }
  return (
    <G>
      {skyEl(c, sky, hy)}
      {sunEl(c, sunX, hy - R * 0.3, R, { top: '#FFF3C4', bottom: art.orange, glow: art.amber, glowR: 3.4 })}
      <Path d={rays.join('')} fill={art.sunTop} opacity={0.07} />
      {birdsEl(c, 120, hy * 0.4, 4, clamp(H / 400, 0.7, 1.4), '#2A0E45')}
      {city.el}
      <Rect x={-2} y={hy} width={404} height={H - hy + 2} fill={c.lin([[0, '#E8806A'], [1, '#7A2A5A']])} />
      <Path d={farTree} fill={art.amber} opacity={0.55} transform="translate(-1.5 -1)" />
      <Path d={farTree} fill="#1A1622" />
      <Path d={hill} fill={c.lin([[0, '#5A5A2A'], [0.25, '#2A3420'], [1, '#0C120C']])} />
      <Glow d={crest} color={art.amber} core={art.sunTop} w={1} op={0.7} />
      <Path d={tufts.join('')} stroke="#0C140C" strokeWidth={1} opacity={0.8} />
      <Path d={nearTree} fill={art.amber} opacity={0.5} transform="translate(2 -1.5)" />
      <Path d={nearTree} fill="#0E120E" />
      {people.map((p, i) => {
        const y = gy + (i % 2) * 4;
        const mw = (p.pose === 'downDog' || p.pose === 'lungeUp' || p.pose === 'warrior' ? 34 : 22) * s;
        return (
          <G key={i}>
            <Path d={polyD([[p.x - mw - 3 * s, y + 3 * s], [p.x + mw - 3 * s, y + 3 * s], [p.x + mw + 3 * s, y - 2 * s], [p.x - mw + 3 * s, y - 2 * s]])} fill={p.mat} opacity={0.9} />
            <Person x={p.x + (p.pose === 'downDog' ? -6 * s : 0)} y={y} s={s} pose={p.pose} flip={p.flip} hair={i % 2 ? 'bun' : 'pony'} rim={i % 2 ? art.amber : art.pinkHi} shadow={false} />
          </G>
        );
      })}
      {vignetteEl(c, 0.4)}
    </G>
  );
}

function hiitScene(c: Ctx): Node {
  const { H } = c;
  const floorY = H * 0.68;
  const s = figScale(c);
  const panels: string[] = [];
  const frames: string[] = [];
  const sheen: string[] = [];
  const pTop = Math.max(10, floorY - 100 * s * 1.9);
  for (let i = 0; i < 5; i++) {
    const x = -10 + i * 84;
    panels.push(rectD(x + 2, pTop, 80, floorY - pTop));
    frames.push(rectD(x + 2, pTop, 80, floorY - pTop));
    const sx = x + 10 + c.r() * 30;
    sheen.push(polyD([[sx, pTop], [sx + 14, pTop], [sx - 30, floorY], [sx - 44, floorY]]));
    sheen.push(polyD([[sx + 22, pTop], [sx + 26, pTop], [sx - 18, floorY], [sx - 22, floorY]]));
  }
  const beams = [
    { x: 90, col: art.pink },
    { x: 205, col: art.purple },
    { x: 320, col: art.pink },
  ].map((b, i) => (
    <G key={i}>
      <Path d={polyD([[b.x - 6, -2], [b.x + 6, -2], [b.x + 62, floorY + 22], [b.x - 62, floorY + 22]])} fill={c.lin([[0, b.col, 0.55], [1, b.col, 0.04]])} />
      <Ellipse cx={b.x} cy={floorY + 22} rx={70} ry={12} fill={c.rad([[0, b.col, 0.5], [1, b.col, 0]])} />
    </G>
  ));
  const planks: string[] = [];
  for (let i = -10; i <= 10; i++) planks.push(`M${200 + i * 20} ${f(floorY)}L${200 + i * 80} ${f(H + 2)}`);
  const fy = floorY + (H - floorY) * 0.55;
  const track: [number, number][] = [];
  for (let x = 12; x < 400; x += 22) track.push([x, 6]);
  return (
    <G>
      <Rect x={-2} y={-2} width={404} height={floorY + 4} fill={c.lin([[0, '#12081E'], [1, '#22103A']])} />
      <Path d={panels.join('')} fill={c.lin([[0, '#2E1C4E'], [0.5, '#1E1234'], [1, '#2A1446']])} />
      <Path d={sheen.join('')} fill={art.white} opacity={0.05} />
      <Path d={frames.join('')} stroke="#46306A" strokeWidth={2} fill="none" />
      <Path d={dotsD(track)} stroke={art.white} strokeWidth={3} strokeLinecap="round" opacity={0.8} />
      <Rect x={-2} y={floorY} width={404} height={H - floorY + 2} fill={c.lin([[0, '#2A1234'], [1, '#0B0612']])} />
      <Path d={planks.join('')} stroke="#1A0A22" strokeWidth={1} />
      <Glow d={`M-2 ${f(floorY)}h404`} color={art.cyan} core="#CFF8FF" w={1} />
      {beams}
      <Person x={105} y={fy} s={s} pose="tuckJump" hair="pony" rim={art.pinkHi} reflect={0.16} />
      <Person x={205} y={fy + 4} s={s * 1.05} pose="jack" hair="bun" rim={art.cyan} reflect={0.16} />
      <Person x={318} y={fy} s={s} pose="plank" flip hair="short" rim={art.pinkHi} reflect={0.16} />
      {vignetteEl(c, 0.5)}
    </G>
  );
}

function leafClump(cx: number, by: number, h: number, r: () => number): [string, string] {
  const dark: string[] = [];
  const light: string[] = [];
  for (let i = 0; i < 9; i++) {
    const a = (-80 + (i / 8) * 160 + (r() - 0.5) * 16) * (Math.PI / 180);
    const L = h * (0.6 + r() * 0.4);
    const tip: Pt = [cx + Math.sin(a) * L, by - Math.cos(a) * L];
    const mid: Pt = [cx + Math.sin(a) * L * 0.5, by - Math.cos(a) * L * 0.5];
    const nx = Math.cos(a) * L * 0.16;
    const ny = Math.sin(a) * L * 0.16;
    const pts: Pt[] = [];
    for (let k = 0; k <= 6; k++) pts.push(quad([cx, by], [mid[0] + nx, mid[1] + ny], tip, k / 6));
    for (let k = 6; k >= 0; k--) pts.push(quad([cx, by], [mid[0] - nx, mid[1] - ny], tip, k / 6));
    (i % 2 ? light : dark).push(polyD(pts));
  }
  return [dark.join(''), light.join('')];
}

function cafeScene(c: Ctx): Node {
  const { H } = c;
  const B = Math.min(H, 520);
  const yb = H - B * 0.16;
  const wy1 = yb - B * 0.42;
  const wy2 = yb - B * 0.04;
  const ya1 = wy1 - B * 0.1;
  const ya2 = wy1 + B * 0.015;
  const signY = ya1 - B * 0.12;
  const roof = ya1 - B * 0.24;
  const s = figScale(c) * 0.95;
  const wx1 = 46;
  const wx2 = 292;
  // awning stripes
  const pinkS: string[] = [];
  const creamS: string[] = [];
  const n = 12;
  const topL = 36;
  const topR = 364;
  const botL = 24;
  const botR = 376;
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const poly = polyD([
      [lerp(topL, topR, t0), ya1],
      [lerp(topL, topR, t1), ya1],
      [lerp(botL, botR, t1), ya2],
      [lerp(botL, botR, t0), ya2],
    ]);
    const rr = (botR - botL) / n / 2;
    const sc = `M${f(lerp(botL, botR, t0))} ${f(ya2 - 0.5)}A${f(rr)} ${f(rr * 0.8)} 0 0 0 ${f(lerp(botL, botR, t1))} ${f(ya2 - 0.5)}Z`;
    (i % 2 ? creamS : pinkS).push(poly + sc);
  }
  // interior
  const counterY = wy2 - (wy2 - wy1) * 0.3;
  const pend: string[] = [];
  const bulbs: [number, number, number][] = [];
  for (const x of [90, 168, 246]) {
    const by = wy1 + (wy2 - wy1) * 0.28;
    pend.push(`M${x} ${f(wy1)}V${f(by)}`);
    pend.push(`M${x - 8} ${f(by + 5)}Q${x} ${f(by - 4)} ${x + 8} ${f(by + 5)}Z`);
    bulbs.push([x, by + 6, 2.2]);
  }
  const shelves: string[] = [];
  for (let k = 0; k < 2; k++) {
    const y = wy1 + (wy2 - wy1) * (0.46 + k * 0.12);
    shelves.push(`M${wx1 + 150} ${f(y)}h${wx2 - wx1 - 160}`);
  }
  const jars: string[] = [];
  for (let k = 0; k < 2; k++) {
    const y = wy1 + (wy2 - wy1) * (0.46 + k * 0.12);
    for (let i = 0; i < 5; i++) jars.push(rectD(wx1 + 156 + i * 17, y - 9, 8, 9));
  }
  const cups =
    rectD(70, counterY - 12, 9, 12) +
    rectD(84, counterY - 9, 8, 9) +
    `M110 ${f(counterY)}a12 7 0 0 1 24 0z` +
    rectD(150, counterY - 14, 10, 14);
  const cupsHi = circleD(122, counterY - 3, 3) + circleD(127, counterY - 4, 2.4) + circleD(117, counterY - 4, 2);
  // neon sign: cup + steam + leaf
  const k = clamp(B / 400, 0.6, 1.1);
  const cupSign =
    `M${f(200 - 24 * k)} ${f(signY - 8 * k)}h${f(48 * k)}l${f(-6 * k)} ${f(26 * k)}h${f(-36 * k)}z` +
    `M${f(200 + 24 * k)} ${f(signY - 2 * k)}a${f(8 * k)} ${f(7 * k)} 0 1 1 ${f(-3 * k)} ${f(13 * k)}` +
    `M${f(200 - 34 * k)} ${f(signY + 22 * k)}h${f(68 * k)}`;
  const steam = [-10, 0, 10]
    .map((dx) => `M${f(200 + dx * k)} ${f(signY - 12 * k)}q${f(-5 * k)} ${f(-6 * k)} 0 ${f(-12 * k)}q${f(5 * k)} ${f(-6 * k)} 0 ${f(-12 * k)}`)
    .join('');
  const leaf = `M${f(250 * 1)} ${f(signY + 14 * k)}q${f(4 * k)} ${f(-26 * k)} ${f(26 * k)} ${f(-30 * k)}q${f(2 * k)} ${f(24 * k)} ${f(-26 * k)} ${f(30 * k)}zM${f(250)} ${f(signY + 14 * k)}l${f(18 * k)} ${f(-20 * k)}`;
  // table and sitters
  const gy = yb + (H - yb) * 0.62;
  const tx = 185;
  const tTop = gy - 50 * s;
  const sitter = (x: number, flip: boolean, hair: Hair, rim: string) => (
    <Person x={x} y={gy + 24 * s - 22 * s} s={s} pose="sit" flip={flip} hair={hair} rim={rim} shadow={false}>
      <Path d="M-8 -48h14M-6 -48l-2 26M4 -48l2 26M-8 -48l-4 -30" stroke="#07030C" strokeWidth={2.5} fill="none" strokeLinecap="round" />
    </Person>
  );
  const [pdA, plA] = leafClump(26, yb + 4, clamp(B * 0.28, 50, 130), c.r);
  const [pdB, plB] = leafClump(378, yb + 4, clamp(B * 0.24, 44, 110), c.r);
  const pots = polyD([[12, yb + 2], [40, yb + 2], [36, yb + 24], [16, yb + 24]]) + polyD([[366, yb + 2], [390, yb + 2], [387, yb + 22], [369, yb + 22]]);
  const bricks: string[] = [];
  for (let y = roof + 6, row = 0; y < yb; y += 8, row++) {
    bricks.push(`M0 ${f(y)}h400`);
    for (let x = row % 2 ? 0 : 10; x < 400; x += 20) bricks.push(`M${x} ${f(y)}v8`);
  }
  const nearSky = skyline(c.r, { base: roof + 2, minH: 20, maxH: clamp(roof * 0.8, 20, 200), wMin: 20, wMax: 40, win: { w: 2, h: 3, sx: 5, sy: 7, lit: 0.3, palette: NIGHT.win } });
  const warm = c.lin([
    [0, '#FFD38A'],
    [0.55, '#FFA15A'],
    [1, '#E0567A'],
  ]);
  return (
    <G>
      {skyEl(c, [[0, art.night1], [0.5, art.dusk], [1, art.coral]], roof + 4)}
      {starsEl(c, 20, roof * 0.6, 0.6)}
      <SkylineLayer sky={nearSky} fill="#1A0C2A" winOpacity={0.7} />
      <Rect x={-2} y={roof} width={404} height={yb - roof + 2} fill={c.lin([[0, '#2A1236'], [1, '#1A0A24']])} />
      <Path d={bricks.join('')} stroke="#3E1C4E" strokeWidth={0.7} opacity={0.6} />
      <Rect x={-2} y={roof - 4} width={404} height={6} fill="#12081E" />
      <Rect x={wx1} y={wy1} width={wx2 - wx1} height={wy2 - wy1} fill={warm} />
      <Rect x={306} y={wy1 + 4} width={46} height={yb - wy1 - 4} fill={warm} opacity={0.85} />
      <Path d={shelves.join('')} stroke="#6A2A3A" strokeWidth={2} opacity={0.6} />
      <Path d={jars.join('')} fill="#8A3A4A" opacity={0.55} />
      <Path d={pend.join('')} stroke="#4A1A2A" strokeWidth={1.2} fill="#4A1A2A" />
      {lampsEl(c, bulbs, art.sunTop, art.white)}
      <Rect x={wx1} y={counterY} width={wx2 - wx1} height={wy2 - counterY} fill="#5A2238" />
      <Path d={`M${wx1} ${f(counterY)}h${wx2 - wx1}`} stroke={art.sunTop} strokeWidth={1.2} opacity={0.8} />
      <Path d={cups} fill="#3A1426" />
      <Path d={cupsHi} fill={art.pink} />
      <Path d={`M74 ${f(counterY - 12)}l3 -7M154 ${f(counterY - 14)}l-2 -7`} stroke={art.green} strokeWidth={1.4} strokeLinecap="round" />
      <Path d={rectD(wx1, wy1, wx2 - wx1, wy2 - wy1) + `M${f((wx1 + wx2) / 2)} ${f(wy1)}V${f(wy2)}` + rectD(306, wy1 + 4, 46, yb - wy1 - 4)} stroke="#1A0A1E" strokeWidth={4} fill="none" />
      <Path d={`M344 ${f((wy1 + yb) / 2)}v14`} stroke="#1A0A1E" strokeWidth={2.4} strokeLinecap="round" />
      <Path d={pinkS.join('')} fill={art.pink} />
      <Path d={creamS.join('')} fill={art.cloud} />
      <Path d={polyD([[topL, ya1], [topR, ya1], [lerp(topR, botR, 0.4), lerp(ya1, ya2, 0.4)], [lerp(topL, botL, 0.4), lerp(ya1, ya2, 0.4)]])} fill={art.night0} opacity={0.35} />
      <Glow d={cupSign} color={art.cyan} core="#CFF8FF" w={1.6} />
      <Glow d={steam} color={art.pink} core={art.pinkHi} w={1.3} />
      <Glow d={leaf} color={art.green} core="#C8FFE4" w={1.4} />
      <Rect x={-2} y={yb} width={404} height={H - yb + 2} fill={c.lin([[0, '#2E1630'], [1, art.night0]])} />
      <Path d={polyD([[wx1, yb], [wx2, yb], [wx2 + 40, H + 2], [wx1 - 40, H + 2]])} fill={c.lin([[0, art.amber, 0.35], [1, art.amber, 0]])} />
      <Path d={`M-2 ${f(yb)}h404`} stroke={art.sunTop} strokeWidth={0.8} opacity={0.35} />
      <Path d={pots} fill="#3A1A1A" />
      <Path d={pdA + pdB} fill="#15402C" />
      <Path d={plA + plB} fill="#2E7A4E" />
      {sitter(tx - 42 * s, false, 'pony', art.pinkHi)}
      {sitter(tx + 42 * s, true, 'short', art.cyan)}
      <Path d={`M${f(tx)} ${f(tTop)}V${f(gy)}M${f(tx - 12 * s)} ${f(gy)}h${f(24 * s)}`} stroke="#07030C" strokeWidth={3} strokeLinecap="round" />
      <Path d={ellipseD(tx, tTop, 24 * s, 3.2 * s)} fill="#07030C" stroke={art.amber} strokeWidth={0.8} />
      <Path d={rectD(tx - 12 * s, tTop - 10 * s, 6 * s, 9 * s) + rectD(tx + 6 * s, tTop - 8 * s, 6 * s, 7 * s)} fill={art.pink} />
      <Path d={`M${f(tx - 8 * s)} ${f(tTop - 10 * s)}l${f(2 * s)} ${f(-5 * s)}`} stroke={art.green} strokeWidth={1.2} />
      {vignetteEl(c, 0.45)}
    </G>
  );
}

function brunchScene(c: Ctx): Node {
  const { H } = c;
  const edge = H - clamp(H * 0.08, 14, 44);
  const land = H / 400 < 0.8;
  const u = land ? clamp(H / 245, 0.6, 1) : 1.2;
  const cy = (edge - 10) / 2 + 5;
  const pos = land
    ? { toast: [86, cy + 4], bowl: [226, cy + 2], coffee: [340, cy - 44 * u], juice: [344, cy + 52 * u], extra: [150, cy + 78 * u] }
    : { toast: [200 - 85 * u, cy - 75 * u], bowl: [200 + 80 * u, cy - 50 * u], coffee: [200 - 90 * u, cy + 95 * u], juice: [200 + 86 * u, cy + 106 * u], extra: [206, cy + 42 * u] };
  const P = (k: keyof typeof pos): Pt => [pos[k][0], pos[k][1]];
  const shadow: string[] = [];
  // ---- toast plate
  const [tx, ty] = P('toast');
  const plR = 70 * u;
  shadow.push(circleD(tx + 5 * u, ty + 8 * u, plR));
  const toastRot = `rotate(-14 ${f(tx)} ${f(ty)})`;
  const tw = 66 * u;
  const th = 54 * u;
  const crust = `M${f(tx - tw / 2)} ${f(ty - th / 2 + 10 * u)}q0 ${f(-14 * u)} ${f(14 * u)} ${f(-14 * u)}h${f(tw - 28 * u)}q${f(14 * u)} 0 ${f(14 * u)} ${f(14 * u)}v${f(th - 14 * u)}q0 ${f(4 * u)} ${f(-4 * u)} ${f(4 * u)}h${f(-tw + 8 * u)}q${f(-4 * u)} 0 ${f(-4 * u)} ${f(-4 * u)}z`;
  const avo: string[] = [];
  const avoHi: string[] = [];
  for (let i = 0; i < 5; i++) {
    const ax = tx - 20 * u + i * 10 * u;
    avo.push(ellipseD(ax, ty + 2 * u, 7 * u, 17 * u));
    avoHi.push(ellipseD(ax + 1.5 * u, ty + 2 * u, 4 * u, 13 * u));
  }
  const flakes: Pt[] = [];
  for (let i = 0; i < 18; i++) flakes.push([tx + (c.r() - 0.5) * 50 * u, ty + (c.r() - 0.5) * 38 * u]);
  const radish = circleD(tx + 18 * u, ty - 16 * u, 6 * u) + circleD(tx - 22 * u, ty + 18 * u, 5 * u);
  const radishIn = circleD(tx + 18 * u, ty - 16 * u, 3.6 * u) + circleD(tx - 22 * u, ty + 18 * u, 3 * u);
  const egg = ellipseD(tx + 34 * u, ty + 34 * u, 17 * u, 14 * u);
  const yolk = circleD(tx + 35 * u, ty + 33 * u, 7 * u);
  // ---- bowl
  const [bx, by] = P('bowl');
  const bR = 64 * u;
  shadow.push(circleD(bx + 5 * u, by + 8 * u, bR));
  const berries: Pt[] = [];
  for (let i = 0; i < 6; i++) berries.push([bx - bR * 0.55 + i * bR * 0.16, by + bR * 0.48 + Math.abs(i - 2.5) * -2 * u]);
  const band: Pt[] = [];
  for (let i = 0; i < 46; i++) band.push([bx + (c.r() - 0.5) * bR * 1.5, by - bR * 0.12 + (c.r() - 0.5) * bR * 0.22]);
  const straws: string[] = [];
  for (let i = 0; i < 4; i++) {
    const hx = bx - bR * 0.45 + i * bR * 0.3;
    const hy2 = by + bR * 0.18;
    const q = 6.5 * u;
    straws.push(`M${f(hx)} ${f(hy2 + q)}C${f(hx - q * 1.6)} ${f(hy2)} ${f(hx - q)} ${f(hy2 - q)} ${f(hx)} ${f(hy2 - q * 0.4)}C${f(hx + q)} ${f(hy2 - q)} ${f(hx + q * 1.6)} ${f(hy2)} ${f(hx)} ${f(hy2 + q)}Z`);
  }
  const seedsS: Pt[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) seedsS.push([bx - bR * 0.45 + i * bR * 0.3 + (j - 1) * 2.4 * u, by + bR * 0.18 + (j % 2) * 2 * u]);
  const banana: string[] = [];
  const bananaIn: string[] = [];
  for (let i = 0; i < 5; i++) {
    const x = bx - bR * 0.55 + i * bR * 0.2;
    const y = by - bR * 0.42 + Math.abs(i - 2) * 4 * u;
    banana.push(circleD(x, y, 8 * u));
    bananaIn.push(circleD(x, y, 3 * u));
  }
  const kiwi = circleD(bx + bR * 0.5, by + bR * 0.38, 11 * u) + circleD(bx + bR * 0.3, by + bR * 0.6, 10 * u);
  const kiwiIn = circleD(bx + bR * 0.5, by + bR * 0.38, 4 * u) + circleD(bx + bR * 0.3, by + bR * 0.6, 3.5 * u);
  const kiwiSeeds: Pt[] = [];
  for (const [kx, ky, kr] of [
    [bx + bR * 0.5, by + bR * 0.38, 7 * u],
    [bx + bR * 0.3, by + bR * 0.6, 6.5 * u],
  ]) {
    for (let i = 0; i < 8; i++) kiwiSeeds.push([kx + Math.cos((i / 8) * 6.28) * kr * 0.8, ky + Math.sin((i / 8) * 6.28) * kr * 0.8]);
  }
  // ---- coffee
  const [cx, cy2] = P('coffee');
  const cR = 30 * u;
  shadow.push(circleD(cx + 4 * u, cy2 + 6 * u, cR * 1.45));
  const heart = `M${f(cx)} ${f(cy2 + 9 * u)}C${f(cx - 16 * u)} ${f(cy2 - 2 * u)} ${f(cx - 8 * u)} ${f(cy2 - 13 * u)} ${f(cx)} ${f(cy2 - 5 * u)}C${f(cx + 8 * u)} ${f(cy2 - 13 * u)} ${f(cx + 16 * u)} ${f(cy2 - 2 * u)} ${f(cx)} ${f(cy2 + 9 * u)}Z`;
  // ---- juice
  const [jx, jy] = P('juice');
  const jR = 26 * u;
  shadow.push(circleD(jx + 4 * u, jy + 6 * u, jR * 1.05));
  const ice = rectD(jx - 12 * u, jy - 8 * u, 10 * u, 10 * u) + rectD(jx + 2 * u, jy - 2 * u, 9 * u, 9 * u);
  const oSlice = `M${f(jx + jR * 0.2)} ${f(jy - jR * 0.98)}a${f(jR * 0.6)} ${f(jR * 0.6)} 0 0 1 ${f(jR * 0.9)} ${f(jR * 0.7)}z`;
  // ---- extras: orange half, berries scattered, mint, cutlery
  const [ex, ey] = P('extra');
  const oR = 20 * u;
  const segs: string[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    segs.push(`M${f(ex)} ${f(ey)}l${f(Math.cos(a) * oR * 0.78)} ${f(Math.sin(a) * oR * 0.78)}`);
  }
  shadow.push(circleD(ex + 3 * u, ey + 5 * u, oR));
  const cutX = land ? 30 : 38;
  const cutlery = `M${f(cutX)} ${f(ty - 50 * u)}v${f(110 * u)}M${f(cutX + 9 * u)} ${f(ty - 50 * u)}v${f(110 * u)}`;
  const grain: string[] = [];
  for (let i = 0; i < 12; i++) {
    const y = (i / 12) * edge + c.r() * 10;
    grain.push(`M-5 ${f(y)}C120 ${f(y + (c.r() - 0.5) * 20)} 260 ${f(y + (c.r() - 0.5) * 20)} 405 ${f(y + (c.r() - 0.5) * 10)}`);
  }
  return (
    <G>
      <Rect x={-2} y={-2} width={404} height={H + 4} fill={c.rad([[0, '#2E1A3E'], [0.7, '#180C24'], [1, art.night0]], 0.5, 0.4, 0.8)} />
      <Path d={grain.join('')} stroke="#3A2248" strokeWidth={1} fill="none" opacity={0.45} />
      <Rect x={-2} y={edge - H * 0.3} width={404} height={H * 0.3} fill={c.lin([[0, art.pink, 0], [1, art.pink, 0.22]])} />
      <Path d={shadow.join('')} fill="#000" opacity={0.4} />
      <Path d={cutlery} stroke={art.steel} strokeWidth={3 * u} strokeLinecap="round" opacity={0.9} />
      {/* toast plate */}
      <Circle cx={tx} cy={ty} r={plR} fill={art.cloud} />
      <Circle cx={tx} cy={ty} r={plR * 0.8} fill="none" stroke="#D8CAE4" strokeWidth={1.5} />
      <G transform={toastRot}>
        <Path d={crust} fill="#B8743A" />
        <Path d={crust} fill="#E8B070" transform={`translate(${f(tx * 0.1)} ${f(ty * 0.1)}) scale(0.9)`} />
        <Path d={crust} fill="#7CB342" transform={`translate(${f(tx * 0.2)} ${f(ty * 0.2)}) scale(0.8)`} />
        <Path d={avo.join('')} fill="#5AA02C" />
        <Path d={avoHi.join('')} fill="#B6E06A" />
      </G>
      <Path d={radish} fill={art.pink} />
      <Path d={radishIn} fill="#FFE4F4" />
      <Path d={egg} fill={art.white} />
      <Path d={yolk} fill={art.amber} />
      <Path d={dotsD(flakes)} stroke={art.coral} strokeWidth={2.2 * u} strokeLinecap="round" />
      {/* smoothie bowl */}
      <Circle cx={bx} cy={by} r={bR} fill="#1E5A6A" />
      <Circle cx={bx} cy={by} r={bR * 0.86} fill={c.rad([[0, '#FF4FA8'], [1, '#A0186A']])} />
      <Path d={dotsD(band)} stroke="#D89A48" strokeWidth={4.2 * u} strokeLinecap="round" />
      <Path d={dotsD(band.slice(0, 16))} stroke="#F4ECF8" strokeWidth={2.2 * u} strokeLinecap="round" />
      <Path d={banana.join('')} fill="#FFF0B8" />
      <Path d={bananaIn.join('')} fill="#F0D080" />
      <Path d={kiwi} fill="#7ACB3A" />
      <Path d={kiwiIn} fill="#E8F8C0" />
      <Path d={dotsD(kiwiSeeds)} stroke="#1A1A10" strokeWidth={1.4 * u} strokeLinecap="round" />
      <Path d={straws.join('')} fill="#FF2E55" />
      <Path d={dotsD(seedsS)} stroke={art.sunTop} strokeWidth={1.2 * u} strokeLinecap="round" />
      <Path d={dotsD(berries)} stroke="#3A3AB8" strokeWidth={8 * u} strokeLinecap="round" />
      <Path d={dotsD(berries.map((p): Pt => [p[0] - 1.5 * u, p[1] - 1.5 * u]))} stroke="#8A8AF0" strokeWidth={2 * u} strokeLinecap="round" />
      {/* coffee */}
      <Circle cx={cx} cy={cy2} r={cR * 1.45} fill={art.cloud} />
      <Path d={rectD(cx + cR * 0.85, cy2 - 5 * u, 16 * u, 10 * u)} fill={art.white} />
      <Circle cx={cx} cy={cy2} r={cR} fill={art.white} />
      <Circle cx={cx} cy={cy2} r={cR * 0.82} fill="#7A4220" />
      <Circle cx={cx} cy={cy2} r={cR * 0.62} fill="#C8915A" />
      <Path d={heart} fill="#F6E4C8" />
      {/* juice */}
      <Circle cx={jx} cy={jy} r={jR} fill="#FFE6C0" opacity={0.5} />
      <Circle cx={jx} cy={jy} r={jR * 0.86} fill={c.rad([[0, art.amber], [1, '#FF7A1A']])} />
      <Path d={ice} fill={art.white} opacity={0.45} />
      <Path d={oSlice} fill={art.orange} stroke={art.amber} strokeWidth={1.5 * u} />
      <Path d={`M${f(jx - 4 * u)} ${f(jy + 2 * u)}L${f(jx - 40 * u)} ${f(jy - 30 * u)}`} stroke={art.pinkHi} strokeWidth={4 * u} strokeLinecap="round" />
      {/* orange half */}
      <Circle cx={ex} cy={ey} r={oR} fill={art.orange} />
      <Circle cx={ex} cy={ey} r={oR * 0.84} fill={art.amber} />
      <Path d={segs.join('')} stroke="#FFE8B0" strokeWidth={1.4 * u} />
      {/* neon table edge */}
      <Rect x={-2} y={edge} width={404} height={H - edge + 2} fill={art.night0} />
      <Glow d={`M-4 ${f(edge)}h408`} color={art.pink} core={art.pinkHi} w={2} />
      {vignetteEl(c, 0.45)}
    </G>
  );
}

function crewScene(c: Ctx): Node {
  const { H } = c;
  const hy = H * 0.64;
  const R = clamp(hy * 0.38, 45, 110);
  const city = cityEl(c, SUNSET, hy, { valley: 0.6 });
  const s = figScale(c);
  const yP = H * 0.78;
  const yF = yP + (H - yP) * 0.62;
  const conf: [Pt[], Pt[], Pt[]] = [[], [], []];
  for (let i = 0; i < 45; i++) conf[i % 3].push([c.r() * 400, lerp(hy * 0.2, yF - 60 * s, c.r())]);
  const crew: { x: number; pose: PoseName; flip?: boolean }[] = [
    { x: 48, pose: 'armsUp' },
    { x: 108, pose: 'cheerJump' },
    { x: 178, pose: 'highFive' },
    { x: 178 + 44 * s, pose: 'highFive', flip: true },
    { x: 290, pose: 'fistPump' },
    { x: 352, pose: 'armsUp' },
  ];
  const tank = rectD(330, yP - 40 * s, 36 * s, 26 * s) + rectD(333, yP - 14 * s, 2, 14 * s) + rectD(330 + 32 * s, yP - 14 * s, 2, 14 * s);
  return (
    <G>
      {skyEl(c, SUNSET.sky, hy)}
      {starsEl(c, 20, hy * 0.3, 0.5)}
      {sunEl(c, 200, sunY(hy, city.hmax, R), R, { cut: true })}
      {cloudsEl(c, hy * 0.3, hy * 0.75, [art.magenta, art.purple], 5)}
      {city.el}
      <Rect x={-2} y={yP - 10} width={404} height={H - yP + 12} fill={c.lin([[0, '#1C0C2C'], [1, art.night0]])} />
      <Path d={tank} fill="#0E0718" />
      <Rect x={-2} y={yP - 12} width={404} height={6} fill="#0B0614" />
      <Glow d={`M-4 ${f(yP - 12)}h408`} color={art.pink} core={art.pinkHi} w={1.4} />
      <Path d={dotsD(conf[0])} stroke={art.pinkHi} strokeWidth={2.6} strokeLinecap="round" />
      <Path d={dotsD(conf[1])} stroke={art.cyan} strokeWidth={2.2} strokeLinecap="round" />
      <Path d={dotsD(conf[2])} stroke={art.yellow} strokeWidth={2} strokeLinecap="round" />
      {crew.map((p, i) => (
        <Person key={i} x={p.x} y={yF + (i % 2) * 3} s={s * (0.95 + (i % 3) * 0.03)} pose={p.pose} flip={p.flip} hair={HAIRS[(i + Math.floor(c.r() * 3)) % HAIRS.length]} rim={i % 2 ? art.cyan : art.pinkHi} light={p.x < 200 ? -1 : 1} />
      ))}
      {vignetteEl(c, 0.45)}
    </G>
  );
}

function bikeD(): { frame: string; wheels: string } {
  const frame =
    lineD([[-1, -47], [14, -9], [-18, -8], [-1, -47]]) + lineD([[-1, -45], [44, -48], [14, -9]]) + lineD([[44, -48], [50, -8]]) + lineD([[44, -48], [49, -54], [55, -52]]) + lineD([[-6, -48], [5, -48]]);
  const wheels = circleD(-18, -8, 15) + circleD(50, -8, 15);
  return { frame, wheels };
}

function cyclingScene(c: Ctx): Node {
  const { H } = c;
  const hy = H * 0.55;
  const R = clamp(hy * 0.4, 42, 110);
  const sunX = 140;
  const city = cityEl(c, SUNSET, hy, { valley: 0.6, valleyX: sunX, scale: 0.8 });
  const yD = H * 0.76;
  const dT = clamp(H * 0.035, 7, 18);
  const px = 300;
  const tH = clamp(H * 0.62, 120, 440);
  const yT = yD - tH;
  const cables: string[] = [];
  for (let i = 0; i < 10; i++) {
    const ay = yT + 10 + i * 4;
    cables.push(`M${px} ${f(ay)}L${f(px - 30 - i * 26)} ${f(yD - 6)}M${px} ${f(ay)}L${f(px + 22 + i * 18)} ${f(yD - 6)}`);
  }
  const pylon = polyD([[px - 14, yD + dT], [px - 3, yT], [px + 3, yT], [px + 14, yD + dT], [px + 8, yD + dT], [px, yT + 30], [px - 8, yD + dT]]) + rectD(px - 14, yD + dT, 28, H);
  const posts: string[] = [];
  for (let x = 4; x < 400; x += 12) posts.push(`M${x} ${f(yD - 8)}v8`);
  const s = figScale(c) * 0.85;
  const { frame, wheels } = bikeD();
  const riders = [70, 160, 235].map((x, i) => (
    <Person
      key={i}
      x={x}
      y={yD - 7 * s}
      s={s * (1 - i * 0.04)}
      pose="cycle"
      hair="cap"
      rim={i % 2 ? art.cyan : art.pinkHi}
      light={-1}
      shadow={false}
    >
      <G>
        <Path d={wheels} stroke={i % 2 ? art.cyan : art.pinkHi} strokeWidth={3.6} fill="none" transform="translate(-1.2 -1)" />
        <Path d={wheels} stroke={art.silhouette} strokeWidth={2.6} fill="none" />
        <Path d={frame} stroke={art.silhouette} strokeWidth={2.6} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      </G>
    </Person>
  ));
  return (
    <G>
      {skyEl(c, SUNSET.sky, hy)}
      {sunEl(c, sunX, sunY(hy, city.hmax, R), R, { cut: true })}
      {cloudsEl(c, hy * 0.3, hy * 0.8, [art.magenta, art.purple], 5)}
      {city.el}
      <Rect x={-2} y={hy} width={404} height={H - hy + 2} fill={c.lin(SUNSET.water)} />
      {city.near && reflectEl(city.near, hy + 1, '#12081E', 0.6)}
      {streaksEl(c, sunX, R * 0.8, hy, H, [art.sunTop, art.pinkHi], 1.2)}
      <G transform={`translate(0 ${f(yD + dT)}) scale(1 -0.45) translate(0 ${f(-(yD + dT))})`} opacity={0.35}>
        <Path d={pylon} fill="#07030C" />
      </G>
      <Path d={cables.join('')} stroke="#FFC0E6" strokeWidth={0.8} opacity={0.65} />
      <Path d={pylon} fill="#0B0614" />
      <Path d={`M${px + 3} ${f(yT)}L${px + 14} ${f(yD)}`} stroke={art.pinkHi} strokeWidth={1} opacity={0.7} />
      <Path d={posts.join('') + `M-2 ${f(yD - 8)}h404`} stroke="#07030C" strokeWidth={1.3} />
      <Rect x={-2} y={yD} width={404} height={dT} fill="#0B0614" />
      <Glow d={`M-4 ${f(yD + dT * 0.6)}h408`} color={art.pink} core={art.pinkHi} w={1.2} />
      <Path d={Array.from({ length: 14 }, (_, i) => `M${f(i * 30 + c.r() * 10)} ${f(yD + dT + 6 + c.r() * 20)}h${f(6 + c.r() * 10)}`).join('')} stroke={art.pinkHi} strokeWidth={1.2} opacity={0.4} strokeLinecap="round" />
      {riders}
      {vignetteEl(c, 0.45)}
    </G>
  );
}

function hillsD(c: Ctx, base: number, amp: number, y0: number, step: number): string {
  const pts: Pt[] = [[-10, base + 5]];
  for (let x = -10; x <= 420; x += step) pts.push([x, y0 - Math.pow(c.r(), 0.8) * amp]);
  pts.push([420, base + 5]);
  // smooth with quadratic midpoints
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}L${f(pts[1][0])} ${f(pts[1][1])}`;
  for (let i = 1; i < pts.length - 2; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += `Q${f(pts[i][0])} ${f(pts[i][1])} ${f(mx)} ${f(my)}`;
  }
  d += `L${f(pts[pts.length - 2][0])} ${f(pts[pts.length - 2][1])}L${f(pts[pts.length - 1][0])} ${f(pts[pts.length - 1][1])}Z`;
  return d;
}

function lakeScene(c: Ctx): Node {
  const { H } = c;
  const hy = H * 0.56;
  const R = clamp(hy * 0.2, 24, 60);
  const sunX = 240;
  const sky: Stops = [
    [0, '#2E1F58'],
    [0.35, '#7A4A9A'],
    [0.62, '#E07A9A'],
    [0.84, '#FFB08A'],
    [1, '#FFE0A8'],
  ];
  const amp = clamp(hy * 0.3, 30, 120);
  const farH = hillsD(c, hy, amp, hy - amp * 0.15, 70);
  const nearH = hillsD(c, hy, amp * 0.5, hy, 55);
  const tiny = skyline(c.r, { x0: 20, x1: 150, base: hy - amp * 0.05, minH: 6, maxH: amp * 0.45, wMin: 5, wMax: 11 });
  const yS = H * 0.74;
  const shore = `M-10 ${f(yS)}Q140 ${f(yS - 12)} 260 ${f(yS - 4)}T410 ${f(yS + 2)}L410 ${f(H + 2)}L-10 ${f(H + 2)}Z`;
  const pathTop = yS + (H - yS) * 0.28;
  const path = `M-10 ${f(pathTop + 6)}Q160 ${f(pathTop - 8)} 410 ${f(pathTop + 2)}L410 ${f(pathTop + 2 + (H - yS) * 0.28)}Q160 ${f(pathTop + (H - yS) * 0.22)} -10 ${f(pathTop + 6 + (H - yS) * 0.3)}Z`;
  const reeds: string[] = [];
  for (let i = 0; i < 26; i++) {
    const x = i < 13 ? c.r() * 90 : 310 + c.r() * 90;
    const h = 10 + c.r() * clamp(H * 0.08, 10, 40);
    reeds.push(`M${f(x)} ${f(yS + 4)}q${f((c.r() - 0.5) * 6)} ${f(-h * 0.6)} ${f((c.r() - 0.3) * 8)} ${f(-h)}`);
  }
  const s = figScale(c) * 0.9;
  const mist = c.lin([
    [0, art.white, 0],
    [0.5, art.white, 0.35],
    [1, art.white, 0],
  ]);
  return (
    <G>
      {skyEl(c, sky, hy)}
      {sunEl(c, sunX, hy - R * 0.6, R, { top: '#FFFBE8', bottom: '#FFC08A', glow: '#FFC6A0', glowR: 4 })}
      {cloudsEl(c, hy * 0.2, hy * 0.7, ['#F7B4CC', '#9A7AC8'], 5)}
      {birdsEl(c, 120, hy * 0.4, 5, clamp(H / 400, 0.7, 1.4), '#3A2A5A')}
      <Path d={farH} fill={c.lin([[0, '#A07AB8'], [1, '#D8A0B8']])} />
      <Path d={tiny.body} fill="#8A6AA8" />
      <Rect x={-2} y={hy - amp * 0.4} width={404} height={amp * 0.45} fill={mist} />
      <Path d={nearH} fill={c.lin([[0, '#5A3A7E'], [1, '#7A4E8E']])} />
      <Rect x={-2} y={hy} width={404} height={H - hy + 2} fill={c.lin([[0, '#F4B8A8'], [0.4, '#9A6AA8'], [1, '#2A1A48']])} />
      <G transform={`translate(0 ${f(hy)}) scale(1 -0.8) translate(0 ${f(-hy)})`} opacity={0.45}>
        <Path d={farH} fill="#B08AC4" />
        <Path d={nearH} fill="#5A3A7E" />
      </G>
      {streaksEl(c, sunX, R * 1.3, hy, yS, ['#FFF4D0', '#FFC0A0'], 1)}
      {ripplesEl(c, hy + 3, yS, art.white, 20, 0.25)}
      <Rect x={-2} y={hy - 4} width={404} height={16} fill={mist} />
      <Path d={shore} fill={c.lin([[0, '#2A1840'], [1, '#120A20']])} />
      <Path d={path} fill={c.lin([[0, '#6A4A7A'], [1, '#3A2650']])} />
      <Path d={reeds.join('')} stroke="#120A20" strokeWidth={1.4} fill="none" strokeLinecap="round" />
      <Path d={treeD(c.r, 372, yS + 6, clamp(H * 0.4, 90, 260))} fill="#140C22" />
      <Person x={210} y={pathTop + (H - yS) * 0.2} s={s} pose="runA" flip hair="pony" rim={art.amber} light={1} />
      {vignetteEl(c, 0.3)}
    </G>
  );
}

function catenary(x1: number, y1: number, x2: number, y2: number, sag: number, n: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([lerp(x1, x2, t), lerp(y1, y2, t) + sag * 4 * t * (1 - t)]);
  }
  return pts;
}

function rooftopScene(c: Ctx): Node {
  const { H } = c;
  const hy = H * 0.66;
  const city = cityEl(c, NIGHT, hy, { valley: 0.2 });
  const yP = H * 0.78;
  const s = figScale(c);
  const yF = yP + (H - yP) * 0.6;
  const top = clamp(yP - 100 * s * 1.9, 8, yP);
  const strands = [catenary(8, top, 392, top + 12, clamp(H * 0.12, 24, 90), 22), catenary(8, top + 26, 392, top + 18, clamp(H * 0.1, 20, 70), 20)];
  const warm: Pt[] = [];
  const pink: Pt[] = [];
  strands.forEach((st) => st.forEach((p, i) => (i % 4 === 2 ? pink : warm).push([p[0], p[1] + 3])));
  const poles = rectD(5, top - 4, 3, yP - top + 4) + rectD(390, top - 4, 3, yP - top + 4);
  const pots = polyD([[18, yF - 10], [44, yF - 10], [40, yF + 6], [22, yF + 6]]);
  const [plD, plL] = leafClump(31, yF - 10, 40 * s, c.r);
  return (
    <G>
      {skyEl(c, NIGHT.sky, hy)}
      {starsEl(c, 70, hy * 0.7)}
      {moonEl(c, 90, clamp(hy * 0.2, 30, 140), clamp(hy * 0.05, 10, 22))}
      <Rect x={-2} y={hy * 0.5} width={404} height={hy * 0.5} fill={c.lin([[0, art.magenta, 0], [1, art.pink, 0.25]])} />
      {city.el}
      <Rect x={-2} y={yP - 10} width={404} height={H - yP + 12} fill={c.lin([[0, '#1A0C2A'], [1, art.night0]])} />
      <Path d={Array.from({ length: 12 }, (_, i) => `M${200 + (i - 6) * 40} ${f(yP)}L${200 + (i - 6) * 110} ${f(H + 2)}`).join('')} stroke="#2A1640" strokeWidth={0.8} />
      <Rect x={-2} y={yP - 12} width={404} height={6} fill="#0B0614" />
      <Glow d={`M-4 ${f(yP - 12)}h408`} color={art.cyan} core="#CFF8FF" w={1.2} />
      <Path d={poles} fill="#0B0614" />
      <Path d={strands.map((st) => lineD(st)).join('')} stroke="#0B0614" strokeWidth={1} fill="none" />
      <Path d={dotsD(warm)} stroke={art.amber} strokeWidth={11} strokeLinecap="round" opacity={0.2} />
      <Path d={dotsD(pink)} stroke={art.pink} strokeWidth={11} strokeLinecap="round" opacity={0.25} />
      <Path d={dotsD(warm)} stroke="#FFE7A8" strokeWidth={3.4} strokeLinecap="round" />
      <Path d={dotsD(pink)} stroke={art.pinkHi} strokeWidth={3.4} strokeLinecap="round" />
      <Path d={polyD([[80, yF + 2], [160, yF + 2], [168, yF - 4], [88, yF - 4]]) + polyD([[240, yF + 2], [330, yF + 2], [336, yF - 4], [246, yF - 4]])} fill={art.purple} opacity={0.8} />
      <Path d={pots} fill="#2A1430" />
      <Path d={plD} fill="#15402C" />
      <Path d={plL} fill="#2E7A4E" />
      <Person x={120} y={yF} s={s} pose="sideStretch" hair="bun" rim={art.cyan} />
      <Person x={200} y={yF + 3} s={s} pose="quad" hair="short" rim={art.pinkHi} flip />
      <Person x={290} y={yF} s={s} pose="lungeUp" hair="pony" rim={art.cyan} />
      {vignetteEl(c, 0.45)}
    </G>
  );
}

function stadiumScene(c: Ctx): Node {
  const { H } = c;
  const yT = H * 0.6;
  const yS = yT - clamp(H * 0.2, 40, 150);
  const sky: Stops = [
    [0, art.night0],
    [0.6, art.night1],
    [1, '#40185A'],
  ];
  const city = skyline(c.r, { base: yS + 12, minH: 20, maxH: clamp(yS * 0.6, 30, 200), wMin: 14, wMax: 30, win: { w: 1.8, h: 2.4, sx: 4.6, sy: 6, lit: 0.35, palette: NIGHT.win } });
  const stands = `M-10 ${f(yS + 8)}Q200 ${f(yS - 10)} 410 ${f(yS + 8)}L410 ${f(yT)}L-10 ${f(yT)}Z`;
  const crowd: [Pt[], Pt[], Pt[]] = [[], [], []];
  const rows: string[] = [];
  for (let y = yS + 8; y < yT - 4; y += 5) {
    rows.push(`M-10 ${f(y)}h420`);
    for (let x = -4; x < 404; x += 5 + c.r() * 5) if (c.r() < 0.45) crowd[Math.floor(c.r() * 3)].push([x, y + 2.5]);
  }
  const towers = [36, 364];
  const bankY = Math.max(16, yS - clamp(H * 0.24, 50, 220));
  const lampDots: Pt[] = [];
  towers.forEach((x) => {
    for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) lampDots.push([x - 12 + i * 6, bankY + j * 6]);
  });
  const beams = towers.map((x, i) => {
    const dir = i ? -1 : 1;
    return (
      <Path
        key={i}
        d={polyD([[x - 14, bankY], [x + 14, bankY + 12], [x + dir * 260, H + 2], [x + dir * 90, H + 2]])}
        fill={c.lin([[0, art.white, 0.28], [1, art.cyan, 0]], [0, 0, 0, 1])}
      />
    );
  });
  // track ellipses
  const tcx = 330;
  const tcy = yT + (H - yT) * 0.05;
  const rx0 = 210;
  const ry0 = (H - yT) * 0.28;
  const drx = 24;
  const dry = (H - yT) * 0.085;
  const lanes: string[] = [];
  for (let k = 0; k <= 7; k++) lanes.push(ellipseD(tcx, tcy, rx0 + k * drx, ry0 + k * dry));
  const clipId = c.id();
  c.add(
    <ClipPath key={clipId} id={clipId}>
      <Rect x={-2} y={yT} width={404} height={H - yT + 2} />
    </ClipPath>,
  );
  // sprinter on lane 5
  const lk = 5.5;
  const sx = 150;
  const rxk = rx0 + lk * drx;
  const ryk = ry0 + lk * dry;
  const sy = tcy + ryk * Math.sqrt(Math.max(0, 1 - Math.pow((sx - tcx) / rxk, 2)));
  const s = figScale(c) * 1.05;
  return (
    <G>
      {skyEl(c, sky, yT)}
      {starsEl(c, 50, yS * 0.8)}
      <Path d={city.body} fill="#1A0C2C" />
      {city.win.map(([col, d]) => (
        <Path key={col} d={d} fill={col} opacity={0.7} />
      ))}
      <Rect x={-2} y={yS - 30} width={404} height={40} fill={c.lin([[0, art.magenta, 0], [1, art.magenta, 0.4]])} />
      <Path d={stands} fill={c.lin([[0, '#1E1030'], [1, '#2C1444']])} />
      <Path d={rows.join('')} stroke="#12081E" strokeWidth={1.2} />
      <Path d={dotsD(crowd[0])} stroke={art.pinkHi} strokeWidth={1.8} strokeLinecap="round" opacity={0.55} />
      <Path d={dotsD(crowd[1])} stroke={art.cyan} strokeWidth={1.8} strokeLinecap="round" opacity={0.45} />
      <Path d={dotsD(crowd[2])} stroke={art.cloud} strokeWidth={1.8} strokeLinecap="round" opacity={0.35} />
      <Glow d={`M-10 ${f(yS + 8)}Q200 ${f(yS - 10)} 410 ${f(yS + 8)}`} color={art.pink} core={art.pinkHi} w={1.2} />
      <Path d={towers.map((x) => rectD(x - 2, bankY, 4, yT - bankY)).join('')} fill="#0B0614" />
      <Path d={towers.map((x) => rectD(x - 16, bankY - 4, 32, 20)).join('')} fill="#140A20" />
      <G clipPath={`url(#${clipId})`}>
        <Rect x={-2} y={yT} width={404} height={H - yT + 2} fill="#2A0C22" />
        <Path d={ellipseD(tcx, tcy, rx0 + 8 * drx, ry0 + 8 * dry)} fill={c.lin([[0, '#C0405A'], [1, '#6A1A36']])} />
        <Path d={ellipseD(tcx, tcy, rx0, ry0)} fill={c.lin([[0, '#1F6A42'], [1, '#0E3A26']])} />
        <Path d={lanes.join('')} stroke={art.white} strokeWidth={1.1} fill="none" opacity={0.75} />
      </G>
      {beams}
      <Path d={dotsD(lampDots)} stroke={art.white} strokeWidth={10} strokeLinecap="round" opacity={0.18} />
      <Path d={dotsD(lampDots)} stroke="#FFF6D0" strokeWidth={4} strokeLinecap="round" />
      <Glow d={`M${f(sx - 110 * s)} ${f(sy - 55 * s)}h${f(70 * s)}M${f(sx - 95 * s)} ${f(sy - 35 * s)}h${f(55 * s)}M${f(sx - 120 * s)} ${f(sy - 75 * s)}h${f(60 * s)}`} color={art.cyan} core="#CFF8FF" w={1} op={0.8} />
      <Person x={sx} y={sy} s={s} pose="sprint" hair="pony" rim={art.cyan} />
      {vignetteEl(c, 0.45)}
    </G>
  );
}

/* ================================================================= entry */

const BUILDERS: Record<SceneKind, (c: Ctx) => Node> = {
  'city-sunset': citySunset,
  'city-night': cityNight,
  'city-dawn': cityDawn,
  run: runScene,
  yoga: yogaScene,
  cafe: cafeScene,
  brunch: brunchScene,
  crew: crewScene,
  hiit: hiitScene,
  cycling: cyclingScene,
  lake: lakeScene,
  rooftop: rooftopScene,
  stadium: stadiumScene,
};

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
}

export interface SceneProps {
  kind: SceneKind;
  seed?: number;
  style?: StyleProp<ViewStyle>;
  /** width / height of the frame the scene will be shown in. Default 0.8. */
  aspect?: number;
}

export const Scene = React.memo(function Scene({ kind, seed = 1, style, aspect = 0.8 }: SceneProps) {
  const rawId = React.useId();
  const uid = 'sc' + rawId.replace(/[^a-zA-Z0-9]/g, '');
  const H = Math.round(400 / clamp(aspect, 0.2, 5));
  const content = React.useMemo(() => {
    const c = new Ctx(uid, 400, H, makeRng(seed * 131 + hashStr(kind)));
    const body = BUILDERS[kind](c);
    return { defs: c.defs, body };
  }, [kind, seed, H, uid]);
  return (
    <View style={[{ width: '100%', height: '100%', overflow: 'hidden' }, style]} pointerEvents="none">
      <Svg width="100%" height="100%" viewBox={`0 0 400 ${H}`} preserveAspectRatio="xMidYMid slice">
        <Defs>{content.defs}</Defs>
        {content.body}
      </Svg>
    </View>
  );
});
