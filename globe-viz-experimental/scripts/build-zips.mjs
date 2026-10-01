// Builds public/geo/zcta.topo.json: simplified US ZIP Code Tabulation Area outlines as
// TopoJSON (shared borders stored once), keyed by 5-digit ZIP. The extension loads it only
// when a choropleth is filled by ZIP, Territory, Region, etc., and merges ZIP outlines into
// larger areas with topojson.merge, the same way Tableau rolls ZIPs up into territories.
//
// Source (public domain): U.S. Census Bureau cartographic boundary file
//   https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip
// Download and unzip it, then run:
//   npm run build:zips -- path/to/cb_2020_us_zcta520_500k.shp
import { mkdirSync, statSync } from 'node:fs';
import mapshaper from 'mapshaper';

const input = process.argv[2];
if (!input) {
  console.error('Usage: npm run build:zips -- path/to/cb_2020_us_zcta520_500k.shp');
  process.exit(1);
}

const outDir = new URL('../public/geo/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const out = new URL('zcta.topo.json', outDir);

// 6% of vertices kept: file size is dominated by the ~33k shapes, not their detail, so
// this keeps borders reasonably smooth. keep-shapes stops small ZIPs from disappearing.
await mapshaper.runCommands(
  [
    `-i "${input}"`,
    '-filter-fields ZCTA5CE20',
    '-simplify 6% keep-shapes',
    '-rename-layers zcta',
    `-o "${decodeURIComponent(out.pathname).replace(/^\/([A-Za-z]:)/, '$1')}" format=topojson id-field=ZCTA5CE20 quantization=100000`,
  ].join(' '),
);

console.log(`wrote ${out.pathname} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
