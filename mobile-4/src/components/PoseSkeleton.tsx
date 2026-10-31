import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, G, Line } from 'react-native-svg';
import { colors } from '@/theme';

/**
 * Body-tracking overlay: glowing bones + joints on a 100×100 box.
 * `pose` holds joint positions (0–100). Joints named in `faults` are drawn in the alert colour.
 */
export type Joint = 'shoulder' | 'chest' | 'elbow' | 'wrist' | 'hip' | 'knee' | 'ankle' | 'hip2' | 'knee2' | 'ankle2';
export type Pose = Record<Joint, [number, number]>;

const BONES: [Joint, Joint][] = [
  ['shoulder', 'elbow'],
  ['elbow', 'wrist'],
  ['shoulder', 'chest'],
  ['chest', 'hip'],
  ['hip', 'knee'],
  ['knee', 'ankle'],
  ['hip2', 'knee2'],
  ['knee2', 'ankle2'],
];
const DOTS: Joint[] = ['shoulder', 'chest', 'elbow', 'wrist', 'hip', 'knee', 'ankle', 'knee2', 'ankle2'];

export function PoseSkeleton({ pose, faults = [], color = colors.primary, style }: { pose: Pose; faults?: Joint[]; color?: string; style?: StyleProp<ViewStyle> }) {
  const tint = (j: Joint) => (faults.includes(j) ? colors.coral : color);
  return (
    <Svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style={[StyleSheet.absoluteFill, style]} pointerEvents="none">
      {/* glow pass */}
      <G opacity={0.28}>
        {BONES.map(([a, b]) => (
          <Line key={`g${a}${b}`} x1={pose[a][0]} y1={pose[a][1]} x2={pose[b][0]} y2={pose[b][1]} stroke={tint(b)} strokeWidth={3.2} strokeLinecap="round" />
        ))}
      </G>
      {BONES.map(([a, b]) => (
        <Line key={`${a}${b}`} x1={pose[a][0]} y1={pose[a][1]} x2={pose[b][0]} y2={pose[b][1]} stroke={tint(b)} strokeWidth={0.9} strokeLinecap="round" opacity={a.endsWith('2') ? 0.75 : 1} />
      ))}
      {DOTS.map((j) => (
        <G key={j}>
          <Circle cx={pose[j][0]} cy={pose[j][1]} r={2.6} fill={tint(j)} opacity={0.25} />
          <Circle cx={pose[j][0]} cy={pose[j][1]} r={1.4} fill={tint(j)} />
        </G>
      ))}
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Guided squat motion (used until the phone can run a pose model)
// ---------------------------------------------------------------------------

const STAND: Pose = {
  shoulder: [49, 28], chest: [48, 38], elbow: [61, 29], wrist: [75, 29],
  hip: [46, 50], knee: [48, 68], ankle: [46, 86],
  hip2: [52, 50], knee2: [55, 68], ankle2: [55, 86],
};
const SQUAT: Pose = {
  shoulder: [53, 43], chest: [47, 51], elbow: [65, 41], wrist: [79, 40],
  hip: [37, 60], knee: [55, 63], ankle: [47, 86],
  hip2: [43, 61], knee2: [62, 62], ankle2: [56, 86],
};

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** depth 0 = standing, 1 = bottom of the squat. */
export function squatPose(depth: number): Pose {
  const t = ease(Math.min(1, Math.max(0, depth)));
  const out = {} as Pose;
  (Object.keys(STAND) as Joint[]).forEach((j) => {
    out[j] = [STAND[j][0] + (SQUAT[j][0] - STAND[j][0]) * t, STAND[j][1] + (SQUAT[j][1] - STAND[j][1]) * t];
  });
  return out;
}
