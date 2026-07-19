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

  // Screen-space square dilation of a 0/1 mask by radius r pixels (separable, cheap).
  // Works at any zoom, so "widen" is a constant on-screen thickness.
  function dilate(mask, w, h, r) {
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let v = 0;
        const x0 = x - r < 0 ? 0 : x - r, x1 = x + r >= w ? w - 1 : x + r;
        for (let xx = x0; xx <= x1; xx++) if (mask[row + xx]) { v = 1; break; }
        tmp[row + x] = v;
      }
    }
    const out = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let v = 0;
        const y0 = y - r < 0 ? 0 : y - r, y1 = y + r >= h ? h - 1 : y + r;
        for (let yy = y0; yy <= y1; yy++) if (tmp[yy * w + x]) { v = 1; break; }
        out[y * w + x] = v;
      }
    }
    return out;
  }

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
      const W = size.x, H = size.y;
      const tile = document.createElement("canvas");
      tile.width = W; tile.height = H;
      const ctx = tile.getContext("2d");
      const cellsPerPx = Math.pow(2, FOG_ZOOM - coords.z);
      const originCellX = coords.x * W * cellsPerPx;
      const originCellY = coords.y * H * cellsPerPx;
      const fog = this.fogMap;
      const samples = cellsPerPx > 1 ? Math.min(Math.ceil(cellsPerPx), 4) : 1;
      const stride = cellsPerPx > 1 ? cellsPerPx / samples : 1;

      // 1) base "visited" mask, one bit per pixel
      let mask = new Uint8Array(W * H);
      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          let v = 0;
          if (cellsPerPx <= 1) {
            v = fog.isVisitedCell(
              Math.floor(originCellX + px * cellsPerPx),
              Math.floor(originCellY + py * cellsPerPx)) ? 1 : 0;
          } else {
            const bx = originCellX + px * cellsPerPx, by = originCellY + py * cellsPerPx;
            for (let sy = 0; sy < samples && !v; sy++)
              for (let sx = 0; sx < samples && !v; sx++)
                if (fog.isVisitedCell(Math.floor(bx + sx * stride), Math.floor(by + sy * stride))) v = 1;
          }
          mask[py * W + px] = v;
        }
      }

      // 2) widen defogged paths in screen space (works at every zoom)
      const r = this.style.dilate | 0;
      if (r > 0) mask = dilate(mask, W, H, r);

      // 3) paint the chosen side
      const paintExplored = this.style.target === "explored";
      const [R, G, B] = this._paintRgb();
      const A = this.style.alpha;
      const img = ctx.createImageData(W, H);
      const data = img.data;
      for (let i = 0; i < W * H; i++) {
        if (paintExplored ? mask[i] : !mask[i]) {
          const o = i * 4;
          data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = A;
        }
      }
      ctx.putImageData(img, 0, 0);
      return tile;
    }
  });

  global.createFogLayer = function (fogMap, opts) { return new FogLayer(fogMap, opts); };
})(window);
