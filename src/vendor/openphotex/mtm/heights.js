/*
  MTM2 track heights, classic and Community Patch 4.

  Classic MTM2 stores DATA\<stem>.RAW as 256 x 256 bytes: one unsigned byte per 32 ft grid
  corner, a byte step being 2 ft (0 to 510 ft). Community Patch 4 (beta 0.52, Traxx 1.7.0) adds
  three 16-bit terrain grids, told apart by the height file's length and the track's .TXV
  `terrainGrid` key:

    length      samples             mode        surface
    65,536      u8   256 x 256      classic8    flat 32 ft triangles (the original game)
    131,072     u16  256 x 256      classic16   flat 32 ft triangles, finer steps
    131,072     u16  256 x 256      spline      terrainGrid=spline: the engine expands the map
                                                to 1024 x 1024 (8 ft) with terrainspline.c and
                                                drives on that (src/terrain/spline.ts)
    2,097,152   u16  1024 x 1024    fine        "Full Map": 8 ft heights stored as authored

  16-bit samples are little-endian, rows along Z, and count 1/128 ft: feet = v / 128, so the
  range is 0 to 511.99 ft, the same ceiling as classic, at a 1/128 ft (about 2.4 mm) step. A
  classic byte b is the 16-bit value b << 8. The engine keeps only v >> 1 (1/64 ft, about 4.8 mm,
  in signed 16 bits): `mtm2EngineHeightsFt` gives the heights the game actually drives on. The ground boxes (.RA0/.RA1/.CL0), .CLR and .LTE
  stay 256 x 256 at 32 ft in every mode.

  A track can instead name a 16-bit grey PNG with the .TXV key `terrainHeights`
  (DATA\<stem>_H.PNG, 256 or 1024 square, 8-bit samples meaning b << 8): see decodeMtm2HeightPng.

  Mode rules follow Traxx 1.7's ResolveTerrainMode (TrackPODTerrain.cpp), which was written
  against the engine's contract: a 1024-square file is always fine; a 256-square file is classic
  by width unless the key says spline; a key of "fine" on a 256-square file falls back to
  classic. The engine's own log strings (CP4 monster.exe 2.0.52.2) agree on the accepted sizes.

  CART Precision Racing also ships 131,072-byte u16 terrain, at a different scale (10.6 fixed
  point in 4 ft steps, src/terrain/height.ts). The length cannot tell them apart; the caller knows
  which game a level belongs to and uses this decoder only for MTM2 levels.
*/
import { terrainSplineExpand } from "../terrain/spline.js";
import { decodePngSamples } from "../texture/png.js";
/** 16-bit height units per foot. */
export const MTM2_H16_PER_FT = 128;
export const MTM2_RAW_LENGTH_8BIT = 65536;
export const MTM2_RAW_LENGTH_16BIT = 131072;
export const MTM2_RAW_LENGTH_FINE = 2097152;
/** Fine-grid spacing in feet (the coarse grid is 32 ft). */
export const MTM2_FINE_CELL_FT = 8;
/** The .TXV `terrainGrid` value as a mode, null when absent, "unknown" for a value no tool knows. */
export function parseTerrainGridKey(value) {
    if (value == null)
        return null;
    const v = value.trim().toLowerCase();
    if (v === "")
        return null;
    if (v === "classic" || v === "spline" || v === "fine")
        return v;
    return "unknown";
}
/** The terrain mode for a height file of `length` bytes and a .TXV `terrainGrid` value. */
export function resolveMtm2TerrainMode(length, terrainGrid) {
    const key = parseTerrainGridKey(terrainGrid);
    if (length === MTM2_RAW_LENGTH_FINE) {
        const warning = key === "fine" ? null
            : key === "spline" ? "terrainGrid=spline but the height file is 1024 x 1024: read as a Full Map"
                : key === "unknown" ? `unknown terrainGrid value "${terrainGrid}": the height file is 1024 x 1024, read as a Full Map`
                    : key === "classic" ? "terrainGrid=classic but the height file is 1024 x 1024: read as a Full Map"
                        : null;
        return { mode: "fine", warning };
    }
    if (length !== MTM2_RAW_LENGTH_8BIT && length !== MTM2_RAW_LENGTH_16BIT) {
        throw new RangeError(`MTM2 height file is ${length} bytes; expected 65536 (8-bit 256x256), 131072 (16-bit 256x256) or 2097152 (16-bit 1024x1024)`);
    }
    const base = length === MTM2_RAW_LENGTH_16BIT ? "classic16" : "classic8";
    if (key === "spline")
        return { mode: "spline", warning: null };
    if (key === "fine")
        return { mode: base, warning: "terrainGrid=fine but the height file is 256 x 256: read as a 32 ft grid" };
    if (key === "unknown")
        return { mode: base, warning: `unknown terrainGrid value "${terrainGrid}": read as a 32 ft grid` };
    return { mode: base, warning: null };
}
function u16le(bytes, count) {
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++)
        out[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8);
    return out;
}
function coarseOfFine(fine) {
    const coarse = new Uint16Array(65536);
    for (let z = 0; z < 256; z++)
        for (let x = 0; x < 256; x++)
            coarse[z * 256 + x] = fine[4 * z * 1024 + 4 * x];
    return coarse;
}
function finish(mode, coarse, fine, warning) {
    if (mode === "spline")
        fine = terrainSplineExpand(coarse);
    if (mode === "fine" && fine)
        coarse = coarseOfFine(fine);
    return { mode, coarse, fine: mode === "spline" || mode === "fine" ? fine : null, warning };
}
/** Decode DATA\<stem>.RAW of an MTM2 track. */
export function decodeMtm2Heights(bytes, terrainGrid) {
    const { mode, warning } = resolveMtm2TerrainMode(bytes.length, terrainGrid);
    if (bytes.length === MTM2_RAW_LENGTH_8BIT) {
        const coarse = new Uint16Array(65536);
        for (let i = 0; i < 65536; i++)
            coarse[i] = bytes[i] << 8;
        return finish(mode, coarse, null, warning);
    }
    if (bytes.length === MTM2_RAW_LENGTH_16BIT)
        return finish(mode, u16le(bytes, 65536), null, warning);
    return finish(mode, new Uint16Array(0), u16le(bytes, 1024 * 1024), warning);
}
/**
 * Decode a CP4 height PNG (.TXV terrainHeights): grey or grey + alpha (alpha ignored), 8 or 16
 * bits, 256 or 1024 square. 8-bit samples mean b << 8 (2 ft steps). A 1024-square image is a Full
 * Map; a 256-square one is classic16, or spline when terrainGrid says so.
 */
export function decodeMtm2HeightPng(bytes, terrainGrid) {
    const png = decodePngSamples(bytes);
    if (png.colorType !== 0 && png.colorType !== 4)
        throw new RangeError("height PNG must be greyscale (RGB and palette images are refused, as the engine does)");
    if (png.width !== png.height || (png.width !== 256 && png.width !== 1024)) {
        throw new RangeError(`height PNG is ${png.width} x ${png.height}; expected 256 x 256 or 1024 x 1024`);
    }
    const n = png.width * png.height;
    const v = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
        const s = png.samples[i * png.channels];
        v[i] = png.bitDepth === 8 ? s << 8 : s;
    }
    const warning8 = png.bitDepth === 8 && png.width === 1024 ? "Full Map height PNG is 8-bit: 2 ft height steps only" : null;
    if (png.width === 1024) {
        const r = resolveMtm2TerrainMode(MTM2_RAW_LENGTH_FINE, terrainGrid);
        return { ...finish("fine", new Uint16Array(0), v, r.warning ?? warning8), bitDepth: png.bitDepth };
    }
    const r = resolveMtm2TerrainMode(MTM2_RAW_LENGTH_16BIT, terrainGrid);
    return { ...finish(r.mode, v, null, r.warning), bitDepth: png.bitDepth };
}
/**
 * Heights in feet as the CP4 engine holds them: it stores every 16-bit sample as v >> 1 in signed 16 bits, 1/64 ft a
 * step (CP4 monster.exe 2.0.52.2, OpenMTM2 docs/CP4_EXE_ANALYSIS.md 1), dropping the file's lowest bit. Spline
 * expansion runs on v first and the shift comes after, so pass the expanded grid. This is what a game should drive on.
 */
export function mtm2EngineHeightsFt(v) {
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++)
        out[i] = (v[i] >> 1) / 64;
    return out;
}
/** Heights in feet (v / 128) of a 1/128 ft grid, at the file's full precision (an editor's view). */
export function mtm2HeightsToFeet(v) {
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++)
        out[i] = v[i] / MTM2_H16_PER_FT;
    return out;
}
