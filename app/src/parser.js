// Fog of World sync-data parser (browser port of CaviarChen/Fog-of-World-Data-Parser).
//
// Format recap:
//   Sync/ holds one file per TILE. World = 512x512 tiles (Web Mercator).
//   Filename: md5(id)[0:4] + base10(id) encoded via MASK1 + mask2(id[-2:]).
//   Each file is zlib-compressed. Decompressed:
//     - header: 128*128 uint16 (little-endian) mapping block position -> 1-based block index (0 = absent)
//     - then blocks, each 515 bytes: 512-byte bitmap (64x64 bits) + 3 bytes extra (region + checksum)
//   A set bit = a defogged cell. Grid is 512 tiles * (128 blocks * 64 bits) = 2^22 cells per axis.
(function (global) {
  const FILENAME_MASK1 = "olhwjsktri";
  const MAP_WIDTH = 512;
  const TILE_WIDTH = 128;
  const TILE_HEADER_LEN = TILE_WIDTH * TILE_WIDTH;   // 16384
  const TILE_HEADER_SIZE = TILE_HEADER_LEN * 2;      // 32768 bytes
  const BLOCK_BITMAP_SIZE = 512;
  const BLOCK_SIZE = 515;
  const BITMAP_WIDTH = 64;
  const BITS_PER_TILE_EDGE = TILE_WIDTH * BITMAP_WIDTH; // 8192 = 2^13
  const WORLD_CELLS = MAP_WIDTH * BITS_PER_TILE_EDGE;   // 4194304 = 2^22

  function parseTileId(filename) {
    const core = filename.slice(4, -2);
    let id = 0;
    for (const ch of core) {
      const v = FILENAME_MASK1.indexOf(ch);
      if (v < 0) return null;
      id = id * 10 + v;
    }
    return id;
  }

  class Tile {
    constructor(id, data) {
      this.id = id;
      this.x = id % MAP_WIDTH;
      this.y = Math.floor(id / MAP_WIDTH);
      this.data = data;
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      this.header = new Uint16Array(TILE_HEADER_LEN);
      for (let i = 0; i < TILE_HEADER_LEN; i++) this.header[i] = dv.getUint16(i * 2, true);
    }
    // blockX,blockY in 0..127 ; bitX,bitY in 0..63
    isVisited(blockX, blockY, bitX, bitY) {
      const idx = this.header[blockY * TILE_WIDTH + blockX];
      if (idx === 0) return false;
      const start = TILE_HEADER_SIZE + (idx - 1) * BLOCK_SIZE;
      const byte = this.data[start + (bitX >> 3) + bitY * 8];
      return (byte & (1 << (7 - (bitX & 7)))) !== 0;
    }
  }

  class FogMap {
    constructor() {
      this.tiles = new Map();
      this.tileCount = 0;
      this.bounds = null; // {minX,minY,maxX,maxY} in tile-grid units
    }
    _key(tx, ty) { return ty * MAP_WIDTH + tx; }

    addTile(filename, decompressed) {
      const id = parseTileId(filename);
      if (id === null) return false;
      const t = new Tile(id, decompressed);
      this.tiles.set(this._key(t.x, t.y), t);
      this.tileCount++;
      const b = this.bounds || { minX: t.x, minY: t.y, maxX: t.x, maxY: t.y };
      b.minX = Math.min(b.minX, t.x); b.minY = Math.min(b.minY, t.y);
      b.maxX = Math.max(b.maxX, t.x); b.maxY = Math.max(b.maxY, t.y);
      this.bounds = b;
      return true;
    }

    // global cell coords in [0, WORLD_CELLS)
    isVisitedCell(cx, cy) {
      if (cx < 0 || cy < 0 || cx >= WORLD_CELLS || cy >= WORLD_CELLS) return false;
      const t = this.tiles.get(this._key(cx >> 13, cy >> 13));
      if (!t) return false;
      const lx = cx & 8191, ly = cy & 8191;
      return t.isVisited(lx >> 6, ly >> 6, lx & 63, ly & 63);
    }

    // Lat/lng bounding box of loaded data, as [[south,west],[north,east]].
    latLngBounds() {
      if (!this.bounds) return null;
      const b = this.bounds;
      const c1 = tileToLngLat(b.minX, b.minY);
      const c2 = tileToLngLat(b.maxX + 1, b.maxY + 1);
      return [[Math.min(c1.lat, c2.lat), Math.min(c1.lng, c2.lng)],
              [Math.max(c1.lat, c2.lat), Math.max(c1.lng, c2.lng)]];
    }
  }

  // x,y in 512-tile-grid units (fractional allowed)
  function tileToLngLat(x, y) {
    const lng = x / MAP_WIDTH * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y / MAP_WIDTH)) * 180 / Math.PI;
    return { lng, lat };
  }

  global.FogParser = { FogMap, parseTileId, tileToLngLat, WORLD_CELLS, MAP_WIDTH, BITS_PER_TILE_EDGE };
})(window);
