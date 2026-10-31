export type Metric = 'distance_m' | 'duration_s' | 'runs_completed' | 'territory_area_m2' | 'territories_captured';

export function extractMetricValue(metricKey: Metric, rowType: string, metricsJson: Record<string, any>): number {
  if (rowType !== 'run') return 0;

  switch (metricKey) {
    case 'distance_m':
      return typeof metricsJson.distance_m === 'number' ? metricsJson.distance_m : 0;
    case 'duration_s':
      return typeof metricsJson.elapsed_time_s === 'number' ? metricsJson.elapsed_time_s : 0;
    case 'runs_completed':
      return 1;
    case 'territory_area_m2':
      return metricsJson.territory_claimed === true && typeof metricsJson.area_m2 === 'number' ? metricsJson.area_m2 : 0;
    case 'territories_captured':
      return metricsJson.territory_claimed === true ? 1 : 0;
    default:
      return 0;
  }
}