// "Streets left": lights up the streets and paths you haven't defogged yet.
//
// Street geometry for the area on screen comes from the shared StreetIndex
// (Overpass, fetched in fixed tiles so panning reuses what's already cached).
// Each way is judged in ~20 m pieces against the fog: a piece is still "left"
// when no defogged cell lies within DONE_WITHIN_M of it, the same idea the
// route editor uses to split a drawn path into new and already-done ground.
// Consecutive left pieces become a run, and only the runs are drawn, so a
// street you've half walked lights up along its missing half only.
//
// Drawing is a glow: a wide translucent halo under a thin bright core, on a
// canvas pane between the fog and the route overlays. The colour is the user's
// own, deepened a little on a light map, and never the fog swatch colour, which
// would read as "already defogged". Stretches the chosen way of travelling
// can't take are drawn faintly rather than dropped, so a walk-only alley still
// shows while you're planning a bike ride.
(function (global) {
  const TILE_DEG = 0.05;     // download tiles, ~5.5 x 3.5 km at 51°N
  const MAX_TILES = 12;      // bigger views would download too much: ask to zoom in
  const PIECE_M = 20;        // ways are judged in pieces this long
  const DONE_WITHIN_M = 20;  // a piece is done if a defogged cell lies this close (forgives GPS wobble)
  const MIN_RUN_M = 25;      // shorter leftover stretches aren't drawn (confetti at crossings)
  const SLICE_MS = 12;       // classify in slices this long so big cities don't freeze the page
  const RETRY_MS = 10000;    // after a failed download, wait this long before trying again on a move
  const SECOND_TRY_MS = 3000; // Overpass answers 504 when momentarily busy: one quiet retry first
  // One colour serves both maps: as-is on the dark map, deepened a little on the
  // light one so it still reads against pale ground while staying bright.
  const DEFAULT_COLOR = "#4fd6e6";
  const OPS = {
    light: { coreOp: 0.72, haloOp: 0.14, shade: 0.82 },
    dark: { coreOp: 0.9, haloOp: 0.3, shade: 1 }
  };
  const DIM_OP = 0.3; // strength of stretches the chosen transport can't use
  // Which travel class each Plan mode needs; the rest can go anywhere on foot.
  const MODE_CLASS = { trekking: "bike", fastbike: "road", "car-fast": "car" };
  function shade(hex, f) {
    const h = hex.replace("#", "");
    const c = [0, 2, 4].map((i) => Math.round(parseInt(h.substr(i, 2), 16) * f));
    return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  const coreWeight = (z) => (z <= 13 ? 2 : z <= 15 ? 2.5 : 3);
  const HALO_EXTRA = 4;

  const Badge = L.Control.extend({
    onAdd: function () {
      const d = L.DomUtil.create("div", "streetsBadge");
      d.style.display = "none";
      L.DomEvent.disableClickPropagation(d);
      return d;
    }
  });

  function StreetsLeftLayer(map, opts) {
    this.map = map;
    this.streets = opts.streets;   // shared StreetIndex
    this.isNew = opts.isNew;       // (lon, lat, radiusM) -> true when no defogged cell is within radius
    this.onStats = opts.onStats || null; // called whenever what's drawn changes (for the header readout)
    this.enabled = false;
    this.look = "light";
    this.color = DEFAULT_COLOR;
    this.opacity = 1;
    this.travelClass = null;       // null = draw every stretch at full strength
    this.runs = [];                // stretches still to do: [{ll: [[lat, lng], ...], m, s, w, n, e}]
    this.doneRuns = [];            // stretches already defogged (kept for the "% of streets left" readout)
    this._cursor = 0;              // how many of streets.ways have been classified
    this._busy = false; this._dirty = false; this._retryAt = 0;
    if (!map.getPane("streets")) {
      map.createPane("streets");
      map.getPane("streets").style.zIndex = 360; // above the fog (350), below routes (400)
    }
    const renderer = L.canvas({ pane: "streets" });
    // faint stretches first, so the ones you can actually take draw over them
    this.dim = L.polyline([], { renderer, pane: "streets", interactive: false, lineCap: "round", lineJoin: "round" });
    this.halo = L.polyline([], { renderer, pane: "streets", interactive: false, lineCap: "round", lineJoin: "round" });
    this.core = L.polyline([], { renderer, pane: "streets", interactive: false, lineCap: "round", lineJoin: "round" });
    this.badge = new Badge({ position: "topright" });
    this._onMove = () => this._update();
  }

  StreetsLeftLayer.prototype.setEnabled = function (on) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.dim.addTo(this.map); this.halo.addTo(this.map); this.core.addTo(this.map);
      this.badge.addTo(this.map);
      this.map.on("moveend", this._onMove);
      this._restyle();
      this._update();
    } else {
      this.map.off("moveend", this._onMove);
      this.map.removeLayer(this.dim); this.map.removeLayer(this.halo); this.map.removeLayer(this.core);
      this.map.removeControl(this.badge);
    }
  };

  // look: "dark" | "light", matching the basemap
  StreetsLeftLayer.prototype.setLook = function (look) {
    this.look = OPS[look] ? look : "light";
    this._restyle();
  };
  // Plan-tab transport mode: stretches it can't use are drawn faintly.
  StreetsLeftLayer.prototype.setMode = function (profile) {
    const c = MODE_CLASS[profile] || null;
    if (c === this.travelClass) return;
    this.travelClass = c;
    if (this.enabled) this._draw();
  };
  StreetsLeftLayer.prototype.setColor = function (hex) {
    this.color = /^#[0-9a-f]{6}$/i.test(hex || "") ? hex : DEFAULT_COLOR;
    this._restyle();
  };
  // The colour the streets are drawn in right now (the header readout matches it).
  StreetsLeftLayer.prototype.currentColor = function () {
    return shade(this.color, OPS[this.look].shade);
  };
  StreetsLeftLayer.prototype.setOpacity = function (a) {
    this.opacity = Math.max(0, Math.min(1, a));
    this._restyle();
  };

  // The fog changed (more tiles loaded): every way needs judging again.
  StreetsLeftLayer.prototype.invalidateFog = function () {
    this.runs = []; this.doneRuns = []; this._cursor = 0;
    if (this.enabled) this._update();
  };

  StreetsLeftLayer.prototype._restyle = function () {
    if (!this.enabled) return;
    const lk = OPS[this.look], w = coreWeight(this.map.getZoom()), c = this.currentColor();
    this.core.setStyle({ color: c, opacity: lk.coreOp * this.opacity, weight: w });
    this.halo.setStyle({ color: c, opacity: lk.haloOp * this.opacity, weight: w + HALO_EXTRA });
    this.dim.setStyle({ color: c, opacity: lk.coreOp * this.opacity * DIM_OP, weight: Math.max(1, w - 0.5) });
  };

  // Metres of street still to do / already done inside the given bounds, counting
  // each 20 m piece by its midpoint. Only meaningful for the area already fetched.
  StreetsLeftLayer.prototype.statsInView = function (b) {
    const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
    const ky = 110540, kx = 111320 * Math.cos(((s + n) / 2) * Math.PI / 180);
    const sum = (list) => {
      let m = 0;
      for (const r of list) {
        if (r.n < s || r.s > n || r.e < w || r.w > e) continue;
        const ll = r.ll;
        for (let i = 1; i < ll.length; i++) {
          const la = (ll[i - 1][0] + ll[i][0]) / 2, lo = (ll[i - 1][1] + ll[i][1]) / 2;
          if (la < s || la > n || lo < w || lo > e) continue;
          m += Math.hypot((ll[i][1] - ll[i - 1][1]) * kx, (ll[i][0] - ll[i - 1][0]) * ky);
        }
      }
      return m;
    };
    return { leftM: sum(this.runs), doneM: sum(this.doneRuns) };
  };

  StreetsLeftLayer.prototype._say = function (text) {
    const el = this.badge.getContainer();
    if (!el) return;
    el.textContent = text || "";
    el.style.display = text ? "" : "none";
  };

  // Fixed-grid tiles touching the current view.
  StreetsLeftLayer.prototype._visibleTiles = function () {
    const b = this.map.getBounds();
    const tx0 = Math.floor(b.getWest() / TILE_DEG), tx1 = Math.floor(b.getEast() / TILE_DEG);
    const ty0 = Math.floor(b.getSouth() / TILE_DEG), ty1 = Math.floor(b.getNorth() / TILE_DEG);
    const tiles = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++)
      tiles.push({ s: ty * TILE_DEG, n: (ty + 1) * TILE_DEG, w: tx * TILE_DEG, e: (tx + 1) * TILE_DEG });
    return tiles;
  };

  StreetsLeftLayer.prototype._update = async function () {
    if (!this.enabled) return;
    const tiles = this._visibleTiles();
    if (tiles.length > MAX_TILES) {
      this._say("Zoom in to see the streets left (up to about a town at a time)");
      this.dim.setLatLngs([]); this.halo.setLatLngs([]); this.core.setLatLngs([]);
      return;
    }
    if (this._busy) { this._dirty = true; return; }
    if (Date.now() < this._retryAt) return; // a download just failed; retry on a later move
    this._busy = true;
    try {
      if (this.streets.needsFetch(tiles, "run")) this._say("Reading the street map…");
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try { await this.streets.ensureRects(tiles, "run"); ok = true; }
        catch (e) { if (attempt === 0) await new Promise((r) => setTimeout(r, SECOND_TRY_MS)); }
        if (!this.enabled) return;
      }
      if (!ok) {
        this._retryAt = Date.now() + RETRY_MS;
        this._say("Couldn't load the street map. Move the map to try again in a moment.");
        return;
      }
      await this._classifyNew();
      if (!this.enabled) return;
      this._say("");
      this._draw();
    } finally {
      this._busy = false;
      if (this._dirty) { this._dirty = false; this._update(); }
    }
  };

  // Judge the ways fetched since last time, in short time slices. Yields through a
  // message channel rather than a timer or animation frame: those are throttled
  // or paused in a background tab, and this should finish there too.
  StreetsLeftLayer.prototype._classifyNew = function () {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      const step = () => {
        const ways = this.streets.ways, t0 = performance.now();
        while (this._cursor < ways.length && performance.now() - t0 < SLICE_MS) this._classifyWay(ways[this._cursor++]);
        if (this._cursor < ways.length) ch.port2.postMessage(null); else resolve();
      };
      ch.port1.onmessage = step;
      step();
    });
  };

  // Split one way into runs of consecutive "left" pieces and consecutive "done" pieces.
  StreetsLeftLayer.prototype._classifyWay = function (w) {
    const g = w.geometry;
    const ky = 110540, kx = 111320 * Math.cos(g[0].lat * Math.PI / 180);
    let run = null, runM = 0, runLeft = false;
    const close = () => {
      if (run) {
        let s = 90, n = -90, ww = 180, e = -180;
        for (const p of run) { if (p[0] < s) s = p[0]; if (p[0] > n) n = p[0]; if (p[1] < ww) ww = p[1]; if (p[1] > e) e = p[1]; }
        (runLeft ? this.runs : this.doneRuns).push({ id: w.id, ll: run, m: runM, s, n, w: ww, e });
      }
      run = null; runM = 0;
    };
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1], b = g[i];
      const edgeM = Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * ky);
      const pieces = Math.max(1, Math.ceil(edgeM / PIECE_M)), pieceM = edgeM / pieces;
      for (let p = 0; p < pieces; p++) {
        const tm = (p + 0.5) / pieces;
        const left = this.isNew(a.lon + (b.lon - a.lon) * tm, a.lat + (b.lat - a.lat) * tm, DONE_WITHIN_M);
        if (run && left !== runLeft) close();
        if (!run) {
          const t0 = p / pieces;
          runLeft = left;
          run = [[a.lat + (b.lat - a.lat) * t0, a.lon + (b.lon - a.lon) * t0]];
        }
        const t1 = (p + 1) / pieces;
        run.push([a.lat + (b.lat - a.lat) * t1, a.lon + (b.lon - a.lon) * t1]);
        runM += pieceM;
      }
    }
    close();
  };

  // Draw the runs near the view (a margin so a small pan doesn't show edges).
  StreetsLeftLayer.prototype._draw = function () {
    const b = this.map.getBounds().pad(0.2);
    const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
    // a way we haven't classified yet counts as usable, so nothing fades in late
    const usable = (id) => !this.travelClass || !this.streets.classified.has(id) ||
      this.streets.classIds[this.travelClass].has(id);
    const shown = [], faint = [];
    for (const r of this.runs)
      if (r.m >= MIN_RUN_M && r.n >= s && r.s <= n && r.e >= w && r.w <= e) (usable(r.id) ? shown : faint).push(r.ll);
    this._restyle();
    this.dim.setLatLngs(faint);
    this.halo.setLatLngs(shown);
    this.core.setLatLngs(shown);
    if (this.onStats) this.onStats();
  };

  global.StreetsLeftLayer = StreetsLeftLayer;
})(window);
