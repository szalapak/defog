// Graph route planner: searches the real street network for the loop or A-to-B
// walk that defogs the most, instead of hoping a handful of via pins steers
// BRouter there. Works on the ways already fetched by StreetIndex: shared OSM
// node ids give connectivity, and every edge carries a reward = the still-
// fogged area its ~30 m corridor would clear. The search is a greedy
// insertion over "pockets" (clusters of rewarding streets) connected by
// reward-hungry shortest paths, with each traversed edge's reward spent so the
// way back is pushed onto different streets: that is what makes long thin
// loops (out one fogged street, back a parallel one) fall out naturally.
// Everything runs locally; the winner is later snapped by one BRouter request.
(function (global) {
  const SAMPLE_M = 25;        // reward sampling step along an edge
  const CORRIDOR_M = 30;      // full width Fog of World clears as you travel
  const POCKET_GRID_M = 300;  // pocket = rewarding streets clustered at this scale
  const POCKET_MIN_M2 = 1200; // ignore pockets worth less than ~40 m of virgin street
  const MAX_POCKETS = 60;
  const MAX_ANCHORS = 9;      // start + up to 8 pockets per loop
  const RICH_PULL = 0.65;     // how strongly connecting paths bend toward reward
  const PARALLEL_M = 22;      // spending an edge also spends parallels this close

  // ---- binary heap keyed by dist -------------------------------------------
  function Heap() { this.n = []; this.d = []; }
  Heap.prototype.push = function (node, dist) {
    const n = this.n, d = this.d;
    let i = n.length; n.push(node); d.push(dist);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p] <= d[i]) break;
      [n[p], n[i]] = [n[i], n[p]]; [d[p], d[i]] = [d[i], d[p]]; i = p;
    }
  };
  Heap.prototype.pop = function () {
    const n = this.n, d = this.d;
    const top = { node: n[0], dist: d[0] };
    const ln = n.pop(), ld = d.pop();
    if (n.length) {
      n[0] = ln; d[0] = ld;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < n.length && d[l] < d[m]) m = l;
        if (r < n.length && d[r] < d[m]) m = r;
        if (m === i) break;
        [n[m], n[i]] = [n[i], n[m]]; [d[m], d[i]] = [d[i], d[m]]; i = m;
      }
    }
    return top;
  };
  Heap.prototype.empty = function () { return this.n.length === 0; };

  // newFrac is ~25 cell lookups a call; edges sample every 25 m, so cache by a
  // ~10 m grid (the fog is static while planning).
  function fracCache(newFrac) {
    const cache = new Map();
    return (lon, lat) => {
      const key = Math.round(lon * 1e4) * 2e6 + Math.round(lat * 1e4);
      let v = cache.get(key);
      if (v === undefined) { v = newFrac(lon, lat); cache.set(key, v); }
      return v;
    };
  }

  function GraphPlanner(streets, newFrac) {
    this.streets = streets;
    this.newFrac = fracCache(newFrac);
    this.built = 0; // ways incorporated so far; rebuild when more are fetched
  }

  // ---- graph construction --------------------------------------------------
  // Nodes: way endpoints + any OSM node shared by 2+ ways (intersections).
  // Edges: the way pieces between nodes, each with geometry, length and reward.
  GraphPlanner.prototype.build = function () {
    const ways = this.streets.ways;
    if (this.built === ways.length && this.adj) return;
    const t0 = Date.now();
    const uses = new Map();
    for (const w of ways) {
      for (let i = 0; i < w.nodes.length; i++) {
        const id = w.nodes[i];
        // interior nodes count once per way; endpoints get +1 so a dead end still splits
        uses.set(id, (uses.get(id) || 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1));
      }
    }
    const nid2idx = new Map();
    const lons = [], lats = [];
    const nodeIdx = (id, lon, lat) => {
      let ix = nid2idx.get(id);
      if (ix === undefined) { ix = lons.length; nid2idx.set(id, ix); lons.push(lon); lats.push(lat); }
      return ix;
    };
    const kx = 111320 * Math.cos((ways.length ? ways[0].geometry[0].lat : 0) * Math.PI / 180);
    const ky = 110540;
    this.kx = kx; this.ky = ky;

    this.edges = [];      // {a,b,len,coords:[[lon,lat]..]}
    this.reward = [];     // base reward per edge, m² (static)
    this.spentVer = [];   // reward-claim stamp per edge (see _fresh)
    this.usedVer = [];    // traversal stamp: walked edges cost extra to re-walk
    const midGrid = new Map(); // 100 m bins of edge sample points, for parallel spend
    this.midGrid = midGrid;
    const pushEdge = (aId, bId, coords) => {
      let len = 0, rew = 0;
      const samples = [];
      for (let i = 1; i < coords.length; i++) {
        const [alon, alat] = coords[i - 1], [blon, blat] = coords[i];
        const em = Math.hypot((blon - alon) * kx, (blat - alat) * ky);
        const n = Math.max(1, Math.round(em / SAMPLE_M));
        for (let s = 0; s < n; s++) {
          const t = (s + 0.5) / n;
          const lon = alon + (blon - alon) * t, lat = alat + (blat - alat) * t;
          rew += (em / n) * CORRIDOR_M * this.newFrac(lon, lat);
          samples.push([lon * kx, lat * ky]);
        }
        len += em;
      }
      if (len < 5) return;
      const e = this.edges.length;
      this.edges.push({
        a: nodeIdx(aId, coords[0][0], coords[0][1]),
        b: nodeIdx(bId, coords[coords.length - 1][0], coords[coords.length - 1][1]),
        len, coords
      });
      this.reward.push(rew);
      this.spentVer.push(0);
      this.usedVer.push(0);
      for (const [x, y] of samples) {
        const key = Math.floor(x / 100) + "," + Math.floor(y / 100);
        let cell = midGrid.get(key);
        if (!cell) midGrid.set(key, (cell = []));
        cell.push({ x, y, e });
      }
    };
    for (const w of ways) {
      let start = 0;
      for (let i = 1; i < w.nodes.length; i++) {
        if (i === w.nodes.length - 1 || uses.get(w.nodes[i]) >= 2) {
          pushEdge(w.nodes[start], w.nodes[i],
            w.geometry.slice(start, i + 1).map((g) => [g.lon, g.lat]));
          start = i;
        }
      }
    }
    this.lons = lons; this.lats = lats;
    this.adj = Array.from({ length: lons.length }, () => []);
    this.edges.forEach((e, i) => { this.adj[e.a].push(i); this.adj[e.b].push(i); });
    this.plainDist = new Map(); // source node -> Float64Array of shortest lengths
    this.ver = 0;
    this.built = ways.length;
    this.buildMs = Date.now() - t0;
  };

  GraphPlanner.prototype._fresh = function (e) { return this.spentVer[e] < this.ver ? this.reward[e] : 0; };

  // How fogged the streets within rM of a point still are, 0..1. Where this is
  // high the ground is mostly virgin and planning is pointless: any wide loop
  // defogs near the ceiling, and benchmarks showed simple compass squares beat
  // planned walks there. Planning pays off where the surroundings are picked
  // over and the remaining fog is structured (measured: 0.57-0.74 at starts
  // where plans won, 0.89-0.94 where they lost; note even fully-walked streets
  // score ~0.3-0.5 because the recorded fog corridor is narrower than ours).
  GraphPlanner.prototype.meanFracNear = function (latlng, rM) {
    this.build();
    const px = latlng.lng * this.kx, py = latlng.lat * this.ky;
    let r = 0, l = 0;
    for (let i = 0; i < this.edges.length; i++) {
      const c = this.edges[i].coords[0];
      const dx = c[0] * this.kx - px, dy = c[1] * this.ky - py;
      if (dx * dx + dy * dy > rM * rM) continue;
      r += this.reward[i]; l += this.edges[i].len;
    }
    return l ? r / (l * CORRIDOR_M) : 1;
  };

  // Spend an edge's reward, and that of parallel edges whose corridor largely
  // overlaps (both sides of the same street, a footway hugging a road).
  GraphPlanner.prototype._spend = function (e) {
    this.spentVer[e] = this.ver;
    const g = this.midGrid;
    const edge = this.edges[e];
    for (let i = 1; i < edge.coords.length; i++) {
      const x = ((edge.coords[i - 1][0] + edge.coords[i][0]) / 2) * this.kx;
      const y = ((edge.coords[i - 1][1] + edge.coords[i][1]) / 2) * this.ky;
      for (let gy = -1; gy <= 1; gy++) for (let gx = -1; gx <= 1; gx++) {
        const cell = g.get((Math.floor(x / 100) + gx) + "," + (Math.floor(y / 100) + gy));
        if (!cell) continue;
        for (const p of cell) {
          if (p.e === e || this.spentVer[p.e] >= this.ver) continue;
          if ((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) < PARALLEL_M * PARALLEL_M) this.spentVer[p.e] = this.ver;
        }
      }
    }
  };

  GraphPlanner.prototype._dijkstra = function (src, costFn) {
    const N = this.lons.length;
    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    dist[src] = 0;
    const h = new Heap();
    h.push(src, 0);
    while (!h.empty()) {
      const { node: u, dist: du } = h.pop();
      if (du > dist[u]) continue;
      for (const ei of this.adj[u]) {
        const e = this.edges[ei];
        const v = e.a === u ? e.b : e.a;
        const nd = du + costFn(ei);
        if (nd < dist[v]) { dist[v] = nd; prev[v] = ei; h.push(v, nd); }
      }
    }
    return { dist, prev };
  };

  GraphPlanner.prototype._plain = function (src) {
    let d = this.plainDist.get(src);
    if (!d) { d = this._dijkstra(src, (ei) => this.edges[ei].len).dist; this.plainDist.set(src, d); }
    return d;
  };

  // Shortest path that would rather run along rewarding streets: fresh reward
  // discounts an edge's cost (never below 35%), so the metric stays positive.
  // Edges this plan has already walked cost extra, pushing the way back onto
  // different streets; that is what keeps loops loops instead of out-and-backs.
  GraphPlanner.prototype._richPath = function (u, v) {
    const { dist, prev } = this._dijkstra(u, (ei) => {
      const e = this.edges[ei];
      if (this.usedVer[ei] >= this.ver) return e.len * 1.8;
      const rate = this._fresh(ei) / e.len;
      return e.len * (1 - RICH_PULL * Math.min(1, rate / CORRIDOR_M));
    });
    if (!isFinite(dist[v])) return null;
    const edgeIds = [];
    for (let n = v; n !== u;) {
      const ei = prev[n];
      if (ei < 0) return null;
      edgeIds.push(ei);
      const e = this.edges[ei];
      n = e.a === n ? e.b : e.a;
    }
    edgeIds.reverse();
    let len = 0, gained = 0;
    const coords = [];
    let at = u;
    for (const ei of edgeIds) {
      const e = this.edges[ei];
      const cs = e.a === at ? e.coords : e.coords.slice().reverse();
      for (const c of cs) {
        if (!coords.length || coords[coords.length - 1][0] !== c[0] || coords[coords.length - 1][1] !== c[1]) coords.push(c);
      }
      len += e.len;
      gained += this._fresh(ei);
      this._spend(ei);
      this.usedVer[ei] = this.ver;
      at = e.a === at ? e.b : e.a;
    }
    return { coords, len, gained };
  };

  GraphPlanner.prototype.nearestNode = function (latlng, maxM) {
    let best = -1, bd = (maxM || 600) * (maxM || 600);
    for (let i = 0; i < this.lons.length; i++) {
      const dx = (this.lons[i] - latlng.lng) * this.kx, dy = (this.lats[i] - latlng.lat) * this.ky;
      const d = dx * dx + dy * dy;
      // prefer proper intersections; a dead-end start makes every plan begin with a spur
      if (d < bd && this.adj[i].length >= 2) { bd = d; best = i; }
    }
    return best;
  };

  // Rewarding street clusters on a coarse grid: what the plan visits.
  GraphPlanner.prototype._pockets = function () {
    const cells = new Map();
    this.edges.forEach((e, i) => {
      const r = this.reward[i];
      if (r <= 0) return;
      const mid = e.coords[Math.floor(e.coords.length / 2)];
      const key = Math.floor(mid[0] * this.kx / POCKET_GRID_M) + "," + Math.floor(mid[1] * this.ky / POCKET_GRID_M);
      let c = cells.get(key);
      if (!c) cells.set(key, (c = { m2: 0, bestR: -1, node: -1 }));
      c.m2 += r;
      if (r > c.bestR) { c.bestR = r; c.node = e.a; }
    });
    return [...cells.values()]
      .filter((c) => c.m2 >= POCKET_MIN_M2)
      .sort((a, b) => b.m2 - a.m2)
      .slice(0, MAX_POCKETS);
  };

  GraphPlanner.prototype._plainLen = function (anchors, cyclic) {
    let L2 = 0;
    for (let i = 1; i < anchors.length; i++) L2 += this._plain(anchors[i - 1])[anchors[i]];
    if (cyclic) L2 += this._plain(anchors[anchors.length - 1])[anchors[0]];
    return L2;
  };

  // Insert the single best pocket (richest per metre of detour) whose insertion
  // keeps the plain length within budget. Returns true if one was inserted.
  GraphPlanner.prototype._growOne = function (anchors, cyclic, budgetPlainM, pockets, used) {
    if (anchors.length >= MAX_ANCHORS) return false;
    const cur = this._plainLen(anchors, cyclic);
    let best = null;
    for (const p of pockets) {
      if (used.has(p) || p.node < 0) continue;
      const gaps = anchors.length - (cyclic ? 0 : 1);
      for (let g = 0; g < gaps; g++) {
        const u = anchors[g], v = anchors[(g + 1) % anchors.length];
        const cost = this._plain(u)[p.node] + this._plain(p.node)[v] - this._plain(u)[v];
        if (!isFinite(cost)) continue;
        if (cur + cost > budgetPlainM) continue;
        const ratio = p.m2 / Math.max(cost, 150);
        if (!best || ratio > best.ratio) best = { p, g, ratio };
      }
    }
    if (!best) return null;
    anchors.splice(best.g + 1, 0, best.p.node);
    used.add(best.p);
    return best.p.node;
  };

  GraphPlanner.prototype._materialize = function (anchors, cyclic) {
    this.ver++;
    const seq = cyclic ? anchors.concat([anchors[0]]) : anchors;
    let coords = [], len = 0, gained = 0;
    for (let i = 1; i < seq.length; i++) {
      const leg = this._richPath(seq[i - 1], seq[i]);
      if (!leg) return null;
      coords = coords.length ? coords.concat(leg.coords.slice(1)) : leg.coords;
      len += leg.len; gained += leg.gained;
    }
    return { coords, len, gained };
  };

  function resampleWps(coords, n, kx, ky) {
    const cum = [0];
    for (let i = 1; i < coords.length; i++)
      cum.push(cum[i - 1] + Math.hypot((coords[i][0] - coords[i - 1][0]) * kx, (coords[i][1] - coords[i - 1][1]) * ky));
    const total = cum[cum.length - 1];
    const out = [];
    let k = 1;
    for (let t = 1; t <= n; t++) {
      const target = total * t / (n + 1);
      while (k < cum.length - 1 && cum[k] < target) k++;
      out.push(L.latLng(coords[k][1], coords[k][0]));
    }
    return out;
  }

  // Plan up to nCands loops from S of roughly distM. Each result:
  // { wps (for BRouter, S first and last), predM2, lenM }
  GraphPlanner.prototype.planLoop = function (S, distM, buffer, nCands) {
    this.build();
    const s = this.nearestNode(S, 600);
    if (s < 0) return [];
    const pockets = this._pockets();
    if (!pockets.length) return [];
    const dS = this._plain(s);
    const reach = pockets.filter((p) => p.node >= 0 && isFinite(dS[p.node]) && dS[p.node] <= distM * (1 + buffer) * 0.45);
    // seeds: richest pockets, spread out so the candidates differ
    const seeds = [];
    for (const p of reach) {
      if (seeds.length >= nCands + 2) break;
      const far = seeds.every((q) => {
        const dx = (this.lons[q.node] - this.lons[p.node]) * this.kx;
        const dy = (this.lats[q.node] - this.lats[p.node]) * this.ky;
        return Math.hypot(dx, dy) > distM * 0.12;
      });
      if (far) seeds.push(p);
    }
    const out = [];
    // BRouter snapping straightens a plan ~6-8% shorter than its graph length,
    // so aim past the requested distance or every loop lands short of it
    const target = distM * 1.07;
    const ceilG = distM * (1 + buffer) * 1.04;
    for (const seed of seeds) {
      const used = new Set([seed]);
      const anchors = [s, seed.node];
      const stack = []; // pockets in insertion order, so overshoot can undo
      let m = this._materialize(anchors, true);
      // insert pockets one at a time, re-walking the loop after each, with the
      // plain-to-walked inflation learned as we go: fixed estimates either
      // overshot into rejection or stalled below target (both observed)
      for (let it = 0; it < MAX_ANCHORS && m && m.len < target * 0.96; it++) {
        const inflate = Math.min(1.4, Math.max(1.0, m.len / Math.max(1, this._plainLen(anchors, true))));
        const node = this._growOne(anchors, true, ceilG / inflate, reach, used);
        if (!node) break;
        const m2 = this._materialize(anchors, true);
        if (!m2) break;
        stack.push(node);
        m = m2;
      }
      // drop the most recent pockets while the loop overshoots what snapping
      // can bring back inside the promise
      while (m && m.len > ceilG && stack.length) {
        anchors.splice(anchors.indexOf(stack.pop()), 1);
        const m2 = this._materialize(anchors, true);
        if (!m2) break;
        m = m2;
      }
      if (!m || m.len < distM * (1 - buffer) * 0.8 || m.len > distM * (1 + buffer) * 1.15) continue;
      // dense waypoints: with ~1 km gaps BRouter shortcuts the plan's detail
      // and the predicted defogging evaporates; ~550 m holds it to the streets
      const nWps = Math.min(20, Math.max(6, Math.round(m.len / 550)));
      out.push({ wps: [S].concat(resampleWps(m.coords, nWps, this.kx, this.ky), [S]), predM2: m.gained, lenM: m.len });
    }
    out.sort((a, b) => b.predM2 - a.predM2);
    return dedupePlans(out).slice(0, nCands);
  };

  // Different seeds can converge onto the same loop once insertion fills in
  // the rest; near-identical (length, reward) pairs are the same plan.
  function dedupePlans(plans) {
    const seen = new Set(), out = [];
    for (const p of plans) {
      const key = Math.round(p.lenM / 150) + ":" + Math.round(p.predM2 / 1500);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  }

  // Plan up to nCands A-to-B walks within budgetM.
  GraphPlanner.prototype.planP2P = function (A, B, budgetM, nCands) {
    this.build();
    const a = this.nearestNode(A, 600), b = this.nearestNode(B, 600);
    if (a < 0 || b < 0) return [];
    const pockets = this._pockets();
    const dA = this._plain(a), dB = this._plain(b);
    if (!isFinite(dA[b])) return [];
    const reach = pockets.filter((p) => p.node >= 0 && isFinite(dA[p.node]) && isFinite(dB[p.node]) &&
      dA[p.node] + dB[p.node] <= budgetM * 0.95);
    const out = [];
    const tried = new Set();
    for (let v = 0; v < nCands + 2 && v < Math.max(1, reach.length); v++) {
      const seed = reach[v];
      const key = seed ? seed.node : -1;
      if (tried.has(key)) continue;
      tried.add(key);
      const used = seed ? new Set([seed]) : new Set();
      const anchors = seed ? [a, seed.node, b] : [a, b];
      let m = this._materialize(anchors, false);
      const ceilW = budgetM * 1.03; // snapping usually shortens; slight overhang ok
      for (let it = 0; it < MAX_ANCHORS && m && m.len < budgetM * 0.97; it++) {
        const inflate = Math.min(1.4, Math.max(1.0, m.len / Math.max(1, this._plainLen(anchors, false))));
        if (!this._growOne(anchors, false, ceilW / inflate, reach, used)) break;
        const m2 = this._materialize(anchors, false);
        if (!m2) break;
        m = m2;
      }
      if (!m || m.len > budgetM * 1.1) continue;
      const nWps = Math.min(16, Math.max(2, Math.round(m.len / 550)));
      out.push({ wps: [A].concat(resampleWps(m.coords, nWps, this.kx, this.ky), [B]), predM2: m.gained, lenM: m.len });
      if (out.length >= nCands + 1) break;
    }
    out.sort((x, y) => y.predM2 - x.predM2);
    return dedupePlans(out).slice(0, nCands);
  };

  global.GraphPlanner = GraphPlanner;
})(window);
