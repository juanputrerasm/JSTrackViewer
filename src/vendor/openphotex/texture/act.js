/*
  .ACT palettes.

  Ported from JSTrackViewer's src/worker/texture-decoder.js, the behavioural baseline. See
  docs/RAW_ACT.md for the evidence.
*/
/** Bytes in an .ACT palette: 256 RGB triples. Longer files carry extra data after it. */
export const ACT_PALETTE_SIZE = 256 * 3;
/*
  ACT files in this family come in two bit depths and the file itself does not say which:

    - Adobe ACT, full 8-bit channels, 0..255.
    - VGA palettes, 6-bit channels, 0..63, which is what the era's hardware DACs took.

  A 6-bit palette used as if it were 8-bit renders at roughly a quarter brightness, which is
  the "everything is nearly black" look. Detection is by content: if any channel byte exceeds
  63 the palette must be 8-bit, because a 6-bit one cannot produce that value.

  Not exceeding 63 is NOT enough to call it 6-bit, though. The rule used to be exactly that,
  and it brightened every genuinely dark 8-bit palette about fourfold. Across all 7,356 .ACT
  files in the stock MTM1, MTM2, CPR, TV, Fury3 and Hellbender PODs there are 40 whose
  channels stay at or under 63, and every one is simply a dark palette: MI4BLACK, RA4BLACK
  (all zeros), NITESKY, the TSHADOW truck shadows, Hellbender's CAVSKY, and Laguna's LAGQ28CC,
  LAGQ28D9 and LAGQ799, the walkway's shadow baked into three road quads, which came out as
  bright tan dirt. None of the 40 reaches 63; the brightest is 60. The 7,038 stock 4x4
  Evolution palettes agree: 10 stay under 63 (NITESKY, RAINSKY, GLARE, all-zero BOMB and
  DETAIL), none reaches it.

  A real VGA palette is a DAC table and uses its full range, so its brightest channel is 63.
  That is the test: a palette is 6-bit when its largest channel byte is exactly 63, and is
  scaled with (v*255 + 31)/63 so 0 maps to 0 and 63 to exactly 255 rather than 252. Anything
  darker is taken as stored.
*/
/**
 * Resolve an .ACT into 8-bit RGB: 768 bytes, `[r0, g0, b0, r1, ...]`. Always a new buffer.
 * `null` when there are fewer than 768 bytes.
 */
export function decodeActPalette(actBytes) {
    if (!actBytes || actBytes.length < ACT_PALETTE_SIZE)
        return null;
    const raw = actBytes.subarray(0, ACT_PALETTE_SIZE);
    // 8-bit, or a dark 8-bit palette that never needed a bright entry: use as stored.
    if (actPaletteDepth(raw) === 8)
        return raw.slice();
    const out = new Uint8Array(ACT_PALETTE_SIZE);
    for (let i = 0; i < ACT_PALETTE_SIZE; i++) {
        out[i] = Math.round((raw[i] * 255 + 31) / 63);
    }
    return out;
}
/**
 * Which channel depth `decodeActPalette` reads a palette as: 6 when its largest channel byte
 * is exactly 63, otherwise 8. `null` for fewer than 768 bytes.
 */
export function actPaletteDepth(actBytes) {
    if (actBytes.length < ACT_PALETTE_SIZE)
        return null;
    let max = 0;
    for (let i = 0; i < ACT_PALETTE_SIZE; i++)
        if (actBytes[i] > max)
            max = actBytes[i];
    return max === 63 ? 6 : 8;
}
