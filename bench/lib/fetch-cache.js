// Disk-cached fetch for benchmarks: identical URLs are served from bench/cache/
// so re-runs are reproducible, instant, and never hammer public servers.
// Real (uncached) requests are throttled to one every THROTTLE_MS.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_DIR = path.join(__dirname, "..", "cache");
const THROTTLE_MS = 400;

let stats = { hits: 0, misses: 0 };
let lastReal = 0;
const realFetch = global.fetch;

function keyFor(url, body) {
  return crypto.createHash("sha1").update(url + "\n" + (body || "")).digest("hex");
}

async function cachedFetch(url, opts) {
  const sub = url.includes("overpass") ? "overpass" : "brouter";
  const dir = path.join(CACHE_DIR, sub);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, keyFor(url, opts && opts.body) + ".json");
  if (fs.existsSync(file)) {
    stats.hits++;
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ok: cached.ok, status: cached.status, json: async () => cached.body, text: async () => JSON.stringify(cached.body) };
  }
  stats.misses++;
  const wait = lastReal + THROTTLE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReal = Date.now();
  const res = await realFetch(url, opts);
  let body = null;
  if (res.ok) { try { body = await res.json(); } catch (e) { return { ok: false, status: res.status, json: async () => null }; } }
  if (res.ok && body) fs.writeFileSync(file, JSON.stringify({ ok: res.ok, status: res.status, body }));
  return { ok: res.ok, status: res.status, json: async () => body, text: async () => JSON.stringify(body) };
}

function install() { global.fetch = cachedFetch; }
function counters() { return stats; }
function resetCounters() { stats = { hits: 0, misses: 0 }; }

module.exports = { install, cachedFetch, counters, resetCounters };
