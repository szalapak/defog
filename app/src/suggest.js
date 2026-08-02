// "Surprise me" routing: suggest up to 3 point-to-point routes that maximise defogging.
// Candidates come from two sources — BRouter's own alternatives (alternativeidx 1..3) and
// fog-seeking via-points sampled inside the length budget (baseline + 15%) — then every
// candidate is scored client-side with the caller's defog-gain function. The fog itself
// never leaves the device; only waypoint coordinates go to BRouter, same as manual drawing.
(function (global) {
  const BROUTER = "https://brouter.de/brouter";
  const BUFFER = 1.15;      // candidates may be up to 15% longer than the baseline route
  const MAX_VIAS = 6;       // fog-seeking detour candidates per run (each is one BRouter call)
  const CONCURRENCY = 3;    // parallel BRouter requests (be kind to the public server)
  const COLORS = ["#40639c", "#68509f", "#3f7d6d"]; // muted blue · purple · teal previews

  function pinIcon(cls, label) {
    const COARSE = !!(global.matchMedia && global.matchMedia("(pointer: coarse)").matches);
    const sz = COARSE ? 26 : 18;
    return L.divIcon({ className: "", html: '<div class="wp ' + cls + '">' + label + "</div>", iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
  }

  function SuggestTool(map, opts) {
    this.map = map;
    this.fogMap = opts.fogMap;
    this.computeGain = opts.computeGain;   // (coords) -> { area, newPct } | null
    this.onPoints = opts.onPoints || null; // (count) -> UI update
    this.onResults = opts.onResults || null; // (state|null) -> render progress/cards
    this.a = null; this.b = null;          // start / end markers
    this.active = false;
    this.results = [];                     // top candidates of the last run
    this.lines = [];                       // their preview polylines
    this.selected = -1;
    this._runId = 0;
    this._onClick = (e) => this._place(e.latlng);
  }

  SuggestTool.prototype.setActive = function (on) {
    this.active = on;
    if (on) this.map.on("click", this._onClick);
    else this.map.off("click", this._onClick);
    this.map.getContainer().style.cursor = on ? "crosshair" : "";
  };

  SuggestTool.prototype.pointCount = function () { return (this.a ? 1 : 0) + (this.b ? 1 : 0); };

  SuggestTool.prototype._place = function (latlng) {
    if (this.a && this.b) return; // both set — drag the pins to adjust
    const isA = !this.a;
    const m = L.marker(latlng, { draggable: true, icon: pinIcon(isA ? "sugA" : "sugB", isA ? "A" : "B") }).addTo(this.map);
    m.on("dragend", () => this.clearResults());
    m.on("click", (e) => { L.DomEvent.stop(e); this._removePin(m); });
    if (isA) this.a = m; else this.b = m;
    this.clearResults();
    if (this.onPoints) this.onPoints(this.pointCount());
  };

  SuggestTool.prototype._removePin = function (m) {
    this.map.removeLayer(m);
    if (this.a === m) this.a = null; else if (this.b === m) this.b = null;
    this.clearResults();
    if (this.onPoints) this.onPoints(this.pointCount());
  };

  SuggestTool.prototype.reset = function () {
    if (this.a) this.map.removeLayer(this.a);
    if (this.b) this.map.removeLayer(this.b);
    this.a = this.b = null;
    this.clearResults();
    if (this.onPoints) this.onPoints(0);
  };

  SuggestTool.prototype.clearResults = function () {
    this._runId++; // cancels any in-flight run
    this.lines.forEach((l) => this.map.removeLayer(l));
    this.lines = []; this.results = []; this.selected = -1;
    if (this.onResults) this.onResults(null);
  };

  SuggestTool.prototype.select = function (i) {
    this.selected = i;
    this.lines.forEach((l, k) => l.setStyle(k === i ? { weight: 6, opacity: 0.95 } : { weight: 4, opacity: 0.35 }));
  };

  // Waypoints that reproduce candidate i in the ordinary route editor. Via candidates are
  // exact (same request); BRouter alternatives are approximated by pinning their midpoint.
  SuggestTool.prototype.adopt = function (i) {
    const c = this.results[i];
    if (!c) return null;
    const wps = c.adoptWps.slice();
    this.clearResults();
    return wps;
  };

  // ----- candidate generation ---------------------------------------------------

  SuggestTool.prototype._route = async function (latlngs, profile, altIdx) {
    const lonlats = latlngs.map((ll) => ll.lng.toFixed(6) + "," + ll.lat.toFixed(6)).join("|");
    const url = `${BROUTER}?lonlats=${lonlats}&profile=${encodeURIComponent(profile)}&alternativeidx=${altIdx}&format=geojson`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const gj = await res.json();
      const feat = gj.features && gj.features[0];
      if (!feat) return null;
      const coords = feat.geometry.coordinates;
      let asc = 0, desc = 0;
      for (let i = 1; i < coords.length; i++) {
        const d = (coords[i][2] || 0) - (coords[i - 1][2] || 0);
        if (d > 0) asc += d; else desc -= d;
      }
      return { coords, lenM: parseInt(feat.properties["track-length"], 10) || 0, ascent: Math.round(asc), descent: Math.round(desc) };
    } catch (e) { return null; }
  };

  // Share of never-visited cells within ~100 m of a point — used to skip via candidates
  // that sit in ground the user has already covered.
  SuggestTool.prototype._newness = function (latlng) {
    if (!this.fogMap.tileCount) return 1;
    const cellM = (40075016.686 / FogParser.WORLD_CELLS) * Math.cos(latlng.lat * Math.PI / 180);
    const r = Math.min(15, Math.max(2, Math.round(100 / cellM)));
    const c = FogParser.lngLatToCell(latlng.lng, latlng.lat);
    const cx0 = Math.floor(c.cx), cy0 = Math.floor(c.cy);
    let visited = 0, total = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      total++;
      if (this.fogMap.isVisitedCell(cx0 + dx, cy0 + dy)) visited++;
    }
    return 1 - visited / total;
  };

  // Largest perpendicular offset at fraction t along A→B whose straight-line via-path still
  // fits the budget (a lower bound on the routed length, so a safe outer limit).
  function dmax(t, L, budget) {
    let lo = 0, hi = budget;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (Math.hypot(t * L, mid) + Math.hypot((1 - t) * L, mid) <= budget) lo = mid; else hi = mid;
    }
    return lo;
  }

  SuggestTool.prototype._viaCandidates = function (budgetM) {
    const A = this.a.getLatLng(), B = this.b.getLatLng();
    const lat0 = (A.lat + B.lat) / 2;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540; // deg -> local metres
    const ax = A.lng * kx, ay = A.lat * ky, bx = B.lng * kx, by = B.lat * ky;
    const L2 = Math.hypot(bx - ax, by - ay);
    if (L2 < 100) return [];
    const px = -(by - ay) / L2, py = (bx - ax) / L2; // unit perpendicular
    const cands = [];
    for (const t of [0.3, 0.5, 0.7]) {
      // 0.85: real roads are longer than the straight-line bound, so aim inside it
      const dm = dmax(t, L2, budgetM) * 0.85;
      for (const side of [1, -1]) {
        for (const scale of (t === 0.5 ? [1, 0.55] : [1])) {
          const d = dm * scale;
          if (d < 150) continue; // not a meaningful detour
          const x = ax + (bx - ax) * t + px * side * d;
          const y = ay + (by - ay) * t + py * side * d;
          const ll = L.latLng(y / ky, x / kx);
          cands.push({ latlng: ll, newness: this._newness(ll) });
        }
      }
    }
    return cands
      .filter((c) => c.newness >= 0.35) // skip detours into already-covered ground
      .sort((a, b) => b.newness - a.newness)
      .slice(0, MAX_VIAS);
  };

  // Coarse geometry fingerprint (8 sampled points on a ~100 m grid) to drop near-duplicates —
  // e.g. a via candidate that snapped onto the same roads as a BRouter alternative.
  function sig(coords) {
    const out = [];
    for (let i = 0; i < 8; i++) {
      const p = coords[Math.min(coords.length - 1, Math.round((i / 7) * (coords.length - 1)))];
      out.push(Math.round(p[0] * 1000) + "," + Math.round(p[1] * 1000));
    }
    return out;
  }
  function sameSig(s1, s2) {
    let m = 0;
    for (let i = 0; i < 8; i++) if (s1[i] === s2[i]) m++;
    return m >= 7;
  }

  // ----- the run ----------------------------------------------------------------

  SuggestTool.prototype.suggest = async function (profile) {
    if (!this.a || !this.b) return;
    this.clearResults();
    const runId = this._runId;
    const stale = () => runId !== this._runId;
    const emit = (s) => { if (!stale() && this.onResults) this.onResults(s); };
    const A = this.a.getLatLng(), B = this.b.getLatLng();

    emit({ loading: true, phase: "baseline" });
    const base = await this._route([A, B], profile, 0);
    if (stale()) return;
    if (!base) { emit({ error: true }); return; }
    const budget = base.lenM * BUFFER;

    // candidate jobs: BRouter's alternatives + our fog-seeking via-points
    const jobs = [];
    for (let idx = 1; idx <= 3; idx++)
      jobs.push({ adoptKind: "alt", run: () => this._route([A, B], profile, idx) });
    for (const v of this._viaCandidates(budget))
      jobs.push({ adoptKind: "via", via: v.latlng, run: () => this._route([A, v.latlng, B], profile, 0) });

    let done = 0;
    const total = jobs.length;
    emit({ loading: true, phase: "detours", done, total });
    const routes = [];
    let next = 0;
    const worker = async () => {
      while (next < jobs.length && !stale()) {
        const job = jobs[next++];
        const r = await job.run();
        if (stale()) return;
        done++;
        emit({ loading: true, phase: "detours", done, total });
        if (r && r.lenM > 0 && r.lenM <= budget) routes.push({ job, r });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
    if (stale()) return;

    // score everything (baseline included), dedupe, rank by defogged area
    const all = [{ job: { adoptKind: "base" }, r: base }].concat(routes);
    const scored = [];
    for (const c of all) {
      const s = sig(c.r.coords);
      if (scored.some((o) => sameSig(o.s, s))) continue;
      const gain = this.computeGain(c.r.coords) || { area: 0, newPct: 0 };
      const mid = c.r.coords[Math.floor(c.r.coords.length / 2)];
      const adoptWps =
        c.job.adoptKind === "via" ? [A, c.job.via, B] :
        c.job.adoptKind === "alt" ? [A, L.latLng(mid[1], mid[0]), B] : [A, B];
      scored.push({ s, r: c.r, gain, adoptWps, isBase: c.job.adoptKind === "base" });
    }
    scored.sort((x, y) => y.gain.area - x.gain.area);
    this.results = scored.slice(0, 3);

    this.lines = this.results.map((c, i) =>
      L.polyline(c.r.coords.map((p) => [p[1], p[0]]), { color: COLORS[i], weight: 4, opacity: 0.85 }).addTo(this.map));
    if (this.lines.length) {
      let bounds = this.lines[0].getBounds();
      this.lines.forEach((l) => { bounds = bounds.extend(l.getBounds()); });
      this.map.fitBounds(bounds, { padding: [30, 30] });
      this.select(0); // best option pre-selected before the cards render
    }
    emit({
      baseKm: base.lenM / 1000,
      list: this.results.map((c, i) => ({
        color: COLORS[i],
        km: c.r.lenM / 1000,
        deltaKm: (c.r.lenM - base.lenM) / 1000,
        ascent: c.r.ascent, descent: c.r.descent,
        area: c.gain.area, newPct: c.gain.newPct,
        isBase: c.isBase
      }))
    });
  };

  global.SuggestTool = SuggestTool;
})(window);
