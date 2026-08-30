// Route-shape metrics for benchmark reporting.
"use strict";
const { SuggestTool } = require("./load.js");
const { overlapFrac } = SuggestTool._internals;

function metresPerDeg(lat) {
  return { kx: 111320 * Math.cos(lat * Math.PI / 180), ky: 110540 };
}

// Elongation: sqrt of the ratio of the route's principal variance axes.
// 1 = round blob; 3+ = a proper "line" of a loop.
function elongation(coords) {
  if (coords.length < 3) return 1;
  const { kx, ky } = metresPerDeg(coords[0][1]);
  let mx = 0, my = 0;
  for (const p of coords) { mx += p[0] * kx; my += p[1] * ky; }
  mx /= coords.length; my /= coords.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of coords) {
    const dx = p[0] * kx - mx, dy = p[1] * ky - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const d = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + d, l2 = Math.max(1e-9, tr / 2 - d);
  return Math.sqrt(l1 / l2);
}

module.exports = { elongation, overlapFrac };
