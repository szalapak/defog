// "Surprise me" routing: suggest up to 3 routes that maximise defogging.
// Two modes — point-to-point (A → B) and loop (start + target distance).
// Candidates come from BRouter (its own alternatives, plus fog-seeking via-points /
// fog-biased loop bearings we generate) and every candidate is scored client-side with
// the caller's defog-gain function. The fog itself never leaves the device; only
// waypoint coordinates go to BRouter, same as manual drawing.
(function (global) {
  const BROUTER = "https://brouter.de/brouter";
  const DEFAULT_BUFFER = 0.15;  // p2p: max length over baseline; loop: tolerance around target
  const MAX_VIAS = 6;           // fog-seeking detour candidates per p2p run
  const MAX_LOOPS = 6;          // loop bearings tried per run
  const CONCURRENCY = 3;        // parallel BRouter requests (be kind to the public server)
  // Muted crimson · terracotta · berry — same warm family as the drawn route,
  // deliberately far from the blue/purple/slate fog swatches.
  const COLORS = ["#d6455f", "#e0813f", "#a34a6b"];

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
    this.mode = "p2p";                     // "p2p" | "loop"
    this.a = null; this.b = null;          // start / end markers (loop uses only a)
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

  SuggestTool.prototype.setMode = function (m) {
    if (this.mode === m) return;
    this.mode = m;
    if (m === "loop" && this.b) { this.map.removeLayer(this.b); this.b = null; }
    this.clearResults();
    if (this.onPoints) this.onPoints(this.pointCount());
  };

  SuggestTool.prototype.pointCount = function () { return (this.a ? 1 : 0) + (this.b ? 1 : 0); };
  SuggestTool.prototype.pointsNeeded = function () { return this.mode === "loop" ? 1 : 2; };

  SuggestTool.prototype._place = function (latlng) {
    if (this.a && (this.mode === "loop" || this.b)) return; // all pins set — drag to adjust
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

  // Waypoints that reproduce candidate i in the ordinary route editor. Via and loop
  // candidates are exact (same request); BRouter alternatives are approximated by
  // pinning their midpoint.
  SuggestTool.prototype.adopt = function (i) {
    const c = this.results[i];
    if (!c) return null;
    const wps = c.adoptWps.slice();
    this.clearResults();
    return wps;
  };

  // ----- shared plumbing --------------------------------------------------------

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

  // Share of never-visited cells within ~100 m of a point — used to steer candidates
  // away from ground the user has already covered.
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

  // deg -> local metres around a latitude
  function metresPerDeg(lat) {
    return { kx: 111320 * Math.cos(lat * Math.PI / 180), ky: 110540 };
  }

  // Run jobs (thunks returning a promise) through a small worker pool, reporting progress.
  SuggestTool.prototype._pool = async function (jobs, stale, onTick) {
    const out = [];
    let next = 0, done = 0;
    const worker = async () => {
      while (next < jobs.length && !stale()) {
        const j = jobs[next++];
        const r = await j();
        if (stale()) return;
        done++;
        onTick(done);
        if (r) out.push(r);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
    return out;
  };

  // Score, dedupe, rank and present the top 3 of a run.
  SuggestTool.prototype._finish = function (runId, cands, extra) {
    if (runId !== this._runId) return;
    const emit = (s) => { if (this.onResults) this.onResults(s); };
    if (!cands.length) { emit(Object.assign({ empty: true }, extra)); return; }
    const scored = [];
    for (const c of cands) {
      const s = sig(c.r.coords);
      if (scored.some((o) => sameSig(o.s, s))) continue;
      const gain = this.computeGain(c.r.coords) || { area: 0, newPct: 0 };
      scored.push(Object.assign({ s, gain }, c));
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
    const refKm = extra.baseKm != null ? extra.baseKm : extra.targetKm;
    emit(Object.assign({}, extra, {
      list: this.results.map((c, i) => ({
        color: COLORS[i],
        km: c.r.lenM / 1000,
        deltaKm: c.r.lenM / 1000 - refKm,
        ascent: c.r.ascent, descent: c.r.descent,
        area: c.gain.area, newPct: c.gain.newPct,
        isBase: !!c.isBase
      }))
    }));
  };

  SuggestTool.prototype.suggest = function (profile, o) {
    o = o || {};
    const buffer = o.buffer || DEFAULT_BUFFER;
    if (this.mode === "loop") return this._suggestLoop(profile, o.distM, buffer);
    return this._suggestP2P(profile, buffer);
  };

  // ----- point-to-point ---------------------------------------------------------

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
    const { kx, ky } = metresPerDeg((A.lat + B.lat) / 2);
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

  SuggestTool.prototype._suggestP2P = async function (profile, buffer) {
    if (!this.a || !this.b) return;
    this.clearResults();
    const runId = this._runId;
    const stale = () => runId !== this._runId;
    const emit = (s) => { if (!stale() && this.onResults) this.onResults(s); };
    const A = this.a.getLatLng(), B = this.b.getLatLng();
    const bufferPct = Math.round(buffer * 100);

    emit({ loading: true, phase: "baseline" });
    const base = await this._route([A, B], profile, 0);
    if (stale()) return;
    if (!base) { emit({ error: true }); return; }
    const budget = base.lenM * (1 + buffer);

    // candidate jobs: BRouter's alternatives + our fog-seeking via-points
    const jobs = [];
    for (let idx = 1; idx <= 3; idx++)
      jobs.push(async () => {
        const r = await this._route([A, B], profile, idx);
        if (!r || !r.lenM || r.lenM > budget) return null;
        const mid = r.coords[Math.floor(r.coords.length / 2)];
        return { r, adoptWps: [A, L.latLng(mid[1], mid[0]), B] };
      });
    for (const v of this._viaCandidates(budget))
      jobs.push(async () => {
        const r = await this._route([A, v.latlng, B], profile, 0);
        if (!r || !r.lenM || r.lenM > budget) return null;
        return { r, adoptWps: [A, v.latlng, B] };
      });

    const total = jobs.length;
    emit({ loading: true, phase: "detours", done: 0, total });
    const found = await this._pool(jobs, stale, (done) => emit({ loading: true, phase: "detours", done, total }));
    if (stale()) return;
    found.unshift({ r: base, adoptWps: [A, B], isBase: true });
    this._finish(runId, found, { baseKm: base.lenM / 1000, bufferPct });
  };

  // ----- loops ------------------------------------------------------------------

  // Rank compass bearings by how foggy the ground out that way is: sample newness at two
  // ranges along each of 12 bearings, then greedily pick well-separated winners.
  SuggestTool.prototype._loopBearings = function (S, distM) {
    const { kx, ky } = metresPerDeg(S.lat);
    const at = (thDeg, m) => {
      const th = thDeg * Math.PI / 180;
      return L.latLng(S.lat + (Math.cos(th) * m) / ky, S.lng + (Math.sin(th) * m) / kx);
    };
    const scored = [];
    for (let b = 0; b < 360; b += 30)
      scored.push({ b, score: (this._newness(at(b, distM * 0.25)) + this._newness(at(b, distM * 0.4))) / 2 });
    scored.sort((x, y) => y.score - x.score);
    const picked = [];
    for (const s of scored) {
      if (picked.length >= MAX_LOOPS) break;
      const sep = (a, b2) => { const d = Math.abs(a - b2) % 360; return Math.min(d, 360 - d); };
      if (picked.every((p) => sep(p, s.b) >= 45)) picked.push(s.b);
    }
    return picked;
  };

  // Equilateral-ish triangle S → v1 → v2 → S out along a bearing. side is the triangle
  // edge in metres; vias sit at bearing ±30° so the straight perimeter is 3·side.
  SuggestTool.prototype._loopVias = function (S, bearingDeg, side) {
    const { kx, ky } = metresPerDeg(S.lat);
    const at = (thDeg) => {
      const th = thDeg * Math.PI / 180;
      return L.latLng(S.lat + (Math.cos(th) * side) / ky, S.lng + (Math.sin(th) * side) / kx);
    };
    return [at(bearingDeg - 30), at(bearingDeg + 30)];
  };

  SuggestTool.prototype._suggestLoop = async function (profile, distM, buffer) {
    if (!this.a || !distM) return;
    this.clearResults();
    const runId = this._runId;
    const stale = () => runId !== this._runId;
    const emit = (s) => { if (!stale() && this.onResults) this.onResults(s); };
    const S = this.a.getLatLng();
    const bufferPct = Math.round(buffer * 100);
    const inTol = (lenM) => Math.abs(lenM - distM) <= buffer * distM;

    const bearings = this._loopBearings(S, distM);
    const total = bearings.length;
    emit({ loading: true, phase: "loops", done: 0, total });

    // 3.75: roads inflate the straight triangle by ~25%, so start with perimeter = D/1.25.
    // If the routed loop misses the tolerance, retry once with a proportionally scaled triangle.
    const jobs = bearings.map((bearing) => async () => {
      let side = distM / 3.75;
      let vias = this._loopVias(S, bearing, side);
      let r = await this._route([S, vias[0], vias[1], S], profile, 0);
      if (r && r.lenM && !inTol(r.lenM)) {
        side *= Math.min(2.5, Math.max(0.4, distM / r.lenM));
        const vias2 = this._loopVias(S, bearing, side);
        const r2 = await this._route([S, vias2[0], vias2[1], S], profile, 0);
        if (r2 && r2.lenM && Math.abs(r2.lenM - distM) < Math.abs(r.lenM - distM)) { r = r2; vias = vias2; }
      }
      if (!r || !r.lenM || !inTol(r.lenM)) return null;
      return { r, adoptWps: [S, vias[0], vias[1], S] };
    });

    const found = await this._pool(jobs, stale, (done) => emit({ loading: true, phase: "loops", done, total }));
    if (stale()) return;
    this._finish(runId, found, { targetKm: distM / 1000, bufferPct });
  };

  global.SuggestTool = SuggestTool;
})(window);
