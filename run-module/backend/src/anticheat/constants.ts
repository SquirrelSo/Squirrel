// ~2:19/km. Above elite sprint pace sustained; matches RM-1.2's client-side bound so the server enforces the same limit independently.
export const MAX_PLAUSIBLE_SPEED_MS = 12.0;

// 2:00/km, the spec's own car-speed example. An AVERAGE at or above this over a whole run is implausible.
export const IMPLAUSIBLE_AVG_SPEED_MS = 8.33;

// Sustained acceleration between consecutive GPS samples. Human sprint starts exceed this instantaneously but not across 1 Hz samples.
export const MAX_PLAUSIBLE_ACCEL_MS2 = 4.0;

// ~90 km/h between consecutive points: not a measurement error, a discontinuity.
export const TELEPORT_MIN_SPEED_MS = 25.0;

export const MIN_SAMPLES_FOR_SCORING = 10;

export const LOW_ACCURACY_THRESHOLD_M = 20.0;
export const LOW_ACCURACY_FAIL_RATIO = 0.5;
export const SUSPICIOUS_ACCURACY_VARIANCE = 0.1;

export const MOCK_RATIO_FAIL = 0.0;
export const ROOT_SIGNAL_PENALTY = 0.3;

export const SPEED_CV_SUSPICIOUS = 0.05;
export const DUPLICATE_HAUSDORFF_M = 15.0;
export const DUPLICATE_AREA_TOLERANCE = 0.02;
export const DUPLICATE_DURATION_TOLERANCE = 0.05;
export const DUPLICATE_PACE_TOLERANCE = 0.05;
export const DUPLICATE_LOOKBACK_RUNS = 50;

export const OVERLAP_MIN_SECONDS = 60;
export const IMPOSSIBLE_UPLOAD_SKEW_S = 60;
export const TEMPORAL_LOOKBACK_RUNS = 50;

export const BAND_REJECT_BELOW = 0.3;
export const BAND_ACCEPT_ABOVE = 0.7;

export const TERRITORY_TTL_DAYS = 14;
