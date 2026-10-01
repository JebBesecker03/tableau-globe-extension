import { geoBounds, geoDistance } from 'd3-geo';
import type { Feature, Geometry } from 'geojson';
import type { GlobePoint } from '../types';

export const FLY_MS = 1000;
/**
 * Both renderers look at the globe's center, so a bar directly below the camera is seen
 * end-on. Aiming this many degrees south of the target tilts bars into view.
 */
const TILT_DEGREES = 20;
const DEG = 180 / Math.PI;

/** Where the globe opens: centered on the contiguous United States. */
export const START_VIEW = { lat: 39.5, lng: -98.5 };

export interface FlyPlan {
  lat: number;
  lng: number;
  /**
   * For filled areas: angular radius (degrees) around lat/lng that must fit on screen.
   * Absent for bars, which use a fixed zoom and the tilt.
   */
  fitRadiusDeg?: number;
}

/**
 * Where to aim the view. Filled areas (points with radiusDeg) are centered exactly and
 * framed to fit; bars are aimed south of their centroid so they're seen from the side.
 */
export function flyPlan(points: GlobePoint[]): FlyPlan {
  const center = points.length === 1 ? { lat: points[0].lat, lng: points[0].lng } : sphericalCentroid(points);
  if (points.every((p) => p.radiusDeg !== undefined)) {
    let radius = 0;
    for (const p of points) {
      const d = geoDistance([center.lng, center.lat], [p.lng, p.lat]) * DEG;
      radius = Math.max(radius, d + p.radiusDeg!);
    }
    return { ...center, fitRadiusDeg: Math.min(90, Math.max(0.2, radius)) };
  }
  return { lat: Math.max(-85, center.lat - TILT_DEGREES), lng: center.lng };
}

/** Angular radius (degrees) from `center` that covers the feature's bounding box. */
export function areaRadiusDeg(feature: Feature<Geometry>, center: [lng: number, lat: number]): number {
  const [[x0, y0], [x1, y1]] = geoBounds(feature);
  const corners: [number, number][] = [
    [x0, y0],
    [x0, y1],
    [x1, y0],
    [x1, y1],
  ];
  return Math.max(...corners.map((c) => geoDistance(center, c))) * DEG;
}

/** Averages points as unit vectors so centroids across the antimeridian are correct. */
function sphericalCentroid(points: GlobePoint[]): { lat: number; lng: number } {
  const rad = Math.PI / 180;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    const la = p.lat * rad;
    const ln = p.lng * rad;
    x += Math.cos(la) * Math.cos(ln);
    y += Math.cos(la) * Math.sin(ln);
    z += Math.sin(la);
  }
  return {
    lat: Math.atan2(z, Math.hypot(x, y)) / rad,
    lng: Math.atan2(y, x) / rad,
  };
}
