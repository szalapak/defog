// "Surprise me" routing: suggest up to 3 routes that maximise defogging.
// Two modes: point-to-point (A → B) and loop (start + target distance).
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
  // Same neon family as the drawn route (#ff2d55): red · pink · orange, which pops against
  // the fog, deliberately far from the blue/purple/slate fog swatches.
  const COLORS = ["#ff2d55", "#ff4fa3", "#ff8c2d"];

  function pinIcon(cls, label) {
    const COARSE = !!(global.matchMedia && global.matchMedia("(pointer: coarse)").matches);
    const sz = COARSE ? 26 : 18;
    return L.divIcon({ className: "", html: '<div class="wp ' + cls + '">' + label + "</div>", iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
  }

  function SuggestTool(map, opts) {
    this.map = map;
    this.fogMap = opts.fogMap;
    this.computeGain = opts.computeGain;   // (coords) -> { area, newPct } | null
    this.isNew = opts.isNew || null;       // (lon,lat) -> true if the point is new ground
    this.streets = opts.streets || null;   // StreetIndex; candidates chase undefogged streets
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
    if (this.a && (this.mode === "loop" || this.b)) return; // all pins set, drag to adjust
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
    this.lines.forEach((l) => { this.map.removeLayer(l.solid); this.map.removeLayer(l.dashed); });
    this.lines = []; this.results = []; this.selected = -1;
    if (this.onResults) this.onResults(null);
  };

  SuggestTool.prototype.select = function (i) {
    this.selected = i;
    this.lines.forEach((l, k) => {
      const sel = k === i;
      l.solid.setStyle({ weight: sel ? 6 : 4, opacity: sel ? 0.95 : 0.65 });
      l.dashed.setStyle({ weight: sel ? 4.5 : 3, opacity: sel ? 0.9 : 0.55 });
    });
  };

  // Same split as the drawn route: solid runs where the route breaks new ground,
  // dashed ("hatched") runs where it crosses ground that's already defogged.
  function splitRuns(coords, isNew) {
    const newRuns = [], oldRuns = [];
    let cur = null, run = null;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const isN = isNew ? isNew((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) : true;
      if (cur === null) { cur = isN; run = [[a[1], a[0]]]; }
      else if (isN !== cur) { (cur ? newRuns : oldRuns).push(run); cur = isN; run = [[a[1], a[0]]]; }
      run.push([b[1], b[0]]);
    }
    if (run) (cur ? newRuns : oldRuns).push(run);
    return { newRuns, oldRuns };
  }

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

  // Share of never-visited cells within ~100 m of a point, used to steer candidates
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

  // Coarse geometry fingerprint (8 sampled points on a ~100 m grid) to drop near-duplicates,
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

  // Which street classes matter: on foot everything walkable, on wheels not
  // footways/paths (also keeps the bigger bike-range downloads sane).
  function streetKind(profile) { return profile === "hiking-mountain" ? "run" : "bike"; }

  // The graph planner searches the fetched street network directly for high-
  // defog loops and walks. Built lazily, rebuilt only when new streets arrive.
  SuggestTool.prototype._getPlanner = function () {
    if (!this.streets || !global.GraphPlanner || !this.streets.ways.length) return null;
    if (!this._planner) this._planner = new global.GraphPlanner(this.streets, this.streets.newFrac);
    return this._planner;
  };

  // Defoggable area (m²) reachable via the ways within rM of the point, or
  // null where street data doesn't cover it. Null means: fall back to fog-only
  // scoring. Raw fog can't tell a street grid from a lake; this can, and it is
  // area-weighted so a lone path through virgin meadow scores what it's worth.
  SuggestTool.prototype._newAreaM2 = function (latlng, rM) {
    if (!this.streets || !this.streets.covered(latlng.lat, latlng.lng)) return null;
    return this.streets.newAreaM2(latlng, rM);
  };

  // Pull a generation via to the most undefogged-street-rich spot within reach,
  // so loops are born aimed at fogged streets instead of hoping BRouter finds
  // them. The current spot keeps a bias and distance discounts a candidate, so
  // the loop holds roughly its intended shape and length.
  SuggestTool.prototype._snapToNewStreets = function (ll, radiusM) {
    const base = this._newAreaM2(ll, 200);
    if (base === null || radiusM < 200) return ll;
    const { kx, ky } = metresPerDeg(ll.lat);
    // gentle keep-bias: in dense areas scores are high everywhere, so a strong
    // bias (tried 1.15) freezes every via in place and the snapping no-ops
    let best = ll, bs = base * 1.05 + 600;
    const step = Math.max(150, radiusM / 3);
    for (let dy = -radiusM; dy <= radiusM; dy += step) {
      for (let dx = -radiusM; dx <= radiusM; dx += step) {
        if (!dx && !dy) continue;
        const p = L.latLng(ll.lat + dy / ky, ll.lng + dx / kx);
        const m = this._newAreaM2(p, 200);
        if (m === null) continue;
        const s = m * (1 - Math.hypot(dx, dy) / (radiusM * 2.2));
        if (s > bs) { bs = s; best = p; }
      }
    }
    return best;
  };

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
    // Score first, rank, THEN dedupe, because near-identical routes must collapse onto the
    // best-gaining of the pair, not whichever happened to be scored first.
    let scored = cands.map((c) => Object.assign({
      s: sig(c.r.coords),
      gain: this.computeGain(c.r.coords) || { area: 0, newPct: 0 }
    }, c));
    // a route that breaks <1% new ground isn't a suggestion, it's a re-walk
    scored = scored.filter((c) => c.gain.area > 0 && c.gain.newPct >= 1);
    if (!scored.length) { emit(Object.assign({ empty: true, reason: "defogged" }, extra)); return; }
    // rank by area, blended with share-of-length-on-new-ground: between two
    // routes that defog the same area, the one that isn't mostly a re-walk wins
    const key = (c) => c.gain.area * (0.7 + 0.3 * Math.min(1, c.gain.newPct / 100));
    scored.sort((x, y) => key(y) - key(x));
    const unique = [];
    for (const c of scored) {
      if (unique.some((o) => sameSig(o.s, c.s))) continue;
      unique.push(c);
    }
    this.results = unique.slice(0, 3);

    this.lines = this.results.map((c, i) => {
      const runs = splitRuns(c.r.coords, this.isNew);
      return {
        solid: L.polyline(runs.newRuns, { color: COLORS[i], weight: 4, opacity: 0.65 }).addTo(this.map),
        dashed: L.polyline(runs.oldRuns, { color: COLORS[i], weight: 3, opacity: 0.55, dashArray: "2 8", lineCap: "round" }).addTo(this.map)
      };
    });
    if (this.lines.length) {
      let bounds = null;
      this.results.forEach((c) => c.r.coords.forEach((p) => {
        bounds = bounds ? bounds.extend([p[1], p[0]]) : L.latLngBounds([p[1], p[0]], [p[1], p[0]]);
      }));
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

  // Point at fraction t along A→B, offset d metres perpendicular on the given side.
  SuggestTool.prototype._viaPoint = function (t, side, d) {
    const A = this.a.getLatLng(), B = this.b.getLatLng();
    const { kx, ky } = metresPerDeg((A.lat + B.lat) / 2);
    const ax = A.lng * kx, ay = A.lat * ky, bx = B.lng * kx, by = B.lat * ky;
    const L2 = Math.hypot(bx - ax, by - ay);
    if (L2 < 100) return null;
    const px = -(by - ay) / L2, py = (bx - ax) / L2;
    return L.latLng((ay + (by - ay) * t + py * side * d) / ky, (ax + (bx - ax) * t + px * side * d) / kx);
  };

  SuggestTool.prototype._viaCandidates = function (budgetM) {
    const A = this.a.getLatLng(), B = this.b.getLatLng();
    const { kx, ky } = metresPerDeg((A.lat + B.lat) / 2);
    const L2 = Math.hypot((B.lng - A.lng) * kx, (B.lat - A.lat) * ky);
    if (L2 < 100) return [];
    const cands = [];
    for (const t of [0.3, 0.5, 0.7]) {
      // 0.85: real roads are longer than the straight-line bound, so aim inside it
      const dm = dmax(t, L2, budgetM) * 0.85;
      for (const side of [1, -1]) {
        for (const scale of [1, 0.5]) { // full and medium detours at every station
          const d = dm * scale;
          if (d < 150) continue; // not a meaningful detour
          const ll = this._viaPoint(t, side, d);
          cands.push({ latlng: ll, scale, t, side, d });
        }
      }
    }
    return cands;
  };

  // Rank via candidates by defoggable area via ways within 350 m when street
  // data covers them all, by fog newness otherwise.
  // Rank within each detour size, then take half from each. Far offsets always
  // look richer but often route over the length budget; medium ones fit reliably, and
  // ranking them together would spend the whole request budget on the far side.
  SuggestTool.prototype._pickVias = function (cands) {
    for (const c of cands) {
      c.areaM2 = this._newAreaM2(c.latlng, 350);
      if (c.areaM2 === null) c.newness = this._newness(c.latlng);
    }
    const street = cands.length > 0 && cands.every((c) => c.areaM2 !== null);
    // floors: below ~2000 m² reachable (or 5% new fog) a detour isn't worth a request
    const ok = (c) => (street ? c.areaM2 >= 2000 : c.newness >= 0.05);
    const val = (c) => (street ? c.areaM2 : c.newness);
    const rank = (sc) => cands.filter((c) => c.scale === sc && ok(c))
      .sort((a, b) => val(b) - val(a));
    const full = rank(1), med = rank(0.5);
    const take = Math.ceil(MAX_VIAS / 2);
    const picked = full.slice(0, take).concat(med.slice(0, take));
    // top up from whichever side has leftovers if the other ran short
    for (const c of full.slice(take).concat(med.slice(take)))
      if (picked.length < MAX_VIAS) picked.push(c);
    return picked.slice(0, MAX_VIAS);
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

    // Fetch street data so candidates can chase undefogged streets. Short
    // trips get one rect covering everywhere the budget could reach, which
    // also feeds the graph planner; longer ones just get discs around the via
    // candidates. On any failure, carry on with fog-only scoring.
    const rawVias = this._viaCandidates(budget);
    if (this.streets) {
      emit({ loading: true, phase: "streets" });
      try {
        if (budget <= 12000) {
          const mid = L.latLng((A.lat + B.lat) / 2, (A.lng + B.lng) / 2);
          const half = budget * 0.55 + 400;
          const { kx, ky } = metresPerDeg(mid.lat);
          await this.streets.ensureRects(
            [{ s: mid.lat - half / ky, n: mid.lat + half / ky, w: mid.lng - half / kx, e: mid.lng + half / kx }],
            streetKind(profile));
        } else if (rawVias.length) {
          await this.streets.ensureDiscs(rawVias.map((c) => c.latlng), 500, streetKind(profile));
        }
      } catch (e) {}
      if (stale()) return;
    }

    // The graph planner proposes whole A-to-B walks through rewarding streets;
    // each costs one BRouter request to become a real route. Skipped in
    // mostly-virgin areas, where simple detours already defog near the ceiling.
    let planned = [];
    if (budget <= 12000) {
      const planner = this._getPlanner();
      if (planner) {
        const mid = L.latLng((A.lat + B.lat) / 2, (A.lng + B.lng) / 2);
        try {
          if (planner.meanFracNear(mid, Math.min(1800, budget * 0.25)) < 0.82)
            planned = planner.planP2P(A, B, budget, 3);
        } catch (e) {}
      }
    }

    // candidate jobs: BRouter's alternatives + our street/fog-seeking via-points
    const jobs = [];
    for (let idx = 1; idx <= 3; idx++)
      jobs.push(async () => {
        const r = await this._route([A, B], profile, idx);
        if (!r || !r.lenM || r.lenM > budget) return null;
        const mid = r.coords[Math.floor(r.coords.length / 2)];
        return { r, adoptWps: [A, L.latLng(mid[1], mid[0]), B] };
      });
    for (const pl of planned)
      jobs.push(async () => {
        const r = await this._route(pl.wps, profile, 0);
        if (!r || !r.lenM || r.lenM > budget * 1.02) return null;
        const snip = snipOldSpurs(r.coords, this.computeGain, 0);
        if (snip.coords) return { r: statsFromCoords(snip.coords), adoptWps: [A].concat(resampleMids(snip.coords, 4), [B]) };
        return { r, adoptWps: pl.wps };
      });
    // planner plans free up request budget: fewer geometric vias needed then
    for (const v of this._pickVias(rawVias).slice(0, planned.length >= 2 ? 3 : MAX_VIAS))
      jobs.push(async () => {
        // real streets inflate the straight-line ellipse bound, so a via route often
        // overshoots the budget, so pull the via toward the line proportionally and retry
        let ll = v.latlng;
        let r = await this._route([A, ll, B], profile, 0);
        if (r && r.lenM > budget && r.lenM < budget * 1.8 && r.lenM > base.lenM) {
          // 0.95: aim just inside the budget, because the best detours live right at the edge
          const shrink = Math.max(0.2, Math.min(0.9, 0.95 * (budget - base.lenM) / (r.lenM - base.lenM)));
          const d = v.d * shrink;
          const ll2 = d >= 120 ? this._viaPoint(v.t, v.side, d) : null;
          if (ll2) {
            const r2 = await this._route([A, ll2, B], profile, 0);
            if (r2 && r2.lenM) { r = r2; ll = ll2; }
          }
        }
        // 1.02: don't bin a paid-for route for skimming the budget by metres
        if (!r || !r.lenM || r.lenM > budget * 1.02) return null;
        const snip = snipOldSpurs(r.coords, this.computeGain, 0);
        if (snip.coords) return { r: statsFromCoords(snip.coords), adoptWps: [A].concat(resampleMids(snip.coords, 3), [B]) };
        return { r, adoptWps: [A, ll, B] };
      });

    const total = jobs.length;
    emit({ loading: true, phase: "detours", done: 0, total });
    const found = await this._pool(jobs, stale, (done) => emit({ loading: true, phase: "detours", done, total }));
    if (stale()) return;
    found.unshift({ r: base, adoptWps: [A, B], isBase: true });
    this._finish(runId, found, { baseKm: base.lenM / 1000, bufferPct });
  };

  // ----- loops ------------------------------------------------------------------

  // Scoring radius for a bearing sample: wide enough to see a neighbourhood,
  // scaled with the loop so long rides judge whole districts.
  function bearingRadius(distM) { return Math.min(800, Math.max(300, distM * 0.05)); }

  // Rank compass bearings by how much undefogged STREET lies out that way
  // (fog-only newness as fallback): sample at two ranges along each of 12
  // bearings, then greedily pick well-separated winners. Street scoring stops
  // bearings aiming at rivers, parks and fields that look richly foggy but
  // hold nothing to defog.
  SuggestTool.prototype._loopBearings = function (S, distM) {
    const { kx, ky } = metresPerDeg(S.lat);
    const at = (thDeg, m) => {
      const th = thDeg * Math.PI / 180;
      return L.latLng(S.lat + (Math.cos(th) * m) / ky, S.lng + (Math.sin(th) * m) / kx);
    };
    const R = bearingRadius(distM);
    const score = (p) => {
      const st = this._newAreaM2(p, R);
      return st !== null ? st : this._newness(p) * 2 * R * 30; // fallback on a roughly comparable scale
    };
    const scored = [];
    for (let b = 0; b < 360; b += 30)
      scored.push({ b, score: (score(at(b, distM * 0.25)) + score(at(b, distM * 0.4))) / 2 });
    scored.sort((x, y) => y.score - x.score);
    const picked = [];
    for (const s of scored) {
      if (picked.length >= MAX_LOOPS) break;
      const sep = (a, b2) => { const d = Math.abs(a - b2) % 360; return Math.min(d, 360 - d); };
      if (picked.every((p) => sep(p, s.b) >= 45)) picked.push(s.b);
    }
    return picked;
  };

  // Square-ish loop S → v1 → v2 → v3 → S out along a bearing (S and three vias as the
  // corners, edge a metres, straight perimeter 4a). Benchmarked against 2-via triangles:
  // three vias give BRouter much less room to fold the loop into out-and-back spurs
  // (mean retraced length 8% vs 25%) and hit the distance tolerance more often.
  SuggestTool.prototype._loopVias = function (S, bearingDeg, a) {
    const { kx, ky } = metresPerDeg(S.lat);
    const at = (thDeg, m) => {
      const th = thDeg * Math.PI / 180;
      return L.latLng(S.lat + (Math.cos(th) * m) / ky, S.lng + (Math.sin(th) * m) / kx);
    };
    return [at(bearingDeg - 45, a), at(bearingDeg, a * Math.SQRT2), at(bearingDeg + 45, a)]
      .map((v) => this._snapToNewStreets(v, a * 0.3));
  };

  // Triangle fallback (2 vias, side D/3.75): used when the square's vias hit somewhere
  // BRouter can't route from (water, restricted areas). Fewer points, fewer chances to fail.
  SuggestTool.prototype._loopViasTri = function (S, bearingDeg, side) {
    const { kx, ky } = metresPerDeg(S.lat);
    const at = (thDeg) => {
      const th = thDeg * Math.PI / 180;
      return L.latLng(S.lat + (Math.cos(th) * side) / ky, S.lng + (Math.sin(th) * side) / kx);
    };
    return [at(bearingDeg - 30), at(bearingDeg + 30)].map((v) => this._snapToNewStreets(v, side * 0.3));
  };

  // Share of the route's length that runs within ~25 m of another, path-distant part of
  // itself. High values mean out-and-back spurs rather than a proper loop.
  function overlapFrac(coords) {
    const { kx, ky } = metresPerDeg(coords.length ? coords[0][1] : 0);
    const d2 = (p, q) => { const dx = (p.x - q.x), dy = (p.y - q.y); return dx * dx + dy * dy; };
    const pts = [];
    let acc = 0;
    for (let i = 1; i < coords.length; i++) {
      const ax = coords[i - 1][0] * kx, ay = coords[i - 1][1] * ky;
      const bx = coords[i][0] * kx, by = coords[i][1] * ky;
      const len = Math.hypot(bx - ax, by - ay);
      pts.push({ x: (ax + bx) / 2, y: (ay + by) / 2, len, at: acc + len / 2 });
      acc += len;
    }
    let overlap = 0, total = 0;
    for (const p of pts) {
      total += p.len;
      for (const q of pts) {
        const along = Math.abs(p.at - q.at);
        if (Math.min(along, acc - along) < 250) continue; // path-adjacent (loop-circular)
        if (d2(p, q) < 25 * 25) { overlap += p.len; break; }
      }
    }
    return total ? overlap / total : 0;
  }

  // Cut "there and back" excursions that don't pull their weight: an excursion is a
  // stretch that returns to within 60 m of where it left the route. If the defog area
  // it contributes per metre is under 40% of the route's overall rate, splice it out.
  // That catches dead-end re-walks of covered ground (rate ≈ 0) and marginal wiggles,
  // while keeping spurs INTO fog, which are ugly but often the point of the suggestion.
  // Returns { coords, blockedM }: coords is the spliced geometry (null if nothing was
  // cut) and blockedM the length of cuts wanted but skipped to respect minLenM, so the
  // caller can regrow the loop by that much and retry.
  function snipOldSpurs(coords, computeGain, minLenM) {
    const none = { coords: null, blockedM: 0 };
    if (!computeGain || coords.length < 10) return none;
    const routeGain = computeGain(coords);
    if (!routeGain || !(routeGain.area > 0)) return none;
    const { kx, ky } = metresPerDeg(coords[0][1]);
    const xy = coords.map((p) => ({ x: p[0] * kx, y: p[1] * ky }));
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y));
    const total = cum[cum.length - 1];
    const routeEff = routeGain.area / total;
    const near = (i, j) => Math.hypot(xy[i].x - xy[j].x, xy[i].y - xy[j].y) < 60;
    const snips = [];
    let i = 0;
    while (i < coords.length - 1) {
      let found = -1;
      for (let j = coords.length - 1; j > i; j--) { // longest excursion from i first
        const ex = cum[j] - cum[i];
        if (ex < 200) break;              // too short to matter (and shrinking further)
        if (ex > total * 0.45) continue;  // never amputate the main loop body
        if (near(i, j)) { found = j; break; }
      }
      if (found < 0) { i++; continue; }
      const without = coords.slice(0, i + 1).concat(coords.slice(found));
      const lost = routeGain.area - ((computeGain(without) || { area: 0 }).area || 0);
      const exLen = cum[found] - cum[i];
      if (lost / exLen < 0.5 * routeEff) snips.push({ i, j: found, cut: exLen });
      i = found;
    }
    // apply biggest cuts first, skip overlapping ones, never fall below the tolerance floor
    snips.sort((a, b) => b.cut - a.cut);
    const applied = [];
    let remaining = total, blockedM = 0;
    for (const s of snips) {
      if (applied.some((a) => s.i < a.j && a.i < s.j)) continue;
      if (remaining - s.cut < minLenM) { blockedM += s.cut; continue; }
      applied.push(s);
      remaining -= s.cut;
    }
    if (!applied.length) return { coords: null, blockedM };
    applied.sort((a, b) => a.i - b.i);
    const out = [];
    let idx = 0;
    for (const s of applied) { out.push(...coords.slice(idx, s.i + 1)); idx = s.j; }
    out.push(...coords.slice(idx));
    return { coords: out, blockedM };
  }

  // Recompute length/ascent/descent after geometry surgery.
  function statsFromCoords(coords) {
    const { kx, ky } = metresPerDeg(coords[0][1]);
    let len = 0, asc = 0, desc = 0;
    for (let i = 1; i < coords.length; i++) {
      len += Math.hypot((coords[i][0] - coords[i - 1][0]) * kx, (coords[i][1] - coords[i - 1][1]) * ky);
      const d = (coords[i][2] || 0) - (coords[i - 1][2] || 0);
      if (d > 0) asc += d; else desc -= d;
    }
    return { coords, lenM: Math.round(len), ascent: Math.round(asc), descent: Math.round(desc) };
  }

  // Evenly spaced points along a snipped route's cleaned shape, used as adoption
  // waypoints so BRouter follows the same streets instead of re-growing the spur.
  function resampleMids(coords, n) {
    const { kx, ky } = metresPerDeg(coords[0][1]);
    const cum = [0];
    for (let i = 1; i < coords.length; i++)
      cum.push(cum[i - 1] + Math.hypot((coords[i][0] - coords[i - 1][0]) * kx, (coords[i][1] - coords[i - 1][1]) * ky));
    const total = cum[cum.length - 1];
    const mids = [];
    let k = 1;
    for (let t = 1; t <= n; t++) {
      const target = total * t / (n + 1);
      while (k < cum.length - 1 && cum[k] < target) k++;
      mids.push(L.latLng(coords[k][1], coords[k][0]));
    }
    return mids;
  }

  SuggestTool.prototype._suggestLoop = async function (profile, distM, buffer) {
    if (!this.a || !distM) return;
    this.clearResults();
    const runId = this._runId;
    const stale = () => runId !== this._runId;
    const emit = (s) => { if (!stale() && this.onResults) this.onResults(s); };
    const S = this.a.getLatLng();
    const bufferPct = Math.round(buffer * 100);
    const inTol = (lenM) => Math.abs(lenM - distM) <= buffer * distM;

    // Fetch street data first so bearings and vias chase undefogged
    // streets rather than raw fog. Short loops get one rect around the whole
    // reach (via snapping needs area coverage); long loops fetch discs around
    // the bearing sample points only, to keep the download sane. On any
    // failure, carry on with fog-only scoring; suggestions must never die
    // because Overpass is busy.
    if (this.streets) {
      emit({ loading: true, phase: "streets" });
      try {
        const { kx, ky } = metresPerDeg(S.lat);
        if (distM <= 16000) {
          const half = distM * 0.45 + 800;
          await this.streets.ensureRects(
            [{ s: S.lat - half / ky, n: S.lat + half / ky, w: S.lng - half / kx, e: S.lng + half / kx }],
            streetKind(profile));
        } else {
          const pts = [];
          for (let b = 0; b < 360; b += 30) for (const f of [0.25, 0.4]) {
            const th = b * Math.PI / 180;
            pts.push(L.latLng(S.lat + (Math.cos(th) * distM * f) / ky, S.lng + (Math.sin(th) * distM * f) / kx));
          }
          await this.streets.ensureDiscs(pts, bearingRadius(distM) + 200, streetKind(profile));
        }
      } catch (e) {}
      if (stale()) return;
    }

    // Search the street network itself for high-defog loops (thin shapes, odd
    // topologies: whatever the fog asks for). Each plan then costs one BRouter
    // request to become a real route. Only for distances whose whole reach was
    // fetched as one street rect, and only where new ground is scarce enough
    // that shape matters: in mostly-virgin areas wide simple loops already
    // defog near the ceiling and planned walks measured worse.
    let planned = [];
    if (distM <= 16000) {
      const planner = this._getPlanner();
      if (planner) {
        try {
          if (planner.meanFracNear(S, Math.min(1800, distM * 0.18)) < 0.82)
            planned = planner.planLoop(S, distM, buffer, 4);
        } catch (e) {}
      }
    }
    // With planner candidates in hand, compass-square candidates become a
    // safety net; keep a couple so an off-target plan can't empty the results.
    const bearings = this._loopBearings(S, distM).slice(0, planned.length >= 3 ? 2 : MAX_LOOPS);
    const total = bearings.length + planned.length;
    emit({ loading: true, phase: "loops", done: 0, total });

    // 5: roads inflate the straight square (4a) by ~25%, so start with perimeter = D/1.25.
    // If the routed loop misses the tolerance, retry once with a proportionally scaled shape;
    // if the square doesn't route at all, fall back to a triangle on the same bearing.
    const loopWps = (vias) => [S].concat(vias, [S]);
    const fails = { server: 0, tol: 0 };
    const floor = distM * (1 - buffer);
    const plannedJobs = planned.map((pl) => async () => {
      const raw = await this._route(pl.wps, profile, 0);
      if (!raw || !raw.lenM) { fails.server++; return null; }
      const snip = snipOldSpurs(raw.coords, this.computeGain, floor);
      const c = snip.coords
        ? { r: statsFromCoords(snip.coords), adoptWps: [S].concat(resampleMids(snip.coords, 6), [S]) }
        : { r: raw, adoptWps: pl.wps };
      if (!inTol(c.r.lenM)) { fails.tol++; return null; }
      return { r: c.r, adoptWps: c.adoptWps, overlap: overlapFrac(c.r.coords) };
    });
    const jobs = plannedJobs.concat(bearings.map((bearing) => async () => {
      let mk = (d) => this._loopVias(S, bearing, d);
      // route + snip in one step, so tolerance and the rescale-retry both judge the
      // CLEANED length, so a loop whose snips pull it under target gets regrown, not binned
      const prep = async (d) => {
        const vias = mk(d);
        const raw = await this._route(loopWps(vias), profile, 0);
        if (!raw || !raw.lenM) return null;
        const snip = snipOldSpurs(raw.coords, this.computeGain, floor);
        return snip.coords
          ? { r: statsFromCoords(snip.coords), adoptWps: [S].concat(resampleMids(snip.coords, 4), [S]), blockedM: snip.blockedM }
          : { r: raw, adoptWps: loopWps(vias), blockedM: snip.blockedM };
      };
      let dim = distM / 5;
      let c = await prep(dim);
      if (!c) {
        mk = (d) => this._loopViasTri(S, bearing, d);
        dim = distM / 3.75;
        c = await prep(dim);
      }
      if (!c) { fails.server++; return null; }
      // retry when out of tolerance OR a wanted snip was blocked by the tolerance floor;
      // regrowing by the blocked amount makes the cut affordable on the second pass
      const badness = (x) => (inTol(x.r.lenM) ? 0 : 2) + (x.blockedM > 0 ? 1 : 0);
      // up to two improvement passes: a far-off first shot may need one rescale to reach
      // tolerance and a second to regrow room for a floor-blocked snip
      for (let attempt = 0; attempt < 2 && badness(c) > 0; attempt++) {
        dim *= Math.min(2.5, Math.max(0.4, (distM + c.blockedM) / c.r.lenM));
        const c2 = await prep(dim);
        if (!c2) break;
        const better = badness(c2) < badness(c) ||
          (badness(c2) === badness(c) && Math.abs(c2.r.lenM - distM) < Math.abs(c.r.lenM - distM));
        if (!better) break;
        c = c2;
      }
      if (!inTol(c.r.lenM)) { fails.tol++; return null; }
      return { r: c.r, adoptWps: c.adoptWps, overlap: overlapFrac(c.r.coords) };
    }));

    const found = await this._pool(jobs, stale, (done) => emit({ loading: true, phase: "loops", done, total }));
    if (stale()) return;
    if (!found.length && fails.server > 0 && fails.tol === 0) {
      // nothing routed at all, a server problem, not a tolerance problem; say so
      emit({ empty: true, reason: "server", targetKm: distM / 1000, bufferPct });
      return;
    }
    // prefer proper loops: drop candidates that retrace >30% of themselves, unless that
    // would leave nothing to show
    const clean = found.filter((c) => c.overlap <= 0.3);
    this._finish(runId, clean.length ? clean : found, { targetKm: distM / 1000, bufferPct });
  };

  SuggestTool._internals = { snipOldSpurs, overlapFrac, statsFromCoords }; // for tests
  global.SuggestTool = SuggestTool;
})(window);
