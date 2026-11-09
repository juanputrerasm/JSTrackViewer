/*
  WORLD\<stem>.WTR, Community Patch 4's lakes: extra water bodies above a track's main water.

  Body 0 is the track's own water, the .LVL `!waterHeight`. A .WTR adds up to 255 lakes, each a
  flat sheet at its own height covering the tiles its map assigns it. The engine uses the tile map
  as written; it never floods a lake itself (Traxx 1.7 does that when the author places one).
  Lakes have no tide and can never sit at or below body 0 (the engine skips such a lake and logs
  BELOW_BODY0 / TOUCHES_BODY0), and heights outside 1..4096 are refused (HEIGHT_RANGE).

  Layout, little-endian (Traxx TrackPODLakes.cpp BuildWTR / ParseWTR):

    0    "MWTR"
    4    u16 major = 1 (a reader refuses a newer major)
    6    u16 minor = 0
    8    u32 header size = 32
    12   u32 chunk count
    16   u16 tiles X = 256, u16 tiles Z = 256
    20   12 bytes zero
    32   directory, 16 bytes a chunk: id[4], u32 version = 1, u32 offset, u32 size
         BODY, then TMAP. Unknown ids are skipped, the first of a duplicate wins.

    BODY  u32 count, u16 stride = 64, u16 0, then per lake (id order 1..N):
          0  u8 id (index + 1)        1  u8 seed count (1..8)    2  u16 flags (1 = reflective)
          4  u32 height, 0.5 ft units (the !waterHeight scale)
          8  8 x (u16 x, u16 z) seed tiles
          40 u8 min x, min z, max x, max z (the bounding box; it wraps, so min may exceed max)
          44 u32 tile count           48..63 zero
    TMAP  65,536 bytes, one per 32 ft tile at x + z * 256: 0 dry, else the lake's id.
*/
export const WTR_MAGIC = "MWTR";
export const WTR_HEADER = 32;
export const WTR_STRIDE = 64;
export const WTR_TILES = 65536;
/** Feet per .WTR height unit (the .LVL water scale). */
export const WTR_HEIGHT_FT = 0.5;
export const WTR_FLAG_REFLECTIVE = 1;
const r16 = (b, o) => b[o] | (b[o + 1] << 8);
const r32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
export function isWtr(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x4d && bytes[1] === 0x57 && bytes[2] === 0x54 && bytes[3] === 0x52;
}
export function parseWtr(bytes) {
    if (bytes.length < WTR_HEADER || !isWtr(bytes))
        throw new RangeError("WTR: not an MWTR file");
    const major = r16(bytes, 4);
    if (major > 1)
        throw new RangeError(`WTR: major version ${major} needs a newer reader`);
    const headerSize = r32(bytes, 8);
    const count = r32(bytes, 12);
    if (headerSize < WTR_HEADER || headerSize > bytes.length || count > (bytes.length - headerSize) / 16)
        throw new RangeError("WTR: bad header");
    let body = null;
    let tmap = null;
    for (let i = 0; i < count; i++) {
        const e = headerSize + i * 16;
        const id = String.fromCharCode(bytes[e], bytes[e + 1], bytes[e + 2], bytes[e + 3]);
        const off = r32(bytes, e + 8), size = r32(bytes, e + 12);
        if (off > bytes.length || size > bytes.length - off)
            continue;
        if (id === "BODY" && !body)
            body = [off, size];
        else if (id === "TMAP" && tmap === null && size === WTR_TILES)
            tmap = off;
    }
    if (!body || body[1] < 8)
        throw new RangeError("WTR: no BODY chunk");
    const [bo, bsize] = body;
    const n = r32(bytes, bo);
    const stride = r16(bytes, bo + 4);
    if (stride < WTR_STRIDE || n > 255 || n * stride > bsize - 8)
        throw new RangeError("WTR: bad BODY chunk");
    const lakes = [];
    for (let i = 0; i < n; i++) {
        const r = bo + 8 + i * stride;
        const ns = bytes[r + 1];
        if (bytes[r] !== i + 1 || ns < 1 || ns > 8)
            throw new RangeError(`WTR: lake record ${i + 1} is malformed`);
        const flags = r16(bytes, r + 2);
        const height = r32(bytes, r + 4);
        const seeds = [];
        for (let s = 0; s < ns; s++)
            seeds.push({ x: r16(bytes, r + 8 + 4 * s), z: r16(bytes, r + 10 + 4 * s) });
        lakes.push({
            id: i + 1, flags, reflective: (flags & WTR_FLAG_REFLECTIVE) !== 0, height, heightFt: height * WTR_HEIGHT_FT, seeds,
            box: { minX: bytes[r + 40], minZ: bytes[r + 41], maxX: bytes[r + 42], maxZ: bytes[r + 43] },
            tileCount: r32(bytes, r + 44),
        });
    }
    return {
        major, minor: r16(bytes, 6), tilesX: r16(bytes, 16), tilesZ: r16(bytes, 18), lakes,
        tileMap: tmap === null ? null : bytes.slice(tmap, tmap + WTR_TILES),
    };
}
/** Write a .WTR exactly as Traxx 1.7 lays one out. Lake i gets id i + 1, which tileMap must use. */
export function writeWtr(lakes, tileMap) {
    if (tileMap.length !== WTR_TILES)
        throw new RangeError("WTR: tile map must be 65536 bytes");
    if (lakes.length < 1 || lakes.length > 255)
        throw new RangeError("WTR: 1 to 255 lakes");
    const bodySize = 8 + lakes.length * WTR_STRIDE;
    const bodyOff = WTR_HEADER + 32;
    const tmapOff = bodyOff + bodySize;
    const out = new Uint8Array(tmapOff + WTR_TILES);
    const v = new DataView(out.buffer);
    out.set([0x4d, 0x57, 0x54, 0x52]);
    v.setUint16(4, 1, true);
    v.setUint32(8, WTR_HEADER, true);
    v.setUint32(12, 2, true);
    v.setUint16(16, 256, true);
    v.setUint16(18, 256, true);
    const dir = (o, id, off, size) => {
        for (let i = 0; i < 4; i++)
            out[o + i] = id.charCodeAt(i);
        v.setUint32(o + 4, 1, true);
        v.setUint32(o + 8, off, true);
        v.setUint32(o + 12, size, true);
    };
    dir(WTR_HEADER, "BODY", bodyOff, bodySize);
    dir(WTR_HEADER + 16, "TMAP", tmapOff, WTR_TILES);
    v.setUint32(bodyOff, lakes.length, true);
    v.setUint16(bodyOff + 4, WTR_STRIDE, true);
    lakes.forEach((k, i) => {
        const p = bodyOff + 8 + i * WTR_STRIDE;
        if (k.seeds.length < 1 || k.seeds.length > 8)
            throw new RangeError(`WTR: lake ${i + 1} needs 1 to 8 seeds`);
        out[p] = i + 1;
        out[p + 1] = k.seeds.length;
        v.setUint16(p + 2, k.flags, true);
        v.setUint32(p + 4, k.height, true);
        k.seeds.forEach((s, j) => { v.setUint16(p + 8 + 4 * j, s.x, true); v.setUint16(p + 10 + 4 * j, s.z, true); });
        out[p + 40] = k.box.minX;
        out[p + 41] = k.box.minZ;
        out[p + 42] = k.box.maxX;
        out[p + 43] = k.box.maxZ;
        v.setUint32(p + 44, k.tileCount, true);
    });
    out.set(tileMap, tmapOff);
    return out;
}
/** The lake id (0 none) of the 32 ft tile under world feet (x, z); the world wraps at 8192 ft. */
export function wtrLakeAt(wtr, xFt, zFt) {
    if (!wtr.tileMap)
        return 0;
    const tx = Math.floor(xFt / 32) & 255;
    const tz = Math.floor(zFt / 32) & 255;
    return wtr.tileMap[tx + tz * 256];
}
