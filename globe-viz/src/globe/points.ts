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
};

const CATEGORICAL: Record<CategoricalScheme, readonly string[]> = {
  Tableau10: schemeTableau10,
  Category10: schemeCategory10,
  Set2: schemeSet2,
  Dark2: schemeDark2,
  Paired: schemePaired,
};

const NULL_COLOR = '#9d9d9d';
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
  return (p) => (p.height === null ? MIN_ALTITUDE : scale(Math.abs(p.height)) * barScale);
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
    return (p) => (p.colorValue === null ? NULL_COLOR : scale(String(p.colorValue)));
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

/** Adds an alpha channel to a "#rrggbb" or "rgb(r, g, b)" color. */
export function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : color;
}
