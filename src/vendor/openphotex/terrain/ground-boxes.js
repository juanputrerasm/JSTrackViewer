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
/**
 * Decode a ground-box layer. Returns [] when a grid is shorter than the level's cell count;
 * `faces` may be null, leaving every face at texture -1.
 */
export function decodeGroundBoxes(ra0, ra1, cl0, gridSize, heightOffset = 0) {
    const cells = gridSize * gridSize;
    if (ra0.length < cells || ra1.length < cells)
        return [];
    if (cl0 && cl0.length < cells * 12)
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
                const cl0Base = idx * 12;
                for (let face = 0; face < 6; face++) {
                    const off = cl0Base + face * 2;
                    const word = decodeClrWord(cl0[off] | (cl0[off + 1] << 8));
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
