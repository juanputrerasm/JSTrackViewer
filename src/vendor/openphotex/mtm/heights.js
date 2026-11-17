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
    if (png.bitDepth !== 8 && png.bitDepth !== 16)
        throw new RangeError(`png: bit depth ${png.bitDepth} is not supported`);
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
/** log2 of an allowed terrainHeightStep, or a RangeError. */
function stepShift(step) {
    const shift = Math.log2(step);
    if (!Number.isInteger(shift) || shift < 0 || shift > 7)
        throw new RangeError(`terrainHeightStep=${step}; allowed: 1, 2, 4, 8, 16, 32, 64 or 128`);
    return shift;
}
function v6Mode(side, cells, terrainGrid) {
    const key = terrainGrid == null || terrainGrid === "" ? null : terrainGrid.toLowerCase();
    if (key !== null && key !== "classic" && key !== "spline" && key !== "fine")
        throw new RangeError(`TXV: terrainGrid=${terrainGrid}; allowed: classic, spline or fine`);
    if (side === 4 * cells) {
        return { mode: "fine", warning: key === null || key === "fine" ? null : `terrainGrid=${key} but the height file is ${side} x ${side}: read as 8 ft heights` };
    }
    if (key === "spline")
        return { mode: "spline", warning: null };
    if (key === "fine")
        return { mode: "classic", warning: `terrainGrid=fine but the height file is ${side} x ${side}: read as a 32 ft grid` };
    return { mode: "classic", warning: null };
}
/**
 * Decode a version 6 terrainHeightMap entry. `name` (the key's value) says PNG or RAW by its
 * extension; `cells` is worldCells; `step` and `base` the .TXV's (they are carried, not applied).
 * A file of the wrong size, depth or colour type is refused with a RangeError.
 */
export function decodeMtm2V6Heights(bytes, opts) {
    const { name, cells } = opts;
    const step = opts.step ?? 128, base = opts.base ?? 0;
    stepShift(step);
    if (cells !== 256 && cells !== 512)
        throw new RangeError(`worldCells=${cells}; allowed: 256 or 512`);
    const fineSide = 4 * cells;
    let side, samples, bitDepth = 16;
    if (/\.png$/i.test(name)) {
        const png = decodePngSamples(bytes);
        if (png.colorType !== 0 && png.colorType !== 4)
            throw new RangeError(`${name}: a height PNG must be greyscale (colour type 0 or 4), not colour type ${png.colorType}`);
        if (png.bitDepth !== 8 && png.bitDepth !== 16)
            throw new RangeError(`${name}: a height PNG must be 8 or 16-bit, not ${png.bitDepth}-bit`);
        if (png.width !== png.height || (png.width !== cells && png.width !== fineSide)) {
            throw new RangeError(`${name} is ${png.width} x ${png.height}; a ${cells}-cell world needs ${cells} x ${cells} or ${fineSide} x ${fineSide}`);
        }
        side = png.width;
        bitDepth = png.bitDepth;
        samples = new Uint16Array(side * side);
        for (let i = 0; i < samples.length; i++) {
            const s = png.samples[i * png.channels];
            samples[i] = bitDepth === 8 ? s << 8 : s;
        }
    }
    else if (/\.raw$/i.test(name)) {
        const coarseBytes = 2 * cells * cells, fineBytes = 2 * fineSide * fineSide;
        if (bytes.length !== coarseBytes && bytes.length !== fineBytes) {
            throw new RangeError(`${name} is ${bytes.length} bytes; a ${cells}-cell world needs ${coarseBytes} (${cells} x ${cells}) or ${fineBytes} (${fineSide} x ${fineSide}) bytes of u16 samples`);
        }
        side = bytes.length === coarseBytes ? cells : fineSide;
        samples = u16le(bytes, side * side);
    }
    else {
        throw new RangeError(`terrainHeightMap=${name}; it must name a .PNG or a .RAW`);
    }
    const { mode, warning } = v6Mode(side, cells, opts.terrainGrid);
    let coarse, fine = null;
    if (side === fineSide) {
        fine = samples;
        coarse = new Uint16Array(cells * cells);
        for (let z = 0; z < cells; z++)
            for (let x = 0; x < cells; x++)
                coarse[z * cells + x] = fine[4 * z * fineSide + 4 * x];
    }
    else {
        coarse = samples;
        if (mode === "spline")
            fine = terrainSplineExpand(coarse, cells);
    }
    const warning8 = bitDepth === 8 && side === fineSide ? "8-bit fine height PNG: 256 sample steps only" : null;
    return { mode, cells, coarse, fine, step, base, bitDepth, warning: warning ?? warning8 };
}
/** Samples to the recommended engine store (section 7.3): h128 = (sample << (7 - log2 step)) + base * 128, in 1/128 ft. */
export function mtm2V6HeightsH128(samples, step, base) {
    const shift = 7 - stepShift(step), offset = base * 128;
    const out = new Int32Array(samples.length);
    for (let i = 0; i < samples.length; i++)
        out[i] = (samples[i] << shift) + offset;
    return out;
}
/** Samples to feet, base + sample / step. Exact in a Float32 (the 1/128 ft store fits its 24-bit mantissa). */
export function mtm2V6HeightsFt(samples, step, base) {
    const shift = 7 - stepShift(step), offset = base * 128;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++)
        out[i] = ((samples[i] << shift) + offset) / 128;
    return out;
}
/**
 * The step and base a writer picks for heights spanning lowFt..highFt (section 11): base the
 * floor of the lowest point, step the largest power of two up to 128 with (high - base) * step at
 * most 65535. A span over 65535 ft cannot be stored and throws.
 */
export function mtm2V6StepAndBase(lowFt, highFt) {
    if (!Number.isFinite(lowFt) || !Number.isFinite(highFt) || highFt < lowFt)
        throw new RangeError(`heights ${lowFt}..${highFt} ft are not a range`);
    const base = Math.floor(lowFt);
    if (base < -32768 || base > 32767)
        throw new RangeError(`lowest point ${lowFt} ft: terrainHeightBase must be -32768..32767`);
    for (let step = 128; step >= 1; step >>= 1)
        if ((highFt - base) * step <= 65535)
            return { step, base };
    throw new RangeError(`heights span ${highFt - base} ft; the most a track can hold is 65535 ft`);
}
/** Feet to samples for a step and base: round(( ft - base) * step), refused outside 0..65535. */
export function mtm2V6SamplesFromFt(feet, step, base) {
    stepShift(step);
    const out = new Uint16Array(feet.length);
    for (let i = 0; i < feet.length; i++) {
        const s = Math.round((feet[i] - base) * step);
        if (!(s >= 0 && s <= 65535))
            throw new RangeError(`height ${feet[i]} ft does not fit terrainHeightBase=${base}, terrainHeightStep=${step}`);
        out[i] = s;
    }
    return out;
}
/** A u16 RAW height file (little-endian samples, row by row): the .RAW form of terrainHeightMap. */
export function encodeMtm2HeightRaw16(samples) {
    const out = new Uint8Array(2 * samples.length);
    for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        if (!(Number.isInteger(v) && v >= 0 && v <= 65535))
            throw new RangeError(`height sample ${i} = ${v} is not a u16`);
        out[2 * i] = v & 0xff;
        out[2 * i + 1] = v >> 8;
    }
    return out;
}
