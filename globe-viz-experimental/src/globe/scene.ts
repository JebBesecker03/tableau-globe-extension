import { geoDistance } from 'd3-geo';
import Globe, { type GlobeInstance } from 'globe.gl';
import type { GlobePoint, GlobeSettings } from '../types';
import { FLY_MS, START_VIEW, flyPlan } from './camera';
import { loadTexture } from './imagery';
import { type PointStyle, mixWithWhite, scaleAlpha, withAlpha } from './points';
import type { GlobeRegion, GlobeRenderer, SceneHandlers } from './renderer';
import { drawSunBehind, drawSunFront } from './sun';

type GeoJsonGeometry = ReturnType<Extract<ReturnType<GlobeInstance['polygonGeoJsonGeometry']>, (...args: never[]) => unknown>>;

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
/** Neon: cap fills slightly see-through, edges mixed toward white. */
const NEON_FILL_ALPHA = 0.82;

/** Photoreal WebGL globe (globe.gl / three.js). */
export class GlobeScene implements GlobeRenderer {
  readonly globe: GlobeInstance;
  private settings: GlobeSettings;
  private resumeTimer: number | undefined;
  private regionStyle: PointStyle | null = null;
  private readonly sun: SunLayers;

  constructor(container: HTMLElement, settings: GlobeSettings, handlers: SceneHandlers) {
    this.settings = settings;
    // The sun layers sit behind and in front of the WebGL canvas within the container.
    container.style.isolation = 'isolate';
    this.globe = new Globe(container, {
      // Keeps the last frame readable for Tableau image export / screenshots.
      rendererConfig: { preserveDrawingBuffer: true, antialias: true, alpha: true },
    })
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

    this.sun = new SunLayers(container, () => this.screenCircle());

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
    const previous = this.settings;
    this.settings = settings;
    if (previous.texture !== settings.texture || !this.globe.globeImageUrl()) {
      // Midnight is generated in the browser; the others are the texture files.
      loadTexture(settings.texture)
        .then((t) => {
          if (this.settings.texture === settings.texture) this.globe.globeImageUrl(t.url);
        })
        .catch((err) => console.warn('[globe] texture failed to load', err));
    }
    this.globe
      // Terrain relief only reads well on the daytime texture.
      .bumpImageUrl(settings.texture === 'day' ? textureUrl('earth-topology.png') : '')
      .showAtmosphere(settings.showAtmosphere)
      .atmosphereColor(settings.showSun ? '#2f8cff' : 'lightskyblue')
      // Thinner halo with the sun, whose backlit rim supplies the glow on that side.
      .atmosphereAltitude(settings.showSun ? 0.04 : 0.15);
    // With the sun on, stars and sun glow are drawn on a canvas behind a transparent globe.
    if (settings.showSun) this.globe.backgroundImageUrl(null).backgroundColor('rgba(0,0,0,0)');
    else this.globe.backgroundImageUrl(textureUrl('night-sky.png')).backgroundColor('#000011');
    this.sun.setEnabled(settings.showSun);
    const controls = this.globe.controls();
    controls.autoRotate = settings.autoRotate;
    controls.autoRotateSpeed = settings.rotateSpeed;
    if (this.regionStyle) this.applyRegionColors(this.regionStyle);
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
    this.regionStyle = style;
    this.applyRegionColors(style);
    this.globe.polygonAltitude((r) => altitude(r as GlobeRegion)).polygonsData(regions);
  }

  /** Neon: see-through caps, glowing sides and near-white edges; otherwise solid fills. */
  private applyRegionColors(style: PointStyle): void {
    const colorOf = (r: object) => style.color((r as GlobeRegion).point);
    if (this.settings.neonOutlines) {
      this.globe
        .polygonCapColor((r) => scaleAlpha(colorOf(r), NEON_FILL_ALPHA))
        .polygonSideColor((r) => scaleAlpha(colorOf(r), 0.75))
        .polygonStrokeColor((r) => scaleAlpha(mixWithWhite(colorOf(r), 0.85), 0.6));
    } else {
      this.globe
        .polygonCapColor((r) => colorOf(r))
        .polygonSideColor((r) => withAlpha(colorOf(r), 0.6))
        .polygonStrokeColor(() => 'rgba(255,255,255,0.35)');
    }
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
   * The globe's outline on screen. The camera looks at the globe's center, so that's the
   * view center; a unit sphere seen from distance D (radii) has angular radius asin(1/D),
   * which projects to f·tan(asin(1/D)) = f / √(D² − 1) pixels for focal length f.
   */
  private screenCircle(): { cx: number; cy: number; r: number } {
    const w = this.globe.width();
    const h = this.globe.height();
    const camera = this.globe.camera() as { fov?: number };
    const focal = h / 2 / Math.tan(((camera.fov ?? 50) / 2) * (Math.PI / 180));
    const distance = 1 + this.globe.pointOfView().altitude;
    return { cx: w / 2, cy: h / 2, r: focal / Math.sqrt(Math.max(1e-6, distance * distance - 1)) };
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

/**
 * Two transparent canvases around the WebGL globe: behind it, stars and the sun's glow;
 * in front, the backlit rim and flare. Redrawn only when the globe's outline on screen
 * changes (zoom, resize); rotation doesn't move the sun, which is fixed to the view.
 */
class SunLayers {
  private readonly back = document.createElement('canvas');
  private readonly front = document.createElement('canvas');
  private enabled = false;
  private lastKey = '';
  private readonly stars = Array.from({ length: 260 }, () => [Math.random(), Math.random(), Math.random()]);

  constructor(
    container: HTMLElement,
    private readonly circle: () => { cx: number; cy: number; r: number },
  ) {
    const style = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    this.back.style.cssText = `${style}z-index:-1;`;
    this.front.style.cssText = `${style}z-index:1;`;
    container.prepend(this.back);
    container.appendChild(this.front);
    const loop = () => {
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.back.hidden = !enabled;
    this.front.hidden = !enabled;
    this.lastKey = '';
  }

  private draw(): void {
    if (!this.enabled) return;
    const w = this.back.clientWidth;
    const h = this.back.clientHeight;
    const { cx, cy, r } = this.circle();
    const key = `${w}x${h}|${cx.toFixed(1)},${cy.toFixed(1)},${r.toFixed(1)}`;
    if (key === this.lastKey || w === 0) return;
    this.lastKey = key;
    const dpr = window.devicePixelRatio || 1;
    for (const canvas of [this.back, this.front]) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const back = this.back.getContext('2d')!;
    back.setTransform(dpr, 0, 0, dpr, 0, 0);
    back.fillStyle = '#000';
    back.fillRect(0, 0, w, h);
    back.fillStyle = '#fff';
    for (const [x, y, s] of this.stars) {
      back.globalAlpha = 0.25 + s * 0.6;
      back.fillRect(x * w, y * h, s > 0.85 ? 1.6 : 1, s > 0.85 ? 1.6 : 1);
    }
    back.globalAlpha = 1;
    drawSunBehind(back, cx, cy, r);
    const front = this.front.getContext('2d')!;
    front.setTransform(dpr, 0, 0, dpr, 0, 0);
    front.clearRect(0, 0, w, h);
    drawSunFront(front, cx, cy, r);
  }
}
