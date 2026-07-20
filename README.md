# FogToMaps

A small, browser-based tool that reads your **[Fog of World](https://fogofworld.app/)**
sync data and renders where you've been (and, more usefully, where you *haven't*)
as an overlay on a real map — so you can plan routes that maximise new "defogging".

Everything runs **client-side**: your location data never leaves your machine.

**→ Open the app: <https://szalapak.github.io/defog/>**

## Features

- Parses the Fog of World `Sync/` format (zlib-compressed tiles → visited cells).
- Renders the fog as a canvas overlay on a real basemap (OSM / CyclOSM / Voyager),
  decoding only the tiles in view so large datasets stay responsive.
- **Fog look:** shade visited/unexplored, colour, opacity, and **Widen** to fatten thin tracks.
- **Live "% defogged"** of the current view in the header.
- **Route planning** snapped to real roads via [BRouter](https://brouter.de) (bike / road /
  walk / car / rail): draggable & line-insertable waypoints, distance + elevation profile,
  and an estimate of the **new area a route would defog**. Export the route as GPX / KML,
  or open it in Google Maps. km/mi units.

Everything runs **client-side** — location data never leaves the browser.

## Use it

Open **<https://szalapak.github.io/defog/>** in Chrome/Edge and click
**"Pick your Sync folder…"** to load any Fog of World `Sync` folder. Nothing is
uploaded — the folder is read and rendered entirely in your browser.

## Deploy

Pushing to `main` auto-deploys the `app/` folder to GitHub Pages via
`.github/workflows/deploy.yml` (enable Pages → Source: GitHub Actions once).

## Project layout

```
app/
  index.html        UI (top bar + Customise panel)
  src/parser.js     Fog of World format → visited cells (+ tile↔lat/lng math)
  src/fogLayer.js   Leaflet GridLayer that paints the fog, with the look/blend/widen options
  src/main.js       wiring: data loading, style controls, persistence
  vendor/           Leaflet + pako (zlib), vendored so there's nothing to install
Sync/               your personal Fog of World data (gitignored — not committed)
```

## Data format (credits)

The sync format was reverse-engineered by
[CaviarChen/Fog-of-World-Data-Parser](https://github.com/CaviarChen/Fog-of-World-Data-Parser)
(see also [Fog Machine](https://github.com/CaviarChen/fog-machine)). `parser.js` is a
faithful browser port of that work. World = 512×512 Web-Mercator tiles; each tile file is
zlib-compressed and holds a 128×128 block header indexing 64×64-bit bitmaps. One set bit =
one defogged cell; the grid is 2²² cells wide, which lines up 1:1 with map pixels at zoom 14.

## License

App code: MIT. Vendored libraries keep their own licenses (Leaflet: BSD-2, pako: MIT).
