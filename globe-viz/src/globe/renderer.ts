import type { Feature, Geometry } from 'geojson';
import type { GlobePoint, GlobeSettings } from '../types';
import type { PointStyle } from './points';

export interface SceneHandlers {
  onPointHover: (point: GlobePoint | null) => void;
  onPointClick: (point: GlobePoint, event: MouseEvent) => void;
  onEmptyClick: () => void;
}

/** A filled country/state for the choropleth, tied to the mark that colors it. */
export interface GlobeRegion {
  point: GlobePoint;
  feature: Feature<Geometry>;
}

/**
 * A globe that draws bars and filled regions and reports interactions. Implemented by
 * the WebGL globe (globe.gl) and by a Canvas 2D fallback for hosts without WebGL, such as
 * Tableau Desktop.
 */
export interface GlobeRenderer {
  applySettings(settings: GlobeSettings): void;
  setPoints(points: GlobePoint[], style: PointStyle): void;
  setRegions(regions: GlobeRegion[], style: PointStyle): void;
  /** Animates the view to a point, or to the centroid of several points. */
  flyTo(points: GlobePoint[]): void;
  /**
   * Screen position (CSS px within the globe container) of a surface point, or null when
   * it's on the far side of the globe.
   */
  project(lat: number, lng: number): { x: number; y: number } | null;
  /** Changes whenever the camera or view size changes, so overlays know to redraw. */
  viewKey(): string;
}

export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
