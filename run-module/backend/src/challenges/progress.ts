import { Metric, extractMetricValue } from './metrics.js';
import { Comparator } from './types.js';

export interface ActivityRow {
  type: string;
  metrics: Record<string, any>;
}

export function computeProgress(rows: ActivityRow[], metric: Metric): number {
  let progress = 0;
  for (const row of rows) {
    progress += extractMetricValue(metric, row.type, row.metrics);
  }
  return progress;
}

export function meetsTarget(progress: number, comparator: Comparator, threshold: number): boolean {
  if (comparator === 'gte') {
    return progress >= threshold;
  }
  if (comparator === 'lte') {
    return progress <= threshold;
  }
  return false;
}