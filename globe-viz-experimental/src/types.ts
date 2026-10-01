/** A country or US state that a mark was geocoded to, used to find its outline. */
export interface Place {
  kind: 'country' | 'state';
  /** Shape id: ISO 3166 numeric for countries, FIPS for states. */
  id: string;
}

export interface GlobePoint {
  lat: number;
  lng: number;
  /** Set when the mark's Country/State field was recognized; needed for choropleth. */
  place?: Place;
  /** The recognized country/state as written in the data, for labels. */
  placeName?: string;
  /** 5-digit ZIP when the sheet has a ZIP field; used to build ZIP-based areas. */
  zip?: string;
  /** Text values of the mark's dimensions by field name (e.g. Region, Territory). */
  dims?: Record<string, string>;
  /**
   * For an area rolled up from many marks (e.g. a Region made of ZIPs): every member's
   * tuple id, so selecting the area selects all of them in Tableau.
   */
  tupleIds?: number[];
  /** Number of marks rolled up into this area. */
  memberCount?: number;
  /**
   * Set for filled areas: angular radius (degrees) around lat/lng covering the area, so the
   * camera can center on it and zoom to fit. Absent for bars.
   */
  radiusDeg?: number;
  /** Drill-down level of this area (0 = top, e.g. Region). Areas of a level share a color scale. */
  level?: number;
  /** Drill-down: clicking this area opens this path (e.g. ["East"] or ["East", "NE Metro"]). */
  drillPath?: string[];
  /**
   * An area known from earlier (unfiltered) data but with no rows now: drawn faintly so the
   * footprint stays the same under filters; not clickable and has no values.
   */
  ghost?: boolean;
  /** Raw value of the Height encoding, or null when that encoding is empty. */
  height: number | null;
  /** Raw value of the Color encoding, or null when that encoding is empty. */
  colorValue: string | number | null;
  /** Joined formatted values of the Label encoding fields. */
  label: string;
  /** Tableau tuple id: 1-based row position in the summary data. */
  tupleId: number;
}

export type ColorKind = 'continuous' | 'categorical' | 'none';

export interface GlobeData {
  points: GlobePoint[];
  colorKind: ColorKind;
  /** The field on the Color encoding, for explaining which palette applies. */
  colorField?: { name: string; readable: boolean; dataType?: string };
  /** Summary-data column name of the Color field, so it's never used as a drill level. */
  colorColumn?: string;
  /**
   * All categories on Color, in palette order. Set when scales are built from a subset of
   * marks (e.g. one drill level), so each category keeps the same color everywhere.
   */
  colorDomain?: string[];
  /** The field on the Height encoding, for rolled-up area tooltips. */
  heightField?: string;
  /** Name of the ZIP column, when the sheet has one. */
  zipField?: string;
  /** Dimension fields a choropleth can be filled by (e.g. Region, Territory). */
  groupFields?: string[];
  /** Set when required encodings are missing, so the UI can prompt the author. */
  missing: string[];
  /** Details shown with an empty-globe message to help diagnose why nothing plotted. */
  diagnostics?: string;
}

/** midnight = darkened, blue-tinted satellite imagery with city lights (the default look). */
export type Texture = 'midnight' | 'day' | 'night' | 'dark';

export type MapType = 'points' | 'choropleth';

export type SequentialScheme =
  | 'YlOrRd'
  | 'Blues'
  | 'Greens'
  | 'Purples'
  | 'Viridis'
  | 'Plasma'
  | 'Turbo'
  | 'RdYlBu'
  | 'RdYlGn'
  | 'Neon';
export type CategoricalScheme = 'Neon' | 'Tableau10' | 'Category10' | 'Set2' | 'Dark2' | 'Paired';

export type Rollup = 'sum' | 'avg';

export interface GlobeSettings {
  mapType: MapType;
  /**
   * Choropleth areas: '' = each mark's country/state, 'zip' = each ZIP, 'drill' = drill
   * down through the sheet's hierarchy (e.g. Region → Territory → ZIP), or a dimension
   * name (e.g. "Region") = merge the ZIP (or state) outlines of each value into one area.
   */
  fillBy: string;
  /** How Height and a measure on Color combine when marks are merged into an area. */
  rollup: Rollup;
  /** Color when nothing is on the Color encoding ("#rrggbb"). */
  singleColor: string;
  /** Ramp when a measure is on Color. */
  sequentialScheme: SequentialScheme;
  /** Palette when a dimension is on Color. */
  categoricalScheme: CategoricalScheme;
  /** Area names (and bar names when few) drawn on the globe. */
  showLabels: boolean;
  /** Glowing neon outlines on filled areas. */
  neonOutlines: boolean;
  /** Satellite imagery on the Desktop (Canvas) globe; off = simple vector land (fastest). */
  detailedEarth: boolean;
  /** Sun behind the globe's edge: backlit rim, flare and a darker far side. */
  showSun: boolean;
  /** Color legend for the Color encoding (gradient for measures, swatches for categories). */
  showLegend: boolean;
  /** Legend title; empty = the Color field's name. */
  legendTitle: string;
  /** Colors chosen for specific categories on Color (e.g. HIGH → green); others use the palette. */
  categoryColors: Record<string, string>;
  autoRotate: boolean;
  rotateSpeed: number;
  texture: Texture;
  barScale: number;
  barRadius: number;
  showAtmosphere: boolean;
}
