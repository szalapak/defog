// A to B plans are ranked by how much they walk twice; synthetic street graphs, no network.
//   node bench/planner-retrace.test.js
"use strict";
const assert = require("node:assert/strict");
require("./lib/load.js");
const { GraphPlanner } = global;

const KX = 111320 * Math.cos(51 * Math.PI / 180), KY = 110540;
const ll = (x, y) => ({ lat: 51 + y / KY, lon: 13.7 + x / KX });
// streets of straight two-node ways: [idA, idB, [x, y], [x, y]]
function planner(ways, newFrac) {
  const streets = { ways: ways.map(([a, b, p, q]) => ({ nodes: [a, b], geometry: [ll(...p), ll(...q)] })) };
  return new GraphPlanner(streets, (lon, lat) => newFrac((lon - 13.7) * KX, (lat - 51) * KY));
}
const A = { lat: 51, lng: 13.7 }, B = { lat: 51, lng: 13.7 + 1000 / KX };
// A(1) -- J(2) -- B(3) along y=0; ring street over y=200 via R1(4), R2(5)
const base = [[1, 2, [0, 0], [500, 0]], [2, 3, [500, 0], [1000, 0]]];
const ring = [[1, 4, [0, 0], [0, 200]], [4, 5, [0, 200], [1000, 200]], [5, 3, [1000, 200], [1000, 0]]];
const spur = [[6, 2, [500, 400], [500, 0]]];

{ // reward only on the parallel street: the plan goes out one way and back the other
  const p = planner(base.concat(ring), (x, y) => (y > 150 ? 1 : 0));
  const plans = p.planP2P(A, B, 2000, 3);
  assert.ok(plans.length > 0);
  assert.ok(plans[0].retraceFrac < 0.05, `ring ${plans[0].retraceFrac}`);
}
{ // reward only up a dead-end spur: the plan has to walk it twice
  const p = planner(base.concat(spur), (x, y) => (y > 50 ? 1 : 0));
  const plans = p.planP2P(A, B, 2000, 3);
  assert.ok(plans.length > 0);
  assert.ok(plans[0].retraceFrac > 0.3, `spur ${plans[0].retraceFrac}`);
}
{ // both on offer: the spur has more raw area, but the ring plan must rank first
  const p = planner(base.concat(ring, spur), (x, y) => (Math.abs(x - 500) < 10 && y > 20 && y < 350 ? 1 : y > 150 ? 0.25 : 0));
  const plans = p.planP2P(A, B, 2000, 3);
  const spurPlan = plans.find((q) => q.retraceFrac > 0.3), ringPlan = plans.find((q) => q.retraceFrac < 0.05);
  assert.ok(spurPlan && ringPlan, "expected both plans");
  assert.ok(spurPlan.predM2 > ringPlan.predM2, "spur should be ahead on raw area");
  assert.ok(plans.indexOf(ringPlan) < plans.indexOf(spurPlan), "ring plan should rank first");
}
console.log("planner-retrace.test.js ok");
