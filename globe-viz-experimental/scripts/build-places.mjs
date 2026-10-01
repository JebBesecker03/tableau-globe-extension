// Generates src/geo/places.json: lookup tables from country / US-state names and codes
// to [lat, lng, shapeId]. The shape id matches src/geo/shapes.ts (ISO numeric for
// countries, FIPS for states) so choropleths can find the outline. Run with
// `npm run build:places` after upgrading world-atlas, us-atlas or i18n-iso-countries.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { geoArea, geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const isoCountries = require('i18n-iso-countries');
isoCountries.registerLocale(require('i18n-iso-countries/langs/en.json'));

const readJson = (path) => JSON.parse(readFileSync(require.resolve(path), 'utf8'));

/** Must match normalizePlace() in src/geo/geocode.ts. */
function normalize(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

/** Must match shapeId() in src/geo/shapes.ts. */
function shapeId(f) {
  return f.id !== undefined ? String(f.id) : `name:${f.properties.name}`;
}

/** Centroid of the largest polygon, so e.g. the USA lands on the mainland, not near Canada. */
function anchor(geometry) {
  let target = geometry;
  if (geometry.type === 'MultiPolygon') {
    let best = -1;
    for (const coordinates of geometry.coordinates) {
      const polygon = { type: 'Polygon', coordinates };
      const area = geoArea(polygon);
      if (area > best) {
        best = area;
        target = polygon;
      }
    }
  }
  const [lng, lat] = geoCentroid(target);
  return [Math.round(lat * 1000) / 1000, Math.round(lng * 1000) / 1000];
}

function add(table, key, coords) {
  const k = normalize(key);
  if (k && !(k in table)) table[k] = coords;
}

// ---- countries ----
const EXTRA_COUNTRY_ALIASES = {
  US: ['usa', 'us', 'u.s.', 'u.s.a.', 'america', 'united states', 'united states of america'],
  GB: ['uk', 'u.k.', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'],
  KR: ['south korea', 's. korea', 'korea south', 'korea, south', 'republic of korea', 'korea'],
  KP: ['north korea', 'n. korea', 'korea north', 'korea, north', 'dprk'],
  RU: ['russia', 'russian federation'],
  CZ: ['czech republic', 'czechia'],
  CI: ['ivory coast', "cote d'ivoire"],
  CD: ['drc', 'dr congo', 'congo kinshasa', 'congo (kinshasa)', 'democratic republic of congo'],
  CG: ['congo brazzaville', 'congo (brazzaville)', 'republic of congo', 'republic of the congo'],
  AE: ['uae', 'u.a.e.'],
  NL: ['holland', 'the netherlands'],
  MM: ['burma'],
  SZ: ['swaziland', 'eswatini'],
  MK: ['macedonia', 'north macedonia'],
  TR: ['turkey', 'turkiye'],
  CV: ['cape verde', 'cabo verde'],
  TL: ['east timor', 'timor leste'],
  VA: ['vatican', 'vatican city', 'holy see'],
  PS: ['palestine', 'state of palestine'],
  TW: ['taiwan', 'republic of china'],
  CN: ['china', "people's republic of china", 'prc', 'mainland china'],
  IR: ['iran'],
  SY: ['syria'],
  LA: ['laos'],
  VN: ['vietnam', 'viet nam'],
  BO: ['bolivia'],
  VE: ['venezuela'],
  TZ: ['tanzania'],
  MD: ['moldova'],
  BN: ['brunei'],
};

const world = readJson('world-atlas/countries-50m.json');
const allNames = isoCountries.getNames('en', { select: 'all' });
const countries = {};
for (const f of feature(world, world.objects.countries).features) {
  const coords = [...anchor(f.geometry), shapeId(f)];
  add(countries, f.properties.name, coords);
  if (f.id === undefined) continue;
  const alpha2 = isoCountries.numericToAlpha2(f.id);
  add(countries, f.id, coords);
  add(countries, String(Number(f.id)), coords); // "004" and "4"
  if (!alpha2) continue;
  add(countries, alpha2, coords);
  add(countries, isoCountries.alpha2ToAlpha3(alpha2), coords);
  for (const name of allNames[alpha2] ?? []) add(countries, name, coords);
  for (const alias of EXTRA_COUNTRY_ALIASES[alpha2] ?? []) add(countries, alias, coords);
}

// ---- US states ----
const STATE_ABBR = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE',
  '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA',
  '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM',
  '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI',
};

const us = readJson('us-atlas/states-10m.json');
const states = {};
for (const f of feature(us, us.objects.states).features) {
  const coords = [...anchor(f.geometry), shapeId(f)];
  add(states, f.properties.name, coords);
  add(states, f.id, coords);
  add(states, String(Number(f.id)), coords);
  if (STATE_ABBR[f.id]) add(states, STATE_ABBR[f.id], coords);
}
add(states, 'Washington DC', states[normalize('District of Columbia')]);
add(states, 'Washington D.C.', states[normalize('District of Columbia')]);

const out = new URL('../src/geo/places.json', import.meta.url);
writeFileSync(out, JSON.stringify({ countries, states }));
console.log(
  `countries: ${Object.keys(countries).length} keys, states: ${Object.keys(states).length} keys -> ${out.pathname}`,
);
