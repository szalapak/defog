// Leaflet GridLayer that renders fog data as a canvas overlay.
// The fog grid is 2^22 cells wide == the pixel grid at map zoom 14, so one fog
// cell maps to one pixel at z14 (and scales cleanly at other zooms).
//
// Style model: we paint the cells on ONE side (explored or unexplored) and use a
// CSS blend mode on the layer's pane to composite them against the basemap:
//   - "desaturate": paint neutral gray, blend "saturation" -> those areas go grayscale
//   - "darken":     paint a dark colour, blend "multiply"  -> app-like fog
//   - "tint":       paint a colour, blend "normal"         -> flat highlight
(function (global) {
  const FOG_ZOOM = 14;

  function hexToRgb(hex) {
    const h = hex.replace("#", "");
    return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
  }
  const BLEND_CSS = { desaturate: "saturation", darken: "multiply", tint: "" };

  const FogLayer = L.GridLayer.extend({
    initialize: function (fogMap, opts) {
      opts = opts || {};
      L.GridLayer.prototype.initialize.call(this, opts);
      this.fogMap = fogMap;
      this.style = Object.assign({
        target: "explored",   // which cells get painted: "explored" | "unexplored"
        style: "desaturate",  // "desaturate" | "darken" | "tint"
        color: "#3a4a5a",
        alpha: 190,           // 0..255
        dilate: 0             // widen defogged paths by this many cells (only when zoomed in); 0 = raw
      }, opts.style || {});
    },
    onAdd: function (map) {
      L.GridLayer.prototype.onAdd.call(this, map);
      this._applyBlend();
    },
    _applyBlend: function () {
      const c = this.getContainer();
      if (c) c.style.mixBlendMode = BLEND_CSS[this.style.style] || "";
    },
    setStyle: function (patch) {
      Object.assign(this.style, patch);
      this._applyBlend();
      this.redraw();
    },
    _paintRgb: function () {
      if (this.style.style === "desaturate") return [128, 128, 128]; // gray -> removes saturation
      return hexToRgb(this.style.color);
    },
    createTile: function (coords) {
      const size = this.getTileSize();
      const tile = document.createElement("canvas");
      tile.width = size.x; tile.height = size.y;
      const ctx = tile.getContext("2d");
      const cellsPerPx = Math.pow(2, FOG_ZOOM - coords.z);
      const originCellX = coords.x * size.x * cellsPerPx;
      const originCellY = coords.y * size.y * cellsPerPx;

      const paintExplored = this.style.target === "explored";
      const [R, G, B] = this._paintRgb();
      const A = this.style.alpha;

      const img = ctx.createImageData(size.x, size.y);
      const data = img.data;
      const fog = this.fogMap;
      const samples = cellsPerPx > 1 ? Math.min(cellsPerPx, 4) : 1;
      const stride = cellsPerPx > 1 ? cellsPerPx / samples : 1;
      // widen only matters when zoomed in (1 pixel <= 1 cell); zoomed out, paths already merge
      const r = cellsPerPx <= 1 ? (this.style.dilate | 0) : 0;

      for (let py = 0; py < size.y; py++) {
        for (let px = 0; px < size.x; px++) {
          let visited = false;
          if (cellsPerPx <= 1) {
            const cx0 = Math.floor(originCellX + px * cellsPerPx);
            const cy0 = Math.floor(originCellY + py * cellsPerPx);
            for (let dy = -r; dy <= r && !visited; dy++)
              for (let dx = -r; dx <= r && !visited; dx++)
                if (fog.isVisitedCell(cx0 + dx, cy0 + dy)) visited = true;
          } else {
            const bx = originCellX + px * cellsPerPx;
            const by = originCellY + py * cellsPerPx;
            for (let sy = 0; sy < samples && !visited; sy++)
              for (let sx = 0; sx < samples && !visited; sx++)
                if (fog.isVisitedCell(Math.floor(bx + sx * stride), Math.floor(by + sy * stride)))
                  visited = true;
          }
          if (paintExplored ? visited : !visited) {
            const o = (py * size.x + px) * 4;
            data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = A;
          }
        }
      }
      ctx.putImageData(img, 0, 0);
      return tile;
    }
  });

  global.createFogLayer = function (fogMap, opts) { return new FogLayer(fogMap, opts); };
})(window);
