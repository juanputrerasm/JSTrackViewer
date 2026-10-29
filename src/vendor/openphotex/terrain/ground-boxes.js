/*
  Ground boxes: the solid blocks MTM, CPR, TV/F3 and Hellbender levels stand on the terrain grid.

  Three companion grids, found beside the heightfield by stem (the level never names them):

    .RA0  1 byte per cell   the box's lower height (legacy height steps)
    .RA1  1 byte per cell   its upper height; 0 means no box in that cell
    .CL0  12 bytes per cell six faces, each a 2-byte .CLR texture word (see decodeClrWord)

  A Hellbender level has a second such layer in its cavern (.RA4/.RA5/.CL2), in the same encoding
  on the biased cavern altitude (see hb-underground.ts), so callers pass the height offset.

  Ported from JSTrackViewer's src/worker/gbox-loader.js, which found the files and decoded them
  in one pass. This is the decoding half.
*/
/*
  The 2-byte texture word .CLR grids and ground-box faces use:
  bits 0-11 texture index, bits 12-13 mirror, bits 14-15 rotation (quarter turns).
*/
export function decodeClrWord(word) {
    return { texture: word & 0x0fff, mirror: (word >> 12) & 3, rotation: (word >> 14) & 3 };
}
/** The inverse of decodeClrWord. A negative texture (a face with no texture) is written as 0. */
export function encodeClrWord(texture, mirror = 0, rotation = 0) {
    return (Math.max(0, texture) & 0x0fff) | ((mirror & 3) << 12) | ((rotation & 3) << 14);
}
/**
 * A .CLR texture grid: one little-endian word per cell, row by row. Returns null when the file
 * is shorter than the grid.
 *
 * A file of exactly one byte per cell is the narrow form Hellbender's loader (HELLBEND.EXE
 * 0x412c3e) accepts by size: each byte is a texture index with no mirror or rotation. No shipped
 * level uses it.
 */
export function decodeClrGrid(bytes, gridSize = 256) {
    const cells = gridSize * gridSize;
    const words = new Uint16Array(cells);
    if (bytes.length >= cells * 2) {
        for (let i = 0; i < cells; i++)
            words[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8);
        return words;
    }
    if (bytes.length === cells) {
        for (let i = 0; i < cells; i++)
            words[i] = bytes[i];
        return words;
    }
    return null;
}
/** The bytes of a .CLR texture grid. */
export function encodeClrGrid(words) {
    const bytes = new Uint8Array(words.length * 2);
    for (let i = 0; i < words.length; i++) {
        bytes[2 * i] = words[i] & 0xff;
        bytes[2 * i + 1] = (words[i] >> 8) & 0xff;
    }
    return bytes;
}
/**
 * Decode a ground-box layer. Returns [] when a grid is shorter than the level's cell count;
 * `faces` may be null, leaving every face at texture -1.
 *
 * A face grid of exactly six bytes per cell is the narrow form Hellbender's loader accepts by
 * size (HELLBEND.EXE 0x412c3e): each byte is a texture index with no mirror or rotation.
 */
export function decodeGroundBoxes(ra0, ra1, cl0, gridSize, heightOffset = 0) {
    const cells = gridSize * gridSize;
    if (ra0.length < cells || ra1.length < cells)
        return [];
    const faceWidth = !cl0 ? 0 : cl0.length >= cells * 12 ? 2 : cl0.length === cells * 6 ? 1 : -1;
    if (faceWidth < 0)
        return [];
    const boxes = [];
    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            const idx = x + y * gridSize;
            const upper = ra1[idx];
            if (upper < 1)
                continue;
            const lower = ra0[idx];
            const faceTexture = new Array(6).fill(-1);
            const faceRotation = new Array(6).fill(0);
            const faceMirror = new Array(6).fill(0);
            if (cl0) {
                const cl0Base = idx * 6 * faceWidth;
                for (let face = 0; face < 6; face++) {
                    const off = cl0Base + face * faceWidth;
                    const word = decodeClrWord(faceWidth === 2 ? cl0[off] | (cl0[off + 1] << 8) : cl0[off]);
                    faceTexture[face] = word.texture;
                    faceMirror[face] = word.mirror;
                    faceRotation[face] = word.rotation;
                }
            }
            boxes.push({
                x, y,
                width: 1, height: 1,
                lower: lower + heightOffset,
                upper: upper + heightOffset,
                midX: (x << 6) + 32,
                midY: (y << 6) + 32,
                midZ: ((lower + upper) >> 1) + heightOffset,
                faceTexture, faceRotation, faceMirror
            });
        }
    }
    return boxes;
}
/**
 * The inverse of decodeGroundBoxes: the .RA0, .RA1 and .CL0 grids of a layer. Cells without a
 * box are zero; a later box in the same cell replaces an earlier one. `heightOffset` is the one
 * decodeGroundBoxes was given, taken back off the heights. A box outside the grid, or one whose
 * heights do not fit a byte (upper 1..255), throws a RangeError, as the grids cannot hold it.
 */
export function encodeGroundBoxes(boxes, gridSize, heightOffset = 0) {
    const cells = gridSize * gridSize;
    const ra0 = new Uint8Array(cells), ra1 = new Uint8Array(cells), cl0 = new Uint8Array(cells * 12);
    for (const box of boxes) {
        if (box.x < 0 || box.y < 0 || box.x >= gridSize || box.y >= gridSize)
            throw new RangeError(`ground box at ${box.x},${box.y} is outside the ${gridSize} grid`);
        const lower = box.lower - heightOffset, upper = box.upper - heightOffset;
        if (!(lower >= 0 && lower <= 255 && upper >= 1 && upper <= 255))
            throw new RangeError(`ground box at ${box.x},${box.y}: heights ${lower}..${upper} do not fit the grids`);
        const idx = box.x + box.y * gridSize;
        ra0[idx] = lower;
        ra1[idx] = upper;
        for (let face = 0; face < 6; face++) {
            const word = encodeClrWord(box.faceTexture[face] ?? 0, box.faceMirror[face] ?? 0, box.faceRotation[face] ?? 0);
            cl0[idx * 12 + face * 2] = word & 0xff;
            cl0[idx * 12 + face * 2 + 1] = word >> 8;
        }
    }
    return { ra0, ra1, cl0 };
}
