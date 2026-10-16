/**
 * src/geometry/types.ts
 *
 * Shared geometric types for the Run Module geometry pipeline.
 * All planar coordinates are in metres relative to a local origin.
 */

/** Geographic coordinate in decimal degrees (WGS84). */
export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Planar coordinate in metres relative to the projection's local origin.
 * x increases eastward, y increases northward.
 */
export interface PlanarXY {
  x: number;
  y: number;
}

/**
 * A reversible map between geographic (WGS84) and local planar (metre) coordinates.
 * Built by createLocalProjection(); centred on the centroid of the input points.
 */
export interface Projection {
  /** Project a WGS84 point to local planar metres. */
  toPlanar(p: LatLng): PlanarXY;
  /** Unproject a local planar point back to WGS84 decimal degrees. */
  toLatLng(p: PlanarXY): LatLng;
}
