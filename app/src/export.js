// Export the fog in the current map view as a KML polygon layer.
// mapy.cz and Google My Maps both import KML as a styled overlay.
//
// Pipeline: clip to the view -> aggregate fog cells into a coarse grid (~30 m squares)
// -> optionally widen -> merge covered cells into horizontal-run rectangles -> KML.
// Auto-coarsens if a view is too dense, and reports what it did (no silent truncation).
(function (global) {
  const { cellToLngLat, lngLatToCell } = global.FogParser;
  const MAX_RECTS = 12000;
  const BASE_COARSE = 4;   // fog cells per grid square at finest export detail (~30 m)
  const MAX_COARSE = 64;

  // approx ground size (m) of one fog cell at a given latitude
  function cellMeters(lat) {
    return (40075016.686 / global.FogParser.WORLD_CELLS) * Math.cos(lat * Math.PI / 180);
  }

  function buildGrid(fogMap, cx0, cy0, cols, rows, coarse, dilateCells) {
    // covered[r*cols + c] = 1 if any fog cell in that coarse square is visited
    const g = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const bx = cx0 + c * coarse, by = cy0 + r * coarse;
        let v = 0;
        for (let dy = 0; dy < coarse && !v; dy++)
          for (let dx = 0; dx < coarse && !v; dx++)
            if (fogMap.isVisitedCell(bx + dx, by + dy)) v = 1;
        g[r * cols + c] = v;
      }
    }
    return dilateCells > 0 ? dilateGrid(g, cols, rows, dilateCells) : g;
  }

  function dilateGrid(g, cols, rows, r) {
    const out = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        let v = 0;
        for (let dy = -r; dy <= r && !v; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= rows) continue;
          for (let dx = -r; dx <= r && !v; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= cols) continue;
            if (g[yy * cols + xx]) v = 1;
          }
        }
        out[y * cols + x] = v;
      }
    return out;
  }

  // merge covered cells into horizontal runs -> [c0, c1, row] rectangles (in grid units)
  function toRects(g, cols, rows, invert) {
    const rects = [];
    for (let r = 0; r < rows; r++) {
      let start = -1;
      for (let c = 0; c <= cols; c++) {
        const on = c < cols && (invert ? !g[r * cols + c] : g[r * cols + c]);
        if (on && start < 0) start = c;
        else if (!on && start >= 0) { rects.push([start, c - 1, r]); start = -1; }
      }
    }
    return rects;
  }

  function kmlColor(hex, alpha) { // -> aabbggrr
    const h = hex.replace("#", "");
    const a = (alpha & 255).toString(16).padStart(2, "0");
    return a + h.substr(4, 2) + h.substr(2, 2) + h.substr(0, 2);
  }

  // opts: { target:'explored'|'unexplored', dilate, color, alpha }
  function toKML(fogMap, bounds, opts) {
    opts = opts || {};
    const invert = opts.target === "unexplored";
    const w = bounds.getWest(), e = bounds.getEast();
    const n = bounds.getNorth(), s = bounds.getSouth();
    const tl = lngLatToCell(w, n), br = lngLatToCell(e, s); // north -> smaller cy
    const cxMin = Math.floor(Math.min(tl.cx, br.cx)), cxMax = Math.ceil(Math.max(tl.cx, br.cx));
    const cyMin = Math.floor(Math.min(tl.cy, br.cy)), cyMax = Math.ceil(Math.max(tl.cy, br.cy));

    let coarse = BASE_COARSE, rects, cols, rows, cx0, cy0;
    while (true) {
      cx0 = Math.floor(cxMin / coarse) * coarse;
      cy0 = Math.floor(cyMin / coarse) * coarse;
      cols = Math.ceil((cxMax - cx0) / coarse);
      rows = Math.ceil((cyMax - cy0) / coarse);
      const g = buildGrid(fogMap, cx0, cy0, cols, rows, coarse, opts.dilate | 0);
      rects = toRects(g, cols, rows, invert);
      if (rects.length <= MAX_RECTS || coarse >= MAX_COARSE) break;
      coarse *= 2;
    }

    const color = kmlColor(opts.color || "#3a4a5a", opts.alpha != null ? opts.alpha : 150);
    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
      "<name>FogToMaps: " + (invert ? "unexplored" : "explored") + "</name>",
      '<Style id="f"><LineStyle><color>00000000</color><width>0</width></LineStyle>' +
        "<PolyStyle><color>" + color + "</color></PolyStyle></Style>"
    ];
    for (const [c0, c1, r] of rects) {
      const fx0 = cx0 + c0 * coarse, fx1 = cx0 + (c1 + 1) * coarse;
      const fy0 = cy0 + r * coarse, fy1 = cy0 + (r + 1) * coarse;
      const a = cellToLngLat(fx0, fy0), b = cellToLngLat(fx1, fy0);
      const cc = cellToLngLat(fx1, fy1), d = cellToLngLat(fx0, fy1);
      const ring = [a, b, cc, d, a]
        .map((p) => p.lng.toFixed(6) + "," + p.lat.toFixed(6) + ",0").join(" ");
      parts.push('<Placemark><styleUrl>#f</styleUrl><Polygon><outerBoundaryIs>' +
        "<LinearRing><coordinates>" + ring + "</coordinates></LinearRing>" +
        "</outerBoundaryIs></Polygon></Placemark>");
    }
    parts.push("</Document></kml>");

    const latC = (n + s) / 2;
    return {
      kml: parts.join("\n"),
      rects: rects.length,
      squareMeters: Math.round(coarse * cellMeters(latC)),
      cappedAt: coarse >= MAX_COARSE && rects.length > MAX_RECTS ? MAX_RECTS : null
    };
  }

  function download(kml, name) {
    const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name || "fogtomaps.kml";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  global.FogExport = { toKML, download };
})(window);
