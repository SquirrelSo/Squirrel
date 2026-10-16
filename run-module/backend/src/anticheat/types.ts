export interface LayerScore {
  layer: string;            // 'kinematic'
  score: number;            // [0, 1], 1 = clean
  signals: Record<string, any>;   // sub-signal detail
  sampleCount: number;
}
