import { scaleLinear, scaleOrdinal, scaleSequential } from 'd3-scale';
import {
  interpolateBlues,
  interpolateGreens,
  interpolatePlasma,
  interpolatePurples,
  interpolateRdYlBu,
  interpolateRdYlGn,
  interpolateTurbo,
  interpolateViridis,
  interpolateYlOrRd,
  schemeCategory10,
  schemeDark2,
  schemePaired,
  schemeSet2,
  schemeTableau10,
} from 'd3-scale-chromatic';
import type { CategoricalScheme, GlobeData, GlobePoint, GlobeSettings, SequentialScheme } from '../types';

/**
 * Ramps for measures, trimmed at the ends: the pale starts of single-hue ramps vanish
 * against the globe, and the darkest ends of Viridis/Plasma/Turbo read as black.
 */
const SEQUENTIAL: Record<SequentialScheme, (t: number) => string> = {
  YlOrRd: (t) => interpolateYlOrRd(0.15 + 0.85 * t),
  Blues: (t) => interpolateBlues(0.3 + 0.7 * t),
  Greens: (t) => interpolateGreens(0.3 + 0.7 * t),
  Purples: (t) => interpolatePurples(0.3 + 0.7 * t),
  Viridis: (t) => interpolateViridis(0.1 + 0.9 * t),
  Plasma: (t) => interpolatePlasma(0.1 + 0.85 * t),
  Turbo: (t) => interpolateTurbo(0.1 + 0.8 * t),
  // Reversed so high values are red.
  RdYlBu: (t) => interpolateRdYlBu(1 - t),
  // Low values red, high values green.
  RdYlGn: (t) => interpolateRdYlGn(t),
  // Saturated electric blue → cyan → green, bright enough to glow on the dark globe.
  Neon: rampFrom(['#2f6bff', '#1fa2ff', '#18dcff', '#2bf7b4', '#5cff63']),
};

const CATEGORICAL: Record<CategoricalScheme, readonly string[]> = {
  Neon: ['#00e5ff', '#39ff14', '#ff2bd6', '#ffe600', '#ff7a00', '#8c5cff', '#00ffa3', '#ff3860', '#4d9dff', '#c6ff00'],
  Tableau10: schemeTableau10,
  Category10: schemeCategory10,
  Set2: schemeSet2,
  Dark2: schemeDark2,
  Paired: schemePaired,
};

const NULL_COLOR = '#9d9d9d';
/** Filtered-out areas kept for their outline: a faint, neutral wash. */
const GHOST_COLOR = 'rgba(150, 175, 210, 0.12)';
const MAX_ALTITUDE = 0.4;
const MIN_ALTITUDE = 0.005;
const UNSELECTED_ALPHA = 0.2;

export interface PointStyle {
  altitude: (p: GlobePoint) => number;
  color: (p: GlobePoint) => string;
  radius: number;
  /** Whether the Height encoding has values; choropleth shapes extrude only then. */
  hasHeight: boolean;
}

/** Builds bar altitude/color accessors for the current data, settings and selection. */
export function buildPointStyle(
  data: GlobeData,
  settings: GlobeSettings,
  selected: ReadonlySet<number>,
): PointStyle {
  const altitude = buildAltitude(data.points, settings.barScale);
  const baseColor = buildColor(data, settings);
  const hasSelection = selected.size > 0;

  return {
    altitude,
    color: (p) => {
      if (p.ghost) return GHOST_COLOR;
      const c = baseColor(p);
      return hasSelection && !isSelected(p, selected) ? withAlpha(c, UNSELECTED_ALPHA) : c;
    },
    radius: settings.barRadius,
    hasHeight: data.points.some((p) => p.height !== null),
  };
}

/** The tuple ids a mark stands for: all members for a rolled-up area. */
export const tupleIdsOf = (p: GlobePoint): number[] => p.tupleIds ?? [p.tupleId];

/** A rolled-up area counts as selected when any of its member marks is. */
export function isSelected(p: GlobePoint, selected: ReadonlySet<number>): boolean {
  return tupleIdsOf(p).some((id) => selected.has(id));
}

function buildAltitude(points: GlobePoint[], barScale: number): (p: GlobePoint) => number {
  const heights = points.map((p) => p.height).filter((h): h is number => h !== null);
  if (heights.length === 0) return () => 0.05 * barScale;

  // Bars grow from zero so heights stay proportional; negatives are drawn by magnitude.
  const max = extent(heights.map(Math.abs))[1] || 1;
  const scale = scaleLinear().domain([0, max]).range([MIN_ALTITUDE, MAX_ALTITUDE]).clamp(true);
  return (p) => (p.height === null || p.ghost ? MIN_ALTITUDE : scale(Math.abs(p.height)) * barScale);
}

function buildColor(data: GlobeData, settings: GlobeSettings): (p: GlobePoint) => string {
  if (data.colorKind === 'continuous') {
    const values = data.points.map((p) => p.colorValue).filter((v): v is number => typeof v === 'number');
    const [lo, hi] = extent(values);
    const ramp = SEQUENTIAL[settings.sequentialScheme] ?? SEQUENTIAL.YlOrRd;
    const scale = scaleSequential(ramp).domain(lo === hi ? [lo - 1, hi + 1] : [lo, hi]);
    return (p) => (typeof p.colorValue === 'number' ? scale(p.colorValue) : NULL_COLOR);
  }
  if (data.colorKind === 'categorical') {
    const scale = scaleOrdinal<string, string>(CATEGORICAL[settings.categoricalScheme] ?? schemeTableau10);
    // Assign colors in sorted order so they stay stable when filters change row order.
    (data.colorDomain ?? [...new Set(data.points.map((p) => String(p.colorValue)))].sort()).forEach((v) => scale(v));
    // Colors picked for specific values (⚙ → Category colors) win over the palette.
    const custom = settings.categoryColors ?? {};
    return (p) => {
      if (p.colorValue === null) return NULL_COLOR;
      const key = String(p.colorValue);
      return custom[key] ?? scale(key);
    };
  }
  return () => settings.singleColor;
}

/** Min/max without spreading, which overflows the call stack on very large arrays. */
function extent(values: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return values.length ? [lo, hi] : [0, 0];
}

/** Linear RGB ramp through evenly spaced "#rrggbb" stops. */
function rampFrom(stops: string[]): (t: number) => string {
  const rgb = stops.map((s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)));
  return (t) => {
    const x = Math.max(0, Math.min(1, t)) * (rgb.length - 1);
    const i = Math.min(rgb.length - 2, Math.floor(x));
    const f = x - i;
    const [r, g, b] = rgb[i].map((c, k) => Math.round(c + (rgb[i + 1][k] - c) * f));
    return `rgb(${r}, ${g}, ${b})`;
  };
}

/** Parses "#rrggbb" or "rgb(a)(r, g, b…)" into [r, g, b, a]; null if unrecognized. */
function parseColor(color: string): [number, number, number, number] | null {
  if (color.startsWith('#') && color.length === 7) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    return [r, g, b, 1];
  }
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
}

/** Multiplies a color's alpha by `k`, so dimmed (unselected) areas also get dimmer glows. */
export function scaleAlpha(color: string, k: number): string {
  const c = parseColor(color);
  return c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3] * k})` : color;
}

/** Mixes a color toward white by `t` (0..1), keeping its alpha. For bright neon edges. */
export function mixWithWhite(color: string, t: number): string {
  const c = parseColor(color);
  if (!c) return color;
  const [r, g, b] = c.slice(0, 3).map((v) => Math.round(v + (255 - v) * t));
  return `rgba(${r}, ${g}, ${b}, ${c[3]})`;
}

/** Adds an alpha channel to a "#rrggbb" or "rgb(r, g, b)" color. */
export function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : color;
}
