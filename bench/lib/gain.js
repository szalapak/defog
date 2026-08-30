// Defog scoring, replicated from app/src/main.js (cellIsNew / computeGain).
// Kept in lockstep by hand; the app versions are closures over UI state so they
// can't be required directly. If you change them there, change them here.
"use strict";

const DEFOG_HALF_M = 15;

function makeGain(fogMap, FogParser) {
  const cellMetersAt = (lat) => (40075016.686 / FogParser.WORLD_CELLS) * Math.cos(lat * Math.PI / 180);

  function cellIsNew(lon, lat) {
    const r = Math.max(1, Math.round(DEFOG_HALF_M / cellMetersAt(lat)));
    const c = FogParser.lngLatToCell(lon, lat);
    const cx0 = Math.floor(c.cx), cy0 = Math.floor(c.cy);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
      if (fogMap.isVisitedCell(cx0 + dx, cy0 + dy)) return false;
    return true;
  }

  // Share of the ~30 m corridor stamp around a point that is still fogged.
  // Street segments are weighted by this, so the reward is area-aligned.
  function corridorNewFrac(lon, lat) {
    const r = Math.max(1, Math.round(DEFOG_HALF_M / cellMetersAt(lat)));
    const c = FogParser.lngLatToCell(lon, lat);
    const cx0 = Math.floor(c.cx), cy0 = Math.floor(c.cy);
    let fogged = 0, total = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      total++;
      if (!fogMap.isVisitedCell(cx0 + dx, cy0 + dy)) fogged++;
    }
    return fogged / total;
  }

  function computeGain(coords) {
    if (!fogMap.tileCount || coords.length < 2) return null;
    const cellM = cellMetersAt(coords[Math.floor(coords.length / 2)][1]);
    const r = Math.max(1, Math.round(DEFOG_HALF_M / cellM));
    const seen = new Set(); let newCells = 0;
    for (const p of coords) {
      const c = FogParser.lngLatToCell(p[0], p[1]);
      const cx0 = Math.floor(c.cx), cy0 = Math.floor(c.cy);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const cx = cx0 + dx, cy = cy0 + dy, key = cy * FogParser.WORLD_CELLS + cx;
        if (seen.has(key)) continue; seen.add(key);
        if (!fogMap.isVisitedCell(cx, cy)) newCells++;
      }
    }
    let total = 0, newLen = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = global.L.latLng(coords[i - 1][1], coords[i - 1][0]);
      const b = global.L.latLng(coords[i][1], coords[i][0]);
      const d = a.distanceTo(b); total += d;
      if (cellIsNew((coords[i - 1][0] + coords[i][0]) / 2, (coords[i - 1][1] + coords[i][1]) / 2)) newLen += d;
    }
    return { area: newCells * cellM * cellM, newPct: total > 0 ? 100 * newLen / total : 0 };
  }

  return { cellIsNew, corridorNewFrac, computeGain, cellMetersAt };
}

module.exports = { makeGain, DEFOG_HALF_M };
