/*
  4x4 Evolution 1 Lite tracks (`.LTE`, `customtracks\*.lte`): a custom track in one compressed file
  that borrows the level (.LVL), the tile table (.TEX), the art and the models of a stock world. Not
  the light grid MTM2 keeps under the same extension. See docs/EVO.md, "Lite tracks (.LTE)".

  The file is an LZW stream (the game's `CLZWDictionary`, `..\support\codec.cpp`): bits least significant
  first within each byte; a dictionary of the 256 bytes at first, a code width of 8 that grows by a bit
  whenever an entry is added at a power-of-two count; each code read against the count `n` with the bits
  that `n - 1` lacks left out until a stored 0 is met where it has a 1; up to 0x8000 entries, and the add
  that finds it full empties it, the next code starting with no previous string.

  Decoded: `LTE 1\n`, the base world's name, an Evo 1 .SIT, then the terrain: two int32s (the lowest and
  highest height, .RAW units of 1/32 ft), 256 x 256 height bytes and two 256 x 256 planes of tile numbers
  (low bytes, then high bytes). Pure: bytes in, plain data out.
*/
export const EVO_LITE_GRID = 256;
/** The terrain block at the end of a decoded Lite track: hMin, hMax, heights, tile low bytes, tile high bytes. */
export const EVO_LITE_TERRAIN_BYTES = 8 + 3 * EVO_LITE_GRID * EVO_LITE_GRID;
/** The largest Lite track the game lists, bytes. */
export const EVO_LITE_MAX_FILE = 0x18800;
/** The most bytes `decodeEvoLzw` writes before it gives up on a stream. */
export const EVO_LZW_MAX_OUTPUT = 1 << 26;
/** The dictionary's size: the add that finds it full empties it. */
export const EVO_LZW_ENTRIES = 0x8000;
/** Decode the game's LZW stream. */
export function decodeEvoLzw(data) {
    let pos = 0, buffer = 0, bits = 0;
    const bit = () => {
        if (bits === 0) {
            if (pos >= data.length)
                return -1;
            buffer = data[pos++];
            bits = 8;
        }
        const b = buffer & 1;
        buffer >>= 1;
        bits--;
        return b;
    };
    // The dictionary as prefix codes and last bytes; the 256 single bytes have no prefix.
    const prefix = new Int32Array(EVO_LZW_ENTRIES), last = new Uint8Array(EVO_LZW_ENTRIES), length = new Int32Array(EVO_LZW_ENTRIES);
    for (let i = 0; i < 256; i++) {
        prefix[i] = -1;
        last[i] = i;
        length[i] = 1;
    }
    let count = 256, width = 8;
    let out = new Uint8Array(Math.max(1024, data.length * 4)), size = 0;
    const grow = (need) => {
        if (size + need <= out.length)
            return;
        // A Lite track decodes to well under a megabyte; a stream that runs past this is not one.
        if (size + need > EVO_LZW_MAX_OUTPUT)
            throw new Error("LZW: output too large");
        let next = out.length * 2;
        while (size + need > next)
            next *= 2;
        const bigger = new Uint8Array(next);
        bigger.set(out.subarray(0, size));
        out = bigger;
    };
    const write = (code) => {
        const n = length[code];
        grow(n);
        let c = code;
        for (let k = n - 1; k >= 0; k--) {
            out[size + k] = last[c];
            c = prefix[c];
        }
        const first = out[size];
        size += n;
        return first;
    };
    /** One code against the dictionary's count, or -1 at the end of the data. */
    const read = () => {
        const top = count - 1;
        let code = 0, free = false;
        for (let b = width - 1; b >= 0; b--) {
            const mask = 1 << b;
            if (!free && (top & mask) === 0)
                continue;
            const v = bit();
            if (v < 0)
                return -1;
            if (v)
                code |= mask;
            else if (!free)
                free = true;
        }
        return code;
    };
    let previous = -1;
    for (;;) {
        const code = read();
        if (code < 0)
            break;
        let first;
        if (code < count)
            first = write(code);
        else if (code === count && previous >= 0) {
            // The string being defined: the previous one and its own first byte.
            first = write(previous);
            grow(1);
            out[size++] = first;
        }
        else
            throw new Error(`LZW: code ${code} with ${count} entries`);
        if (previous >= 0) {
            if (count >= EVO_LZW_ENTRIES) {
                count = 256;
                width = 8;
                previous = -1;
                continue;
            }
            if ((count & (count - 1)) === 0)
                width++;
            prefix[count] = previous;
            last[count] = first;
            length[count] = length[previous] + 1;
            count++;
        }
        previous = code;
    }
    return out.slice(0, size);
}
const latin1 = new TextDecoder("latin1");
/** The decoded text's first line, when it is a Lite track's (`LTE <n>`). */
function liteVersion(decoded) {
    const head = latin1.decode(decoded.subarray(0, 16));
    const m = /^LTE (\d+)\r?\n/.exec(head);
    return m ? Number(m[1]) : null;
}
/** Whether a file is a 4x4 Evolution 1 Lite track (its decoded start reads `LTE <n>`), not MTM2's light grid. */
export function isEvoLite(bytes) {
    if (bytes.length === 0 || bytes.length > EVO_LITE_MAX_FILE)
        return false;
    try {
        // The first bytes decode alone; a light grid makes nonsense or a bad code.
        return liteVersion(decodeEvoLzw(bytes.subarray(0, 32))) !== null;
    }
    catch {
        return false;
    }
}
/** Read a Lite track. Throws when the file is not one. */
export function parseEvoLte(bytes, sourceName = "track.lte") {
    const decoded = decodeEvoLzw(bytes);
    const version = liteVersion(decoded);
    if (version === null)
        throw new Error(`${sourceName}: not a 4x4 Evolution Lite track (no "LTE" line)`);
    if (version !== 1)
        throw new Error(`${sourceName}: Lite track version ${version} (only 1 is known)`);
    // The version line, then the base world's.
    let at = decoded.indexOf(0x0a) + 1;
    const end = decoded.indexOf(0x0a, at);
    if (end < 0)
        throw new Error(`${sourceName}: no base world line`);
    const baseWorld = latin1.decode(decoded.subarray(at, end)).trim();
    at = end + 1;
    const terrainAt = decoded.length - EVO_LITE_TERRAIN_BYTES;
    if (terrainAt <= at)
        throw new Error(`${sourceName}: too short for the terrain (${decoded.length} bytes decoded)`);
    const view = new DataView(decoded.buffer, decoded.byteOffset + terrainAt, 8);
    const hMin = view.getInt32(0, true), hMax = view.getInt32(4, true);
    const cells = EVO_LITE_GRID * EVO_LITE_GRID;
    const plane = (k) => decoded.subarray(terrainAt + 8 + k * cells, terrainAt + 8 + (k + 1) * cells);
    const heightBytes = plane(0), low = plane(1), high = plane(2);
    const heights = new Uint16Array(cells), tiles = new Uint16Array(cells);
    for (let i = 0; i < cells; i++) {
        // The game's integer sums, truncated (CGround::load); an even field rises from one under its height.
        const h = hMin === hMax
            ? hMin - 1 + Math.trunc(heightBytes[i] / 255)
            : hMin + Math.trunc((heightBytes[i] * (hMax - hMin)) / 255);
        heights[i] = h & 0xffff;
        tiles[i] = (low[i] + high[i] * 256) & 0xfff;
    }
    return { version, baseWorld, sitBytes: decoded.slice(at, terrainAt), hMin, hMax, heights, tiles };
}
