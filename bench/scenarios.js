// Benchmark scenarios, chosen from the real fog (see characterize.js).
// Densities are raw-cell shares of a 1 km box; ~35%+ means a thoroughly walked
// street grid (defogging is a ~30 m corridor, so 100% never happens on land).
"use strict";

module.exports = [
  // Heavily defogged home turf: the hard case, new ground is rare.
  { name: "neustadt-run-10k", mode: "loop", a: [51.0681, 13.7543], distM: 10000, profile: "hiking-mountain", buffer: 0.15, note: "dense 37%" },
  { name: "neustadt-bike-50k", mode: "loop", a: [51.0681, 13.7543], distM: 50000, profile: "trekking", buffer: 0.15, note: "dense 37%" },
  // Partially defogged: remnants and gaps, the "interesting middle".
  { name: "striesen-run-10k", mode: "loop", a: [51.0590, 13.7829], distM: 10000, profile: "hiking-mountain", buffer: 0.15, note: "medium 19%" },
  { name: "dd-north-run-10k", mode: "loop", a: [51.1133, 13.7543], distM: 10000, profile: "hiking-mountain", buffer: 0.15, note: "sparse 4%" },
  // Barely touched big cities: fog everywhere, shape quality is what matters.
  { name: "berlin-run-10k", mode: "loop", a: [52.52, 13.405], distM: 10000, profile: "hiking-mountain", buffer: 0.15, note: "sparse 1%" },
  { name: "london-run-10k", mode: "loop", a: [51.507, -0.128], distM: 10000, profile: "hiking-mountain", buffer: 0.15, note: "sparse 2%" },
  // One p2p for regression context (p2p already benchmarked well in v4).
  { name: "neustadt-p2p", mode: "p2p", a: [51.0681, 13.7543], b: [51.0590, 13.7829], profile: "trekking", buffer: 0.30, note: "dense to medium" },
];
