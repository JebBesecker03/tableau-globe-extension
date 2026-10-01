# 3D Globe — Tableau Viz Extension

Plots lat/long marks as 3D bars on an interactive globe (globe.gl / three.js).
Bar height and color come from Tableau encodings; hover shows Tableau's native tooltip and
clicking selects marks, which drives dashboard actions.

Requires **Tableau Desktop 2024.2+** (Extensions API 1.12, for native tooltips and tuple selection).

## Run locally

```bash
npm install
npm run dev
```

The dev server runs at http://localhost:8765. Opened in a normal browser it shows sample
data (`?mock` forces this). `?mock=states` gives US states colored by census region, which is
good for trying choropleth. `?mock=20000` generates 20k random points for performance checks.

## Load in Tableau Desktop

1. Keep `npm run dev` running.
2. Open a worksheet. In the **Marks** card, open the mark type dropdown → **Viz Extensions** →
   **Access Local Viz Extensions** → choose `GlobeViz.trex`.
3. Drag fields onto the extension's encodings:

| Encoding  | Field | Required |
|-----------|-------|----------|
| Latitude  | Latitude (generated), or a latitude field from your data | no* |
| Longitude | Longitude (generated), or a longitude field from your data | no* |
| Height    | a measure; bar height is proportional to its absolute value | no |
| Color     | a measure (ramp) or dimension (palette); palettes are chosen in ⚙ | no |

Put dimensions on the Marks card's built-in **Detail** to set the level of detail (one bar
per combination, e.g. Site or City), and the fields you want in the tooltip on **Tooltip**.

\* **Where coordinates come from**, in order of preference:

- Latitude/Longitude on the encodings. *Generated* coordinates only have values when a
  field with a geographic role (Country, State, City, ZIP…) is on Detail. A plain field
  like a sales Region gives nothing.
- If those are empty, a **Country** and/or **US State** field on Detail. The built-in
  geocoder places each mark at the centroid of that area's largest landmass. It matches
  English names, common aliases, ISO alpha-2/alpha-3/numeric codes, and state abbreviations
  or FIPS codes. With both Country and State present, states are used only for US rows.

The lookup table `src/geo/places.json` is generated from Natural Earth (via `world-atlas`)
and `us-atlas`. Regenerate it with `npm run build:places`.

## Colors

In the ⚙ panel: **Single color** (nothing on Color), **Palette for measures on Color**
(Yellow–Orange–Red, Blues, Greens, Purples, Viridis, Plasma, Turbo, or diverging
Red–Yellow–Blue / Red–Yellow–Green, where low values are red and high values green) and **Palette for dimensions on Color** (Tableau 10, Category 10, Set 2,
Dark 2, Paired).

## Map types

Choose in the ⚙ panel (saved with the workbook):

- **Points**: one 3D bar per mark (Height = bar height, Color = bar color).
- **Choropleth**: each mark's **country or US state** is filled with its Color. Put a
  Country or State field on Detail. To color by region, put the State/Country field on
  Detail and **Region on Color**. On the WebGL globe a Height field extrudes the shapes;
  the Canvas globe draws them flat. Marks that have no outline at 1:110m (e.g. Singapore) or
  only have coordinates stay as bars. If several marks fall in the same area, the first
  one colors it.

### Regions and territories built from ZIPs

Like Tableau's custom territories, the choropleth can merge ZIP outlines into larger areas:

1. Put **ZIP**, **Territory** and **Region** on Detail (Region can go on Color instead).
   The sheet must stay at ZIP level: ZIP is how the extension learns each area's members.
2. In ⚙ set Map type to **Choropleth** and **Fill by** to *Merge by Region* or
   *Merge by Territory*. The list is built from the text fields on the sheet.
3. **Combine values when merging**: Sum or Average for Height and a measure on Color.

Clicking an area selects all of its ZIP marks in Tableau, so dashboard actions work at that
level. Hovering shows the area name, ZIP count and rolled-up values. Without ZIPs, *Merge by*
merges state (or country) outlines instead, e.g. Region with State on Detail.

ZIP outlines are US Census 2020 ZIP Code Tabulation Areas (`public/geo/zcta.topo.json`, 7.5 MB,
loaded only when needed). PO-box and single-building ZIPs have no outline: they still count
in the totals but aren't drawn. Rebuild the file with `npm run build:zips -- <path to .shp>`
(see `scripts/build-zips.mjs`).

**Drill down** (Fill by → *Drill down: Region → Territory → ZIP*) starts with just the
region outlines. Clicking a region zooms to it and shows its territories; clicking a
territory shows its ZIPs. The rest stays visible, dimmed, for context. Go back with the
breadcrumb at the top left or by clicking outside the areas. Each click also selects that
area's marks in Tableau. The levels are detected from the sheet: text fields ordered by
number of values, each nested inside the previous one (every Territory in one Region).
Merged areas are drawn as solid outer outlines, so land with no ZIP area (forests, lakes)
doesn't show as holes.

Selecting any filled area (state, region, territory, ZIP) centers the camera on it and
zooms to fit it.

**Labels** (⚙ → Labels) name each area at its center: region, territory, ZIP code, state or
country. Bars are named too when there are 80 or fewer. A label appears only if its area is big
enough on screen to hold it and it doesn't overlap a more important one, so zooming in reveals
more (e.g. individual ZIP codes). In a drill-down, the areas you're choosing between are bold
and the dimmed context areas are small. Whatever is under the mouse, or selected, always gets
a highlighted label.

*Each ZIP* (every ZIP filled separately) works but is slow on the Desktop (Canvas) globe when
zoomed in, and heavy on the 3D globe. Prefer *Merge by Region / Territory* for large areas.

## Renderers

Tableau Desktop's embedded browser (Qt WebEngine) has **WebGL disabled for extensions**, and
Tableau has marked this "Won't Fix". So the extension picks a renderer at startup:

| Where | Renderer |
|-------|----------|
| Browser with WebGL (Tableau Cloud / Server) | Photoreal globe (globe.gl / three.js, satellite textures) |
| No WebGL (Tableau Desktop) | Canvas 2D globe: orthographic country map, projected 3D bars |

Both support the same tooltips, selection, fly-to, auto-rotate and settings. "Texture" maps to a
color scheme on the Canvas globe. Add `?renderer=canvas` to the dev URL to preview the fallback in a
normal browser.

## Interaction

- **Hover** a bar for its Tableau tooltip.
- **Click** a bar to select it (the camera flies to it); **Ctrl/Shift+click** toggles marks in the selection.
- **Click empty globe** to clear the selection.
- Auto-rotate pauses while you interact and resumes after 5 s.
- The **gear** (authoring mode only) sets rotation, texture, bar height/width and atmosphere.
  Settings are saved in the workbook.

## Project layout

```
GlobeViz.trex          manifest: encodings and the extension URL
src/main.ts            bootstrap: Tableau init (or mock mode), events, render loop
src/tableau/data.ts    visual spec + summary data -> GlobePoint[]
src/tableau/interaction.ts  hoverTupleAsync / selectTuplesAsync
src/globe/scene.ts     globe.gl setup, textures, auto-rotate, resize
src/globe/points.ts    bar altitude and color scales, selection dimming
src/globe/camera.ts    fly-to
src/settings.ts        settings persistence + gear panel
public/lib, public/textures  vendored Tableau API library and Earth textures
```

## Deploying (Tableau Cloud / Server)

`npm run build` writes a static site to `dist/`. Host it over HTTPS, change
`<source-location>` in `GlobeViz.trex` to that URL, and have a site admin allow the extension.

## Manifest notes

The published docs are out of date; Tableau Desktop validates `.trex` files against an XSD
embedded in `bin\res\tablangres.rcc`. Rules the docs don't mention:

- `<icon>` (a Base64 PNG, ≤ ~19 KB) is **required**, right after `<source-location>`.
- At most **4** custom `<encoding>` elements. Detail and Tooltip are always on the Marks card.

Both violations show up as the same misleading error:
`element 'encoding' is not allowed for content model '(...,encoding*)'`.

## Known limits

- WebGL globe: above 10,000 marks the bars are merged into one mesh for speed, so per-bar
  hover and click are unavailable. The Canvas globe keeps hover and click at any size, but above
  5,000 marks it skips depth sorting.
- Don't create and delete temporary files inside `globe-viz/` while `npm run dev` is running.
  On Windows, Vite's file watcher can crash with `EBUSY`.
- Selection made elsewhere (e.g. from another sheet's action) isn't reflected in bar dimming yet.
- Colors use the extension's own palettes, not the workbook's color legend.
