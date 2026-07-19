# FogToMaps

A small, browser-based tool that reads your **[Fog of World](https://fogofworld.app/)**
sync data and renders where you've been (and, more usefully, where you *haven't*)
as an overlay on a real map — so you can plan routes that maximise new "defogging".

Everything runs **client-side**: your location data never leaves your machine.

## Status

Working MVP:

- Parses the Fog of World `Sync/` format (zlib-compressed tiles → visited cells).
- Renders the fog as a canvas overlay on an OpenStreetMap basemap (Leaflet).
- Only decodes the tiles in view, so large datasets stay responsive.
- "Customise the look" panel: mute visited vs unexplored, desaturate / tint / darken,
  muted colour palette, opacity, and **Widen paths** (dilation) to fatten thin tracks.

Planned next: export the overlay (GeoJSON/KML, clipped to the current view) for import
into **mapy.cz** / Google My Maps, where their native routing does the actual planning.

## Run it

No build step, no Node required. From the project root:

```sh
python -m http.server 8000 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8000/app/index.html> in Chrome/Edge and click
**"Load my Sync (dev)"** (reads the bundled `Sync/` folder via the dev server),
or **"Pick Sync folder…"** to load any Fog of World `Sync` folder.

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
