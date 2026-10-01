import type { Column, DataValue, FieldInstance, Worksheet } from '@tableau/extensions-api-types';
import { buildGeocoder } from '../geo/geocode';
import { normalizeZip } from '../geo/shapes';
import type { ColorKind, GlobeData, GlobePoint } from '../types';

/** Encoding ids declared in GlobeViz.trex. */
const ENC = {
  latitude: 'latitude',
  longitude: 'longitude',
  height: 'height',
  color: 'color',
} as const;

/**
 * Reads the worksheet's encodings + summary data and converts rows to globe points.
 * Coordinates come from the Latitude/Longitude encodings when Tableau provides them;
 * otherwise marks are geocoded from Country / US-state fields on Detail.
 */
export async function readGlobeData(worksheet: Worksheet): Promise<GlobeData> {
  const { fieldsByEncoding, seen } = await getEncodingFields(worksheet);

  // ignoreSelection: we always want every mark, and draw selection state ourselves.
  const reader = await worksheet.getSummaryDataReaderAsync(undefined, { ignoreSelection: true });
  try {
    // getAllPagesAsync throws (verifyRange) when the sheet has no rows, e.g. everything filtered out.
    if (reader.totalRowCount === 0 || reader.pageCount === 0) {
      return { points: [], colorKind: 'none', missing: [], diagnostics: 'No marks: the worksheet has no data rows.' };
    }
    const table = await reader.getAllPagesAsync();
    const col = (id: string) => findColumn(table.columns, fieldsByEncoding.get(id)?.[0]);
    const latCol = col(ENC.latitude);
    const lngCol = col(ENC.longitude);
    const heightCol = col(ENC.height);
    const colorCol = col(ENC.color);
    // Level of detail comes from Tableau's built-in Detail encoding; use those
    // (non-encoded, discrete) columns to name each mark.
    const encodedIndexes = new Set([latCol, lngCol, heightCol, colorCol].map((c) => c?.index));
    const labelCols = table.columns.filter(
      (c) => !encodedIndexes.has(c.index) && String(c.dataType) === 'string',
    );
    const zipCol = findZipColumn(
      table.columns.filter((c) => !encodedIndexes.has(c.index)),
      table.data,
    );
    // Text dimensions (including one on Color) that a choropleth can merge areas by.
    const dimCols = table.columns.filter(
      (c) => c !== zipCol && c !== latCol && c !== lngCol && c !== heightCol && String(c.dataType) === 'string',
    );

    const geocoder = buildGeocoder(table.columns, table.data);
    // With a ZIP field, marks can still be merged into areas even without coordinates.
    if (!(latCol && lngCol) && !geocoder && !zipCol) {
      return {
        points: [],
        colorKind: 'none',
        missing: [ENC.latitude, ENC.longitude],
        diagnostics: noLocationMessage(fieldsByEncoding, seen, table.columns, table.data),
      };
    }

    const colorField = fieldsByEncoding.get(ENC.color)?.[0];
    const colorKind: ColorKind = !colorCol
      ? 'none'
      : colorKindOf(colorField, colorCol, table.data);

    const points: GlobePoint[] = [];
    table.data.forEach((row, i) => {
      // Geocode even when coordinates are encoded: choropleth needs the place's outline.
      const located = geocoder?.locate(row) ?? null;
      let lat = latCol ? num(row[latCol.index]) : null;
      let lng = lngCol ? num(row[lngCol.index]) : null;
      if ((lat === null || lng === null) && located) ({ lat, lng } = located);
      const zip = zipCol ? (normalizeZip(row[zipCol.index]?.nativeValue) ?? undefined) : undefined;
      const hasCoords = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      // Marks without coordinates are kept only for ZIP-based areas (not drawn as bars).
      if (!hasCoords && !zip) return;
      points.push({
        lat: hasCoords ? lat! : NaN,
        lng: hasCoords ? lng! : NaN,
        place: located?.place,
        placeName: located?.name,
        zip,
        dims: Object.fromEntries(dimCols.map((c) => [c.fieldName, fmt(row[c.index])])),
        height: heightCol ? num(row[heightCol.index]) : null,
        colorValue: colorCol ? colorValueOf(row[colorCol.index], colorKind) : null,
        label: labelCols.map((c) => fmt(row[c.index])).join(', '),
        // Tableau's tuple id for a summary-data row is its 1-based row position
        // (see the official Sankey viz extension sample).
        tupleId: i + 1,
      });
    });

    const source = latCol && lngCol ? 'latitude/longitude' : `locations in ${geocoder?.describe}`;
    return {
      points,
      colorKind,
      colorField: colorField && {
        name: colorField.name,
        readable: !!colorCol,
        dataType: [colorCol && String(colorCol.dataType), colorField.role, colorField.columnType]
          .filter(Boolean)
          .join(', '),
      },
      heightField: heightCol?.fieldName,
      colorColumn: colorCol?.fieldName,
      zipField: zipCol?.fieldName,
      groupFields: dimCols.map((c) => c.fieldName),
      missing: [],
      diagnostics:
        points.length === 0 && table.data.length > 0
          ? `No marks could be placed: none of the ${table.data.length} marks have usable ${source}.`
          : undefined,
    };
  } finally {
    await reader.releaseAsync();
  }
}

function noLocationMessage(
  fieldsByEncoding: Map<string, FieldInstance[]>,
  seen: string,
  columns: Column[],
  rows: DataValue[][],
): string {
  const lines = [
    'To place marks, either put latitude/longitude fields from your data on the Latitude and ' +
      'Longitude encodings, or put a Country or US State field on Detail.',
  ];
  const generated = [ENC.latitude, ENC.longitude]
    .map((id) => fieldsByEncoding.get(id)?.[0]?.name ?? '')
    .filter((name) => /\(generated\)/i.test(name));
  if (generated.length > 0) {
    // Tableau only produces generated coordinates when the view has a field with a
    // geographic role; otherwise the columns are absent from the summary data.
    lines.push(
      `${generated.join(' and ')} have no values: Tableau only generates coordinates when a field ` +
        'with a geographic role (Country, State, City, ZIP…) is on Detail.',
    );
  }
  lines.push(`\nEncodings: ${seen || 'none'}`);
  for (const c of columns) {
    // A few distinct values show why a column didn't geocode (e.g. "EMEA", "East").
    const samples = [...new Set(rows.slice(0, 200).map((r) => fmt(r[c.index])))].slice(0, 5);
    lines.push(`${c.fieldName}: ${samples.join(', ')}${samples.length === 5 ? ', …' : ''}`);
  }
  if (columns.length === 0) lines.push('Data columns: none');
  return lines.join('\n');
}

async function getEncodingFields(
  worksheet: Worksheet,
): Promise<{ fieldsByEncoding: Map<string, FieldInstance[]>; seen: string }> {
  const spec = await worksheet.getVisualSpecificationAsync();
  const card = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
  const known: string[] = Object.values(ENC);
  const fieldsByEncoding = new Map<string, FieldInstance[]>();
  const seen: string[] = [];
  for (const enc of card?.encodings ?? []) {
    seen.push(`${enc.id} (${enc.type}) = ${enc.field?.name}`);
    // Tolerate host-specific prefixes such as "<extension-id>.latitude".
    const id = enc.id.toLowerCase();
    const key = known.find((k) => id === k || id.endsWith(`.${k}`) || id.endsWith(`:${k}`) || id.endsWith(`/${k}`));
    if (!key || !enc.field) continue;
    const list = fieldsByEncoding.get(key) ?? [];
    list.push(enc.field);
    fieldsByEncoding.set(key, list);
  }
  return { fieldsByEncoding, seen: seen.join('; ') };
}

/** Match an encoded field to its summary-data column: by fieldId, then by name. */
function findColumn(columns: Column[], field: FieldInstance | undefined): Column | undefined {
  if (!field) return undefined;
  const bare = (s: string) => s.replace(/^\[|\]$/g, '').toLowerCase();
  const name = bare(field.name);
  return (
    columns.find((c) => c.fieldId === field.fieldId) ??
    columns.find((c) => bare(c.fieldName) === name) ??
    // Summary columns carry the aggregation, e.g. "AVG(Latitude)".
    columns.find((c) => bare(c.fieldName).endsWith(`(${name})`)) ??
    // fieldIds look like "[datasource].[agg:Field:qk]"; compare the field part.
    columns.find((c) => c.fieldId.toLowerCase().includes(`:${name}:`))
  );
}

/**
 * A column of US ZIP codes: named like one ("ZIP", "Postal Code") with mostly ZIP-shaped
 * values, or unnamed but with nearly all values exactly 5 digits. Plain 4-digit numbers
 * such as years only count when the name says ZIP (ZIPs stored as numbers lose leading 0s).
 */
function findZipColumn(columns: Column[], rows: DataValue[][]): Column | undefined {
  const sample = rows.slice(0, 500);
  let best: { column: Column; rate: number } | undefined;
  for (const c of columns) {
    const named = /zip|postal|zcta/i.test(c.fieldName);
    let values = 0;
    let hits = 0;
    for (const row of sample) {
      const v = row[c.index]?.nativeValue;
      if (v === null || v === undefined || v === '') continue;
      values++;
      const fiveDigit = typeof v === 'number' ? v >= 10000 && v < 100000 : /^\d{5}(-\d{4})?$/.test(String(v).trim());
      if (named ? normalizeZip(v) !== null : fiveDigit) hits++;
    }
    const rate = values ? hits / values : 0;
    if (rate >= (named ? 0.8 : 0.95) && (!best || rate > best.rate)) best = { column: c, rate };
  }
  return best?.column;
}

/**
 * Numbers get a color ramp, the way Tableau colors a measure, unless the field is a
 * discrete dimension (a year, a code). Decided from the values rather than the column's
 * data type alone, so a numeric measure is never shown as categories.
 */
function colorKindOf(field: FieldInstance | undefined, column: Column, rows: DataValue[][]): ColorKind {
  if (String(field?.role) === 'dimension' && String(field?.columnType) === 'discrete') return 'categorical';
  let numbers = 0;
  let others = 0;
  for (const row of rows) {
    const v = row[column.index]?.nativeValue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') numbers++;
    else others++;
  }
  if (numbers > 0 && others === 0) return 'continuous';
  return ['float', 'int'].includes(String(column.dataType)) ? 'continuous' : 'categorical';
}

function num(v: DataValue | undefined): number | null {
  const n = v?.nativeValue;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function fmt(v: DataValue | undefined): string {
  return v?.formattedValue ?? String(v?.nativeValue ?? '');
}

function colorValueOf(v: DataValue | undefined, kind: ColorKind): string | number | null {
  if (kind === 'continuous') return num(v);
  return v?.nativeValue == null ? null : fmt(v);
}
