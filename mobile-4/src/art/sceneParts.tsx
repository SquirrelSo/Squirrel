/**
 * Geometry + drawing helpers for <Scene />. Everything here is deterministic
 * (seeded) and produces merged path strings so a whole scene stays well under
 * a few hundred SVG nodes.
 */
import React from 'react';
import { G, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';
import { art } from './palette';

/* ------------------------------------------------------------------ basics */

export type Rng = () => number;
export type Pt = readonly [number, number];

/** mulberry32 */
export function makeRng(seed: number): Rng {
  let a = (Math.floor(seed * 7919) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Compact number formatting for path strings. */
export function f(v: number): string {
  const r = Math.round(v * 10) / 10;
  return r === 0 ? '0' : String(r);
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const RAD = Math.PI / 180;

/** Clockwise rectangle subpath (positive winding, so unions never punch holes). */
export function rectD(x: number, y: number, w: number, h: number): string {
  return `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}z`;
}

export function circleD(cx: number, cy: number, r: number): string {
  return `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 1 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 1 ${f(-2 * r)} 0z`;
}

export function ellipseD(cx: number, cy: number, rx: number, ry: number): string {
  return `M${f(cx - rx)} ${f(cy)}a${f(rx)} ${f(ry)} 0 1 1 ${f(2 * rx)} 0a${f(rx)} ${f(ry)} 0 1 1 ${f(-2 * rx)} 0z`;
}

/** Polygon subpath normalised to clockwise winding. */
export function polyD(pts: ReadonlyArray<Pt>): string {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const list = area < 0 ? [...pts].reverse() : pts;
  return list.map((p, i) => `${i ? 'L' : 'M'}${f(p[0])} ${f(p[1])}`).join('') + 'Z';
}

/** Round dots (zero-length strokes rendered with round caps). */
export function dotsD(pts: ReadonlyArray<Pt>): string {
  return pts.map((p) => `M${f(p[0])} ${f(p[1])}h0.01`).join('');
}

export function lineD(pts: ReadonlyArray<Pt>): string {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${f(p[0])} ${f(p[1])}`).join('');
}

/** Sample a quadratic bezier. */
export function quad(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
}

/* -------------------------------------------------------------- gradients */

export type Stops = ReadonlyArray<readonly [number, string, number?]>;

/** Per-scene context: owns unique ids and the <Defs> list. */
export class Ctx {
  readonly defs: React.ReactElement[] = [];
  private count = 0;
  constructor(
    readonly uid: string,
    readonly W: number,
    readonly H: number,
    readonly r: Rng,
  ) {}

  id(): string {
    this.count += 1;
    return `${this.uid}x${this.count}`;
  }

  lin(stops: Stops, v: readonly [number, number, number, number] = [0, 0, 0, 1], user = false): string {
    const id = this.id();
    this.defs.push(
      <LinearGradient key={id} id={id} x1={v[0]} y1={v[1]} x2={v[2]} y2={v[3]} gradientUnits={user ? 'userSpaceOnUse' : 'objectBoundingBox'}>
        {stops.map(([o, c, op], i) => (
          <Stop key={i} offset={o} stopColor={c} stopOpacity={op ?? 1} />
        ))}
      </LinearGradient>,
    );
    return `url(#${id})`;
  }

  rad(stops: Stops, cx = 0.5, cy = 0.5, r = 0.5, user = false): string {
    const id = this.id();
    this.defs.push(
      <RadialGradient key={id} id={id} cx={cx} cy={cy} r={r} fx={cx} fy={cy} gradientUnits={user ? 'userSpaceOnUse' : 'objectBoundingBox'}>
        {stops.map(([o, c, op], i) => (
          <Stop key={i} offset={o} stopColor={c} stopOpacity={op ?? 1} />
        ))}
      </RadialGradient>,
    );
    return `url(#${id})`;
  }

  /** Register a def element built by the caller (e.g. ClipPath). */
  add(el: React.ReactElement): void {
    this.defs.push(el);
  }
}

/** Neon glow: wide faint stroke + medium + bright core. */
export function Glow({ d, color, core, w = 2, op = 1 }: { d: string; color: string; core?: string; w?: number; op?: number }) {
  return (
    <G opacity={op}>
      <Path d={d} stroke={color} strokeWidth={w * 5} strokeOpacity={0.12} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <Path d={d} stroke={color} strokeWidth={w * 2.2} strokeOpacity={0.35} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <Path d={d} stroke={core ?? color} strokeWidth={w} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </G>
  );
}

/* --------------------------------------------------------------- skyline */

export interface WinOpts {
  w: number;
  h: number;
  sx: number;
  sy: number;
  lit: number;
  palette: ReadonlyArray<readonly [string, number]>;
}

export interface SkyOpts {
  x0?: number;
  x1?: number;
  base: number;
  minH: number;
  maxH: number;
  wMin: number;
  wMax: number;
  gap?: number;
  /** Lower the skyline around valleyX (0..1 strength) so a sun can show. */
  valley?: number;
  valleyX?: number;
  domes?: boolean;
  win?: WinOpts;
}

export interface Tower {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SkyResult {
  body: string;
  win: Array<readonly [string, string]>;
  towers: Tower[];
}

function pickWeighted(r: Rng, list: ReadonlyArray<readonly [string, number]>): string {
  const total = list.reduce((s, [, w]) => s + w, 0);
  let v = r() * total;
  for (const [c, w] of list) {
    v -= w;
    if (v <= 0) return c;
  }
  return list[list.length - 1][0];
}

export function skyline(r: Rng, o: SkyOpts): SkyResult {
  const x1 = o.x1 ?? 412;
  let x = o.x0 ?? -12;
  const body: string[] = [];
  const win = new Map<string, string[]>();
  const towers: Tower[] = [];
  const vx = o.valleyX ?? 200;
  while (x < x1) {
    const w = o.wMin + r() * (o.wMax - o.wMin);
    const cx = x + w / 2;
    const env = o.valley ? 1 - o.valley * Math.max(0, 1 - Math.abs(cx - vx) / 150) : 1;
    let h = (o.minH + Math.pow(r(), 1.5) * (o.maxH - o.minH)) * env;
    if (r() < 0.12) h *= 1.3;
    const top = o.base - h;
    body.push(rectD(x, top, w, h + 3));
    let roof = top;
    const k = r();
    if (k < 0.22 && w > 12) {
      const ins = w * 0.16;
      const sh = h * 0.1 + 4;
      body.push(rectD(x + ins, top - sh, w - 2 * ins, sh + 1));
      roof = top - sh;
      if (r() < 0.5) {
        const ins2 = w * 0.34;
        const sh2 = sh * 0.7;
        body.push(rectD(x + ins2, roof - sh2, w - 2 * ins2, sh2 + 1));
        roof -= sh2;
      }
    } else if (k < 0.34) {
      const sh = w * 0.8;
      body.push(polyD([[x + w * 0.15, top + 1], [x + w / 2, top - sh], [x + w * 0.85, top + 1]]));
      roof = top - sh;
    } else if (k < 0.44 && o.domes) {
      const rr = w * 0.34;
      body.push(`M${f(cx - rr)} ${f(top + 1)}A${f(rr)} ${f(rr * 1.1)} 0 0 1 ${f(cx + rr)} ${f(top + 1)}Z`);
      body.push(rectD(cx - 0.7, top - rr * 1.1 - 5, 1.4, 6));
      roof = top - rr * 1.1 - 5;
    } else if (k < 0.54) {
      const s = w * 0.3;
      body.push(polyD(r() < 0.5 ? [[x, top + 1], [x, top - s], [x + w, top + 1]] : [[x, top + 1], [x + w, top - s], [x + w, top + 1]]));
      roof = top - s;
    }
    if (r() < 0.28) {
      const ax = x + w * (0.3 + r() * 0.4);
      const ah = 6 + r() * 12;
      body.push(rectD(ax, roof - ah, 1.1, ah + 1));
    }
    towers.push({ x, y: top, w, h });

    if (o.win) {
      const wo = o.win;
      const bias = pickWeighted(r, wo.palette);
      const bandy = r() < 0.14;
      const lit = wo.lit * (0.35 + r() * 1.1);
      const m = Math.max(2, (w - Math.floor((w - 4) / wo.sx) * wo.sx) / 2 + (wo.sx - wo.w) / 2);
      for (let wy = top + wo.sy * 0.8; wy < o.base - wo.h - 1; wy += wo.sy) {
        if (bandy) {
          if (r() < lit * 1.2) {
            const c = r() < 0.75 ? bias : pickWeighted(r, wo.palette);
            const arr = win.get(c) ?? [];
            arr.push(rectD(x + 2, wy + wo.h * 0.3, w - 4, wo.h * 0.45));
            win.set(c, arr);
          }
          continue;
        }
        for (let wx = x + m; wx + wo.w < x + w - 1.5; wx += wo.sx) {
          if (r() < lit) {
            const c = r() < 0.72 ? bias : pickWeighted(r, wo.palette);
            const arr = win.get(c) ?? [];
            arr.push(rectD(wx, wy, wo.w, wo.h));
            win.set(c, arr);
          }
        }
      }
    }
    x += w + (o.gap ?? 0) * r() - 0.5;
  }
  return { body: body.join(''), win: [...win.entries()].map(([c, a]) => [c, a.join('')] as const), towers };
}

/** Draws a skyline layer (body + windows). */
export function SkylineLayer({ sky, fill, winOpacity = 0.9 }: { sky: SkyResult; fill: string; winOpacity?: number }) {
  return (
    <G>
      <Path d={sky.body} fill={fill} />
      {sky.win.map(([c, d]) => (
        <Path key={c} d={d} fill={c} opacity={winOpacity} />
      ))}
    </G>
  );
}

/* ------------------------------------------------------------------ palms */

/** A whole palm tree as one filled path. */
export function palmD(r: Rng, x: number, base: number, h: number, lean: number): string {
  const parts: string[] = [];
  const top: Pt = [x + lean, base - h];
  const ctrl: Pt = [x + lean * 0.15, base - h * 0.55];
  const left: Pt[] = [];
  const right: Pt[] = [];
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = quad([x, base], ctrl, top, t);
    const hw = lerp(h * 0.03, h * 0.014, t);
    left.push([p[0] - hw, p[1]]);
    right.push([p[0] + hw, p[1]]);
  }
  parts.push(polyD([...left, ...right.reverse()]));
  // fronds
  const angles = [-18, 8, 32, 60, 88, 118, 148, 172, 198];
  for (const a0 of angles) {
    const a = (a0 + (r() - 0.5) * 14) * RAD;
    const L = h * (0.3 + r() * 0.1);
    const dx = Math.cos(a);
    const dy = -Math.sin(a);
    const tip: Pt = [top[0] + dx * L, top[1] + dy * L * 0.45 + L * 0.42];
    const c: Pt = [top[0] + dx * L * 0.55, top[1] + dy * L * 0.5 - L * 0.12];
    const upper: Pt[] = [];
    const lower: Pt[] = [];
    const S = 16;
    for (let i = 0; i <= S; i++) {
      const t = i / S;
      const p = quad(top, c, tip, t);
      upper.push(p);
      const wv = L * 0.1 * Math.sin(Math.PI * Math.min(1, t * 1.1)) * (i % 2 ? 1.6 : 0.7);
      lower.push([p[0] - dx * wv * 0.35, p[1] + wv]);
    }
    parts.push(polyD([...upper, ...lower.reverse()]));
  }
  parts.push(circleD(top[0] - 2, top[1] + 3, h * 0.018 + 0.8));
  parts.push(circleD(top[0] + 2.5, top[1] + 4, h * 0.018 + 0.8));
  return parts.join('');
}

/** Round-canopy tree as one path. */
export function treeD(r: Rng, x: number, base: number, h: number): string {
  const parts: string[] = [];
  const tw = h * 0.05;
  parts.push(polyD([[x - tw, base], [x - tw * 0.6, base - h * 0.55], [x + tw * 0.6, base - h * 0.55], [x + tw, base]]));
  const cy = base - h * 0.62;
  const R = h * 0.3;
  const blobs = 6;
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 + r();
    const rr = R * (0.5 + r() * 0.25);
    parts.push(circleD(x + Math.cos(a) * R * 0.55, cy + Math.sin(a) * R * 0.45, rr));
  }
  parts.push(circleD(x, cy - R * 0.1, R * 0.7));
  return parts.join('');
}

/* ----------------------------------------------------------------- people */

export type Ang = readonly [number, number];

/**
 * A pose, angles in degrees measured from "straight down"; positive swings
 * toward +x (forward in side view, figure's left in front view).
 */
export interface Pose {
  front?: boolean;
  lean?: number;
  tilt?: number;
  armA: Ang;
  armB: Ang;
  legA: Ang;
  legB: Ang;
  lift?: number;
  /** Keep hip at (0,-50); don't auto-ground on lowest point. */
  free?: boolean;
}

export const POSES = {
  runA: { lean: 12, armA: [45, 125], armB: [-50, 15], legA: [58, 10], legB: [-28, -100] },
  runB: { lean: 10, armA: [-40, 30], armB: [40, 120], legA: [28, 2], legB: [-38, -80] },
  runC: { lean: 14, armA: [60, 140], armB: [-60, 0], legA: [70, 20], legB: [-20, -115], lift: 3 },
  sprint: { lean: 16, tilt: -8, armA: [70, 150], armB: [-65, -5], legA: [72, 5], legB: [-38, -72], lift: 8 },
  stand: { armA: [8, 6], armB: [-6, -4], legA: [4, 2], legB: [-3, -2] },
  standF: { front: true, armA: [14, 8], armB: [-14, -8], legA: [5, 2], legB: [-5, -2] },
  armsUp: { front: true, armA: [155, 170], armB: [-155, -170], legA: [10, 6], legB: [-10, -6] },
  cheerJump: { front: true, armA: [145, 160], armB: [-150, -175], legA: [30, -20], legB: [-25, 25], lift: 14 },
  fistPump: { front: true, armA: [150, 200], armB: [-20, -40], legA: [9, 4], legB: [-8, -4] },
  highFive: { lean: 4, tilt: -10, armA: [125, 148], armB: [-15, 5], legA: [14, 6], legB: [-12, -8] },
  tree: { front: true, armA: [165, 210], armB: [-165, -210], legA: [60, -75], legB: [0, 0] },
  warrior: { front: true, armA: [92, 90], armB: [-92, -90], legA: [62, 4], legB: [-45, -45] },
  downDog: { lean: 128, tilt: 20, armA: [34, 34], armB: [30, 30], legA: [-32, -32], legB: [-28, -28] },
  press: { front: true, armA: [150, 176], armB: [-150, -176], legA: [11, 5], legB: [-11, -5] },
  jack: { front: true, armA: [128, 150], armB: [-128, -150], legA: [24, 24], legB: [-24, -24], lift: 5 },
  tuckJump: { lean: 10, armA: [130, 150], armB: [120, 145], legA: [85, -20], legB: [70, -30], lift: 20 },
  plank: { lean: 74, tilt: 16, armA: [8, 8], armB: [2, 2], legA: [-68, -68], legB: [-64, -64] },
  lungeUp: { lean: 2, armA: [172, 178], armB: [168, 176], legA: [80, 2], legB: [-40, -100] },
  sideStretch: { front: true, lean: -14, armA: [160, 240], armB: [-40, 30], legA: [8, 4], legB: [-8, -4] },
  quad: { lean: 2, armA: [80, 85], armB: [-14, -18], legA: [2, 0], legB: [-6, -164] },
  sit: { lean: 4, armA: [35, 90], armB: [30, 85], legA: [90, 2], legB: [85, -2], free: true },
  cycle: { lean: 58, tilt: -25, armA: [62, 78], armB: [58, 72], legA: [52, -6], legB: [16, 22], free: true },
} satisfies Record<string, Pose>;

export type PoseName = keyof typeof POSES;
export type Hair = 'pony' | 'bun' | 'short' | 'cap';

export interface Joints {
  hip: Pt;
  neck: Pt;
  head: Pt;
  hands: [Pt, Pt];
  feet: [Pt, Pt];
}

const dir = (a: number): Pt => [Math.sin(a * RAD), Math.cos(a * RAD)];
const add = (p: Pt, v: Pt, s: number): Pt => [p[0] + v[0] * s, p[1] + v[1] * s];

export interface Figure {
  body: string; // torso + head + hair (filled)
  thigh: string;
  shin: string;
  upper: string;
  fore: string;
  joints: Joints;
}

/** Solve a pose into merged paths. Units: figure ~100 tall, feet at y=0. */
export function buildFigure(pose: Pose, hair: Hair = 'short'): Figure {
  const L = pose.lean ?? 0;
  const hip0: Pt = [0, -50];
  const u: Pt = [Math.sin(L * RAD), -Math.cos(L * RAD)];
  const perp: Pt = [Math.cos(L * RAD), Math.sin(L * RAD)];
  const neck0 = add(hip0, u, 30);
  const shC = add(hip0, u, 27);
  const ht = (L + (pose.tilt ?? 0)) * RAD;
  const head0 = add(neck0, [Math.sin(ht), -Math.cos(ht)], 8.5);
  const fr = !!pose.front;
  const sw = fr ? 7.5 : 0;
  const hw = fr ? 4.5 : 0;
  const shA = add(shC, perp, sw);
  const shB = add(shC, perp, -sw);
  const hpA = add(hip0, perp, hw);
  const hpB = add(hip0, perp, -hw);
  const arm = (sh: Pt, a: Ang) => {
    const el = add(sh, dir(a[0]), 15);
    return [sh, el, add(el, dir(a[1]), 14)] as const;
  };
  const leg = (hp: Pt, a: Ang, side: number) => {
    const kn = add(hp, dir(a[0]), 24);
    const an = add(kn, dir(a[1]), 23);
    const toe: Pt = fr ? [an[0] + side * 3, an[1] + 0.5] : [an[0] + Math.cos(a[1] * RAD) * 6, an[1] - Math.sin(a[1] * RAD) * 6];
    return [hp, kn, an, toe] as const;
  };
  const aA = arm(shA, pose.armA);
  const aB = arm(shB, pose.armB);
  const lA = leg(hpA, pose.legA, 1);
  const lB = leg(hpB, pose.legB, -1);

  let dy = 0;
  if (!pose.free) {
    const maxY = Math.max(lA[2][1] + 3, lB[2][1] + 3, lA[3][1] + 2, lB[3][1] + 2, aA[2][1] + 2, aB[2][1] + 2);
    dy = -maxY - (pose.lift ?? 0);
  }
  const T = (p: Pt): Pt => [p[0], p[1] + dy];

  const ws = fr ? 11 : 8;
  const wh = fr ? 8 : 7;
  const hipLow = add(hip0, u, -3);
  const torso = polyD([
    T(add(shC, perp, ws)),
    T(add(add(shC, perp, ws * 0.7), u, 3.5)),
    T(add(add(shC, perp, -ws * 0.7), u, 3.5)),
    T(add(shC, perp, -ws)),
    T(add(hipLow, perp, -wh)),
    T(add(hipLow, perp, wh)),
  ]);
  const hd = T(head0);
  let hairD = '';
  const back = -1; // hair trails behind (−x) in side view
  if (hair === 'pony') {
    hairD = fr
      ? circleD(hd[0], hd[1] - 7.5, 3.2)
      : polyD([[hd[0] + back * 3, hd[1] - 5], [hd[0] + back * 13, hd[1] - 3], [hd[0] + back * 15, hd[1] + 5], [hd[0] + back * 10, hd[1] + 1], [hd[0] + back * 5, hd[1] + 1]]);
  } else if (hair === 'bun') {
    hairD = circleD(hd[0] + (fr ? 0 : back * 3), hd[1] - 7.2, 3.6);
  } else if (hair === 'cap') {
    hairD = fr ? rectD(hd[0] - 8, hd[1] - 4, 16, 2.4) : polyD([[hd[0] - 2, hd[1] - 5], [hd[0] + 11, hd[1] - 4], [hd[0] + 10, hd[1] - 2.2], [hd[0] - 1, hd[1] - 2.5]]);
  }
  const body = torso + circleD(hd[0], hd[1], 7.6) + hairD;
  const seg = (a: Pt, b: Pt) => `M${f(T(a)[0])} ${f(T(a)[1])}L${f(T(b)[0])} ${f(T(b)[1])}`;
  const thigh = seg(lA[0], lA[1]) + seg(lB[0], lB[1]);
  const shin = lineD([T(lA[1]), T(lA[2]), T(lA[3])]) + lineD([T(lB[1]), T(lB[2]), T(lB[3])]);
  const upper = seg(aA[0], aA[1]) + seg(aB[0], aB[1]) + seg(neck0, head0);
  const fore = seg(aA[1], aA[2]) + seg(aB[1], aB[2]);
  return {
    body,
    thigh,
    shin,
    upper,
    fore,
    joints: { hip: T(hip0), neck: T(neck0), head: hd, hands: [T(aA[2]), T(aB[2])], feet: [T(lA[2]), T(lB[2])] },
  };
}

function FigureShape({ fig, color, extra = 0 }: { fig: Figure; color: string; extra?: number }) {
  const s = { stroke: color, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <G>
      <Path d={fig.thigh} {...s} strokeWidth={12.5 + extra} />
      <Path d={fig.shin} {...s} strokeWidth={8.4 + extra} />
      <Path d={fig.upper} {...s} strokeWidth={7.4 + extra} />
      <Path d={fig.fore} {...s} strokeWidth={5.6 + extra} />
      <Path d={fig.body} fill={color} stroke={extra ? color : 'none'} strokeWidth={extra} strokeLinejoin="round" />
    </G>
  );
}

export interface PersonProps {
  x: number;
  y: number;
  s: number;
  pose: PoseName | Pose;
  flip?: boolean;
  rim?: string;
  hair?: Hair;
  color?: string;
  /** rim-light direction in scene space (+1 = light from the right). */
  light?: number;
  shadow?: boolean;
  /** Extra things (props like a barbell) drawn in figure space. */
  children?: React.ReactNode;
  reflect?: number;
}

export function Person({ x, y, s, pose, flip, rim = art.pink, hair = 'short', color = art.silhouette, light = 1, shadow = true, children, reflect }: PersonProps) {
  const p: Pose = typeof pose === 'string' ? POSES[pose] : pose;
  const fig = buildFigure(p, hair);
  const sx = flip ? -s : s;
  const ldx = (flip ? -light : light) * 1.3;
  return (
    <G>
      {shadow && <Path d={ellipseD(x, y, 22 * s, 3.2 * s)} fill="#000" opacity={0.35} />}
      {reflect ? (
        <G transform={`translate(${f(x)} ${f(y)}) scale(${sx} ${-s * 0.9})`} opacity={reflect}>
          <FigureShape fig={fig} color={rim} />
        </G>
      ) : null}
      <G transform={`translate(${f(x)} ${f(y)}) scale(${sx} ${s})`}>
        <G transform={`translate(${ldx} -1)`}>
          <FigureShape fig={fig} color={rim} extra={0.6} />
        </G>
        <FigureShape fig={fig} color={color} />
        {children}
      </G>
    </G>
  );
}

/** Returns joints of a pose in figure space (for attaching props). */
export function poseJoints(pose: PoseName | Pose): Joints {
  const p: Pose = typeof pose === 'string' ? POSES[pose] : pose;
  return buildFigure(p).joints;
}
