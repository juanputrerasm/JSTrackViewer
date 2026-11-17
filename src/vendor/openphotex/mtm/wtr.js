/*
  WORLD\<stem>.WTR, Community Patch 4's lakes: extra water bodies above a track's main water.

  Body 0 is the track's own water, the .LVL `!waterHeight`. A .WTR adds up to 255 lakes, each a
  flat sheet at its own height covering the tiles its map assigns it. The engine uses the tile map
  as written; it never floods a lake itself (Traxx 1.7 does that when the author places one).
  Lakes have no tide and can never sit at or below body 0 (the engine skips such a lake and logs
  BELOW_BODY0 / TOUCHES_BODY0), and heights outside 1..4096 are refused (HEIGHT_RANGE).

  Layout, little-endian (Traxx 1.7.3 TrackPODLakes.cpp BuildWTR / ParseWTR):

    0    "MWTR"
    4    u16 major = 1 (a reader refuses a newer major)
    6    u16 minor = 0, or 1 for a file built with Traxx 1.7.3's edge rule
    8    u32 header size = 32
    12   u32 chunk count
    16   u16 tiles X = 256, u16 tiles Z = 256
    20   u32 flags: bit 0 = the lakes were filled with the edge rule (water crosses between tiles only
         through an edge whose lowest point is at or below the lake's height); clear = the tile rule
         (Traxx 1.7.0 to 1.7.2). The tile map is final either way: the flag says how it was made.
    24   8 bytes zero
    32   directory, 16 bytes a chunk: id[4], u32 version = 1, u32 offset, u32 size
         BODY, then TMAP. Unknown ids are skipped, the first of a duplicate wins.

    BODY  u32 count, u16 stride = 64, u16 0, then per lake (id order 1..N):
          0  u8 id (index + 1)        1  u8 seed count (1..8)    2  u16 flags (1 = reflective)
          4  u32 height, 0.5 ft units (the !waterHeight scale)
          8  8 x (u16 x, u16 z) seed tiles
          40 u8 min x, min z, max x, max z (the bounding box; it wraps, so min may exceed max)
          44 u32 tile count           48..63 zero
    TMAP  65,536 bytes, one per 32 ft tile at x + z * 256: 0 dry, else the lake's id.

  Version 2, track format version 6 (https://openmtm2.github.io/proposals/track-format-v6, 9.1),
  widens the map, the boxes and the heights for larger and taller worlds:

    4    u16 major = 2
    16   u16 tiles X = 512, u16 tiles Z = 512 (worldCells; version 2 is the 512-cell world's only)
    BODY 4  i32 height, 0.5 ft units, valid from 2 * terrainHeightBase + 1 to
            2 * (terrainHeightBase + 65536 / terrainHeightStep)
         40 u16 min x, min z, max x, max z (tiles 0..N-1)
         48 u32 tile count             52..63 zero
    TMAP N * N bytes, at x + z * N.

  The world's size picks the version: a 256-cell world's .WTR is version 1 (the CP4 file, which a
  .SI3 track of 256 cells keeps too), a 512-cell world's version 2. A reader refuses any other
  pairing, and a 256-cell world's lake above 2,048 ft cannot be written. CP4 0.52 refuses any
  major but 1, so it never misreads a version 2 file.
*/
export const WTR_MAGIC = "MWTR";
export const WTR_HEADER = 32;
export const WTR_STRIDE = 64;
export const WTR_TILES = 65536;
/** Feet per .WTR height unit (the .LVL water scale). */
export const WTR_HEIGHT_FT = 0.5;
export const WTR_FLAG_REFLECTIVE = 1;
/** Header flags (byte 20) bit 0: the lakes were filled with the edge rule. */
export const WTR_HEADER_EDGE_RULE = 1;
const r16 = (b, o) => b[o] | (b[o + 1] << 8);
const r32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
export function isWtr(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x4d && bytes[1] === 0x57 && bytes[2] === 0x54 && bytes[3] === 0x52;
}
/**
 * Parse a .WTR, version 1 or 2. With `cells` (a version 6 track's worldCells) the header's size
 * must be N x N and the TMAP N * N bytes, else it is refused.
 */
export function parseWtr(bytes, { cells } = {}) {
    if (bytes.length < WTR_HEADER || !isWtr(bytes))
        throw new RangeError("WTR: not an MWTR file");
    const major = r16(bytes, 4);
    if (major < 1 || major > 2)
        throw new RangeError(`WTR: major version ${major} needs a newer reader`);
    const headerSize = r32(bytes, 8);
    const count = r32(bytes, 12);
    if (headerSize < WTR_HEADER || headerSize > bytes.length || count > (bytes.length - headerSize) / 16)
        throw new RangeError("WTR: bad header");
    const tilesX = r16(bytes, 16), tilesZ = r16(bytes, 18);
    if (major === 2 && (tilesX !== 512 || tilesZ !== 512))
        throw new RangeError(`WTR: version 2 is a 512-cell world's (512 x 512 tiles), not ${tilesX} x ${tilesZ}`);
    // Version 1's map is 256 x 256 whatever its header says (CP4 0.52 and Traxx 1.7 read 65,536 bytes).
    const side = major === 2 ? tilesX : 256;
    if (cells !== undefined && (side !== cells || (major === 1 && (tilesX !== 256 || tilesZ !== 256))))
        throw new RangeError(`WTR: ${tilesX} x ${tilesZ} tiles in a ${cells}-cell world`);
    const tiles = side * side;
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
        else if (id === "TMAP" && tmap === null) {
            if (size === tiles)
                tmap = off;
            else if (major === 2 || cells !== undefined)
                throw new RangeError(`WTR: TMAP is ${size} bytes; ${tilesX} x ${tilesZ} tiles need ${tiles}`);
        }
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
        const height = major === 2 ? i32(bytes, r + 4) : r32(bytes, r + 4);
        const seeds = [];
        for (let s = 0; s < ns; s++)
            seeds.push({ x: r16(bytes, r + 8 + 4 * s), z: r16(bytes, r + 10 + 4 * s) });
        const box = major === 2
            ? { minX: r16(bytes, r + 40), minZ: r16(bytes, r + 42), maxX: r16(bytes, r + 44), maxZ: r16(bytes, r + 46) }
            : { minX: bytes[r + 40], minZ: bytes[r + 41], maxX: bytes[r + 42], maxZ: bytes[r + 43] };
        lakes.push({
            id: i + 1, flags, reflective: (flags & WTR_FLAG_REFLECTIVE) !== 0, height, heightFt: height * WTR_HEIGHT_FT, seeds, box,
            tileCount: r32(bytes, r + (major === 2 ? 48 : 44)),
        });
    }
    const headerFlags = r32(bytes, 20);
    return { major, minor: r16(bytes, 6), headerFlags, edgeRule: (headerFlags & WTR_HEADER_EDGE_RULE) !== 0, tilesX, tilesZ, lakes, tileMap: tmap === null ? null : bytes.slice(tmap, tmap + tiles) };
}
/**
 * The valid lake heights, in half-feet, inclusive: version 1's 1..4096, or version 2's
 * 2 * base + 1 .. 2 * (base + 65536 / step), the terrain's whole range (9.1).
 */
export function wtrHeightRange(major, step = 128, base = 0) {
    return major === 2 ? [2 * base + 1, 2 * (base + 65536 / step)] : [1, 4096];
}
/**
 * Write a .WTR as Traxx 1.7 lays one out. Lake i gets id i + 1, which tileMap must use. The tile
 * map is N * N bytes, and N picks the version (9.1): 256 x 256 writes version 1 (heights 1..4096,
 * the CP4 file; a lake outside that throws), 512 x 512 version 2. `version`, when given, must agree.
 * `edgeRule` marks a file filled with the edge rule as Traxx 1.7.3 does (minor 1, header flags bit 0);
 * without it the header is Traxx 1.7.0's (minor 0, flags 0).
 */
export function writeWtr(lakes, tileMap, { version, edgeRule = false } = {}) {
    const cells = Math.round(Math.sqrt(tileMap.length));
    if (cells * cells !== tileMap.length || (cells !== 256 && cells !== 512))
        throw new RangeError("WTR: tile map must be 256 x 256 or 512 x 512 bytes");
    if (lakes.length < 1 || lakes.length > 255)
        throw new RangeError("WTR: 1 to 255 lakes");
    const major = cells === 512 ? 2 : 1;
    if (version !== undefined && version !== major)
        throw new RangeError(`WTR: a ${cells} x ${cells} map is version ${major}, not ${version}`);
    if (major === 1 && !lakes.every((k) => Number.isInteger(k.height) && k.height >= 1 && k.height <= 4096)) {
        throw new RangeError("WTR: a 256-cell world's lakes (version 1) are 1..4096 half-feet high (0.5 to 2,048 ft)");
    }
    const tiles = cells * cells;
    const bodySize = 8 + lakes.length * WTR_STRIDE;
    const bodyOff = WTR_HEADER + 32;
    const tmapOff = bodyOff + bodySize;
    const out = new Uint8Array(tmapOff + tiles);
    const v = new DataView(out.buffer);
    out.set([0x4d, 0x57, 0x54, 0x52]);
    v.setUint16(4, major, true);
    v.setUint16(6, edgeRule ? 1 : 0, true);
    v.setUint32(8, WTR_HEADER, true);
    v.setUint32(12, 2, true);
    v.setUint16(16, cells, true);
    v.setUint16(18, cells, true);
    v.setUint32(20, edgeRule ? WTR_HEADER_EDGE_RULE : 0, true);
    const dir = (o, id, off, size) => {
        for (let i = 0; i < 4; i++)
            out[o + i] = id.charCodeAt(i);
        v.setUint32(o + 4, 1, true);
        v.setUint32(o + 8, off, true);
        v.setUint32(o + 12, size, true);
    };
    dir(WTR_HEADER, "BODY", bodyOff, bodySize);
    dir(WTR_HEADER + 16, "TMAP", tmapOff, tiles);
    v.setUint32(bodyOff, lakes.length, true);
    v.setUint16(bodyOff + 4, WTR_STRIDE, true);
    lakes.forEach((k, i) => {
        const p = bodyOff + 8 + i * WTR_STRIDE;
        if (k.seeds.length < 1 || k.seeds.length > 8)
            throw new RangeError(`WTR: lake ${i + 1} needs 1 to 8 seeds`);
        if (!Number.isInteger(k.height) || k.height < -0x80000000 || k.height > 0x7fffffff)
            throw new RangeError(`WTR: lake ${i + 1} height ${k.height} is not a 32-bit integer`);
        const b = k.box;
        if ([b.minX, b.minZ, b.maxX, b.maxZ].some((t) => !Number.isInteger(t) || t < 0 || t >= cells))
            throw new RangeError(`WTR: lake ${i + 1} box is outside the ${cells} x ${cells} tiles`);
        out[p] = i + 1;
        out[p + 1] = k.seeds.length;
        v.setUint16(p + 2, k.flags, true);
        if (major === 2)
            v.setInt32(p + 4, k.height, true);
        else
            v.setUint32(p + 4, k.height, true);
        k.seeds.forEach((s, j) => { v.setUint16(p + 8 + 4 * j, s.x, true); v.setUint16(p + 10 + 4 * j, s.z, true); });
        if (major === 2) {
            v.setUint16(p + 40, b.minX, true);
            v.setUint16(p + 42, b.minZ, true);
            v.setUint16(p + 44, b.maxX, true);
            v.setUint16(p + 46, b.maxZ, true);
            v.setUint32(p + 48, k.tileCount, true);
        }
        else {
            out[p + 40] = b.minX;
            out[p + 41] = b.minZ;
            out[p + 42] = b.maxX;
            out[p + 43] = b.maxZ;
            v.setUint32(p + 44, k.tileCount, true);
        }
    });
    out.set(tileMap, tmapOff);
    return out;
}
/** The lake id (0 none) of the 32 ft tile under world feet (x, z); the world wraps at 32 N ft, N the map's side. */
export function wtrLakeAt(wtr, xFt, zFt) {
    if (!wtr.tileMap)
        return 0;
    const n = wtr.tileMap.length === 512 * 512 ? 512 : 256, m = n - 1;
    const tx = Math.floor(xFt / 32) & m;
    const tz = Math.floor(zFt / 32) & m;
    return wtr.tileMap[tx + tz * n];
}
