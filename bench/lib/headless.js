// Run the app's SuggestTool headless: fake map, pinned markers, cached fetch.
// Resolves with the tool's final results plus request/timing counters.
"use strict";
const { SuggestTool, StreetIndex, L } = require("./load.js");
const cache = require("./fetch-cache.js");

function pin(lat, lng) { const ll = L.latLng(lat, lng); return { getLatLng: () => ll }; }

// scenario: { mode, a:[lat,lng], b?, distM?, profile, buffer, noStreets? }
function runSuggest(fogMap, gain, scenario) {
  cache.install();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    cache.resetCounters();
    const tool = new SuggestTool(global.fakeMap(), {
      fogMap,
      computeGain: gain.computeGain,
      isNew: gain.cellIsNew,
      streets: scenario.noStreets ? null : new StreetIndex({ newFrac: gain.corridorNewFrac }),
      onResults: (s) => {
        if (!s || s.loading) return;
        const c = cache.counters();
        resolve({
          state: s,
          results: tool.results.map((r) => ({ coords: r.r.coords, lenM: r.r.lenM, gain: r.gain, isBase: !!r.isBase })),
          requests: c.hits + c.misses, cacheHits: c.hits, ms: Date.now() - t0
        });
      }
    });
    tool.mode = scenario.mode;
    tool.a = pin(scenario.a[0], scenario.a[1]);
    if (scenario.b) tool.b = pin(scenario.b[0], scenario.b[1]);
    tool.suggest(scenario.profile, { distM: scenario.distM, buffer: scenario.buffer || 0.15 })
      .catch(reject);
    const guard = setTimeout(() => reject(new Error("suggest timed out")), 600000);
    guard.unref(); // don't hold the process open after results resolve
  });
}

module.exports = { runSuggest };
