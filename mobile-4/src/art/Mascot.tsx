import React, { useEffect, useId } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle, Platform } from 'react-native';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { art } from './palette';
import type { MascotAccessory, MascotPose } from '@/types';
import { useAnimatedValue } from '@/hooks/useAnimatedValue';

/**
 * Squirrel Social brand mascot: a chibi squirrel in a black hoodie with pink
 * shades. Drawn in a 200x200 box, feet at y≈195, centred on x=100.
 */

type Pt = readonly [number, number];

const HOOD = '#16101E';
const HOOD_LIT = '#261C33';
const HOOD_HI = '#3A2D4A';
const GOLD_DARK = '#C98E12';
const MOUTH = '#4A1426';
const EYE = '#1A0E14';
const LENS = '#140A1F';
const INNER_EAR = '#F4B38A';

const f = (n: number) => Math.round(n * 100) / 100;

/** Tapered capsule from a (radius ra) to b (radius rb). */
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

/** Unit normal of a->b pointing towards screen-right (the rim-lit side). */
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

const add = (p: Pt, n: Pt, k: number): Pt => [p[0] + n[0] * k, p[1] + n[1] * k];

// ---------------------------------------------------------------------------
// Static shapes (local 200x200 coordinates)
// ---------------------------------------------------------------------------

const HEAD =
  'M100,34 C127,34 145,50 144,72 L151,88 L139,92 C130,107 115,113 100,113 C85,113 70,107 61,92 L49,88 L56,72 C55,50 73,34 100,34Z';
const EAR = 'M62,60 C55,42 58,24 69,10 L72,18 L77,11 C85,24 88,40 86,52Z';
const EAR_INNER = 'M67,53 C63,42 65,31 71,23 C78,31 81,41 80,50Z';
const EAR_TUFT = 'M69,10 L72,18 L77,11 C79,16 80,20 80,24 C76,20 72,19 68,20 C67,16 68,13 69,10Z';
const MUZZLE = 'M79,95 C79,84 89,80 100,80 C111,80 121,84 121,95 C121,105 111,110 100,110 C89,110 79,105 79,95Z';
const NOSE = 'M94,84 Q100,80.5 106,84 Q104.5,90 100,91 Q95.5,90 94,84Z';

const TORSO =
  'M77,121 C84,113 116,113 123,121 C130,136 132,152 129,168 C113,174 87,174 71,168 C68,152 70,136 77,121Z';
const HEM = 'M71.5,162 C88,167 112,167 128.5,162 L129,168 C113,174 87,174 71,168Z';
const POCKET = 'M84,148 C90,146 110,146 116,148 L119,163 C106,166 94,166 81,163Z';

const TAIL =
  'M112,176 C146,188 192,176 196,134 L191,128 L197,122 C200,92 196,62 180,40 L173,40 L176,32 C160,14 132,8 116,20 C104,30 106,46 118,50 C126,52 132,46 130,38 C140,40 150,50 152,64 C154,80 150,100 146,118 C142,136 132,148 116,154Z';
const TAIL_STRIPE = 'M124,168 C162,164 182,136 184,104 C186,74 172,46 150,32 C138,25 124,28 120,38';
const TAIL_FUR = 'M170,150 Q178,142 180,130 M186,92 Q188,80 186,70 M160,30 Q150,24 140,24';

const SLEEP_TAIL =
  'M146,122 C170,116 188,134 187,160 C186,184 170,197 144,198 C112,201 72,200 50,194 C36,189 32,172 41,163 C48,156 62,157 65,165 C67,171 62,175 57,172 C65,181 86,180 104,178 C126,176 144,170 150,156 C154,146 152,134 146,128Z';
const SLEEP_TAIL_STRIPE = 'M170,140 C176,166 160,186 130,189 C100,191 70,189 52,178';

// ---------------------------------------------------------------------------
// Pose specification
// ---------------------------------------------------------------------------

type Hand = 'paw' | 'fist' | 'open';
type ArmLayer = 'back' | 'mid' | 'top';
type Arm = { s: Pt; e: Pt; h: Pt; hand: Hand; layer: ArmLayer };
type Leg = { hip: Pt; knee: Pt; foot: Pt; rot: number; dir: number };
type Eyes = 'open' | 'happy' | 'closed' | 'determined' | 'wide' | 'relaxed';
type Mouth = 'smirk' | 'smile' | 'grin' | 'open' | 'grit' | 'o' | 'hidden';
type TailKind = 'up' | 'run' | 'sit' | 'sleep';

type PoseSpec = {
  dy: number;
  lean: number;
  tilt: number;
  arms: [Arm, Arm];
  legs: [Leg, Leg];
  tail: TailKind;
  eyes: Eyes;
  mouth: Mouth;
  glassesUp: boolean;
  shadow: number;
};

const STAND_LEGS: [Leg, Leg] = [
  { hip: [90, 162], knee: [89, 175], foot: [88, 186], rot: 0, dir: -1 },
  { hip: [110, 162], knee: [111, 175], foot: [112, 186], rot: 0, dir: 1 },
];

const SIT_LEGS: [Leg, Leg] = [
  { hip: [92, 162], knee: [64, 168], foot: [106, 174], rot: -8, dir: 1 },
  { hip: [108, 162], knee: [136, 168], foot: [94, 176], rot: 8, dir: -1 },
];

const RELAXED_A: Arm = { s: [80, 126], e: [71, 145], h: [73, 162], hand: 'paw', layer: 'mid' };
const HIP_A: Arm = { s: [80, 126], e: [60, 140], h: [72, 156], hand: 'paw', layer: 'mid' };
const HIP_B: Arm = { s: [120, 126], e: [140, 140], h: [128, 156], hand: 'paw', layer: 'mid' };

const POSES: Record<MascotPose, PoseSpec> = {
  idle: {
    dy: 0, lean: 0, tilt: -3, tail: 'up', eyes: 'open', mouth: 'smirk', glassesUp: false, shadow: 1,
    arms: [RELAXED_A, HIP_B],
    legs: STAND_LEGS,
  },
  run: {
    dy: 0, lean: 11, tilt: 2, tail: 'run', eyes: 'determined', mouth: 'open', glassesUp: false, shadow: 1,
    arms: [
      { s: [80, 126], e: [63, 136], h: [55, 120], hand: 'fist', layer: 'back' },
      { s: [120, 126], e: [131, 146], h: [148, 136], hand: 'fist', layer: 'mid' },
    ],
    legs: [
      { hip: [92, 162], knee: [80, 174], foot: [64, 172], rot: -35, dir: -1 },
      { hip: [110, 162], knee: [126, 170], foot: [128, 186], rot: 0, dir: 1 },
    ],
  },
  celebrate: {
    dy: -8, lean: 0, tilt: -4, tail: 'up', eyes: 'happy', mouth: 'grin', glassesUp: true, shadow: 0.7,
    arms: [
      { s: [80, 124], e: [62, 108], h: [54, 86], hand: 'open', layer: 'top' },
      { s: [120, 124], e: [138, 108], h: [146, 86], hand: 'open', layer: 'top' },
    ],
    legs: [
      { hip: [90, 162], knee: [84, 174], foot: [82, 184], rot: -10, dir: -1 },
      { hip: [110, 162], knee: [116, 174], foot: [118, 184], rot: 10, dir: 1 },
    ],
  },
  drink: {
    dy: 0, lean: -2, tilt: -10, tail: 'up', eyes: 'relaxed', mouth: 'hidden', glassesUp: false, shadow: 1,
    arms: [HIP_A, { s: [120, 126], e: [134, 106], h: [113, 89], hand: 'paw', layer: 'top' }],
    legs: STAND_LEGS,
  },
  lift: {
    dy: 0, lean: 0, tilt: 0, tail: 'up', eyes: 'determined', mouth: 'grit', glassesUp: false, shadow: 1,
    arms: [
      { s: [80, 124], e: [58, 112], h: [50, 80], hand: 'fist', layer: 'top' },
      { s: [120, 124], e: [142, 112], h: [150, 80], hand: 'fist', layer: 'top' },
    ],
    legs: [
      { hip: [90, 162], knee: [83, 175], foot: [80, 186], rot: 0, dir: -1 },
      { hip: [110, 162], knee: [117, 175], foot: [120, 186], rot: 0, dir: 1 },
    ],
  },
  sit: {
    dy: 16, lean: 0, tilt: -5, tail: 'sit', eyes: 'relaxed', mouth: 'smile', glassesUp: false, shadow: 1.25,
    arms: [
      { s: [80, 126], e: [70, 143], h: [70, 158], hand: 'paw', layer: 'mid' },
      { s: [120, 126], e: [130, 143], h: [130, 158], hand: 'paw', layer: 'mid' },
    ],
    legs: SIT_LEGS,
  },
  cheer: {
    dy: 0, lean: -3, tilt: 5, tail: 'up', eyes: 'wide', mouth: 'open', glassesUp: false, shadow: 1,
    arms: [
      { s: [80, 126], e: [64, 142], h: [76, 152], hand: 'fist', layer: 'mid' },
      { s: [120, 124], e: [142, 112], h: [148, 86], hand: 'fist', layer: 'top' },
    ],
    legs: STAND_LEGS,
  },
  sleep: {
    dy: 16, lean: 3, tilt: 13, tail: 'sleep', eyes: 'closed', mouth: 'o', glassesUp: true, shadow: 1.3,
    arms: [
      { s: [80, 126], e: [82, 146], h: [96, 152], hand: 'paw', layer: 'mid' },
      { s: [120, 126], e: [118, 146], h: [104, 152], hand: 'paw', layer: 'mid' },
    ],
    legs: SIT_LEGS,
  },
  wave: {
    dy: 0, lean: 0, tilt: 5, tail: 'up', eyes: 'open', mouth: 'smile', glassesUp: false, shadow: 1,
    arms: [RELAXED_A, { s: [120, 124], e: [141, 110], h: [148, 84], hand: 'open', layer: 'top' }],
    legs: STAND_LEGS,
  },
};

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function Limb({ a, b, ra, rb, fill, hi }: { a: Pt; b: Pt; ra: number; rb: number; fill: string; hi?: string }) {
  const n = rightNormal(a, b);
  return (
    <>
      <Path d={capsule(add(a, n, 1.6), add(b, n, 1.6), ra, rb)} fill={art.pink} />
      <Path d={capsule(a, b, ra, rb)} fill={fill} />
      {hi ? <Path d={capsule(add(a, n, -ra * 0.4), add(b, n, -rb * 0.4), ra * 0.45, rb * 0.45)} fill={hi} /> : null}
    </>
  );
}

function PawShape({ p, hand }: { p: Pt; hand: Hand }) {
  const [x, y] = p;
  return (
    <>
      <Circle cx={x + 1.4} cy={y + 0.6} r={7.2} fill={art.pink} />
      <Circle cx={x} cy={y} r={7.2} fill={art.fur} />
      {hand === 'open' ? (
        <>
          <Circle cx={x - 5} cy={y - 6} r={3} fill={art.fur} />
          <Circle cx={x} cy={y - 8} r={3.2} fill={art.fur} />
          <Circle cx={x + 5} cy={y - 6} r={3} fill={art.fur} />
          <Ellipse cx={x} cy={y + 0.5} rx={3.6} ry={3} fill={art.belly} />
        </>
      ) : hand === 'fist' ? (
        <Path d={`M${x - 4},${y - 2} Q${x},${y - 4} ${x + 4},${y - 2}`} stroke={art.furDark} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      ) : (
        <Circle cx={x - 2} cy={y - 2} r={2.4} fill={art.furLight} opacity={0.8} />
      )}
    </>
  );
}

function ArmView({ arm }: { arm: Arm }) {
  const cuffA: Pt = [arm.e[0] + (arm.h[0] - arm.e[0]) * 0.62, arm.e[1] + (arm.h[1] - arm.e[1]) * 0.62];
  const cuffB: Pt = [arm.e[0] + (arm.h[0] - arm.e[0]) * 0.8, arm.e[1] + (arm.h[1] - arm.e[1]) * 0.8];
  return (
    <G>
      <Limb a={arm.s} b={arm.e} ra={8} rb={6.8} fill={HOOD} hi={HOOD_LIT} />
      <Limb a={arm.e} b={arm.h} ra={6.8} rb={6.4} fill={HOOD} hi={HOOD_LIT} />
      <Path d={capsule(cuffA, cuffB, 6.9, 6.9)} fill={HOOD_HI} />
      <PawShape p={arm.h} hand={arm.hand} />
    </G>
  );
}

function Sneaker({ x, y, dir, rot }: { x: number; y: number; dir: number; rot: number }) {
  const o = dir * 2.5;
  return (
    <G transform={rot ? `rotate(${rot} ${x} ${y})` : undefined}>
      <Rect x={x - 12 + o} y={y + 2} width={24} height={6.5} rx={3.2} fill="#E4D9EE" />
      <Path
        d={`M${x - 11 + o},${y + 4} C${x - 11 + o},${y - 7} ${x - 3 + o},${y - 9} ${x + 1 + o},${y - 8.5} C${x + 8 + o},${y - 8} ${x + 12 + o},${y - 3} ${x + 12 + o},${y + 4}Z`}
        fill={art.white}
      />
      <Path
        d={`M${x - 7 + o},${y - 3} Q${x + 1 + o},${y + 2} ${x + 9 + o},${y - 2}`}
        stroke={art.pink}
        strokeWidth={2.6}
        strokeLinecap="round"
        fill="none"
      />
      <Rect x={x - 12 + o} y={y + 6} width={24} height={2.5} rx={1.2} fill={art.pink} opacity={0.55} />
    </G>
  );
}

function LegView({ leg }: { leg: Leg }) {
  return (
    <G>
      <Limb a={leg.hip} b={leg.knee} ra={9} rb={7.5} fill={art.fur} hi={art.furLight} />
      <Limb a={leg.knee} b={leg.foot} ra={7.5} rb={6.5} fill={art.fur} />
      <Sneaker x={leg.foot[0]} y={leg.foot[1] + 1} dir={leg.dir} rot={leg.rot} />
    </G>
  );
}

function TailView({ kind, uid }: { kind: TailKind; uid: string }) {
  const sleep = kind === 'sleep';
  const d = sleep ? SLEEP_TAIL : TAIL;
  const stripe = sleep ? SLEEP_TAIL_STRIPE : TAIL_STRIPE;
  const cid = `${uid}tail${kind}`;
  let transform: string | undefined;
  if (kind === 'run') transform = 'translate(200,0) scale(-1,1) rotate(-28 114 160) translate(-6,6)';
  if (kind === 'sit') transform = 'translate(0,14)';
  return (
    <G transform={transform}>
      <Defs>
        <ClipPath id={cid}>
          <Path d={d} />
        </ClipPath>
      </Defs>
      <Path d={d} fill={art.pink} />
      <G clipPath={`url(#${cid})`}>
        <Path d={d} fill={art.furDark} transform="translate(-2.4,-1.6)" />
        <Path d={d} fill={art.fur} transform={sleep ? 'translate(-5,-7)' : 'translate(-12,-6)'} />
        <Path d={stripe} stroke={art.furLight} strokeWidth={14} strokeLinecap="round" fill="none" opacity={0.85} />
        <Path d={stripe} stroke={art.belly} strokeWidth={3.5} strokeLinecap="round" fill="none" opacity={0.55} />
        {!sleep ? <Path d={TAIL_FUR} stroke={art.furDark} strokeWidth={2.4} strokeLinecap="round" fill="none" opacity={0.7} /> : null}
      </G>
    </G>
  );
}

function Torso({ uid }: { uid: string }) {
  const cid = `${uid}torso`;
  return (
    <G>
      <Defs>
        <ClipPath id={cid}>
          <Path d={TORSO} />
        </ClipPath>
      </Defs>
      <Path d={TORSO} fill={art.pink} />
      <G clipPath={`url(#${cid})`}>
        <Path d={TORSO} fill={HOOD} transform="translate(-2,-1)" />
        <Path d={TORSO} fill={HOOD_LIT} transform="translate(-11,-3)" />
        <Path d={POCKET} fill={HOOD} opacity={0.75} />
        <Path d={HEM} fill={HOOD_HI} opacity={0.7} />
      </G>
      {/* chest fluff peeking from the collar */}
      <Path d="M92,116 L96,124 L100,118 L104,124 L108,116Z" fill={art.belly} />
      {/* drawstrings */}
      <Path d="M94,121 Q92,131 93,139" stroke={art.pink} strokeWidth={1.8} strokeLinecap="round" fill="none" />
      <Path d="M106,121 Q108,129 106,136" stroke={art.pink} strokeWidth={1.8} strokeLinecap="round" fill="none" />
      <Rect x={91.6} y={138} width={2.8} height={4.5} rx={1.2} fill={art.pinkHi} />
      <Rect x={104.6} y={135} width={2.8} height={4.5} rx={1.2} fill={art.pinkHi} />
      {/* squirrel-head chest logo */}
      <G transform="translate(114,135)">
        <Path d="M-5,-2 L-4,-8 L-1,-4Z M5,-2 L4,-8 L1,-4Z" fill={art.pink} />
        <Circle cx={0} cy={0} r={4.6} fill={art.pink} />
        <Circle cx={-1.7} cy={-0.6} r={0.9} fill={HOOD} />
        <Circle cx={1.7} cy={-0.6} r={0.9} fill={HOOD} />
      </G>
    </G>
  );
}

function Eyes({ kind }: { kind: Eyes }) {
  if (kind === 'happy') {
    return (
      <>
        <Path d="M76,75 Q84,63 92,75" stroke={EYE} strokeWidth={3.6} strokeLinecap="round" fill="none" />
        <Path d="M108,75 Q116,63 124,75" stroke={EYE} strokeWidth={3.6} strokeLinecap="round" fill="none" />
      </>
    );
  }
  if (kind === 'closed') {
    return (
      <>
        <Path d="M76,72 Q84,79 92,72" stroke={EYE} strokeWidth={3.2} strokeLinecap="round" fill="none" />
        <Path d="M108,72 Q116,79 124,72" stroke={EYE} strokeWidth={3.2} strokeLinecap="round" fill="none" />
      </>
    );
  }
  const ry = kind === 'wide' ? 11.5 : 10.5;
  const one = (cx: number, mirror: boolean) => (
    <G key={cx}>
      <Ellipse cx={cx} cy={72} rx={8.4} ry={ry} fill={EYE} />
      <Ellipse cx={cx} cy={76} rx={5.6} ry={5.5} fill="#3B1D35" />
      <Circle cx={cx - 2.8} cy={67.5} r={3.2} fill={art.white} />
      <Circle cx={cx + 2.6} cy={77} r={1.4} fill={art.white} />
      {kind === 'relaxed' ? (
        <Path d={`M${cx - 9.5},${66} Q${cx},${58} ${cx + 9.5},${66} L${cx + 9.5},${63} L${cx - 9.5},${63}Z`} fill={art.fur} />
      ) : null}
      {kind === 'determined' ? (
        <Path
          d={mirror ? `M${cx + 10},${56} L${cx - 8},${61}` : `M${cx - 10},${56} L${cx + 8},${61}`}
          stroke={art.furDark}
          strokeWidth={4}
          strokeLinecap="round"
        />
      ) : null}
      {kind === 'wide' ? (
        <Path
          d={mirror ? `M${cx + 8},${55} Q${cx},${51} ${cx - 7},${55}` : `M${cx - 8},${55} Q${cx},${51} ${cx + 7},${55}`}
          stroke={art.furDark}
          strokeWidth={3}
          strokeLinecap="round"
          fill="none"
        />
      ) : null}
    </G>
  );
  return (
    <>
      {one(84, false)}
      {one(116, true)}
    </>
  );
}

function MouthView({ kind }: { kind: Mouth }) {
  switch (kind) {
    case 'hidden':
      return null;
    case 'smirk':
      return (
        <>
          <Path d="M91,97 Q101,102 111,94" stroke={EYE} strokeWidth={2.4} strokeLinecap="round" fill="none" />
          <Rect x={97} y={98.6} width={6} height={4} rx={1} fill={art.white} />
        </>
      );
    case 'smile':
      return (
        <>
          <Path d="M89,95 Q94.5,101.5 100,96 Q105.5,101.5 111,95" stroke={EYE} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <Rect x={97.2} y={98.2} width={5.6} height={3.8} rx={1} fill={art.white} />
        </>
      );
    case 'grin':
    case 'open':
      return (
        <>
          <Path
            d={kind === 'grin' ? 'M86,94 Q100,97 114,94 Q112,112 100,112 Q88,112 86,94Z' : 'M91,95 Q100,96 109,95 Q109,109 100,109 Q91,109 91,95Z'}
            fill={MOUTH}
          />
          <Ellipse cx={100} cy={kind === 'grin' ? 107 : 105} rx={kind === 'grin' ? 8 : 5.5} ry={3.6} fill={art.coral} />
          <Rect x={96} y={95} width={8} height={5} rx={1.2} fill={art.white} />
          <Path d="M100,95 L100,100" stroke={MOUTH} strokeWidth={0.8} />
        </>
      );
    case 'grit':
      return (
        <>
          <Rect x={88} y={95} width={24} height={9} rx={4} fill={art.white} stroke={EYE} strokeWidth={2} />
          <Path d="M89,99.5 L111,99.5 M94,95.5 L94,103.5 M100,95.5 L100,103.5 M106,95.5 L106,103.5" stroke={EYE} strokeWidth={1} />
        </>
      );
    case 'o':
      return <Ellipse cx={100} cy={99} rx={3} ry={3.4} fill={MOUTH} />;
  }
}

function Sunglasses({ uid, up }: { uid: string; up: boolean }) {
  const lens = 'M70,65 Q70,61 75,61 L93,62 Q97.5,62.5 96.5,67 L94.5,78 Q93.5,84 86,84 L79,84 Q71,84 70.2,77Z';
  const gid = `${uid}lens`;
  const glid = `${uid}glint`;
  return (
    <G transform={up ? 'translate(20,-18) scale(0.8)' : undefined}>
      <Defs>
        <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={LENS} />
          <Stop offset="1" stopColor="#3A1450" />
        </LinearGradient>
        <LinearGradient id={glid} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={art.cyan} />
          <Stop offset="1" stopColor={art.pink} />
        </LinearGradient>
      </Defs>
      {!up ? (
        <Path d="M71,65 L57,61 M129,65 L143,61" stroke={art.pink} strokeWidth={2.6} strokeLinecap="round" />
      ) : null}
      {[false, true].map((m) => (
        <G key={m ? 'r' : 'l'} transform={m ? 'translate(200,0) scale(-1,1)' : undefined}>
          <Path d={lens} fill={`url(#${gid})`} stroke={art.pink} strokeWidth={3.2} strokeLinejoin="round" />
          <Path d="M76,81 L85,64.5 L90,64.5 L81,82Z" fill={`url(#${glid})`} opacity={0.75} />
          <Path d="M88.5,81 L93,72 L94,72.5 L90.5,81.5Z" fill={`url(#${glid})`} opacity={0.6} />
        </G>
      ))}
      <Path d="M96,66 Q100,62.5 104,66" stroke={art.pink} strokeWidth={3.2} strokeLinecap="round" fill="none" />
    </G>
  );
}

function Crown() {
  return (
    <G transform="rotate(16 112 30)">
      <Path d="M90,38 L88,17 L100,27 L111,9 L122,27 L134,17 L132,38Z" fill={art.yellow} />
      <Path d="M111,9 L122,27 L134,17 L132,38 L116,38Z" fill={GOLD_DARK} opacity={0.55} />
      <Path d="M90,32 L132,32 L132,38 L90,38Z" fill={GOLD_DARK} />
      <Circle cx={88} cy={16} r={2.6} fill={art.yellow} />
      <Circle cx={111} cy={8} r={2.8} fill={art.yellow} />
      <Circle cx={134} cy={16} r={2.6} fill={art.yellow} />
      <Circle cx={111} cy={27} r={3} fill={art.pink} />
      <Circle cx={98} cy={30} r={1.8} fill={art.cyan} />
      <Circle cx={124} cy={30} r={1.8} fill={art.cyan} />
      <Path d="M93,22 L95,33" stroke={art.white} strokeWidth={1.6} strokeLinecap="round" opacity={0.7} />
    </G>
  );
}

function Headband() {
  return (
    <G>
      <Path d="M55,58 Q100,34 145,58 L146,67 Q100,44 54,67Z" fill={art.pink} />
      <Path d="M56,62.5 Q100,39 144,62.5" stroke={art.white} strokeWidth={1.8} fill="none" opacity={0.85} />
      <Path d="M56,59 Q78,47 90,45" stroke={art.pinkHi} strokeWidth={1.6} strokeLinecap="round" fill="none" />
    </G>
  );
}

function Headphones() {
  return (
    <G>
      <Path d="M55,78 C46,22 154,22 145,78" stroke={HOOD} strokeWidth={7} fill="none" strokeLinecap="round" />
      <Path d="M58,58 C62,38 80,30 94,29" stroke={HOOD_HI} strokeWidth={2} fill="none" strokeLinecap="round" />
      <Rect x={43} y={64} width={17} height={28} rx={8} fill={art.pink} />
      <Rect x={140} y={64} width={17} height={28} rx={8} fill={art.pink} />
      <Rect x={46} y={68} width={6} height={20} rx={3} fill={art.pinkHi} />
      <Rect x={152} y={68} width={4} height={20} rx={2} fill={art.magenta} opacity={0.8} />
    </G>
  );
}

function HeadView({ uid, spec, accessory }: { uid: string; spec: PoseSpec; accessory: MascotAccessory }) {
  const cid = `${uid}head`;
  const glasses = accessory === 'sunglasses';
  const glassesOnEyes = glasses && !spec.glassesUp;
  return (
    <G transform={spec.tilt ? `rotate(${spec.tilt} 100 110)` : undefined}>
      {/* ears behind the head */}
      {[false, true].map((m) => (
        <G key={m ? 'r' : 'l'} transform={m ? 'translate(200,0) scale(-1,1)' : undefined}>
          <Path d={EAR} fill={m ? art.furDark : art.fur} />
          <Path d={EAR_INNER} fill={INNER_EAR} />
          <Path d={EAR_TUFT} fill={art.furDark} />
        </G>
      ))}
      <Defs>
        <ClipPath id={cid}>
          <Path d={HEAD} />
        </ClipPath>
      </Defs>
      <Path d={HEAD} fill={art.pink} />
      <G clipPath={`url(#${cid})`}>
        <Path d={HEAD} fill={art.furDark} transform="translate(-2.6,-1.6)" />
        <Ellipse cx={93} cy={66} rx={46} ry={42} fill={art.fur} />
        <Ellipse cx={78} cy={48} rx={17} ry={8} fill={art.furLight} opacity={0.55} />
        {/* cream cheeks around the muzzle */}
        <Ellipse cx={100} cy={112} rx={40} ry={16} fill={art.belly} opacity={0.35} />
      </G>
      <Path d={MUZZLE} fill={art.belly} />
      <Path d="M112,106 C118,103 121,99 121,95 C121,103 114,109 102,110Z" fill="#EFC89A" />
      <Ellipse cx={70} cy={91} rx={6} ry={3.4} fill={art.pink} opacity={0.35} />
      <Ellipse cx={130} cy={91} rx={6} ry={3.4} fill={art.pink} opacity={0.35} />
      {!glassesOnEyes ? <Eyes kind={spec.eyes} /> : null}
      {glassesOnEyes && spec.eyes === 'determined' ? (
        <Path d="M72,54 L92,59 M128,54 L108,59" stroke={art.furDark} strokeWidth={4} strokeLinecap="round" />
      ) : null}
      <Path d={NOSE} fill={art.nose} />
      <Ellipse cx={98} cy={84.3} rx={1.8} ry={1} fill={art.white} opacity={0.6} />
      <MouthView kind={spec.mouth} />
      {accessory === 'headband' ? <Headband /> : null}
      {accessory === 'headphones' ? <Headphones /> : null}
      {accessory === 'crown' ? <Crown /> : null}
      {glasses ? <Sunglasses uid={uid} up={spec.glassesUp} /> : null}
    </G>
  );
}

// ---------------------------------------------------------------------------
// Props / effects
// ---------------------------------------------------------------------------

function Bottle() {
  // nozzle at the mouth, body angled up-right
  return (
    <G transform="translate(97,97) rotate(-122)">
      <Rect x={-3} y={-2} width={6} height={6} rx={2} fill={art.white} />
      <Rect x={-6} y={3} width={12} height={7} rx={2} fill={art.pink} />
      <Rect x={-9} y={9} width={18} height={38} rx={6} fill={art.cyan} />
      <Rect x={-9} y={22} width={18} height={10} fill="#1BA8C9" />
      <Rect x={-5.5} y={12} width={3.2} height={30} rx={1.6} fill={art.white} opacity={0.55} />
    </G>
  );
}

function Barbell() {
  return (
    <G>
      <Path d="M24,80 L176,80" stroke={art.steel} strokeWidth={5} strokeLinecap="round" />
      <Path d="M24,78.6 L176,78.6" stroke={art.cloud} strokeWidth={1.4} strokeLinecap="round" opacity={0.7} />
      {[false, true].map((m) => (
        <G key={m ? 'r' : 'l'} transform={m ? 'translate(200,0) scale(-1,1)' : undefined}>
          <Rect x={26} y={58} width={12} height={44} rx={3} fill="#241238" />
          <Rect x={35} y={58} width={3} height={44} rx={1.5} fill={art.pink} />
          <Rect x={16} y={66} width={10} height={28} rx={3} fill="#241238" />
          <Rect x={23} y={66} width={3} height={28} rx={1.5} fill={art.cyan} />
        </G>
      ))}
    </G>
  );
}

const CONFETTI: { x: number; y: number; w: number; h: number; r: number; c: string; round?: boolean }[] = [
  { x: 22, y: 30, w: 7, h: 4, r: 30, c: art.pink },
  { x: 44, y: 12, w: 4, h: 4, r: 0, c: art.cyan, round: true },
  { x: 168, y: 18, w: 7, h: 4, r: -25, c: art.yellow },
  { x: 184, y: 52, w: 4, h: 4, r: 0, c: art.pink, round: true },
  { x: 16, y: 72, w: 6, h: 3.5, r: 60, c: art.yellow },
  { x: 150, y: 6, w: 3.5, h: 3.5, r: 0, c: art.yellow, round: true },
  { x: 34, y: 108, w: 3, h: 3, r: 0, c: art.cyan, round: true },
  { x: 176, y: 96, w: 7, h: 3.5, r: 40, c: art.cyan },
  { x: 62, y: 4, w: 6, h: 3.5, r: -40, c: art.pink },
  { x: 10, y: 44, w: 3, h: 3, r: 0, c: art.violet, round: true },
];

function Confetti() {
  return (
    <G>
      {CONFETTI.map((c, i) =>
        c.round ? (
          <Circle key={i} cx={c.x} cy={c.y} r={c.w / 2} fill={c.c} />
        ) : (
          <Rect key={i} x={c.x - c.w / 2} y={c.y - c.h / 2} width={c.w} height={c.h} rx={1} fill={c.c} transform={`rotate(${c.r} ${c.x} ${c.y})`} />
        ),
      )}
    </G>
  );
}

function SpeedLines() {
  return (
    <G strokeLinecap="round">
      <Path d="M10,104 L40,104" stroke={art.cyan} strokeWidth={3.5} opacity={0.9} />
      <Path d="M4,122 L30,122" stroke={art.pink} strokeWidth={3.5} opacity={0.9} />
      <Path d="M16,140 L38,140" stroke={art.cyan} strokeWidth={3} opacity={0.6} />
      <Path d="M22,86 L40,86" stroke={art.pink} strokeWidth={2.5} opacity={0.5} />
    </G>
  );
}

function Zzz() {
  const z = (x: number, y: number, s: number, o: number) => (
    <Path
      d={`M${x},${y} L${x + s},${y} L${x},${y + s} L${x + s},${y + s}`}
      stroke={art.violet}
      strokeWidth={Math.max(2, s * 0.2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      opacity={o}
    />
  );
  return (
    <G>
      {z(48, 44, 8, 0.7)}
      {z(30, 26, 11, 0.85)}
      {z(8, 4, 15, 1)}
    </G>
  );
}

function Exclaim() {
  return (
    <G transform="rotate(-12 30 40)">
      <Path d="M27,18 L37,18 L35,46 L29,46Z" fill={art.pink} transform="translate(2.5,2)" />
      <Circle cx={34.5} cy={56} r={5} fill={art.pink} />
      <Path d="M27,18 L37,18 L35,46 L29,46Z" fill={art.yellow} />
      <Circle cx={32} cy={54} r={5} fill={art.yellow} />
    </G>
  );
}

function Burst({ x, y }: { x: number; y: number }) {
  return (
    <G stroke={art.yellow} strokeWidth={2.6} strokeLinecap="round">
      <Path d={`M${x - 14},${y - 8} L${x - 20},${y - 13}`} />
      <Path d={`M${x},${y - 16} L${x},${y - 23}`} />
      <Path d={`M${x + 14},${y - 8} L${x + 20},${y - 13}`} />
    </G>
  );
}

function WaveMarks({ x, y }: { x: number; y: number }) {
  return (
    <G stroke={art.cyan} strokeWidth={2.4} strokeLinecap="round" fill="none">
      <Path d={`M${x + 13},${y - 16} Q${x + 19},${y - 8} ${x + 14},${y}`} />
      <Path d={`M${x + 20},${y - 21} Q${x + 28},${y - 9} ${x + 21},${y + 3}`} opacity={0.6} />
    </G>
  );
}

function SweatDrop() {
  return (
    <G>
      <Path d="M150,40 Q157,52 150,57 Q143,52 150,40Z" fill={art.cyan} />
      <Circle cx={148.3} cy={52} r={1.4} fill={art.white} />
    </G>
  );
}

// ---------------------------------------------------------------------------
// Figure
// ---------------------------------------------------------------------------

type MascotFigureProps = {
  pose?: MascotPose;
  accessory?: MascotAccessory;
  x?: number;
  y?: number;
  scale?: number;
  flip?: boolean;
};

export const MascotFigure = React.memo(function MascotFigure({
  pose = 'idle',
  accessory = 'sunglasses',
  x = 0,
  y = 0,
  scale = 1,
  flip = false,
}: MascotFigureProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const spec = POSES[pose];
  const transform = flip
    ? `translate(${x + 200 * scale},${y}) scale(${-scale},${scale})`
    : `translate(${x},${y}) scale(${scale})`;
  const upper = `translate(0,${spec.dy})${spec.lean ? ` rotate(${spec.lean} 100 165)` : ''}`;
  const arms = (layer: ArmLayer) =>
    spec.arms.filter((a) => a.layer === layer).map((a, i) => <ArmView key={`${layer}${i}`} arm={a} />);
  const sitting = spec.tail === 'sit' || spec.tail === 'sleep';

  return (
    <G transform={transform}>
      {/* ground shadow */}
      <Ellipse cx={100} cy={196} rx={44 * spec.shadow} ry={4.5} fill={art.ink} opacity={0.35} />
      {pose === 'run' ? <SpeedLines /> : null}
      {pose === 'celebrate' ? <Confetti /> : null}

      {spec.tail !== 'sleep' ? <TailView kind={spec.tail} uid={uid} /> : null}

      <G transform={`translate(0,${spec.dy})`}>
        {spec.legs.map((l, i) => (sitting ? null : <LegView key={i} leg={l} />))}
      </G>
      {sitting ? (
        <G>
          {spec.legs.map((l, i) => (
            <LegView key={i} leg={{ ...l, hip: [l.hip[0], l.hip[1] + 16], knee: [l.knee[0], l.knee[1] + 16], foot: [l.foot[0], l.foot[1] + 14] }} />
          ))}
        </G>
      ) : null}

      <G transform={upper}>
        {pose === 'lift' ? <Barbell /> : null}
        {arms('back')}
        <Torso uid={uid} />
        {/* rolled hood behind the neck */}
        <Path d="M72,118 C80,106 120,106 128,118 C118,113 82,113 72,118Z" fill={HOOD_HI} />
        {arms('mid')}
        <HeadView uid={uid} spec={spec} accessory={accessory} />
        {pose === 'drink' ? <Bottle /> : null}
        {arms('top')}
        {pose === 'lift' ? <SweatDrop /> : null}
        {pose === 'wave' ? <WaveMarks x={148} y={84} /> : null}
        {pose === 'cheer' ? <Burst x={148} y={78} /> : null}
      </G>

      {spec.tail === 'sleep' ? <TailView kind="sleep" uid={uid} /> : null}
      {pose === 'sleep' ? <Zzz /> : null}
      {pose === 'cheer' ? <Exclaim /> : null}
    </G>
  );
});

// ---------------------------------------------------------------------------
// Standalone component
// ---------------------------------------------------------------------------

type MascotProps = {
  pose?: MascotPose;
  accessory?: MascotAccessory;
  size?: number;
  animated?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Mascot({ pose = 'idle', accessory = 'sunglasses', size = 160, animated = false, style }: MascotProps) {
  const t = useAnimatedValue(0);

  useEffect(() => {
    if (!animated) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.sin), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(t, { toValue: 0, duration: 800, easing: Easing.inOut(Easing.sin), useNativeDriver: Platform.OS !== 'web' }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      t.setValue(0);
    };
  }, [animated, t]);

  const svg = (
    <Svg width={size} height={size} viewBox="0 0 200 200">
      <MascotFigure pose={pose} accessory={accessory} />
    </Svg>
  );

  if (!animated) {
    return <Animated.View style={[{ width: size, height: size }, style]}>{svg}</Animated.View>;
  }

  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [0, -4] });
  const scale = t.interpolate({ inputRange: [0, 1], outputRange: [1, 1.02] });
  return (
    <Animated.View style={[{ width: size, height: size, transform: [{ translateY }, { scale }] }, style]}>{svg}</Animated.View>
  );
}
