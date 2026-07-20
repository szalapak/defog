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

  // Set-bits-per-byte lookup, for popcounting bitmaps quickly.
  const POPCNT = new Uint8Array(256);
  for (let i = 0; i < 256; i++) POPCNT[i] = (i & 1) + POPCNT[i >> 1];

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

    // Total defogged cells in the whole tile (popcount every present block), cached.
    totalVisited() {
      if (this._tv != null) return this._tv;
      let c = 0;
      for (let i = 0; i < TILE_HEADER_LEN; i++) {
        const idx = this.header[i];
        if (idx === 0) continue;
        const start = TILE_HEADER_SIZE + (idx - 1) * BLOCK_SIZE;
        for (let k = 0; k < BLOCK_BITMAP_SIZE; k++) c += POPCNT[this.data[start + k]];
      }
      return (this._tv = c);
    }

    // Count defogged cells in local cell rect [lx0,lx1) x [ly0,ly1), clamped to the tile.
    countVisited(lx0, ly0, lx1, ly1) {
      lx0 = Math.max(0, lx0); ly0 = Math.max(0, ly0);
      lx1 = Math.min(BITS_PER_TILE_EDGE, lx1); ly1 = Math.min(BITS_PER_TILE_EDGE, ly1);
      if (lx1 <= lx0 || ly1 <= ly0) return 0;
      if (lx0 === 0 && ly0 === 0 && lx1 === BITS_PER_TILE_EDGE && ly1 === BITS_PER_TILE_EDGE) return this.totalVisited();
      const bx0 = lx0 >> 6, bx1 = (lx1 - 1) >> 6, by0 = ly0 >> 6, by1 = (ly1 - 1) >> 6;
      let count = 0;
      for (let by = by0; by <= by1; by++) {
        for (let bx = bx0; bx <= bx1; bx++) {
          const idx = this.header[by * TILE_WIDTH + bx];
          if (idx === 0) continue;
          const start = TILE_HEADER_SIZE + (idx - 1) * BLOCK_SIZE;
          const cbx = bx << 6, cby = by << 6;
          const x0 = Math.max(lx0, cbx) - cbx, x1 = Math.min(lx1, cbx + 64) - cbx;
          const y0 = Math.max(ly0, cby) - cby, y1 = Math.min(ly1, cby + 64) - cby;
          if (x0 === 0 && x1 === 64) {
            for (let bitY = y0; bitY < y1; bitY++) { const r = start + bitY * 8; for (let k = 0; k < 8; k++) count += POPCNT[this.data[r + k]]; }
          } else {
            for (let bitY = y0; bitY < y1; bitY++) {
              const r = start + bitY * 8;
              for (let bitX = x0; bitX < x1; bitX++) if (this.data[r + (bitX >> 3)] & (1 << (7 - (bitX & 7)))) count++;
            }
          }
        }
      }
      return count;
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

    // Count defogged cells whose global coords fall in [cx0,cx1) x [cy0,cy1).
    countVisitedInCellRect(cx0, cy0, cx1, cy1) {
      cx0 = Math.max(0, Math.floor(cx0)); cy0 = Math.max(0, Math.floor(cy0));
      cx1 = Math.min(WORLD_CELLS, Math.ceil(cx1)); cy1 = Math.min(WORLD_CELLS, Math.ceil(cy1));
      if (cx1 <= cx0 || cy1 <= cy0) return 0;
      const tx0 = cx0 >> 13, tx1 = (cx1 - 1) >> 13, ty0 = cy0 >> 13, ty1 = (cy1 - 1) >> 13;
      let count = 0;
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const t = this.tiles.get(this._key(tx, ty));
          if (!t) continue;
          const baseX = tx << 13, baseY = ty << 13;
          count += t.countVisited(cx0 - baseX, cy0 - baseY, cx1 - baseX, cy1 - baseY);
        }
      }
      return count;
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

  // global fog-cell coords (fractional allowed) -> lng/lat
  function cellToLngLat(cx, cy) {
    return tileToLngLat(cx / BITS_PER_TILE_EDGE, cy / BITS_PER_TILE_EDGE);
  }

  // lng/lat -> global fog-cell coords (floats)
  function lngLatToCell(lng, lat) {
    const cx = (lng + 180) / 360 * WORLD_CELLS;
    const yTile = (Math.PI - Math.asinh(Math.tan(lat * Math.PI / 180))) / (2 * Math.PI) * MAP_WIDTH;
    const cy = yTile * BITS_PER_TILE_EDGE;
    return { cx, cy };
  }

  global.FogParser = {
    FogMap, parseTileId, tileToLngLat, cellToLngLat, lngLatToCell,
    WORLD_CELLS, MAP_WIDTH, BITS_PER_TILE_EDGE
  };
})(window);
