// Street-aware reward data for route suggestions ("Tier 2").
// Fetches street geometry for small areas from Overpass (OpenStreetMap) and
// answers one question: how much AREA could still be defogged by travelling
// the ways within reach of a point? Each way segment is weighted by the share
// of its ~30 m corridor that is still fogged, so a lone path through virgin
// meadow (huge corridor gain) outscores its low street-metre count, and a
// half-rewalked grid doesn't get overcounted. Raw fog alone can't tell a
// street grid from a lake; street metres alone can't tell a rich meadow path
// from a rewalked alley. Privacy: Overpass only ever sees bounding boxes, the
// same class of information the basemap tile servers already get. The fog
// itself never leaves the device (segments are scored against it locally).
(function (global) {
  const OVERPASS = "https://overpass-api.de/api/interpreter";
  // Streets someone would plausibly cover on foot vs on a bike. Driveways and
  // parking aisles are excluded: they're numerous and nobody hunts them.
  const RUN_HW = "residential|unclassified|tertiary|secondary|primary|living_street|track|path|footway|cycleway|pedestrian";
  const BIKE_HW = "residential|unclassified|tertiary|secondary|primary|living_street|cycleway|track";
  const SEG_M = 50;              // ways are chopped into ~50 m scoring segments
  const GRID_M = 250;            // spatial bin size for radius queries
  const MAX_SEGS = 400000;       // memory guard (~40 MB worst case)
  const CORRIDOR_M = 30;         // full width Fog of World clears as you travel

  function StreetIndex(opts) {
    this.newFrac = opts.newFrac; // (lon,lat) -> 0..1 share of the corridor stamp still fogged
    this.segs = new Map();       // "gx,gy" -> [{x,y,lon,lat,lenM,isNew}]
    this.rects = [];             // fetched coverage, [{s,w,n,e}]
    this.wayIds = new Set();     // dedupe across overlapping fetches
    this.segCount = 0;
    this.kx = null; this.ky = 110540; // metre frame, anchored on first fetch
  }

  StreetIndex.prototype._anchor = function (lat) {
    if (this.kx === null) this.kx = 111320 * Math.cos(lat * Math.PI / 180);
  };

  StreetIndex.prototype.covered = function (lat, lng) {
    return this.rects.some((r) => lat >= r.s && lat <= r.n && lng >= r.w && lng <= r.e);
  };

  StreetIndex.prototype._addWay = function (w) {
    if (!w.geometry || w.geometry.length < 2 || this.wayIds.has(w.id)) return;
    this.wayIds.add(w.id);
    for (let i = 1; i < w.geometry.length && this.segCount < MAX_SEGS; i++) {
      const a = w.geometry[i - 1], b = w.geometry[i];
      const ax = a.lon * this.kx, ay = a.lat * this.ky;
      const bx = b.lon * this.kx, by = b.lat * this.ky;
      const edgeM = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.round(edgeM / SEG_M));
      for (let s = 0; s < n; s++) {
        const t = (s + 0.5) / n;
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        const key = Math.floor(x / GRID_M) + "," + Math.floor(y / GRID_M);
        let cell = this.segs.get(key);
        if (!cell) this.segs.set(key, (cell = []));
        cell.push({ x, y, lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t, lenM: edgeM / n, frac: null });
        this.segCount++;
      }
    }
  };

  // Fetch streets for the given rects (skipping ones already covered), one
  // Overpass query. kind: "run" | "bike". Throws on failure; callers fall back
  // to fog-only scoring, suggestions must keep working without street data.
  StreetIndex.prototype.ensureRects = async function (rects, kind) {
    const todo = rects.filter((r) =>
      !this.rects.some((o) => r.s >= o.s && r.n <= o.n && r.w >= o.w && r.e <= o.e));
    if (!todo.length) return;
    this._anchor(todo[0].s);
    const hw = kind === "bike" ? BIKE_HW : RUN_HW;
    const bb = (r) => [r.s, r.w, r.n, r.e].map((x) => x.toFixed(4)).join(",");
    const clauses = todo.map((r) =>
      `way[highway~"^(${hw})$"](${bb(r)});way[highway=service][service!~"^(driveway|parking_aisle)$"](${bb(r)});`).join("");
    const q = `[out:json][timeout:60];(${clauses});out skel geom;`;
    const res = await fetch(OVERPASS, {
      method: "POST",
      // UA is for the Node benchmark harness (Overpass rejects Node's default);
      // browsers filter the header out as forbidden, which is fine.
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "FogToMaps/1.0 (defog route suggestions)" },
      body: "data=" + encodeURIComponent(q)
    });
    if (!res.ok) throw new Error("overpass HTTP " + res.status);
    const gj = await res.json();
    for (const el of gj.elements || []) if (el.type === "way") this._addWay(el);
    this.rects.push(...todo);
  };

  // Convenience: coverage discs of radius rM around a list of L.latLng points.
  StreetIndex.prototype.ensureDiscs = function (points, rM, kind) {
    const rects = points.map((p) => {
      const kx = 111320 * Math.cos(p.lat * Math.PI / 180);
      return { s: p.lat - rM / 110540, n: p.lat + rM / 110540, w: p.lng - rM / kx, e: p.lng + rM / kx };
    });
    return this.ensureRects(rects, kind);
  };

  // Defoggable area (m²) reachable by travelling the ways within rM of the
  // point: sum of segment length x corridor width x still-fogged share of the
  // corridor. Segments are scored against the fog lazily and cached (the fog
  // is static while planning). Only meaningful where covered() is true.
  StreetIndex.prototype.newAreaM2 = function (latlng, rM) {
    if (this.kx === null) return 0;
    const px = latlng.lng * this.kx, py = latlng.lat * this.ky;
    const g0x = Math.floor((px - rM) / GRID_M), g1x = Math.floor((px + rM) / GRID_M);
    const g0y = Math.floor((py - rM) / GRID_M), g1y = Math.floor((py + rM) / GRID_M);
    const r2 = rM * rM;
    let m2 = 0;
    for (let gy = g0y; gy <= g1y; gy++) for (let gx = g0x; gx <= g1x; gx++) {
      const cell = this.segs.get(gx + "," + gy);
      if (!cell) continue;
      for (const s of cell) {
        const dx = s.x - px, dy = s.y - py;
        if (dx * dx + dy * dy > r2) continue;
        if (s.frac === null) s.frac = this.newFrac(s.lon, s.lat);
        // linear frac deliberately: sqrt (softer on rewalked grids) and raw
        // street metres both benchmarked worse; length x fogged-share is also
        // exactly the quantity computeGain rewards
        m2 += s.lenM * CORRIDOR_M * s.frac;
      }
    }
    return m2;
  };

  global.StreetIndex = StreetIndex;
})(window);
