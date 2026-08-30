// Characterize the loaded fog: defog density on a km grid around given centres.
// Usage: node bench/characterize.js
// Prints a density map per city plus suggested scenario centres (dense/medium/sparse).
"use strict";
const { loadSync, FogParser } = require("./lib/load.js");

const CITIES = [
  { name: "Dresden", lat: 51.05, lng: 13.74, halfKm: 9 },
  { name: "Berlin", lat: 52.52, lng: 13.405, halfKm: 6 },
  { name: "London", lat: 51.507, lng: -0.128, halfKm: 6 },
];

const { fogMap, bad } = loadSync(require("path").join(__dirname, "..", "Sync"));
console.log(`tiles: ${fogMap.tileCount} (${bad} unreadable)`);

function densityAt(lat, lng, boxM) {
  const half = boxM / 2;
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  const a = FogParser.lngLatToCell(lng - half / kx, lat + half / ky);
  const b = FogParser.lngLatToCell(lng + half / kx, lat - half / ky);
  const cells = Math.max(1, (b.cx - a.cx) * (b.cy - a.cy));
  return fogMap.countVisitedInCellRect(a.cx, a.cy, b.cx, b.cy) / cells;
}

const SHADE = " .:-=+*#%@";
for (const c of CITIES) {
  const kx = 111320 * Math.cos(c.lat * Math.PI / 180), ky = 110540;
  const rows = [];
  const samples = [];
  for (let iy = c.halfKm; iy >= -c.halfKm; iy--) {
    let row = "";
    for (let ix = -c.halfKm; ix <= c.halfKm; ix++) {
      const lat = c.lat + (iy * 1000) / ky, lng = c.lng + (ix * 1000) / kx;
      const d = densityAt(lat, lng, 1000);
      samples.push({ lat, lng, d, ix, iy });
      row += SHADE[Math.min(9, Math.floor(d * 10))];
    }
    rows.push(row);
  }
  const avg = samples.reduce((s, x) => s + x.d, 0) / samples.length;
  console.log(`\n${c.name} (1 km cells, ${2 * c.halfKm + 1}x${2 * c.halfKm + 1}, centre ${c.lat},${c.lng}) avg density ${(avg * 100).toFixed(1)}%`);
  console.log(rows.join("\n"));
  const pick = (lo, hi) => {
    const inBand = samples.filter((s) => s.d >= lo && s.d < hi);
    inBand.sort((x, y) => y.d - x.d);
    return inBand[Math.floor(inBand.length / 2)];
  };
  for (const [label, lo, hi] of [["dense ", 0.5, 1.01], ["medium", 0.15, 0.5], ["sparse", 0.02, 0.15]]) {
    const s = pick(lo, hi);
    if (s) console.log(`  ${label}: ${s.lat.toFixed(4)},${s.lng.toFixed(4)}  density ${(s.d * 100).toFixed(0)}% (km offset ${s.ix},${s.iy})`);
  }
}
