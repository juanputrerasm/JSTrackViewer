/*
  The MTM2 level palette, ART\<track>.ACT, and its RGB555 lookup, FOG\<track>.MAP.

  These matter more than "HD track" suggests. HD registration (a PNG drawn at its own colour
  depth) is a DX11/Vulkan path; the software and DX9 renderers read the same PNG but quantise it
  into this palette on the way in, so a palette that does not describe the track's art leaves
  the track posterised for most players.

  Ported from JSMTM2Converter's src/convert/palette.js.
*/
import { colourCube, medianCutPalette } from "../texture/encode.js";
/*
  The indices reserved either side of the authored band, byte for byte as stock levels write
  them: the Windows system colours below, and the system/UI band from 230 up.
*/
const SYSTEM_LOW = [
    0, 0, 0, 128, 0, 0, 0, 128, 0, 128, 128, 0, 0, 0, 128,
    128, 0, 128, 0, 128, 128, 192, 192, 192, 192, 220, 192, 166, 202, 240,
];
const SYSTEM_HIGH = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    255, 251, 240, 160, 160, 164, 128, 128, 128, 255, 0, 0, 0, 255, 0,
    255, 255, 0, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255,
];
/*
  229 is white and is not available to author. STARTUP.POD's FOG\VGA.LTE is a 32-level shade
  table whose top row maps every index to 229, and every stock level's 229 is white or near it
  (TPARK 252,252,252; BAJA 255,255,255). Letting a median cut have it hands the brightest shade
  row whatever colour the track used most; 226..228 show it is only this one entry.
*/
export const MTM2_PALETTE_WHITE_INDEX = 229;
/** The first index a level authors. */
export const MTM2_PALETTE_FIRST_AUTHORED = 10;
/** How many it authors: 10..228. */
export const MTM2_PALETTE_AUTHORED_COUNT = MTM2_PALETTE_WHITE_INDEX - MTM2_PALETTE_FIRST_AUTHORED;
/** The first index of the system/UI band. */
const SYSTEM_HIGH_FIRST = 230;
/**
 * An MTM2 level palette: the system bands, the authored band median-cut from `histogram` (see
 * sampleForPalette), and white at 229. Without a histogram the authored band is a colour cube.
 */
export function mtm2LevelPalette(histogram = null) {
    const act = new Uint8Array(768);
    act.set(SYSTEM_LOW);
    act.set(SYSTEM_HIGH, SYSTEM_HIGH_FIRST * 3);
    const authored = histogram?.size ? medianCutPalette(histogram, MTM2_PALETTE_AUTHORED_COUNT) : colourCube();
    for (let i = 0; i < MTM2_PALETTE_AUTHORED_COUNT; i++) {
        const colour = authored[i] ?? authored[authored.length - 1] ?? [0, 0, 0];
        act.set(colour, (MTM2_PALETTE_FIRST_AUTHORED + i) * 3);
    }
    act.set([252, 252, 252], MTM2_PALETTE_WHITE_INDEX * 3);
    return act;
}
/*
  FOG\<track>.MAP: MTM2's RGB555-to-palette lookup for its indexed-art loader, 32,768 bytes
  indexed r5 * 1024 + g5 * 32 + b5. Each entry is the nearest colour in the authored band and
  white (10..229), sampled at the centre of its RGB555 cell; the system bands are never targets.

  Byte zero is a palette selector an editor may scribble on, not an RGB555 entry. Every stock
  map stores 0 there and Traxx forces 0 back on save.
*/
export function buildFogMap(palette) {
    const map = new Uint8Array(32 * 32 * 32);
    let offset = 0;
    for (let r5 = 0; r5 < 32; r5++)
        for (let g5 = 0; g5 < 32; g5++)
            for (let b5 = 0; b5 < 32; b5++) {
                const r = r5 * 8 + 3, g = g5 * 8 + 3, b = b5 * 8 + 3;
                let best = MTM2_PALETTE_FIRST_AUTHORED, distance = Infinity;
                for (let index = MTM2_PALETTE_FIRST_AUTHORED; index <= MTM2_PALETTE_WHITE_INDEX; index++) {
                    const at = index * 3;
                    const dr = palette[at] - r, dg = palette[at + 1] - g, db = palette[at + 2] - b;
                    const candidate = dr * dr + dg * dg + db * db;
                    if (candidate <= distance) {
                        distance = candidate;
                        best = index;
                    }
                }
                map[offset++] = best;
            }
    map[0] = 0;
    return map;
}
