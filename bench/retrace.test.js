// Pure-logic checks for the retraced share (overlapFrac) and rankKey; no network, no fog.
//   node bench/retrace.test.js
"use strict";
const assert = require("node:assert/strict");
const { SuggestTool } = require("./lib/load.js");
const { overlapFrac, rankKey, RETRACE_WEIGHT, routeUrl, retraceNogos, statsFromCoords } = SuggestTool._internals;

const LAT = 51, KY = 111320, KX = 111320 * Math.cos(LAT * Math.PI / 180);
// polyline through metre offsets (east, north) from a fixed origin, a point every ~10 m
function line(...pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 10));
    for (let k = i === 1 ? 0 : 1; k <= n; k++)
      out.push([13.7 + (x0 + (x1 - x0) * k / n) / KX, LAT + (y0 + (y1 - y0) * k / n) / KY, 0]);
  }
  return out;
}

{ // out and back along one street
  const f = overlapFrac(line([0, 0], [1000, 0], [0, 0]), false);
  assert.ok(f > 0.8, `out-and-back ${f}`);
}
{ // one-way routes retrace nothing
  assert.equal(overlapFrac(line([0, 0], [1000, 0]), false), 0);
  assert.ok(overlapFrac(line([0, 0], [500, 0], [500, 500]), false) < 0.05);
}
{ // default stays circular: a closed square loop is not a retrace
  assert.ok(overlapFrac(line([0, 0], [250, 0], [250, 250], [0, 250], [0, 0])) < 0.05);
}
{ // A and B about 28 m apart: closing the gap is not retracing
  const f = overlapFrac(line([0, 0], [500, 0], [500, 500], [20, 500], [20, 20]), false);
  assert.ok(f < 0.15, `nearly closed ${f}`);
}
{ // ranking
  assert.equal(RETRACE_WEIGHT, 0.5);
  assert.equal(rankKey({ area: 1000, newPct: 100 }, 0), 1000);
  assert.equal(rankKey({ area: 1000, newPct: 100 }, 1), 500);
  assert.ok(rankKey({ area: 1000, newPct: 60 }, 0.1) > rankKey({ area: 1000, newPct: 60 }, 0.4));
}
{ // guard against quadratic blow-up; 250 ms is generous for 3000 points on a laptop
  const zig = [];
  for (let i = 0; i < 3000; i++) zig.push([13.7 + (i * 4) / KX, LAT + ((i % 2) * 30 + Math.floor(i / 100) * 40) / KY, 0]);
  const t = Date.now();
  overlapFrac(zig, false);
  assert.ok(Date.now() - t < 250, `overlapFrac took ${Date.now() - t} ms`);
}
{ // BRouter URL: unchanged without nogos (bench cache keys), nogos appended otherwise
  const pts = [{ lat: 51, lng: 13.7 }, { lat: 51.01, lng: 13.71 }];
  const plain = "https://brouter.de/brouter?lonlats=13.700000,51.000000|13.710000,51.010000&profile=trekking&alternativeidx=0&format=geojson";
  assert.equal(routeUrl(pts, "trekking", 0), plain);
  assert.equal(routeUrl(pts, "trekking", 0, []), plain);
  assert.equal(routeUrl(pts, "trekking", 0, [{ lat: 51, lng: 13.7, radiusM: 30 }, { lat: 51.01, lng: 13.71, radiusM: 30 }]),
    plain + "&nogos=13.700000,51.000000,30|13.710000,51.010000,30");
}
{ // nogos land on the outbound street, clear of A and the via
  const out = line([0, 0], [1000, 0]), back = line([1000, 0], [0, 0]);
  const A = { lat: out[0][1], lng: out[0][0] }, via = { lat: out[out.length - 1][1], lng: out[out.length - 1][0] };
  const ng = retraceNogos(out, back, [A, via]);
  assert.ok(ng.length > 0 && ng.length <= 8, `nogos ${ng.length}`);
  for (const n of ng) {
    const dx = (n.lng - 13.7) * KX;
    assert.ok(dx > 79.9 && dx < 920.1, `nogo at ${dx} m`);
    assert.ok(Math.abs((n.lat - LAT) * KY) < 1);
  }
  assert.deepEqual(retraceNogos(line([0, 0], [500, 0]), line([500, 400], [0, 400]), [A, via]), []);
}
(async () => {
{ // _rerouteReturn: discs go to _route, result is outbound + new way home; null when nothing to block or BRouter fails
  const route = statsFromCoords(line([0, 0], [1000, 0], [0, 0]));
  const via = { lat: LAT, lng: 13.7 + 1000 / KX };
  const Bll = { lat: LAT, lng: 13.7 };
  const homeStreet = line([1000, 0], [1000, 300], [0, 300], [0, 0]);
  const calls = [];
  const tool = Object.create(SuggestTool.prototype);
  tool._route = async (pts, profile, idx, nogos) => { calls.push({ pts, nogos }); return { coords: homeStreet }; };
  const r = await tool._rerouteReturn(route, via, Bll, "trekking");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].nogos.length > 0);
  assert.ok(Math.abs((calls[0].pts[0].lng - via.lng) * KX) < 15);
  assert.deepEqual(r.coords[0], route.coords[0]);
  assert.deepEqual(r.coords[r.coords.length - 1], homeStreet[homeStreet.length - 1]);
  tool._route = async () => null;
  assert.equal(await tool._rerouteReturn(route, via, Bll, "trekking"), null);
  tool._route = async () => { throw new Error("must not be called"); };
  const oneWay = statsFromCoords(line([0, 0], [1000, 0]));
  assert.equal(await tool._rerouteReturn(oneWay, via, Bll, "trekking"), null);
}
console.log("retrace.test.js ok");
})();
