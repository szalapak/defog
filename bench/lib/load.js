// Node-side loader for the browser app code + a Fog of World Sync/ folder.
// The app files are plain IIFEs over `window`, so we point window at globalThis
// and require them; pako is only needed by the browser (we inflate with zlib here).
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

global.window = global;
require("./leaflet-stub.js"); // defines global.L before suggest.js needs it
require(path.join(__dirname, "..", "..", "app", "src", "parser.js"));
require(path.join(__dirname, "..", "..", "app", "src", "streets.js"));
require(path.join(__dirname, "..", "..", "app", "src", "planner.js"));
require(path.join(__dirname, "..", "..", "app", "src", "suggest.js"));

function loadSync(dir) {
  const fogMap = new global.FogParser.FogMap();
  let bad = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) continue;
    try {
      const data = zlib.inflateSync(fs.readFileSync(file));
      if (!fogMap.addTile(name, new Uint8Array(data))) bad++;
    } catch (e) { bad++; }
  }
  return { fogMap, bad };
}

module.exports = { loadSync, FogParser: global.FogParser, SuggestTool: global.SuggestTool, StreetIndex: global.StreetIndex, L: global.L };
