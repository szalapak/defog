// Pure-logic checks for the A to B wanted-distance window; no network, no fog.
//   node bench/p2p-window.test.js
"use strict";
const assert = require("node:assert/strict");
const { SuggestTool } = require("./lib/load.js");
const { p2pWindow, p2pCandidates } = SuggestTool._internals;

const BASE = 6500, B = 0.15;
const base = { r: { lenM: BASE }, adoptWps: [], isBase: true };
const route = (lenM) => ({ r: { lenM } });
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} != ${b}`);

{ // no wanted distance: budget is fastest plus buffer; re-aimed vias land 95% of the way from the fastest route to it
  const w = p2pWindow(BASE, null, B);
  assert.equal(w.want, null);
  assert.equal(w.clamped, false);
  near(w.budget, 7475);
  assert.equal(w.floor, 0);
  near(w.aim, BASE + 0.95 * (7475 - BASE));
}
{ // wanted distance inside the reachable range
  const w = p2pWindow(BASE, 9000, B);
  assert.equal(w.want, 9000);
  assert.equal(w.clamped, false);
  near(w.budget, 10350);
  near(w.floor, 7650);
  near(w.aim, 9000);
}
{ // wanted distance under the fastest route is clamped up to it
  const w = p2pWindow(BASE, 4000, B);
  assert.equal(w.want, BASE);
  assert.equal(w.clamped, true);
  near(w.budget, 7475);
  assert.equal(w.floor, BASE);
  near(w.aim, 6987.5);
}
{ // under-floor candidates are dropped, the fastest route is not offered
  const r = p2pCandidates([route(7000), route(9000)], base, p2pWindow(BASE, 9000, B));
  assert.deepEqual(r.list.map((c) => c.r.lenM), [9000]);
  assert.equal(r.fallback, false);
}
{ // nothing fits: the fastest route alone, flagged as a fallback
  const r = p2pCandidates([route(7000)], base, p2pWindow(BASE, 9000, B));
  assert.deepEqual(r.list, [base]);
  assert.equal(r.fallback, true);
}
{ // no wanted distance: fastest route first, everything else kept
  const r = p2pCandidates([route(7000)], base, p2pWindow(BASE, null, B));
  assert.deepEqual(r.list.map((c) => c.r.lenM), [BASE, 7000]);
  assert.equal(r.fallback, false);
}
{ // clamped: the fastest route is the floor, so it stays a normal candidate
  const r = p2pCandidates([route(6400), route(7000)], base, p2pWindow(BASE, 4000, B));
  assert.deepEqual(r.list.map((c) => c.r.lenM), [BASE, 7000]);
  assert.equal(r.fallback, false);
}
