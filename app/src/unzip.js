// Minimal in-browser ZIP reader, enough to open a Fog of World backup .zip.
// Reads the central directory (authoritative for sizes/offsets), then inflates each
// entry. Supports the two methods real backups use: stored (0) and deflate (8),
// with pako.inflateRaw for the latter. Handles ZIP64 for the archive that needs it
// (a big traveller's Sync folder can exceed the 16-bit entry count / 4 GB fields).
//
// Returns [{ name, data: Uint8Array }], one entry per file (directories skipped).
// Each returned `data` is still the raw file content; for fog tiles that content is
// itself zlib-compressed, so the caller runs pako.inflate on it in turn.
(function (global) {
  const SIG_EOCD = 0x06054b50;
  const SIG_EOCD64 = 0x06064b50;
  const SIG_LOC64 = 0x07064b50;
  const SIG_CDIR = 0x02014b50;
  const SIG_LOCAL = 0x04034b50;
  const decoder = new TextDecoder("utf-8");

  function unzip(buffer) {
    const dv = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const n = buffer.byteLength;
    if (n < 22) throw new Error("Not a zip file");

    // Find the End Of Central Directory record (scan back over the max comment length).
    let eocd = -1;
    const min = Math.max(0, n - 22 - 65535);
    for (let i = n - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("No zip end-of-directory found");

    let cdOffset = dv.getUint32(eocd + 16, true);
    let cdCount = dv.getUint16(eocd + 10, true);

    // ZIP64: the 32-bit fields saturate to 0xff… and the real values live in the
    // ZIP64 EOCD, located via the locator record just before the EOCD.
    if (cdOffset === 0xffffffff || cdCount === 0xffff) {
      const loc = eocd - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === SIG_LOC64) {
        const z64 = Number(dv.getBigUint64(loc + 8, true));
        if (dv.getUint32(z64, true) === SIG_EOCD64) {
          cdCount = Number(dv.getBigUint64(z64 + 32, true));
          cdOffset = Number(dv.getBigUint64(z64 + 48, true));
        }
      }
    }

    const files = [];
    let p = cdOffset;
    for (let e = 0; e < cdCount; e++) {
      if (dv.getUint32(p, true) !== SIG_CDIR) break;
      const method = dv.getUint16(p + 10, true);
      let compSize = dv.getUint32(p + 20, true);
      let uncompSize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      let localOffset = dv.getUint32(p + 42, true);
      const name = decoder.decode(u8.subarray(p + 46, p + 46 + nameLen));

      // Pull true sizes/offset from the ZIP64 extra field when the base fields saturate.
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
        let ep = p + 46 + nameLen;
        const eend = ep + extraLen;
        while (ep + 4 <= eend) {
          const tag = dv.getUint16(ep, true), sz = dv.getUint16(ep + 2, true);
          if (tag === 0x0001) {
            let fp = ep + 4;
            if (uncompSize === 0xffffffff) { uncompSize = Number(dv.getBigUint64(fp, true)); fp += 8; }
            if (compSize === 0xffffffff) { compSize = Number(dv.getBigUint64(fp, true)); fp += 8; }
            if (localOffset === 0xffffffff) { localOffset = Number(dv.getBigUint64(fp, true)); fp += 8; }
            break;
          }
          ep += 4 + sz;
        }
      }

      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith("/")) continue; // directory entry

      // The central directory doesn't give the data offset directly, so read the local
      // header (whose name/extra lengths may differ) to find where the bytes start.
      if (dv.getUint32(localOffset, true) !== SIG_LOCAL) continue;
      const lNameLen = dv.getUint16(localOffset + 26, true);
      const lExtraLen = dv.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const comp = u8.subarray(dataStart, dataStart + compSize);

      let data;
      if (method === 0) data = comp.slice();
      else if (method === 8) data = pako.inflateRaw(comp);
      else continue; // unsupported compression method
      files.push({ name, data });
    }
    return files;
  }

  global.FogZip = { unzip };
})(window);
