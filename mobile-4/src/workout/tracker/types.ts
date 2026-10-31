import type { StyleProp, ViewStyle } from 'react-native';
import type { PoseFrame } from '@/workout/coach';
import type { TrackerMessage } from './trackerHtml';

export type TrackerStatus = 'loading' | 'ready' | 'denied' | 'error';

export type PoseCameraProps = {
  /** Track and send frames (false while resting or done, to save battery). */
  active: boolean;
  skeleton: 'green' | 'red' | 'white';
  onFrame: (frame: PoseFrame) => void;
  onStatus: (status: TrackerStatus, detail?: string) => void;
  style?: StyleProp<ViewStyle>;
};

/** A page frame (flat x, y, z, v × 33) as the coach's PoseFrame. */
export function toPoseFrame(m: Extract<TrackerMessage, { type: 'frame' }>): PoseFrame {
  if (!m.lm) return { width: m.w, height: m.h, landmarks: null, capturedAt: m.t, inferenceMs: m.ms };
  const landmarks: [number, number, number, number][] = [];
  for (let i = 0; i < m.lm.length; i += 4) landmarks.push([m.lm[i]!, m.lm[i + 1]!, m.lm[i + 2]!, m.lm[i + 3]!]);
  return { width: m.w, height: m.h, landmarks, capturedAt: m.t, inferenceMs: m.ms };
}
