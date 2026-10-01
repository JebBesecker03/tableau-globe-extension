import {
  type GeoProjection,
  geoArea,
  geoBounds,
  geoCentroid,
  geoContains,
  geoDistance,
  geoGraticule10,
  geoOrthographic,
  geoPath,
} from 'd3-geo';
import type { Feature, Geometry, Position } from 'geojson';
import { BORDERS, LAND } from '../geo/shapes';
import type { GlobePoint, GlobeSettings, Texture } from '../types';
import { FLY_MS, START_VIEW, flyPlan } from './camera';
import { ImageryRenderer } from './imagery';
import { type PointStyle, mixWithWhite, scaleAlpha } from './points';
import { drawSunBehind, drawSunFront, sunShade } from './sun';
import type { GlobeRegion, GlobeRenderer, SceneHandlers } from './renderer';

const GRATICULE = geoGraticule10();
const SPHERE = { type: 'Sphere' } as const;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
/** Globe radius as a fraction of the smaller viewport side, at zoom 1. */
const BASE_RADIUS = 0.4;
const MIN_ZOOM = 0.5;
/** Deep enough to frame a single ZIP-level territory. */
const MAX_ZOOM = 60;
const FLY_ZOOM = 1.5;
/** Opening zoom: the United States fills most of the view with some globe around it. */
const START_ZOOM = 1.4;
/** A framed area spans this fraction of half the smaller screen side. */
const FIT_FRACTION = 0.42;
const MAX_BAR_PX = 14;
/** Above this many filled areas (e.g. every ZIP in the country), skip their outlines. */
const OUTLINE_REGIONS_MAX = 3000;
/** Regions smaller than this on screen are drawn as a dot. */
const TINY_REGION_PX = 1.5;
/** Neon: fills are slightly see-through so the glow and imagery read through them. */
const NEON_FILL_ALPHA = 0.82;
/** Neon halo passes only up to this many visible areas (e.g. states, territories). */
const NEON_GLOW_MAX = 400;

interface FixedLayers {
  key: string;
  back: HTMLCanvasElement;
  shade: HTMLCanvasElement;
  front: HTMLCanvasElement;
}

interface RegionBounds {
  lat: number;
  lng: number;
  /** Centroid as a unit vector. */
  x: number;
  y: number;
  z: number;
  /** Angular radius (radians) from the centroid that covers the region's bounding box. */
  radius: number;
}
const GROW_MS = 600;
const RESUME_ROTATE_MS = 5000;
/** Auto-rotate frame-rate cap. */
const ROTATE_FPS = 30;
/** Auto-rotate waits this long after the extension is resized or shown again. */
const RESIZE_SETTLE_MS = 1500;
/** The view counts as "moving" (cheaper imagery) until this long after the last motion. */
const MOVE_HOLD_MS = 200;
/** Matches three.js OrbitControls: autoRotateSpeed 1 = one revolution per minute. */
const DEG_PER_SEC_PER_SPEED = 6;
const CLICK_SLOP_PX = 4;
const HIT_SLOP_PX = 3;
/** Above this many bars, skip depth sorting and caps, and batch strokes by color. */
const FAST_PATH_THRESHOLD = 5000;

interface Palette {
  ocean: string;
  oceanEdge: string;
  land: string;
  /** Land with no data in choropleth mode: neutral so the filled areas stand out. */
  landMuted: string;
  border: string;
  graticule: string;
  glow: string; // "r,g,b"
}

const PALETTES: Record<Texture, Palette> = {
  midnight: {
    ocean: '#0b2348',
    oceanEdge: '#020812',
    land: '#1b3354',
    landMuted: '#1b3354',
    border: 'rgba(140,190,255,0.28)',
    graticule: 'rgba(140,190,255,0.08)',
    glow: '40,130,255',
  },
  day: {
    ocean: '#2b6ca6',
    oceanEdge: '#0c2b4b',
    land: '#7d9a57',
    landMuted: '#8a8f94',
    border: 'rgba(255,255,255,0.35)',
    graticule: 'rgba(255,255,255,0.08)',
    glow: '110,170,255',
  },
  night: {
    ocean: '#0d1f36',
    oceanEdge: '#03070d',
    land: '#1f324b',
    landMuted: '#2a3340',
    border: 'rgba(140,180,255,0.35)',
    graticule: 'rgba(140,180,255,0.07)',
    glow: '90,130,220',
  },
  dark: {
    ocean: '#171b21',
    oceanEdge: '#050607',
    land: '#2e343c',
    landMuted: '#2e343c',
    border: 'rgba(255,255,255,0.18)',
    graticule: 'rgba(255,255,255,0.05)',
    glow: '150,160,180',
  },
};

/**
 * Per-point values that only change with the data or style, so each frame is just a
 * rotation (multiply-adds) and a stroke.
 */
interface BarCache {
  /** Unit vector of each point on the globe. */
  ux: Float64Array;
  uy: Float64Array;
  uz: Float64Array;
  altitude: Float64Array;
  color: string[];
  /** Point indices grouped by color, for batched strokes on large datasets. */
  groups: { color: string; indices: number[] }[];
}

/** Screen geometry of the bars from the last frame, kept for hit testing. */
interface FrameBars {
  x0: Float32Array;
  y0: Float32Array;
  x1: Float32Array;
  y1: Float32Array;
  z: Float32Array;
  /** Visible bar indices in draw order (far to near when depth-sorted). */
  order: number[];
  halfWidth: number;
}

interface Flight {
  from: [number, number, number]; // lambda, phi, zoom
  to: [number, number, number];
  start: number;
}

/**
 * Canvas 2D globe for hosts without WebGL (Tableau Desktop's embedded browser).
 * Orthographic projection of country shapes, with bars projected radially in 3D.
 */
export class CanvasGlobe implements GlobeRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  /** d3 rotation: the view is centered on (lng = -lambda, lat = -phi). */
  private lambda = -START_VIEW.lng;
  private phi = -START_VIEW.lat;
  private zoom = START_ZOOM;
  private settings: GlobeSettings;
  private points: GlobePoint[] = [];
  /** Choropleth fills, countries before states so states draw (and hit-test) on top. */
  private regions: { region: GlobeRegion; color: string }[] = [];
  /** The renderer's input and its draw order; stable across selection re-renders. */
  private sourceRegions: GlobeRegion[] = [];
  private regionOrder: GlobeRegion[] = [];
  private shapeCache: { order: GlobeRegion[]; bucket: number; shapes: Feature<Geometry>[] } | null = null;
  private boundsCache: { order: GlobeRegion[]; bounds: RegionBounds[] } | null = null;
  private fixed: FixedLayers | null = null;
  /** Neon halos are reduced while moving; redraw once settled to restore them. */
  private neonReduced = false;
  /** Projection from the last frame, for turning the pointer into lat/lng. */
  private projection: GeoProjection | null = null;
  private cache: BarCache | null = null;
  private barWidthDeg = 0;
  private growStart = 0;
  private frameBars: FrameBars | null = null;
  private hovered: GlobePoint | null = null;
  private pausedUntil = 0;
  private flight: Flight | null = null;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private lastTime = performance.now();
  private lastDraw = 0;
  private dirty = true;
  /** Auto-rotate moved the view; redrawn at most ROTATE_FPS times a second. */
  private rotated = false;
  private readonly stars = Array.from({ length: 220 }, () => [Math.random(), Math.random(), Math.random()]);
  private readonly imagery = new ImageryRenderer();
  /** Last time the view moved; imagery drawn cheaply while moving is refined after. */
  private lastMove = 0;

  constructor(
    container: HTMLElement,
    settings: GlobeSettings,
    private readonly handlers: SceneHandlers,
  ) {
    this.settings = settings;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    new ResizeObserver(([entry]) => {
      this.width = entry.contentRect.width;
      this.height = entry.contentRect.height;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(this.width * dpr);
      this.canvas.height = Math.round(this.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.dirty = true;
      this.settle();
    }).observe(container);
    // Coming back into view (e.g. a dashboard tab or presentation-mode switch) is a resize too.
    document.addEventListener('visibilitychange', () => this.settle());

    this.bindPointer();
    this.applySettings(settings);
    requestAnimationFrame((t) => this.frame(t));
  }

  applySettings(settings: GlobeSettings): void {
    this.settings = settings;
    if (settings.detailedEarth) this.imagery.use(settings.texture, () => (this.dirty = true));
    this.dirty = true;
  }

  setPoints(points: GlobePoint[], style: PointStyle): void {
    if (points !== this.points) this.growStart = performance.now();
    this.points = points;
    this.cache = buildCache(points, style);
    this.barWidthDeg = style.radius * 2;
    this.dirty = true;
  }

  /**
   * Region outlines thinned to about a pixel at the current zoom. Merged ZIP areas can
   * have tens of thousands of points, most closer together than a pixel at globe scale;
   * drawing them all makes rotation choppy. Rebuilt only when the zoom level changes a lot.
   */
  private regionShapes(radiusPx: number): Feature<Geometry>[] {
    // A hidden canvas has no size yet; thinning would then drop everything.
    if (!(radiusPx > 0)) return this.regionOrder.map((region) => region.feature);
    const tolerance = (0.75 / radiusPx) * DEG; // ~0.75px in degrees of arc
    const bucket = Math.round(Math.log2(tolerance) * 2); // new copy every ~1.4x zoom
    if (this.shapeCache?.order !== this.regionOrder || this.shapeCache.bucket !== bucket) {
      const tol = 2 ** (bucket / 2);
      this.shapeCache = {
        order: this.regionOrder,
        bucket,
        shapes: this.regionOrder.map((region) => thinFeature(region.feature, tol)),
      };
    }
    return this.shapeCache.shapes;
  }

  /**
   * Each region's centroid (as lat/lng and a unit vector) and angular radius, for skipping
   * regions that can't be seen and drawing tiny ones as dots. Independent of zoom.
   */
  private regionBounds(): RegionBounds[] {
    if (this.boundsCache?.order !== this.regionOrder) {
      this.boundsCache = {
        order: this.regionOrder,
        bounds: this.regionOrder.map((region) => {
          const [lng, lat] = geoCentroid(region.feature);
          const [[x0, y0], [x1, y1]] = geoBounds(region.feature);
          const corners: [number, number][] = [[x0, y0], [x0, y1], [x1, y0], [x1, y1]];
          const radius = Math.max(...corners.map((c) => geoDistance([lng, lat], c)));
          const la = lat * RAD;
          const ln = lng * RAD;
          return { lat, lng, radius, x: Math.cos(la) * Math.cos(ln), y: Math.cos(la) * Math.sin(ln), z: Math.sin(la) };
        }),
      };
    }
    return this.boundsCache.bounds;
  }

  setRegions(regions: GlobeRegion[], style: PointStyle): void {
    if (regions !== this.sourceRegions) {
      this.sourceRegions = regions;
      // Largest first, so anything inside another area (a state in its country, a
      // territory's ZIPs over the region) is drawn, and hit-tested, on top.
      const area = new Map(regions.map((r) => [r, geoArea(r.feature)]));
      this.regionOrder = [...regions].sort((a, b) => area.get(b)! - area.get(a)!);
    }
    // Only colors change on selection; the order (and the caches keyed on it) stay.
    this.regions = this.regionOrder.map((region) => ({ region, color: style.color(region.point) }));
    this.dirty = true;
  }

  flyTo(points: GlobePoint[]): void {
    if (points.length === 0) return;
    const { lat, lng, fitRadiusDeg } = flyPlan(points);
    // Areas are framed to fit: the globe is drawn at BASE_RADIUS * zoom of the smaller
    // screen side, and an area of angular radius a spans about r·sin(a) from the center.
    const zoom =
      fitRadiusDeg === undefined
        ? Math.max(this.zoom, FLY_ZOOM)
        : Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, FIT_FRACTION / (BASE_RADIUS * Math.sin(fitRadiusDeg * RAD))));
    // Take the short way around the antimeridian.
    const dLambda = ((((-lng - this.lambda) % 360) + 540) % 360) - 180;
    this.flight = {
      from: [this.lambda, this.phi, this.zoom],
      to: [this.lambda + dLambda, -lat, zoom],
      start: performance.now(),
    };
    this.pauseRotation();
  }

  project(lat: number, lng: number): { x: number; y: number } | null {
    if (!this.projection) return null;
    // Orthographic: only the hemisphere around the view center faces the viewer.
    if (geoDistance([lng, lat], [-this.lambda, -this.phi]) > Math.PI / 2) return null;
    const p = this.projection([lng, lat]);
    return p ? { x: p[0], y: p[1] } : null;
  }

  viewKey(): string {
    return `${this.lambda.toFixed(3)},${this.phi.toFixed(3)},${this.zoom.toFixed(4)},${this.width},${this.height}`;
  }

  private pauseRotation(): void {
    this.pausedUntil = performance.now() + RESUME_ROTATE_MS;
  }

  /**
   * Holds auto-rotate while Tableau resizes or re-shows the extension (entering/leaving
   * full screen, resizing the dashboard), so the page stays idle while Tableau re-lays out.
   */
  private settle(): void {
    this.pausedUntil = Math.max(this.pausedUntil, performance.now() + RESIZE_SETTLE_MS);
  }

  // ---- animation ----

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    if (this.flight) {
      const t = Math.min(1, (now - this.flight.start) / FLY_MS);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; // easeInOutCubic
      const { from, to } = this.flight;
      this.lambda = from[0] + (to[0] - from[0]) * e;
      this.phi = from[1] + (to[1] - from[1]) * e;
      this.zoom = from[2] + (to[2] - from[2]) * e;
      if (t >= 1) this.flight = null;
      this.dirty = true;
    } else if (this.settings.autoRotate && !this.drag && now > this.pausedUntil) {
      this.lambda += DEG_PER_SEC_PER_SPEED * this.settings.rotateSpeed * dt;
      this.rotated = true;
    }
    if (now - this.growStart < GROW_MS) this.dirty = true;

    // Auto-rotate alone redraws at a capped rate: Tableau Desktop's browser renders in
    // software, and drawing every frame there starves Tableau itself (it froze when
    // leaving full screen). Interaction, fly-to and data changes still draw every frame.
    // 2ms slack: at 60Hz two frames are ~33.3ms apart, which would otherwise just miss 30fps.
    const rotateDue = this.rotated && now - this.lastDraw >= 1000 / ROTATE_FPS - 2;
    if (this.flight || this.rotated || this.drag?.moved) this.lastMove = now;
    const moving = now - this.lastMove < MOVE_HOLD_MS;
    // Imagery and neon halos drawn cheaply while moving are redrawn in full once settled.
    if (!moving && ((this.imagery.lowRes && this.settings.detailedEarth) || this.neonReduced)) this.dirty = true;
    if ((this.dirty || rotateDue) && this.width > 0) {
      this.dirty = false;
      this.rotated = false;
      this.lastDraw = now;
      this.draw(now, moving);
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---- drawing ----

  private draw(now: number, moving = false): void {
    const { ctx, width: w, height: h } = this;
    const palette = PALETTES[this.settings.texture];
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * BASE_RADIUS * this.zoom;
    const sun = this.settings.showSun;

    ctx.clearRect(0, 0, w, h);
    // Stars, sun glow, atmosphere, shadow and rim don't turn with the globe: they're drawn
    // once per zoom/size into cached layers and copied in each frame.
    const fixed = this.fixedLayers(cx, cy, r, palette);
    ctx.drawImage(fixed.back, 0, 0, w, h);

    const projection = geoOrthographic()
      .rotate([this.lambda, this.phi])
      .scale(r)
      .translate([cx, cy])
      .clipAngle(90)
      .precision(0.5);
    const path = geoPath(projection, ctx);

    // Earth: satellite imagery, or flat vector land while it loads or when turned off.
    const imagery =
      this.settings.detailedEarth && this.imagery.draw(ctx, cx, cy, r, this.lambda, this.phi, w, h, moving);
    if (!imagery) {
      const ocean = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
      ocean.addColorStop(0, palette.ocean);
      ocean.addColorStop(1, palette.oceanEdge);
      ctx.fillStyle = ocean;
      ctx.beginPath();
      path(SPHERE);
      ctx.fill();
    }

    ctx.strokeStyle = imagery ? 'rgba(150,200,255,0.07)' : palette.graticule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    path(GRATICULE);
    ctx.stroke();

    if (!imagery) {
      ctx.fillStyle = this.regions.length > 0 ? palette.landMuted : palette.land;
      ctx.beginPath();
      path(LAND);
      ctx.fill();
    }

    ctx.strokeStyle = imagery ? 'rgba(150,200,255,0.25)' : palette.border;
    ctx.lineWidth = imagery ? 0.5 : 0.6;
    ctx.beginPath();
    path(BORDERS);
    ctx.stroke();

    if (this.regions.length > 0) this.drawRegions(projection, r, moving);
    this.projection = projection;

    ctx.drawImage(fixed.shade, 0, 0, w, h);
    this.drawBars(now, cx, cy, r);
    if (sun) ctx.drawImage(fixed.front, 0, 0, w, h);
  }

  /**
   * The screen-fixed parts of the scene, cached until the globe's size or position on
   * screen (zoom, resize) or the look settings change:
   * - back: stars, the sun's glow behind the globe, the atmosphere halo;
   * - shade: lighting over the globe (far side in shadow with the sun on);
   * - front: the sun's backlit rim and flare.
   */
  private fixedLayers(cx: number, cy: number, r: number, palette: Palette): FixedLayers {
    const { width: w, height: h } = this;
    const dpr = window.devicePixelRatio || 1;
    const { showSun: sun, showAtmosphere } = this.settings;
    const key = `${w}x${h}@${dpr}|${cx},${cy},${r}|${sun}|${showAtmosphere}|${palette.glow}`;
    if (this.fixed?.key === key) return this.fixed;

    const make = (draw: (ctx: CanvasRenderingContext2D) => void) => {
      const canvas = document.createElement('canvas');
      // At least 1px: drawImage throws on a 0-sized canvas (e.g. before the first resize).
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(ctx);
      return canvas;
    };
    const back = make((ctx) => {
      ctx.fillStyle = '#fff';
      for (const [x, y, s] of this.stars) {
        ctx.globalAlpha = 0.25 + s * 0.6;
        ctx.fillRect(x * w, y * h, s > 0.85 ? 1.6 : 1, s > 0.85 ? 1.6 : 1);
      }
      ctx.globalAlpha = 1;
      if (sun) drawSunBehind(ctx, cx, cy, r);
      if (showAtmosphere) {
        // A thin, faint halo hugging the edge (thinner still with the sun, whose backlit
        // rim supplies the glow on that side).
        const reach = sun ? 1.025 : 1.1;
        const glow = ctx.createRadialGradient(cx, cy, r * 0.99, cx, cy, r * reach);
        glow.addColorStop(0, `rgba(${palette.glow},${sun ? 0.16 : 0.32})`);
        glow.addColorStop(1, `rgba(${palette.glow},0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(cx, cy, r * reach, 0, 2 * Math.PI);
        ctx.fill();
      }
    });
    const shade = make((ctx) => {
      // With the sun, the far side falls into shadow; otherwise a soft highlight
      // upper-left and darker toward the limb.
      if (sun) {
        ctx.fillStyle = sunShade(ctx, cx, cy, r);
      } else {
        const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, 0, cx, cy, r * 1.05);
        g.addColorStop(0, 'rgba(255,255,255,0.12)');
        g.addColorStop(0.55, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.5)');
        ctx.fillStyle = g;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI); // the orthographic globe's outline is a circle
      ctx.fill();
    });
    const front = make((ctx) => {
      if (sun) drawSunFront(ctx, cx, cy, r);
    });
    this.fixed = { key, back, shade, front };
    return this.fixed;
  }

  /**
   * Filled areas. With neon on: slightly translucent fills with a subtle white neon edge
   * (a soft glow plus a fine near-white line, added light so it reads on the dark globe).
   */
  private drawRegions(projection: GeoProjection, r: number, moving: boolean): void {
    const { ctx } = this;
    const neon = this.settings.neonOutlines;
    const shapes = this.regionShapes(r);
    // With many small areas (e.g. every ZIP), outlines cost as much as the fills and
    // mostly hide the colors, so skip them.
    const outline = this.regions.length <= OUTLINE_REGIONS_MAX;
    const bounds = this.regionBounds();
    // View center as a unit vector, and how far from it (radians) the screen reaches.
    const cLat = -this.phi * RAD;
    const cLng = -this.lambda * RAD;
    const [vx, vy, vz] = [Math.cos(cLat) * Math.cos(cLng), Math.cos(cLat) * Math.sin(cLng), Math.sin(cLat)];
    const halfDiag = Math.hypot(this.width, this.height) / 2;
    const visible = halfDiag >= r ? Math.PI / 2 : Math.asin(halfDiag / r);
    const toPath = geoPath(projection);
    const drawn: { shape: Path2D; color: string }[] = [];

    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 0.7;
    // Drawn in order so states land on top of their country.
    this.regions.forEach(({ color }, i) => {
      const b = bounds[i];
      const angle = Math.acos(Math.max(-1, Math.min(1, b.x * vx + b.y * vy + b.z * vz)));
      if (angle > visible + b.radius) return; // far side, or off-screen when zoomed in
      ctx.fillStyle = color;
      if (b.radius * r < TINY_REGION_PX) {
        // Smaller than a couple of pixels: a dot looks the same and is far cheaper.
        if (angle > Math.PI / 2) return;
        const [x, y] = projection([b.lng, b.lat])!;
        ctx.fillRect(x - 1, y - 1, 2, 2);
        return;
      }
      const shape = new Path2D();
      toPath.context(shape as unknown as CanvasRenderingContext2D)(shapes[i]);
      ctx.globalAlpha = neon ? NEON_FILL_ALPHA : 1;
      ctx.fill(shape);
      ctx.globalAlpha = 1;
      if (neon) drawn.push({ shape, color });
      else if (outline) ctx.stroke(shape);
    });
    this.neonReduced = neon && moving && drawn.length > 0 && drawn.length <= NEON_GLOW_MAX;
    if (!neon || drawn.length === 0) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    // A subtle white neon: one soft glow (skipped while moving and at ZIP scale) and a
    // fine near-white edge, each keeping a hint of the area's own color.
    const glow = !moving && drawn.length <= NEON_GLOW_MAX;
    if (glow) {
      ctx.lineWidth = 4;
      for (const { shape, color } of drawn) {
        ctx.strokeStyle = scaleAlpha(mixWithWhite(color, 0.8), 0.13);
        ctx.stroke(shape);
      }
    }
    if (outline) {
      ctx.lineWidth = drawn.length <= NEON_GLOW_MAX ? 0.9 : 0.6;
      for (const { shape, color } of drawn) {
        ctx.strokeStyle = scaleAlpha(mixWithWhite(color, 0.85), 0.6);
        ctx.stroke(shape);
      }
    }
    ctx.restore();
  }

  private drawBars(now: number, cx: number, cy: number, r: number): void {
    const { ctx, cache } = this;
    const n = this.points.length;
    if (!cache || n === 0) {
      this.frameBars = null;
      return;
    }

    const t = Math.min(1, (now - this.growStart) / GROW_MS);
    const grow = 1 - (1 - t) ** 3; // easeOutCubic
    // Size bars in screen space, like map pins: at true scale, zooming in turns dense data
    // (ZIPs, cities) into huge overlapping slabs and long streaks from the view center.
    // Length stays constant when zoomed in; width grows only slightly.
    const baseR = r / this.zoom;
    const lengthScale = grow / Math.max(1, this.zoom);
    const width = Math.min(MAX_BAR_PX, Math.max(1.5, baseR * this.barWidthDeg * RAD * this.zoom ** 0.25));
    const fast = n > FAST_PATH_THRESHOLD;

    // Same rotation as d3.geoRotation([lambda, phi]), expanded so each point costs a few
    // multiply-adds. Screen x = rotated y, screen up = rotated z, depth = rotated x.
    const cl = Math.cos(this.lambda * RAD);
    const sl = Math.sin(this.lambda * RAD);
    const cp = Math.cos(this.phi * RAD);
    const sp = Math.sin(this.phi * RAD);

    const fb = this.frameBuffers(n);
    fb.halfWidth = width / 2;
    fb.order = [];
    const { ux, uy, uz, altitude } = cache;
    for (let i = 0; i < n; i++) {
      const a = ux[i] * cl - uy[i] * sl;
      const x = uy[i] * cl + ux[i] * sl;
      const y = uz[i] * cp + a * sp;
      const z = a * cp - uz[i] * sp; // > 0 faces the viewer
      const top = 1 + altitude[i] * lengthScale;

      let x0 = cx + r * x;
      let y0 = cy - r * y;
      const x1 = cx + r * top * x;
      const y1 = cy - r * top * y;
      if (z < 0) {
        // Base is behind the globe: only the part beyond the limb is visible.
        const s = limbExit(x0 - cx, y0 - cy, x1 - cx, y1 - cy, r);
        if (s === null) continue;
        x0 += (x1 - x0) * s;
        y0 += (y1 - y0) * s;
      }
      fb.x0[i] = x0;
      fb.y0[i] = y0;
      fb.x1[i] = x1;
      fb.y1[i] = y1;
      fb.z[i] = z;
      fb.order.push(i);
    }

    ctx.lineCap = 'butt';
    ctx.lineWidth = width;
    if (fast) {
      // One stroke per color; overlap order within a color doesn't matter.
      const visible = new Uint8Array(n);
      for (const i of fb.order) visible[i] = 1;
      for (const { color, indices } of cache.groups) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        for (const i of indices) {
          if (!visible[i]) continue;
          ctx.moveTo(fb.x0[i], fb.y0[i]);
          ctx.lineTo(fb.x1[i], fb.y1[i]);
        }
        ctx.stroke();
      }
      return;
    }

    fb.order.sort((a, b) => fb.z[a] - fb.z[b]); // far to near
    for (const i of fb.order) {
      const color = cache.color[i];
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(fb.x0[i], fb.y0[i]);
      ctx.lineTo(fb.x1[i], fb.y1[i]);
      ctx.stroke();
      if (fb.z[i] > 0) {
        // Lit cap so bars seen end-on still read as bars.
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(fb.x1[i], fb.y1[i], width / 2, 0, 2 * Math.PI);
        ctx.fill();
        if (!color.startsWith('rgba')) {
          // Highlight only opaque bars; on dimmed (unselected) bars it reads as a grey blob.
          ctx.fillStyle = 'rgba(255,255,255,0.3)';
          ctx.fill();
        }
      }
    }
  }

  /** Reuses the frame's typed arrays while the point count is unchanged. */
  private frameBuffers(n: number): FrameBars {
    if (!this.frameBars || this.frameBars.x0.length !== n) {
      this.frameBars = {
        x0: new Float32Array(n),
        y0: new Float32Array(n),
        x1: new Float32Array(n),
        y1: new Float32Array(n),
        z: new Float32Array(n),
        order: [],
        halfWidth: 0,
      };
    }
    return this.frameBars;
  }

  // ---- interaction ----

  private bindPointer(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, moved: false };
      this.flight = null;
      this.pauseRotation();
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > CLICK_SLOP_PX) this.drag.moved = true;
        if (this.drag.moved) {
          // Degrees per pixel so the surface roughly follows the pointer.
          const k = 1 / (RAD * Math.min(this.width, this.height) * BASE_RADIUS * this.zoom);
          this.lambda += dx * k;
          this.phi = Math.max(-89, Math.min(89, this.phi - dy * k));
          this.drag.x = e.clientX;
          this.drag.y = e.clientY;
          this.dirty = true;
        }
        return;
      }
      this.setHovered(this.hitTest(e));
    });
    c.addEventListener('pointerup', (e) => {
      const wasClick = this.drag && !this.drag.moved;
      this.drag = null;
      if (!wasClick) return;
      const hit = this.hitTest(e);
      if (hit) this.handlers.onPointClick(hit, e);
      else if (this.onGlobe(e)) this.handlers.onEmptyClick();
    });
    c.addEventListener('pointerleave', () => this.setHovered(null));
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * Math.exp(-e.deltaY * 0.001)));
        this.flight = null;
        this.pauseRotation();
        this.lastMove = performance.now();
        this.dirty = true;
      },
      { passive: false },
    );
  }

  private setHovered(point: GlobePoint | null): void {
    if (point === this.hovered) return;
    this.hovered = point;
    this.canvas.style.cursor = point ? 'pointer' : '';
    if (point) this.pauseRotation();
    this.handlers.onPointHover(point);
  }

  /** The bar under the pointer closest to the viewer, else the filled region under it. */
  private hitTest(e: MouseEvent): GlobePoint | null {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    return this.hitBar(px, py) ?? this.hitRegion(px, py);
  }

  private hitBar(px: number, py: number): GlobePoint | null {
    const fb = this.frameBars;
    if (!fb) return null;
    const reach = fb.halfWidth + HIT_SLOP_PX;
    let best = -1;
    for (const i of fb.order) {
      if (best >= 0 && fb.z[i] <= fb.z[best]) continue;
      if (distToSegment(px, py, fb.x0[i], fb.y0[i], fb.x1[i], fb.y1[i]) <= reach) best = i;
    }
    return best >= 0 ? this.points[best] : null;
  }

  private hitRegion(px: number, py: number): GlobePoint | null {
    if (this.regions.length === 0 || !this.projection || !this.onGlobeAt(px, py)) return null;
    const lngLat = this.projection.invert?.([px, py]);
    if (!lngLat) return null;
    // States are last, so searching backwards finds a state before the country under it.
    for (let i = this.regions.length - 1; i >= 0; i--) {
      if (geoContains(this.regions[i].region.feature, lngLat)) return this.regions[i].region.point;
    }
    return null;
  }

  private onGlobe(e: MouseEvent): boolean {
    const rect = this.canvas.getBoundingClientRect();
    return this.onGlobeAt(e.clientX - rect.left, e.clientY - rect.top);
  }

  private onGlobeAt(px: number, py: number): boolean {
    const r = Math.min(this.width, this.height) * BASE_RADIUS * this.zoom;
    return Math.hypot(px - this.width / 2, py - this.height / 2) <= r;
  }
}

type Ring = Position[];

/**
 * Drops outline points closer than `tol` degrees to the previous kept point (longitude
 * scaled by latitude), and rings too small to see. Keeps each ring closed.
 */
function thinFeature(f: Feature<Geometry>, tol: number): Feature<Geometry> {
  const g = f.geometry;
  const thinRing = (ring: Ring): Ring | null => {
    if (ring.length < 4) return null;
    const out: Ring = [ring[0]];
    let [px, py] = ring[0];
    let minX = px;
    let maxX = px;
    let minY = py;
    let maxY = py;
    for (let i = 1; i < ring.length - 1; i++) {
      const [x, y] = ring[i];
      const k = Math.cos(y * RAD);
      if (Math.abs(x - px) * k < tol && Math.abs(y - py) < tol) continue;
      out.push(ring[i]);
      px = x;
      py = y;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    // Sub-pixel slivers and holes (e.g. a missing ZIP inside a territory) aren't visible.
    if ((maxX - minX) * Math.cos(minY * RAD) < tol && maxY - minY < tol) return null;
    out.push(ring[ring.length - 1]);
    return out.length >= 4 ? out : null;
  };
  const thinPolygon = (rings: Ring[]): Ring[] | null => {
    const outer = thinRing(rings[0]);
    if (!outer) return null;
    const holes = rings.slice(1).map(thinRing).filter((h): h is Ring => h !== null);
    const thinned = [outer, ...holes];
    // On a sphere a polygon is "inside" by winding; if dropping points makes a ring cross
    // itself, d3 can read it as everything *except* the shape and flood the globe. Such a
    // polygon suddenly covers more than a hemisphere, so keep the original instead.
    return geoArea({ type: 'Polygon', coordinates: thinned }) > 2 * Math.PI ? rings : thinned;
  };
  if (g.type === 'Polygon') {
    return { ...f, geometry: { type: 'Polygon', coordinates: thinPolygon(g.coordinates) ?? [] } };
  }
  if (g.type === 'MultiPolygon') {
    return {
      ...f,
      geometry: {
        type: 'MultiPolygon',
        coordinates: g.coordinates.map(thinPolygon).filter((p): p is Ring[] => p !== null),
      },
    };
  }
  return f;
}

function buildCache(points: GlobePoint[], style: PointStyle): BarCache {
  const n = points.length;
  const cache: BarCache = {
    ux: new Float64Array(n),
    uy: new Float64Array(n),
    uz: new Float64Array(n),
    altitude: new Float64Array(n),
    color: new Array<string>(n),
    groups: [],
  };
  const groupByColor = new Map<string, number[]>();
  points.forEach((p, i) => {
    const lat = p.lat * RAD;
    const lng = p.lng * RAD;
    cache.ux[i] = Math.cos(lat) * Math.cos(lng);
    cache.uy[i] = Math.cos(lat) * Math.sin(lng);
    cache.uz[i] = Math.sin(lat);
    cache.altitude[i] = style.altitude(p);
    const color = style.color(p);
    cache.color[i] = color;
    const group = groupByColor.get(color);
    if (group) group.push(i);
    else groupByColor.set(color, [i]);
  });
  // Dimmed (unselected) colors first so selected bars draw on top.
  cache.groups = [...groupByColor]
    .map(([color, indices]) => ({ color, indices }))
    .sort((a, b) => Number(b.color.startsWith('rgba')) - Number(a.color.startsWith('rgba')));
  return cache;
}

/**
 * For a segment from p0 (inside the disk of radius r) to p1, returns the parameter
 * where it leaves the disk, or null if it never does.
 */
function limbExit(x0: number, y0: number, x1: number, y1: number, r: number): number | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const a = dx * dx + dy * dy;
  if (a === 0) return null;
  const b = 2 * (x0 * dx + y0 * dy);
  const c = x0 * x0 + y0 * y0 - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const s = (-b + Math.sqrt(disc)) / (2 * a);
  return s >= 0 && s < 1 ? s : null;
}

function distToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}
