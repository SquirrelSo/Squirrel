/**
 * Development-only pose diagnostics over the live workout: frame rate, model time, camera and
 * model resolution, person confidence, joints, framing and the exercise state. Rendered only when
 * EXPO_PUBLIC_POSE_DEBUG=1 (api/config POSE_DEBUG), which production builds never set.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { CoachDebug } from './coach';

/** MediaPipe PoseLandmarker lite: the detector sees 224×224, the landmark model a 256×256 crop. */
const MODEL_INPUT = 'detector 224² · landmarks 256² crop';

export function PoseDebugOverlay({ read, delegate, top }: { read: () => CoachDebug | null; delegate?: string; top: number }) {
  const [d, setD] = useState<CoachDebug | null>(null);
  useEffect(() => {
    const id = setInterval(() => setD(read()), 250);
    return () => clearInterval(id);
  }, [read]);
  if (!d) return null;
  const f = d.framing;
  const box = f.box ? `${f.box.x0.toFixed(2)},${f.box.y0.toFixed(2)} → ${f.box.x1.toFixed(2)},${f.box.y1.toFixed(2)}` : '—';
  const lines = [
    `FPS ${d.fps.toFixed(1)} · inference ${d.inferenceMs ?? '—'} ms`,
    `camera ${d.width}×${d.height} · ${delegate ?? '—'}`,
    `model ${MODEL_INPUT}`,
    `person ${f.box ? 'yes' : 'no'} · confidence ${f.confidence.toFixed(2)}`,
    `joints ${f.visibleLandmarks}/33 · essential ${f.visibleEssential}/${f.totalEssential}`,
    `body ${(f.bodyHeight * 100).toFixed(0)}% · box ${box}`,
    `framing ${f.kind}`,
    `phase ${d.phase} · state ${d.movement ?? '—'} · reps ${d.reps ?? '—'}`,
  ];
  return (
    <View style={[styles.box, { top }]} pointerEvents="none">
      {lines.map((l, i) => <Text key={i} style={styles.line}>{l}</Text>)}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { position: 'absolute', left: 8, backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 6, padding: 6, maxWidth: 320 },
  line: { color: '#9f9', fontSize: 10, fontFamily: 'monospace' },
});
