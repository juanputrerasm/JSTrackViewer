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
 *
 * `depth` 16 reads a track format version 6 layer of u16 heights (mtm2GroundBoxDepth tells it by
 * size); `lower` and `upper` are then the 16-bit values, in the terrain's height steps
 * (mtm2GroundBoxHeightFt).
 */
export function decodeGroundBoxes(ra0, ra1, cl0, gridSize, heightOffset = 0, depth = 8) {
    const cells = gridSize * gridSize;
    if (ra0.length < cells * (depth / 8) || ra1.length < cells * (depth / 8))
        return [];
    const read = depth === 16 ? (g, i) => g[2 * i] | (g[2 * i + 1] << 8) : (g, i) => g[i];
    const faceWidth = !cl0 ? 0 : cl0.length >= cells * 12 ? 2 : cl0.length === cells * 6 ? 1 : -1;
    if (faceWidth < 0)
        return [];
    const boxes = [];
    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            const idx = x + y * gridSize;
            const upper = read(ra1, idx);
            if (upper < 1)
                continue;
            const lower = read(ra0, idx);
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
 * `depth` 16 writes a track format version 6 layer of u16 heights (upper 1..65535).
 */
export function encodeGroundBoxes(boxes, gridSize, heightOffset = 0, depth = 8) {
    const cells = gridSize * gridSize, bytes = depth / 8, max = depth === 16 ? 65535 : 255;
    const ra0 = new Uint8Array(cells * bytes), ra1 = new Uint8Array(cells * bytes), cl0 = new Uint8Array(cells * 12);
    const put = (g, i, v) => { if (bytes === 2) {
        g[2 * i] = v & 0xff;
        g[2 * i + 1] = v >> 8;
    }
    else
        g[i] = v; };
    for (const box of boxes) {
        if (box.x < 0 || box.y < 0 || box.x >= gridSize || box.y >= gridSize)
            throw new RangeError(`ground box at ${box.x},${box.y} is outside the ${gridSize} grid`);
        const lower = box.lower - heightOffset, upper = box.upper - heightOffset;
        if (!(Number.isInteger(lower) && Number.isInteger(upper) && lower >= 0 && lower <= max && upper >= 1 && upper <= max)) {
            throw new RangeError(`ground box at ${box.x},${box.y}: heights ${lower}..${upper} do not fit ${depth}-bit grids`);
        }
        const idx = box.x + box.y * gridSize;
        put(ra0, idx, lower);
        put(ra1, idx, upper);
        for (let face = 0; face < 6; face++) {
            const word = encodeClrWord(box.faceTexture[face] ?? 0, box.faceMirror[face] ?? 0, box.faceRotation[face] ?? 0);
            cl0[idx * 12 + face * 2] = word & 0xff;
            cl0[idx * 12 + face * 2 + 1] = word >> 8;
        }
    }
    return { ra0, ra1, cl0 };
}
/*
  Track format version 6 grid files (https://openmtm2.github.io/proposals/track-format-v6,
  section 8.2): each keeps its DATA\<stem> name and layout and holds N x N cells, N being the
  track's worldCells. A reader refuses a file whose size does not match:

    .CLR 2 bytes a cell   .LTE 7   .RA0 to .RA5 1 (8-bit) or 2 (16-bit)   .CL0, .CL2 12   .CL1 4
*/
export const MTM2_GRID_BYTES_PER_CELL = {
    CLR: [2], LTE: [7], RA0: [1, 2], RA1: [1, 2], RA2: [1, 2], RA3: [1, 2], RA4: [1, 2], RA5: [1, 2], CL0: [12], CL1: [4], CL2: [12],
};
/** Refuse a version 6 grid file whose size is not N x N cells: a RangeError naming the file, else its bytes per cell. */
export function checkMtm2GridSize(name, length, cells) {
    const ext = name.replace(/^.*\./, "").toUpperCase();
    const per = MTM2_GRID_BYTES_PER_CELL[ext];
    if (!per)
        throw new RangeError(`${name}: not an MTM2 grid file`);
    const n = cells * cells;
    const hit = per.find((b) => b * n === length);
    if (hit === undefined) {
        throw new RangeError(`${name} is ${length} bytes; a ${cells}-cell world needs ${per.map((b) => b * n).join(" or ")}`);
    }
    return hit;
}
/**
 * The depth of a ground box pair (.RA0/.RA1, .RA4/.RA5) of a version 6 track, told by size
 * (section 8.3): 8 for one byte a cell, 16 for two. The two files of a pair must agree.
 */
export function mtm2GroundBoxDepth(lower, upper, cells, names = ["RA0", "RA1"]) {
    const a = checkMtm2GridSize(names[0], lower.length, cells), b = checkMtm2GridSize(names[1], upper.length, cells);
    if (a !== b)
        throw new RangeError(`${names[0]} is ${a * 8}-bit and ${names[1]} ${b * 8}-bit; the two files of a ground box pair must have the same depth`);
    return a === 2 ? 16 : 8;
}
/**
 * A version 6 ground box height in feet (section 8.3): 8-bit base + 2 * byte, 16-bit
 * base + value / step, the terrain's rule. A top of 0 still means no box.
 */
export function mtm2GroundBoxHeightFt(value, depth, step = 128, base = 0) {
    return depth === 16 ? base + value / step : base + 2 * value;
}
