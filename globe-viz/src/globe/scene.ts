import { geoDistance } from 'd3-geo';
import Globe, { type GlobeInstance } from 'globe.gl';
import type { GlobePoint, GlobeSettings, Texture } from '../types';
import { FLY_MS, START_VIEW, flyPlan } from './camera';
import { type PointStyle, withAlpha } from './points';
import type { GlobeRegion, GlobeRenderer, SceneHandlers } from './renderer';

type GeoJsonGeometry = ReturnType<Extract<ReturnType<GlobeInstance['polygonGeoJsonGeometry']>, (...args: never[]) => unknown>>;

const TEXTURES: Record<Texture, string> = {
  day: 'earth-blue-marble.jpg',
  night: 'earth-night.jpg',
  dark: 'earth-dark.jpg',
};
const textureUrl = (file: string) => `${import.meta.env.BASE_URL}textures/${file}`;

/** Above this many points, bars are merged into one mesh: much faster, but no per-bar hover. */
export const MERGE_THRESHOLD = 10_000;
const RESUME_ROTATE_MS = 5000;
const FLY_ALTITUDE = 1.6;
/** Opening camera height (globe radii): the United States with some globe around it. */
const START_ALTITUDE = 1.5;
const REGION_BASE_ALTITUDE = 0.006;
/** Extruded shapes are much wider than bars, so keep them lower to stay readable. */
const REGION_HEIGHT_SCALE = 0.3;

/** Photoreal WebGL globe (globe.gl / three.js). */
export class GlobeScene implements GlobeRenderer {
  readonly globe: GlobeInstance;
  private settings: GlobeSettings;
  private resumeTimer: number | undefined;

  constructor(container: HTMLElement, settings: GlobeSettings, handlers: SceneHandlers) {
    this.settings = settings;
    this.globe = new Globe(container, {
      // Keeps the last frame readable for Tableau image export / screenshots.
      rendererConfig: { preserveDrawingBuffer: true, antialias: true },
    })
      .backgroundImageUrl(textureUrl('night-sky.png'))
      .pointLat('lat')
      .pointLng('lng')
      .pointResolution(8)
      .pointsTransitionDuration(600)
      .pointLabel(() => '') // Tableau renders the tooltip.
      .onPointHover((p) => {
        container.style.cursor = p ? 'pointer' : '';
        this.pauseRotation();
        handlers.onPointHover(p as GlobePoint | null);
      })
      .onPointClick((p, event) => {
        this.pauseRotation();
        handlers.onPointClick(p as GlobePoint, event);
      })
      .onGlobeClick(() => handlers.onEmptyClick())
      .polygonGeoJsonGeometry((r) => (r as GlobeRegion).feature.geometry as GeoJsonGeometry)
      .polygonStrokeColor(() => 'rgba(255,255,255,0.35)')
      .polygonsTransitionDuration(400)
      .polygonLabel(() => '')
      .onPolygonHover((r) => {
        container.style.cursor = r ? 'pointer' : '';
        this.pauseRotation();
        handlers.onPointHover((r as GlobeRegion | null)?.point ?? null);
      })
      .onPolygonClick((r, event) => {
        this.pauseRotation();
        handlers.onPointClick((r as GlobeRegion).point, event);
      });

    container.addEventListener('pointerdown', () => this.pauseRotation());
    container.addEventListener('wheel', () => this.pauseRotation(), { passive: true });

    new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      this.globe.width(width).height(height);
    }).observe(container);

    this.globe.pointOfView({ ...START_VIEW, altitude: START_ALTITUDE }, 0);
    this.applySettings(settings);
  }

  applySettings(settings: GlobeSettings): void {
    this.settings = settings;
    this.globe
      .globeImageUrl(textureUrl(TEXTURES[settings.texture]))
      // Terrain relief only reads well on the daytime texture.
      .bumpImageUrl(settings.texture === 'day' ? textureUrl('earth-topology.png') : '')
      .showAtmosphere(settings.showAtmosphere);
    const controls = this.globe.controls();
    controls.autoRotate = settings.autoRotate;
    controls.autoRotateSpeed = settings.rotateSpeed;
  }

  setPoints(points: GlobePoint[], style: PointStyle): void {
    const merge = points.length > MERGE_THRESHOLD;
    if (merge !== this.globe.pointsMerge()) {
      // Toggling merge discards the existing bar meshes; globe.gl only rebuilds them for
      // point objects it hasn't seen, so hand it fresh copies.
      this.globe.pointsMerge(merge).pointResolution(merge ? 6 : 8);
      points = points.map((p) => ({ ...p }));
    }
    this.globe
      .pointAltitude((p) => style.altitude(p as GlobePoint))
      .pointColor((p) => style.color(p as GlobePoint))
      .pointRadius(style.radius)
      .pointsData(points);
  }

  setRegions(regions: GlobeRegion[], style: PointStyle): void {
    // Flat fills sit just above the surface; with a Height field they extrude like the bars.
    const altitude = (r: GlobeRegion) =>
      style.hasHeight ? REGION_BASE_ALTITUDE + style.altitude(r.point) * REGION_HEIGHT_SCALE : REGION_BASE_ALTITUDE;
    this.globe
      .polygonAltitude((r) => altitude(r as GlobeRegion))
      .polygonCapColor((r) => style.color((r as GlobeRegion).point))
      .polygonSideColor((r) => withAlpha(style.color((r as GlobeRegion).point), 0.6))
      .polygonsData(regions);
  }

  flyTo(points: GlobePoint[]): void {
    if (points.length === 0) return;
    const { lat, lng, fitRadiusDeg } = flyPlan(points);
    const altitude = fitRadiusDeg === undefined ? FLY_ALTITUDE : this.fitAltitude(fitRadiusDeg);
    this.globe.pointOfView({ lat, lng, altitude }, FLY_MS);
  }

  project(lat: number, lng: number): { x: number; y: number } | null {
    const pov = this.globe.pointOfView();
    // From altitude h (in globe radii) the camera sees surface points within acos(1/(1+h))
    // of the point below it; beyond that they're behind the horizon.
    const horizon = Math.acos(1 / (1 + pov.altitude));
    if (geoDistance([lng, lat], [pov.lng, pov.lat]) > horizon - 0.01) return null;
    const { x, y } = this.globe.getScreenCoords(lat, lng, REGION_BASE_ALTITUDE);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  viewKey(): string {
    const p = this.globe.pointOfView();
    return `${p.lat.toFixed(3)},${p.lng.toFixed(3)},${p.altitude.toFixed(4)},${this.globe.width()},${this.globe.height()}`;
  }

  /**
   * Camera altitude (in globe radii) at which an area of angular radius `deg` around the
   * view center fills most of the view. A surface point at angle a from the center, seen
   * from distance D (radii), appears at atan(sin a / (D − cos a)) off-axis.
   */
  private fitAltitude(deg: number): number {
    const camera = this.globe.camera() as { fov?: number };
    const vHalf = ((camera.fov ?? 50) / 2) * (Math.PI / 180);
    // A hidden or not-yet-sized view reports 0 width; treat it as square.
    const w = this.globe.width();
    const h = this.globe.height();
    const aspect = w > 0 && h > 0 ? w / h : 1;
    const half = Math.atan(Math.tan(vHalf) * Math.min(1, aspect)) * 0.85;
    const a = deg * (Math.PI / 180);
    const distance = Math.cos(a) + Math.sin(a) / Math.tan(half);
    return Math.max(0.05, Math.min(3, distance - 1));
  }

  /** Stops auto-rotate while the user interacts; resumes after a quiet period. */
  pauseRotation(): void {
    if (!this.settings.autoRotate) return;
    this.globe.controls().autoRotate = false;
    window.clearTimeout(this.resumeTimer);
    this.resumeTimer = window.setTimeout(() => {
      this.globe.controls().autoRotate = this.settings.autoRotate;
    }, RESUME_ROTATE_MS);
  }
}
