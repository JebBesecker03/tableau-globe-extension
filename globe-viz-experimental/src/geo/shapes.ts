import type { Feature, Geometry, MultiPolygon } from 'geojson';
import { feature, merge, mesh } from 'topojson-client';
import type { GeometryCollection, GeometryObject, Polygon, MultiPolygon as TopoMultiPolygon, Topology } from 'topojson-specification';
import usTopo from 'us-atlas/states-10m.json';
import worldTopo from 'world-atlas/countries-110m.json';
import type { Place } from '../types';

type Named = { name: string };
type Areas = Polygon | TopoMultiPolygon;
const world = worldTopo as unknown as Topology<{ countries: GeometryCollection<Named>; land: GeometryCollection }>;
const us = usTopo as unknown as Topology<{ states: GeometryCollection<Named> }>;

/** Land and country borders for the Canvas globe's base map. */
export const LAND = feature(world, world.objects.land);
export const BORDERS = mesh(world, world.objects.countries, (a, b) => a !== b);

export type ShapeKind = 'country' | 'state' | 'zip';

/** A topology plus its area geometries indexed by id, so members can be merged. */
interface ShapeSet {
  topology: Topology;
  byId: Map<string, GeometryObject>;
}

/** Must match shapeId() in scripts/build-places.mjs. */
function shapeId(g: GeometryObject<Named>): string {
  return g.id !== undefined ? String(g.id) : `name:${(g.properties as Named | undefined)?.name}`;
}

/** Indexes area geometries by id; empty ones (null geometry in the source) are skipped. */
const shapeSet = (topology: Topology, collection: GeometryCollection<Named>): ShapeSet => ({
  topology,
  byId: new Map(
    collection.geometries
      .filter((g) => g.type === 'Polygon' || g.type === 'MultiPolygon')
      .map((g) => [shapeId(g), g]),
  ),
});

const SETS: Partial<Record<ShapeKind, ShapeSet>> = {
  country: shapeSet(world, world.objects.countries),
  state: shapeSet(us, us.objects.states),
};

/**
 * The outline for a geocoded place, or undefined if it's too small to appear at this map
 * scale (e.g. Singapore at 1:110m). Those places are drawn as bars instead.
 */
export function placeShape(place: Place): Feature<Geometry> | undefined {
  const set = SETS[place.kind]!;
  const g = set.byId.get(place.id);
  return g && (feature(set.topology, g) as Feature<Geometry>);
}

/** One ZIP's outline (ZIP shapes must be loaded). */
export function zipShape(zip: string): Feature<Geometry> | undefined {
  const set = SETS.zip;
  const g = set?.byId.get(zip);
  return g && set && (feature(set.topology, g) as Feature<Geometry>);
}

/**
 * Merges members' outlines into one area, dropping the borders they share, the way Tableau
 * rolls ZIPs up into territories. Holes are filled: inside a territory they're almost always
 * land with no ZIP area (forests, lakes), which would otherwise show as ragged gaps, so the
 * area is just its outer outline. Returns null if none of the ids have an outline.
 */
export function mergeShapes(kind: ShapeKind, ids: Iterable<string>): Feature<MultiPolygon> | null {
  const set = SETS[kind];
  if (!set) return null;
  const members: Areas[] = [];
  for (const id of ids) {
    const g = set.byId.get(id);
    if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon')) members.push(g);
  }
  if (members.length === 0) return null;
  const merged = merge(set.topology, members);
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiPolygon', coordinates: merged.coordinates.map((polygon) => [polygon[0]]) },
  };
}

// ---- ZIP outlines: large (several MB), so fetched only when first needed ----

let zipLoad: Promise<void> | null = null;

export const zipShapesLoaded = (): boolean => SETS.zip !== undefined;

export function loadZipShapes(): Promise<void> {
  zipLoad ??= fetch(`${import.meta.env.BASE_URL}geo/zcta.topo.json`)
    .then((res) => {
      if (!res.ok) throw new Error(`ZIP outlines failed to load (HTTP ${res.status})`);
      return res.json() as Promise<Topology<{ zcta: GeometryCollection<Named> }>>;
    })
    .then((topology) => {
      SETS.zip = shapeSet(topology, topology.objects.zcta);
    })
    .catch((err) => {
      zipLoad = null; // allow a retry
      throw err;
    });
  return zipLoad;
}

/** "2139", 2139, "02139-4307" → "02139"; anything else → null. */
export function normalizeZip(v: unknown): string | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 && v < 100000 ? String(v).padStart(5, '0') : null;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{3,5})(?:-\d{4})?$/);
  return m ? m[1].padStart(5, '0') : null;
}
