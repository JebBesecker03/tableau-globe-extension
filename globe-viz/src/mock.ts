import { locatePlace } from './geo/geocode';
import type { GlobeData, GlobePoint } from './types';

// [city, country, lat, lng, region, value]
const CITIES: [string, string, number, number, string, number][] = [
  ['Boston', 'United States', 42.36, -71.06, 'North America', 920],
  ['San Francisco', 'United States', 37.77, -122.42, 'North America', 780],
  ['San Diego', 'United States', 32.72, -117.16, 'North America', 610],
  ['Raleigh-Durham', 'United States', 35.99, -78.9, 'North America', 540],
  ['New Jersey', 'United States', 40.22, -74.76, 'North America', 700],
  ['Toronto', 'Canada', 43.65, -79.38, 'North America', 350],
  ['Mexico City', 'Mexico', 19.43, -99.13, 'Latin America', 260],
  ['São Paulo', 'Brazil', -23.55, -46.63, 'Latin America', 410],
  ['Buenos Aires', 'Argentina', -34.6, -58.38, 'Latin America', 190],
  ['London', 'United Kingdom', 51.51, -0.13, 'Europe', 690],
  ['Cambridge UK', 'United Kingdom', 52.2, 0.12, 'Europe', 480],
  ['Basel', 'Switzerland', 47.56, 7.59, 'Europe', 820],
  ['Paris', 'France', 48.86, 2.35, 'Europe', 450],
  ['Copenhagen', 'Denmark', 55.68, 12.57, 'Europe', 520],
  ['Munich', 'Germany', 48.14, 11.58, 'Europe', 330],
  ['Leiden', 'Netherlands', 52.16, 4.49, 'Europe', 240],
  ['Dublin', 'Ireland', 53.35, -6.26, 'Europe', 300],
  ['Tel Aviv', 'Israel', 32.09, 34.78, 'Middle East & Africa', 210],
  ['Johannesburg', 'South Africa', -26.2, 28.05, 'Middle East & Africa', 150],
  ['Cairo', 'Egypt', 30.04, 31.24, 'Middle East & Africa', 120],
  ['Bangalore', 'India', 12.97, 77.59, 'Asia Pacific', 390],
  ['Hyderabad', 'India', 17.39, 78.49, 'Asia Pacific', 360],
  ['Shanghai', 'China', 31.23, 121.47, 'Asia Pacific', 640],
  ['Beijing', 'China', 39.9, 116.4, 'Asia Pacific', 430],
  ['Tokyo', 'Japan', 35.68, 139.69, 'Asia Pacific', 580],
  ['Seoul', 'South Korea', 37.57, 126.98, 'Asia Pacific', 470],
  ['Singapore', 'Singapore', 1.35, 103.82, 'Asia Pacific', 510],
  ['Sydney', 'Australia', -33.87, 151.21, 'Asia Pacific', 280],
  ['Melbourne', 'Australia', -37.81, 144.96, 'Asia Pacific', 250],
  ['Auckland', 'New Zealand', -36.85, 174.76, 'Asia Pacific', 90],
];

/** Sample data is colored by a Region dimension, as if Region were on Color. */
const MOCK_COLOR_FIELD = { name: 'Region', readable: true, dataType: 'string, dimension, discrete' };

/** US Census regions, mirroring a "State on Detail, Region on Color" worksheet. */
const CENSUS_REGIONS: Record<string, string> = {
  Northeast: 'CT ME MA NH RI VT NJ NY PA',
  Midwest: 'IL IN MI OH WI IA KS MN MO NE ND SD',
  South: 'DE DC FL GA MD NC SC VA WV AL KY MS TN AR LA OK TX',
  West: 'AZ CO ID MT NV NM UT WY AK CA HI OR WA',
};

/**
 * Sample data used when the page runs outside Tableau:
 * "" = life-sciences hubs, "states" = US states by census region, a number = random points.
 */
export function mockData(param = ''): GlobeData {
  if (param === 'states') return mockStates();
  if (param === 'zips') return mockZips();
  const count = Number(param) || 0;
  if (count > 0) return mockRandom(count);

  const points = CITIES.map(([label, country, lat, lng, region, value], i) => ({
    lat,
    lng,
    place: locatePlace(country, 'country')?.place,
    placeName: country,
    height: value,
    colorValue: region,
    label,
    tupleId: i + 1,
  }));
  return { points, colorKind: 'categorical', colorField: MOCK_COLOR_FIELD, missing: [] };
}

function mockStates(): GlobeData {
  const points: GlobePoint[] = [];
  for (const [region, states] of Object.entries(CENSUS_REGIONS)) {
    for (const abbr of states.split(' ')) {
      const located = locatePlace(abbr, 'state');
      if (!located) continue;
      points.push({
        lat: located.lat,
        lng: located.lng,
        place: located.place,
        placeName: abbr,
        dims: { Region: region, State: abbr },
        // Deterministic pseudo-value so reloads look the same.
        height: 100 + ((abbr.charCodeAt(0) * 31 + abbr.charCodeAt(1) * 17) % 900),
        colorValue: region,
        label: abbr,
        tupleId: points.length + 1,
      });
    }
  }
  return { points, colorKind: 'categorical', colorField: MOCK_COLOR_FIELD, missing: [] };
}

/** Sales territories as ranges of 3-digit ZIP prefixes, grouped into regions. */
const TERRITORIES: [region: string, territory: string, prefixRanges: [number, number][]][] = [
  ['Northeast', 'New England', [[10, 69]]],
  ['Northeast', 'NY Metro', [[100, 119]]],
  ['Northeast', 'Mid-Atlantic', [[150, 219]]],
  ['Southeast', 'Carolinas', [[270, 299]]],
  ['Southeast', 'Georgia & Florida', [[300, 349]]],
  ['Central', 'Great Lakes', [[430, 499]]],
  ['Central', 'Chicagoland', [[600, 629]]],
  ['West', 'Southern California', [[900, 935]]],
  ['West', 'Northern California', [[940, 961]]],
  ['West', 'Pacific Northwest', [[970, 994]]],
];

/**
 * ZIP-level rows with Territory and Region, like a sheet with ZIP / Territory / Region on
 * Detail. ZIPs are generated from prefixes, so some don't exist; those have no outline and
 * are skipped when areas are merged, as PO-box ZIPs would be. No coordinates: choropleth only.
 */
function mockZips(): GlobeData {
  const points: GlobePoint[] = [];
  for (const [region, territory, ranges] of TERRITORIES) {
    for (const [from, to] of ranges) {
      for (let prefix = from; prefix <= to; prefix++) {
        for (let suffix = 0; suffix < 100; suffix++) {
          const zip = String(prefix * 100 + suffix).padStart(5, '0');
          points.push({
            lat: NaN,
            lng: NaN,
            zip,
            dims: { Region: region, Territory: territory },
            height: 10 + ((prefix * 7 + suffix * 13) % 90),
            colorValue: region,
            label: zip,
            tupleId: points.length + 1,
          });
        }
      }
    }
  }
  return {
    points,
    colorKind: 'categorical',
    colorField: MOCK_COLOR_FIELD,
    heightField: 'SUM(Sales)',
    zipField: 'ZIP',
    groupFields: ['Region', 'Territory'],
    missing: [],
  };
}

function mockRandom(count: number): GlobeData {
  const regions = ['A', 'B', 'C', 'D', 'E'];
  const points: GlobePoint[] = Array.from({ length: count }, (_, i) => ({
    lat: (Math.acos(2 * Math.random() - 1) * 180) / Math.PI - 90,
    lng: Math.random() * 360 - 180,
    height: Math.random() ** 3 * 1000,
    colorValue: regions[i % regions.length],
    label: `Point ${i + 1}`,
    tupleId: i + 1,
  }));
  return { points, colorKind: 'categorical', colorField: MOCK_COLOR_FIELD, missing: [] };
}
