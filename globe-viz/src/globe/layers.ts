import { geoCentroid } from 'd3-geo';
import type { Feature, Geometry } from 'geojson';
import { type ShapeKind, mergeShapes, placeShape, zipShape, zipShapesLoaded } from '../geo/shapes';
import type { GlobeData, GlobePoint, GlobeSettings, Rollup } from '../types';
import { areaRadiusDeg } from './camera';
import type { GlobeRegion } from './renderer';

export interface Layers {
  /** Marks drawn as bars. */
  points: GlobePoint[];
  /** Filled areas. */
  regions: GlobeRegion[];
  /**
   * Data the color/height scales are built from, one per level (index = GlobePoint.level,
   * default 0), so a Region's total isn't compared against a single ZIP's value.
   */
  styleGroups: GlobeData[];
  /** Short message for the corner note, e.g. why nothing is filled. */
  note: string;
  /** ZIP outlines are needed but not loaded yet: load them, then rebuild. */
  needsZipShapes: boolean;
  /** Drill-down only: the level names (e.g. Region, Territory, ZIP) for the breadcrumb. */
  drillLevels?: string[];
}

/** "Fill by" value for filling each ZIP on its own. */
export const FILL_BY_ZIP = 'zip';
/** "Fill by" value for drilling down through the sheet's hierarchy. */
export const FILL_BY_DRILL = 'drill';

const hasCoords = (p: GlobePoint) => Number.isFinite(p.lat) && Number.isFinite(p.lng);

/**
 * Points mode: every mark with coordinates is a bar.
 * Choropleth mode, by settings.fillBy:
 *  - '' (automatic): each mark's country/state (or ZIP, on ZIP-level sheets) is filled.
 *  - 'zip': each mark's ZIP is filled.
 *  - 'drill': the top level (e.g. Region) is filled; the area on `drillPath` is opened to
 *    show its children (Territories, then ZIPs), with everything else kept at its level.
 *  - a dimension (e.g. "Region"): the ZIP outlines (or, without ZIPs, state/country
 *    outlines) of all marks sharing a value are merged into one area, like Tableau's
 *    custom territories; Height and a measure on Color are rolled up per area.
 */
export function buildLayers(data: GlobeData, settings: GlobeSettings, drillPath: string[] = []): Layers {
  // Scales are built per group of areas below; categories must keep one color everywhere.
  if (data.colorKind === 'categorical' && !data.colorDomain) {
    data = { ...data, colorDomain: [...new Set(data.points.map((p) => String(p.colorValue)))].sort() };
  }
  const base: Layers = { points: [], regions: [], styleGroups: [data], note: '', needsZipShapes: false };
  const bars = data.points.filter(hasCoords);
  if (settings.mapType !== 'choropleth') return { ...base, points: bars };

  const fillBy = settings.fillBy;
  if (fillBy === FILL_BY_ZIP && !data.zipField) {
    return { ...base, points: bars, note: 'Fill by ZIP needs a ZIP field on Detail. Showing points instead.' };
  }
  // Any fill on a sheet with ZIPs is built from ZIP outlines (automatic = each ZIP).
  if (data.zipField && !zipShapesLoaded()) return { ...base, note: 'Loading ZIP outlines…', needsZipShapes: true };

  if (fillBy === '' || fillBy === FILL_BY_ZIP) {
    return data.zipField ? fillEachZip(data, base) : fillEachPlace(data, bars, base);
  }
  if (fillBy === FILL_BY_DRILL) {
    const levels = detectHierarchy(data);
    if (levels.length === 0) {
      return {
        ...base,
        points: bars,
        note: 'Drill down needs nested fields on the sheet, e.g. Region and Territory with ZIP or State.',
      };
    }
    return fillDrill(data, levels, drillPath, settings.rollup, base);
  }
  if (!data.groupFields?.includes(fillBy)) {
    return {
      ...base,
      points: bars,
      note: `"${fillBy}" isn't in this sheet. Put it on Detail or Color, or pick another Fill by.`,
    };
  }
  const { areas, regions, unshaped } = mergeGroups(data, data.points, fillBy, settings.rollup);
  const note =
    regions.length === 0
      ? `No areas could be built for "${fillBy}": put ZIP, State or Country on Detail too.`
      : unshaped > 0
        ? `${unshaped} ${fillBy} value${unshaped === 1 ? '' : 's'} had no ZIP/state/country outlines and ${unshaped === 1 ? 'is' : 'are'} not shown.`
        : '';
  return { ...base, regions, styleGroups: [{ ...data, points: areas }], note };
}

/**
 * The sheet's text dimensions that nest, coarsest first (e.g. ["Region", "Territory"]):
 * ordered by number of distinct values, keeping each field only if every one of its values
 * sits inside a single value of the previous field. The leaf below them is each ZIP (or
 * each state/country), so at least one field is needed.
 */
export function detectHierarchy(data: GlobeData): string[] {
  const fields = data.groupFields ?? [];
  const distinct = new Map(fields.map((f) => [f, new Set(data.points.map((p) => p.dims?.[f]))]));
  const leafCount = data.zipField
    ? new Set(data.points.map((p) => p.zip)).size
    : new Set(data.points.map((p) => p.place && `${p.place.kind}:${p.place.id}`)).size;
  const candidates = fields
    .filter((f) => distinct.get(f)!.size >= 2 && distinct.get(f)!.size < leafCount)
    .sort((a, b) => distinct.get(a)!.size - distinct.get(b)!.size);

  const chain: string[] = [];
  for (const f of candidates) {
    const parent = chain[chain.length - 1];
    if (parent) {
      const parentOf = new Map<string | undefined, string | undefined>();
      const nested = data.points.every((p) => {
        const child = p.dims?.[f];
        const seen = parentOf.get(child);
        if (seen === undefined) parentOf.set(child, p.dims?.[parent]);
        return seen === undefined || seen === p.dims?.[parent];
      });
      if (!nested || distinct.get(f)!.size <= distinct.get(parent)!.size) continue;
    }
    chain.push(f);
  }
  return chain;
}

/**
 * Drill-down view for `path` (e.g. [] → all Regions; ["East"] → East's Territories plus the
 * other Regions; ["East", "NE Metro"] → NE Metro's ZIPs plus East's other Territories plus
 * the other Regions). Each mark is shown at the first level where it leaves the path.
 */
function fillDrill(data: GlobeData, levels: string[], path: string[], rollup: Rollup, base: Layers): Layers {
  const leafLevel = levels.length;
  const byLevel: GlobePoint[][] = levels.map(() => []);
  const leafMarks: GlobePoint[] = [];
  for (const p of data.points) {
    let k = 0;
    while (k < levels.length && k < path.length && p.dims?.[levels[k]] === path[k]) k++;
    if (k < levels.length) byLevel[k].push(p);
    else leafMarks.push(p);
  }

  const regions: GlobeRegion[] = [];
  const styleGroups: GlobeData[] = [];
  const points: GlobePoint[] = [];
  byLevel.forEach((marks, level) => {
    const merged = mergeGroups(data, marks, levels[level], rollup, (value) => [...path.slice(0, level), value]);
    for (const r of merged.regions) {
      r.point.level = level;
    }
    regions.push(...merged.regions);
    styleGroups[level] = { ...data, points: merged.areas };
  });

  // The opened leaf area: each ZIP (or state/country) inside it.
  const leafAreas: GlobePoint[] = [];
  const filled = new Set<string>();
  for (const p of leafMarks) {
    const key = data.zipField ? p.zip : p.place && `${p.place.kind}:${p.place.id}`;
    const feature = data.zipField ? (p.zip ? zipShape(p.zip) : undefined) : p.place && placeShape(p.place);
    if (!key || !feature) {
      if (hasCoords(p)) points.push(p);
      continue;
    }
    if (filled.has(key)) continue;
    filled.add(key);
    const area = asArea(p, feature, leafLevel);
    leafAreas.push(area);
    regions.push({ point: area, feature });
  }
  styleGroups[leafLevel] = { ...data, points: leafAreas };

  const leafName = data.zipField ? 'ZIP' : 'State';
  return { ...base, regions, points, styleGroups, drillLevels: [...levels, leafName] };
}

/**
 * Merges the outlines of `marks` sharing a value of `field` into one area per value.
 * `drillPathFor` makes the areas clickable drill targets.
 */
function mergeGroups(
  data: GlobeData,
  marks: GlobePoint[],
  field: string,
  rollup: Rollup,
  drillPathFor?: (value: string) => string[],
): { areas: GlobePoint[]; regions: GlobeRegion[]; unshaped: number } {
  const groups = new Map<string, GlobePoint[]>();
  for (const p of marks) {
    const key = p.dims?.[field];
    if (!key || key === 'Null') continue;
    const members = groups.get(key);
    if (members) members.push(p);
    else groups.set(key, [p]);
  }

  const areas: GlobePoint[] = [];
  const regions: GlobeRegion[] = [];
  let unshaped = 0;
  for (const [key, members] of groups) {
    const { kind, ids } = memberShapes(data, members);
    const feature = kind ? mergeShapes(kind, ids) : null;
    if (!feature) {
      unshaped++;
      continue;
    }
    const [lng, lat] = geoCentroid(feature);
    const area: GlobePoint = {
      lat,
      lng,
      radiusDeg: areaRadiusDeg(feature, [lng, lat]),
      height: combine(members.map((m) => m.height), rollup),
      colorValue:
        data.colorKind === 'continuous'
          ? combine(members.map((m) => m.colorValue as number | null), rollup)
          : mostCommon(members.map((m) => m.colorValue)),
      label: key,
      dims: { [field]: key },
      tupleId: members[0].tupleId,
      tupleIds: members.map((m) => m.tupleId),
      memberCount: members.length,
      drillPath: drillPathFor?.(key),
    };
    areas.push(area);
    regions.push({ point: area, feature });
  }
  return { areas, regions, unshaped };
}

/** A mark shown as its own filled outline, centered on the outline so the camera can frame it. */
function asArea(p: GlobePoint, feature: Feature<Geometry>, level?: number): GlobePoint {
  const [lng, lat] = geoCentroid(feature);
  return { ...p, lat, lng, radiusDeg: areaRadiusDeg(feature, [lng, lat]), level };
}

/** Each mark's country/state; marks without an outline stay bars. First mark wins per area. */
function fillEachPlace(data: GlobeData, bars: GlobePoint[], base: Layers): Layers {
  const points: GlobePoint[] = [];
  const regions: GlobeRegion[] = [];
  const filled = new Set<string>();
  for (const p of bars) {
    const feature = p.place && placeShape(p.place);
    if (!feature) {
      points.push(p);
      continue;
    }
    const key = `${p.place!.kind}:${p.place!.id}`;
    if (filled.has(key)) continue;
    filled.add(key);
    regions.push({ point: asArea(p, feature), feature });
  }
  const note =
    regions.length === 0 && data.points.length > 0
      ? 'Choropleth needs a Country, US State or ZIP field on Detail. Showing points instead.'
      : '';
  return { ...base, points, regions, note };
}

/** Each ZIP filled on its own; ZIPs with no outline (PO boxes) stay bars if they have coordinates. */
function fillEachZip(data: GlobeData, base: Layers): Layers {
  const points: GlobePoint[] = [];
  const regions: GlobeRegion[] = [];
  const filled = new Set<string>();
  for (const p of data.points) {
    const feature = p.zip ? zipShape(p.zip) : undefined;
    if (!feature) {
      if (hasCoords(p)) points.push(p);
      continue;
    }
    if (filled.has(p.zip!)) continue;
    filled.add(p.zip!);
    regions.push({ point: asArea(p, feature), feature });
  }
  return { ...base, points, regions };
}

/** Which outlines make up a group: ZIPs if the sheet has them, else states or countries. */
function memberShapes(data: GlobeData, members: GlobePoint[]): { kind: ShapeKind | null; ids: Set<string> } {
  if (data.zipField) return { kind: 'zip', ids: new Set(members.flatMap((m) => (m.zip ? [m.zip] : []))) };
  const byKind = { state: new Set<string>(), country: new Set<string>() };
  for (const m of members) if (m.place) byKind[m.place.kind].add(m.place.id);
  if (byKind.state.size >= byKind.country.size && byKind.state.size > 0) return { kind: 'state', ids: byKind.state };
  if (byKind.country.size > 0) return { kind: 'country', ids: byKind.country };
  return { kind: null, ids: new Set() };
}

function combine(values: (number | null)[], rollup: Rollup): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    sum += v;
    n++;
  }
  if (n === 0) return null;
  return rollup === 'avg' ? sum / n : sum;
}

function mostCommon<T>(values: T[]): T | null {
  const counts = new Map<T, number>();
  let best: T | null = null;
  let bestCount = 0;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}
