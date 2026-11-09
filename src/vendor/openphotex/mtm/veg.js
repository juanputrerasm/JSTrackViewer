/*
  WORLD\<stem>.VEG, Community Patch 4's MTM2 vegetation (binary, magic "MVEG"). Not to be
  confused with 4x4 Evolution's text .VEG (src/evo/veg.ts): same extension, different game.

  The file holds placements already made: Traxx 1.7 plants the trees and grass from painted
  masks (ART\<stem>_V.PNG trees, ART\<stem>_G.PNG grass, shipped in the pod but never read by the
  engine) and the engine draws what the file says. It is only read from the track's own pod.
  Limits the engine documents through Traxx: 60 species of which at most 16 ground (grass),
  30,000 trees, 131,072 clumps, 1,024 clumps a tile.

  Layout, little-endian (Traxx TrackPODVegetation.cpp BuildVEG):

    header (32)  "MVEG", u16 major 1, u16 minor 0, u32 header size 32, u32 chunk count,
                 u16 tiles X 256, u16 tiles Z 256, u32 flags 0, 8 zero bytes
    directory    16 bytes a chunk: id[4], u32 version 1, u32 offset, u32 length;
                 SPEC, TREE, GRAS, RULE, INFO in that order, an empty one left out

    SPEC  u32 n, u16 stride 192, u16 0; per species:
            0 char[64] model (bare name, e.g. PINE01.BIN)    64 char[64] far-card model
            128 u8 kind (0 placed tree, 1 ground/grass)       129 u8 collide (0 none, 1 trunk, 2 model)
            130 u8 flags (1 cast shadow, 2 far shadow, 4 cross-fade, 8 facing: always turned to the
                camera, so the engine draws it with no far card)
            132 u16 trunk diameter, 1/64 ft                   134 u16 trunk height, 1/16 ft
            136 u16 model fade near, 138 u16 far; 140 u16 far-card band near, 142 u16 far;
            144 u32 grass draw distance; 148 char[32] name (all ft; the CP4 engine reads them,
            0 meaning its defaults 900 / 1000 ft and vegGrassDist; Traxx 1.7 writes them as 0)
    TREE  u32 n, u16 stride 20, u16 0; per tree, sorted by 32 ft tile (z, then x):
            0 i32 x, 4 i32 y, 8 i32 z (1/256 ft; y is the model origin)
            12 u16 species   14 u16 heading (1/65536 turn)   16 u16 scale (x 4096, at least 256)
            18 u8 tint (128)  19 u8 tier (scenery detail: 0 sparse, 1 normal, 2 complex)
    GRAS  u32 n, u16 stride 12, u16 0, u32 tile count; then per tile {u16 tx, u16 tz, u32 first,
          u32 count}, ascending by (tz, tx); then the clumps, grouped by tile (their order inside
          a tile is random and the engine's density thinning relies on it):
            0 u16 species   2 u8 fx, 3 u8 fz (1/8 ft inside the tile)   4 i32 y (1/256 ft)
            8 u8 heading (1/256 turn)   9 u8 scale (0.25 + s / 64)   10 u8 tint (128)   11 0
    RULE  Traxx's planting recipe, CRLF key=value text; the engine never reads it. A .VEG
          without one came from another tool and Traxx keeps it read-only.
    INFO  CRLF key=value text: tool, toolVersion, built, trees, clumps.
*/
export const VEG_MAGIC = "MVEG";
export const VEG_SPEC_STRIDE = 192;
export const VEG_TREE_STRIDE = 20;
export const VEG_CLUMP_STRIDE = 12;
/** Position units per foot (TREE x/y/z and clump y). */
export const VEG_UNITS_PER_FT = 256;
export const VEG_KIND_PLACED = 0;
export const VEG_KIND_GROUND = 1;
export const VEG_FLAG_CAST_SHADOW = 1;
export const VEG_FLAG_FAR_SHADOW = 2;
export const VEG_FLAG_CROSSFADE = 4;
export const VEG_FLAG_FACING = 8;
export const VEG_COLLIDE = ["none", "trunk", "model"];
const r16 = (b, o) => b[o] | (b[o + 1] << 8);
const r32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const latin1 = new TextDecoder("latin1");
function cstr(b, o, n) {
    let e = o;
    while (e < o + n && b[e] !== 0)
        e++;
    return latin1.decode(b.subarray(o, e));
}
export function isMtm2Veg(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x4d && bytes[1] === 0x56 && bytes[2] === 0x45 && bytes[3] === 0x47;
}
function keyValues(text) {
    const out = {};
    for (const line of text.split(/\r\n|\r|\n/)) {
        const eq = line.indexOf("=");
        if (eq > 0 && !line.startsWith("#"))
            out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return out;
}
function emptyTrees() {
    return { count: 0, position: new Int32Array(0), species: new Uint16Array(0), heading: new Uint16Array(0), scale: new Uint16Array(0), tint: new Uint8Array(0), tier: new Uint8Array(0) };
}
function emptyClumps() {
    return { count: 0, tiles: [], species: new Uint16Array(0), offset: new Uint8Array(0), y: new Int32Array(0), heading: new Uint8Array(0), scale: new Uint8Array(0), tint: new Uint8Array(0) };
}
export function parseMtm2Veg(bytes) {
    if (bytes.length < 32 || !isMtm2Veg(bytes))
        throw new RangeError("VEG: not an MVEG file");
    const major = r16(bytes, 4);
    if (major > 1)
        throw new RangeError(`VEG: major version ${major} needs a newer reader`);
    const headerSize = r32(bytes, 8);
    const count = r32(bytes, 12);
    if (headerSize < 32 || headerSize > bytes.length || count > (bytes.length - headerSize) / 16)
        throw new RangeError("VEG: bad header");
    const chunks = new Map();
    for (let i = 0; i < count; i++) {
        const e = headerSize + i * 16;
        const id = latin1.decode(bytes.subarray(e, e + 4));
        const ver = r32(bytes, e + 4), off = r32(bytes, e + 8), len = r32(bytes, e + 12);
        if (ver !== 1 || off > bytes.length || len > bytes.length - off || chunks.has(id))
            continue;
        chunks.set(id, [off, len]);
    }
    const species = [];
    const spec = chunks.get("SPEC");
    if (spec) {
        const [o] = spec;
        const n = r32(bytes, o), stride = r16(bytes, o + 4);
        if (stride < 136 || 8 + n * stride > spec[1])
            throw new RangeError("VEG: bad SPEC chunk");
        for (let i = 0; i < n; i++) {
            const p = o + 8 + i * stride;
            species.push({
                model: cstr(bytes, p, 64), farModel: cstr(bytes, p + 64, 64), kind: bytes[p + 128], collide: bytes[p + 129],
                flags: bytes[p + 130], trunkDiameter: r16(bytes, p + 132), trunkHeight: r16(bytes, p + 134),
                ...(stride >= 0xb4 ? {
                    modelFade: [r16(bytes, p + 136), r16(bytes, p + 138)],
                    cardBand: [r16(bytes, p + 140), r16(bytes, p + 142)],
                    grassDistance: r32(bytes, p + 144), name: cstr(bytes, p + 148, 32),
                } : {}),
            });
        }
    }
    let trees = emptyTrees();
    const tree = chunks.get("TREE");
    if (tree) {
        const [o] = tree;
        const n = r32(bytes, o), stride = r16(bytes, o + 4);
        if (stride < VEG_TREE_STRIDE || 8 + n * stride > tree[1])
            throw new RangeError("VEG: bad TREE chunk");
        trees = { count: n, position: new Int32Array(3 * n), species: new Uint16Array(n), heading: new Uint16Array(n), scale: new Uint16Array(n), tint: new Uint8Array(n), tier: new Uint8Array(n) };
        for (let i = 0; i < n; i++) {
            const p = o + 8 + i * stride;
            trees.position[3 * i] = i32(bytes, p);
            trees.position[3 * i + 1] = i32(bytes, p + 4);
            trees.position[3 * i + 2] = i32(bytes, p + 8);
            trees.species[i] = r16(bytes, p + 12);
            trees.heading[i] = r16(bytes, p + 14);
            trees.scale[i] = r16(bytes, p + 16);
            trees.tint[i] = bytes[p + 18];
            trees.tier[i] = bytes[p + 19];
        }
    }
    let clumps = emptyClumps();
    const gras = chunks.get("GRAS");
    if (gras) {
        const [o] = gras;
        const n = r32(bytes, o), stride = r16(bytes, o + 4), ntiles = r32(bytes, o + 8);
        const base = o + 12 + ntiles * 12;
        if (stride < VEG_CLUMP_STRIDE || base - o + n * stride > gras[1])
            throw new RangeError("VEG: bad GRAS chunk");
        const tiles = [];
        for (let t = 0; t < ntiles; t++) {
            const p = o + 12 + t * 12;
            tiles.push({ tx: r16(bytes, p), tz: r16(bytes, p + 2), first: r32(bytes, p + 4), count: r32(bytes, p + 8) });
        }
        clumps = { count: n, tiles, species: new Uint16Array(n), offset: new Uint8Array(2 * n), y: new Int32Array(n), heading: new Uint8Array(n), scale: new Uint8Array(n), tint: new Uint8Array(n) };
        for (let i = 0; i < n; i++) {
            const p = base + i * stride;
            clumps.species[i] = r16(bytes, p);
            clumps.offset[2 * i] = bytes[p + 2];
            clumps.offset[2 * i + 1] = bytes[p + 3];
            clumps.y[i] = i32(bytes, p + 4);
            clumps.heading[i] = bytes[p + 8];
            clumps.scale[i] = bytes[p + 9];
            clumps.tint[i] = bytes[p + 10];
        }
    }
    const text = (id) => { const c = chunks.get(id); return c ? latin1.decode(bytes.subarray(c[0], c[0] + c[1])) : null; };
    const info = text("INFO");
    return { major, minor: r16(bytes, 6), species, trees, clumps, rule: text("RULE"), info: info ? keyValues(info) : {} };
}
/** A tree's world feet and scale, for drawing. */
export function vegTreeAt(trees, i) {
    return {
        x: trees.position[3 * i] / VEG_UNITS_PER_FT, y: trees.position[3 * i + 1] / VEG_UNITS_PER_FT, z: trees.position[3 * i + 2] / VEG_UNITS_PER_FT,
        headingTurns: trees.heading[i] / 65536, scale: trees.scale[i] / 4096,
    };
}
/** A clump's world feet and scale, for drawing (tiles are 32 ft). */
export function vegClumpAt(clumps, tile, i) {
    return {
        x: tile.tx * 32 + clumps.offset[2 * i] / 8, y: clumps.y[i] / VEG_UNITS_PER_FT, z: tile.tz * 32 + clumps.offset[2 * i + 1] / 8,
        headingTurns: clumps.heading[i] / 256, scale: 0.25 + clumps.scale[i] / 64,
    };
}
/**
 * Write a .VEG in Traxx 1.7's layout. Trees are written sorted by 32 ft tile (z, then x, stable),
 * as Traxx does; clumps must already be grouped by tile in ascending (tz, tx) order.
 * `rule` and `info` are written verbatim when given (CRLF text).
 */
export function writeMtm2Veg(veg) {
    const parts = [];
    const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
    if (veg.species.length) {
        const b = new Uint8Array(8 + veg.species.length * VEG_SPEC_STRIDE);
        const v = new DataView(b.buffer);
        v.setUint32(0, veg.species.length, true);
        v.setUint16(4, VEG_SPEC_STRIDE, true);
        veg.species.forEach((s, i) => {
            const p = 8 + i * VEG_SPEC_STRIDE;
            b.set(enc(s.model).subarray(0, 63), p);
            b.set(enc(s.farModel).subarray(0, 63), p + 64);
            b[p + 128] = s.kind;
            b[p + 129] = s.kind === VEG_KIND_GROUND ? 0 : s.collide;
            b[p + 130] = s.flags;
            v.setUint16(p + 132, s.trunkDiameter, true);
            v.setUint16(p + 134, s.trunkHeight, true);
            if (s.modelFade) {
                v.setUint16(p + 136, s.modelFade[0], true);
                v.setUint16(p + 138, s.modelFade[1], true);
            }
            if (s.cardBand) {
                v.setUint16(p + 140, s.cardBand[0], true);
                v.setUint16(p + 142, s.cardBand[1], true);
            }
            if (s.grassDistance)
                v.setUint32(p + 144, s.grassDistance, true);
            if (s.name)
                b.set(enc(s.name).subarray(0, 31), p + 148);
        });
        parts.push(["SPEC", b]);
    }
    const t = veg.trees;
    if (t.count) {
        const order = Array.from({ length: t.count }, (_, i) => i);
        const tileOf = (i) => [Math.trunc(t.position[3 * i + 2] / 8192), Math.trunc(t.position[3 * i] / 8192)];
        order.sort((a, b) => { const [az, ax] = tileOf(a), [bz, bx] = tileOf(b); return az - bz || ax - bx || a - b; });
        const b = new Uint8Array(8 + t.count * VEG_TREE_STRIDE);
        const v = new DataView(b.buffer);
        v.setUint32(0, t.count, true);
        v.setUint16(4, VEG_TREE_STRIDE, true);
        order.forEach((i, k) => {
            const p = 8 + k * VEG_TREE_STRIDE;
            v.setInt32(p, t.position[3 * i], true);
            v.setInt32(p + 4, t.position[3 * i + 1], true);
            v.setInt32(p + 8, t.position[3 * i + 2], true);
            v.setUint16(p + 12, t.species[i], true);
            v.setUint16(p + 14, t.heading[i], true);
            v.setUint16(p + 16, Math.max(256, t.scale[i]), true);
            b[p + 18] = 128;
            b[p + 19] = t.tier[i];
        });
        parts.push(["TREE", b]);
    }
    const c = veg.clumps;
    if (c.count) {
        const b = new Uint8Array(12 + c.tiles.length * 12 + c.count * VEG_CLUMP_STRIDE);
        const v = new DataView(b.buffer);
        v.setUint32(0, c.count, true);
        v.setUint16(4, VEG_CLUMP_STRIDE, true);
        v.setUint32(8, c.tiles.length, true);
        c.tiles.forEach((tile, k) => {
            const p = 12 + k * 12;
            v.setUint16(p, tile.tx, true);
            v.setUint16(p + 2, tile.tz, true);
            v.setUint32(p + 4, tile.first, true);
            v.setUint32(p + 8, tile.count, true);
        });
        const base = 12 + c.tiles.length * 12;
        for (let i = 0; i < c.count; i++) {
            const p = base + i * VEG_CLUMP_STRIDE;
            v.setUint16(p, c.species[i], true);
            b[p + 2] = c.offset[2 * i];
            b[p + 3] = c.offset[2 * i + 1];
            v.setInt32(p + 4, c.y[i], true);
            b[p + 8] = c.heading[i];
            b[p + 9] = c.scale[i];
            b[p + 10] = 128;
        }
        parts.push(["GRAS", b]);
    }
    if (veg.rule)
        parts.push(["RULE", enc(veg.rule)]);
    if (veg.info)
        parts.push(["INFO", enc(veg.info)]);
    let offset = 32 + parts.length * 16;
    const total = parts.reduce((n, [, b]) => n + b.length, offset);
    const out = new Uint8Array(total);
    const v = new DataView(out.buffer);
    out.set(enc("MVEG"));
    v.setUint16(4, 1, true);
    v.setUint32(8, 32, true);
    v.setUint32(12, parts.length, true);
    v.setUint16(16, 256, true);
    v.setUint16(18, 256, true);
    parts.forEach(([id, b], k) => {
        const e = 32 + k * 16;
        out.set(enc(id), e);
        v.setUint32(e + 4, 1, true);
        v.setUint32(e + 8, offset, true);
        v.setUint32(e + 12, b.length, true);
        out.set(b, offset);
        offset += b.length;
    });
    return out;
}
