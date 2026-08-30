// Street-network context per scenario: how much street is there around each
// start point, and how much of it is still undefogged? This is the raw material
// any suggestion algorithm has to work with (and a preview of the Tier 2/3
// street-aware reward). Responses are disk-cached like BRouter's.
//   node bench/overpass.js [scenarioFilter]
"use strict";
const path = require("path");
const { loadSync, FogParser } = require("./lib/load.js");
const { makeGain } = require("./lib/gain.js");
const cache = require("./lib/fetch-cache.js");
const scenarios = require("./scenarios.js");

const OVERPASS = "https://overpass-api.de/api/interpreter";
// Streets a runner/cyclist can plausibly cover. Motorways and steps excluded.
const HW = "residential|unclassified|tertiary|secondary|primary|living_street|service|track|path|footway|cycleway|pedestrian|bridleway";
const HALF_KM = 3; // bbox half-size around each start; enough for a 10 km loop's reach

function bboxAround(lat, lng, halfM) {
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  return [lat - halfM / ky, lng - halfM / kx, lat + halfM / ky, lng + halfM / kx];
}

async function fetchStreets(bbox) {
  const q = `[out:json][timeout:120];way[highway~"^(${HW})$"](${bbox.map((x) => x.toFixed(4)).join(",")});out geom;`;
  const res = await cache.cachedFetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "FogToMaps-bench/0.1 (personal benchmark)" },
    body: "data=" + encodeURIComponent(q)
  });
  if (!res.ok) throw new Error("overpass HTTP " + res.status);
  const gj = await res.json();
  return gj.elements || [];
}

// The public Overpass instance rations big queries per IP: back-to-back bbox
// dumps earn a 429. Space them out and back off on rejection.
async function fetchStreetsPatient(bbox) {
  for (let attempt = 1; ; attempt++) {
    try { return await fetchStreets(bbox); }
    catch (e) {
      if (attempt >= 4) throw e;
      process.stdout.write(`(${e.message}, retrying in 30 s) `);
      await new Promise((r) => setTimeout(r, 30000));
    }
  }
}

// Walk each way in ~40 m steps; classify each step new/old by its midpoint.
function streetStats(ways, cellIsNew) {
  let totalM = 0, newM = 0, wayCount = 0;
  for (const w of ways) {
    if (!w.geometry || w.geometry.length < 2) continue;
    wayCount++;
    for (let i = 1; i < w.geometry.length; i++) {
      const a = w.geometry[i - 1], b = w.geometry[i];
      const kx = 111320 * Math.cos(a.lat * Math.PI / 180), ky = 110540;
      const segM = Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * ky);
      const steps = Math.max(1, Math.round(segM / 40));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        const lon = a.lon + (b.lon - a.lon) * t, lat = a.lat + (b.lat - a.lat) * t;
        totalM += segM / steps;
        if (cellIsNew(lon, lat)) newM += segM / steps;
      }
    }
  }
  return { wayCount, totalKm: totalM / 1000, newKm: newM / 1000 };
}

(async () => {
  const filter = process.argv[2] || "";
  const { fogMap } = loadSync(path.join(__dirname, "..", "Sync"));
  const gain = makeGain(fogMap, FogParser);
  const seen = new Set();
  for (const sc of scenarios) {
    if (filter && !sc.name.includes(filter)) continue;
    const key = sc.a.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const bbox = bboxAround(sc.a[0], sc.a[1], HALF_KM * 1000);
    process.stdout.write(`${sc.name} (${sc.note}): fetching streets ±${HALF_KM} km… `);
    try {
      const ways = await fetchStreetsPatient(bbox);
      const st = streetStats(ways, gain.cellIsNew);
      console.log(`${st.wayCount} ways, ${st.totalKm.toFixed(0)} km street, ` +
        `${st.newKm.toFixed(0)} km undefogged (${(100 * st.newKm / Math.max(0.001, st.totalKm)).toFixed(0)}%)`);
    } catch (e) {
      console.log("FAILED: " + e.message);
    }
    await new Promise((r) => setTimeout(r, 10000)); // breathe between areas
  }
})();
