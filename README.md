# 3D Globe Viz Extension for Tableau

| Folder | What it is |
| --- | --- |
| `globe-viz/` | Stable v1.0 source. Frozen fallback; do not change. |
| `globe-viz-experimental/` | Experimental source (neon outlines, satellite earth, sun, legend, remembered outlines). |
| `docs/` | Built copies served by GitHub Pages: `docs/stable/`, `docs/experimental/`, and the Tableau Cloud `.trex` files in `docs/trex/`. |

Hosted at <https://jebbesecker03.github.io/tableau-globe-extension/>.

## Tableau Cloud

1. A site admin adds `https://jebbesecker03.github.io` to **Settings → Extensions** (safe list) and allows viz extensions.
2. Download `docs/trex/GlobeViz-Cloud.trex` (or the experimental one) and add it in a worksheet via **Marks card → Viz Extensions → Access Local Extensions**.

## Local development

Run `Start Globe Extension.bat` (port 8765) or `Start Globe Extension (Experimental).bat` (port 8766) and use the `.trex` inside each project folder.

## Publishing changes

Run `Publish to GitHub.bat`: it rebuilds the experimental globe, copies both builds into `docs/`, commits and pushes.
