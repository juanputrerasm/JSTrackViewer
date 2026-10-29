/*
  Smacker video (`.SMK`, RAD Game Tools), as Monster Truck Madness 1 and 2 ship their intro, win and lose films
  (docs/SMK.md). Written from the format's public description; no Smacker code is used.

    header (104 bytes)  "SMK2" | "SMK4", width, height, frames, frame rate, flags, 7 audio buffer sizes,
                        trees size, the four trees' table sizes, 7 audio rates, a spare word
    frame sizes         a u32 per frame (+1 with the ring frame flag); the low two bits are flags (bit 0: key frame)
    frame types         a byte per frame: bit 0 a palette chunk, bit n+1 audio track n
    trees               the four 16-bit Huffman trees (block map, block colours, full blocks, block types)
    frames              palette chunk, audio chunks, then the video bit stream

  Every bit stream reads least significant bit first. `openSmk(bytes)` reads the header and trees; `decoder.next()`
  decodes the frames in order into one 8-bit image (frames build on the one before) with its palette, and the audio
  each track has in that frame. Plain data out; portable.
*/
const SIG2 = 0x324b4d53, SIG4 = 0x344b4d53; // "SMK2", "SMK4" read little-endian
const HEADER_BYTES = 104;
const FLAG_RING = 1, FLAG_INTERLACE = 2, FLAG_DOUBLE = 4;
const AUDIO_PACKED = 0x80000000, AUDIO_PRESENT = 0x40000000, AUDIO_16 = 0x20000000, AUDIO_STEREO = 0x10000000;
const AUDIO_BINK = 0x08000000;
/** Runs of blocks a block-type code stands for (its bits 2 to 7). */
const BLOCK_RUNS = Object.freeze([
    ...Array.from({ length: 59 }, (_, i) => i + 1), 128, 256, 512, 1024, 2048,
]);
const MONO = 0, FULL = 1, SKIP = 2, FILL = 3;
/** A node in a tree array: the low bits hold the size of its left (0) branch. */
const NODE = 0x80000000;
export class SmkError extends Error {
}
/** Least-significant-bit-first reader. */
class Bits {
    bit;
    data;
    end;
    constructor(data, start, end) {
        this.data = data;
        this.end = end;
        this.bit = start * 8;
    }
    get left() { return this.end * 8 - this.bit; }
    one() {
        if (this.bit >= this.end * 8)
            throw new SmkError("Smacker bit stream ran out");
        const v = (this.data[this.bit >> 3] >> (this.bit & 7)) & 1;
        this.bit++;
        return v;
    }
    read(n) {
        let v = 0;
        for (let i = 0; i < n; i++)
            v |= this.one() << i;
        return v >>> 0;
    }
}
/** An 8-bit tree as an array: leaves hold their byte, nodes `NODE | left size`. A lone leaf reads no bits. */
function readByteTree(b) {
    const out = [];
    const walk = (depth) => {
        if (depth > 32)
            throw new SmkError("Smacker tree too deep");
        if (!b.one()) {
            out.push(b.read(8));
            return 1;
        }
        const at = out.length;
        out.push(0);
        const left = walk(depth + 1);
        out[at] = NODE | left;
        return 1 + left + walk(depth + 1);
    };
    walk(0);
    return out;
}
function decodeTree(tree, b) {
    let i = 0;
    while (tree[i] & NODE) {
        if (b.one())
            i += tree[i] & ~NODE;
        i++;
    }
    return tree[i];
}
function readBigTree(b) {
    if (!b.one())
        return { values: [0, 0, 0, 0], last: [1, 2, 3] };
    const halves = [];
    for (let i = 0; i < 2; i++) {
        if (!b.one()) {
            halves.push(0);
            continue;
        }
        const tree = readByteTree(b);
        b.one(); // closing bit
        halves.push(tree.length === 1 ? tree[0] : tree);
    }
    const escapes = [b.read(16), b.read(16), b.read(16)];
    const last = [-1, -1, -1];
    const values = [];
    const half = (h) => (typeof h === "number" ? h : decodeTree(h, b));
    const walk = (depth) => {
        if (depth > 64)
            throw new SmkError("Smacker tree too deep");
        if (!b.one()) {
            let v = half(halves[0]) | (half(halves[1]) << 8);
            const e = escapes.indexOf(v);
            // A leaf with an escape value holds a cache entry (the last such leaf, when there are more).
            if (e >= 0) {
                last[e] = values.length;
                v = 0;
            }
            values.push(v);
            return 1;
        }
        const at = values.length;
        values.push(0);
        const left = walk(depth + 1);
        values[at] = NODE | left;
        return 1 + left + walk(depth + 1);
    };
    walk(0);
    b.one(); // closing bit
    for (let k = 0; k < 3; k++)
        if (last[k] === -1) {
            last[k] = values.length;
            values.push(0);
        }
    return { values, last };
}
function bigCode(t, b) {
    const v = decodeTree(t.values, b);
    const [a, c, d] = t.last;
    if (v !== t.values[a]) {
        t.values[d] = t.values[c];
        t.values[c] = t.values[a];
        t.values[a] = v;
    }
    return v;
}
function resetCache(t) {
    for (const k of t.last)
        t.values[k] = 0;
}
/** A 6-bit palette level as 8 bits. */
const level = (v) => ((v & 0x3f) << 2) | ((v & 0x3f) >> 4);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
/** The header and tables of a `.SMK`, and a decoder for its frames in order. */
export function openSmk(bytes) {
    if (bytes.length < HEADER_BYTES)
        throw new SmkError("Not a Smacker file: too short");
    const sig = u32(bytes, 0);
    if (sig !== SIG2 && sig !== SIG4)
        throw new SmkError("Not a Smacker file");
    const version = sig === SIG4 ? "SMK4" : "SMK2";
    const width = u32(bytes, 4), height = u32(bytes, 8), frames = u32(bytes, 12);
    const rate = u32(bytes, 16) | 0;
    const flags = u32(bytes, 20);
    const treesSize = u32(bytes, 52);
    const audio = [];
    for (let k = 0; k < 7; k++) {
        const a = u32(bytes, 72 + k * 4);
        if (!(a & AUDIO_PRESENT) || (a & 0xffffff) === 0)
            continue;
        if (a & AUDIO_BINK)
            continue; // Bink audio inside Smacker: not used by the games, not decoded
        audio.push({ track: k, rate: a & 0xffffff, channels: a & AUDIO_STEREO ? 2 : 1, bits: a & AUDIO_16 ? 16 : 8, packed: !!(a & AUDIO_PACKED) });
    }
    const ringFrame = !!(flags & FLAG_RING);
    const total = frames + (ringFrame ? 1 : 0);
    if (!width || !height || width > 4096 || height > 4096 || !frames || frames > 100000)
        throw new SmkError("Smacker header out of range");
    let at = HEADER_BYTES;
    if (at + total * 5 + treesSize > bytes.length)
        throw new SmkError("Smacker file truncated");
    const sizes = [];
    for (let i = 0; i < total; i++)
        sizes.push(u32(bytes, at + i * 4) & ~3);
    at += total * 4;
    const types = bytes.slice(at, at + total);
    at += total;
    const treeBits = new Bits(bytes, at, at + treesSize);
    const mmap = readBigTree(treeBits), mclr = readBigTree(treeBits), full = readBigTree(treeBits), type = readBigTree(treeBits);
    at += treesSize;
    const offsets = [];
    for (const size of sizes) {
        offsets.push(at);
        at += size;
    }
    const frameMs = rate > 0 ? rate : rate < 0 ? -rate / 100 : 100;
    const info = {
        version, width, height, frames, frameMs, ringFrame, audio,
        doubled: !!(flags & FLAG_DOUBLE), interlaced: !!(flags & FLAG_INTERLACE),
    };
    const pixels = new Uint8Array(width * height);
    const palette = new Uint8Array(768);
    let index = 0;
    function decodePalette(start, end) {
        const old = palette.slice();
        let o = start, entry = 0;
        while (entry < 256 && o < end) {
            const t = bytes[o];
            if (t & 0x80) {
                entry += (t & 0x7f) + 1;
                o++;
            }
            else if (t & 0x40) {
                let from = bytes[o + 1];
                let count = (t & 0x3f) + 1;
                if (from + count > 256)
                    throw new SmkError("Smacker palette copy out of range");
                while (count-- > 0 && entry < 256) {
                    palette.set(old.subarray(from * 3, from * 3 + 3), entry * 3);
                    entry++;
                    from++;
                }
                o += 2;
            }
            else {
                palette[entry * 3] = level(t);
                palette[entry * 3 + 1] = level(bytes[o + 1]);
                palette[entry * 3 + 2] = level(bytes[o + 2]);
                entry++;
                o += 3;
            }
        }
    }
    function decodeAudio(track, start, end) {
        if (!track.packed) {
            if (track.bits === 8)
                return Float32Array.from(bytes.subarray(start, end), (v) => (v - 128) / 128);
            const n = (end - start) >> 1, out = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const v = bytes[start + i * 2] | (bytes[start + i * 2 + 1] << 8);
                out[i] = (v << 16 >> 16) / 32768;
            }
            return out;
        }
        const unpacked = u32(bytes, start);
        const b = new Bits(bytes, start + 4, end);
        if (!b.one())
            return new Float32Array(0);
        const stereo = b.one(), sixteen = b.one();
        if ((stereo ? 2 : 1) !== track.channels || (sixteen ? 16 : 8) !== track.bits)
            throw new SmkError("Smacker audio does not match its header");
        const trees = [];
        for (let i = 0; i < 1 << (sixteen + stereo); i++) {
            b.one();
            const tree = readByteTree(b);
            b.one();
            trees.push(tree.length === 1 ? tree[0] : tree);
        }
        const code = (k) => { const t = trees[k]; return typeof t === "number" ? t : decodeTree(t, b); };
        const channels = stereo + 1;
        if (sixteen) {
            const n = unpacked >> 1, out = new Float32Array(n);
            const pred = [0, 0];
            for (let c = stereo; c >= 0; c--) {
                const v = b.read(16);
                pred[c] = ((v & 0xff) << 8) | (v >> 8);
            }
            for (let c = 0; c < channels && c < n; c++)
                out[c] = ((pred[c] << 16) >> 16) / 32768;
            for (let i = channels; i < n; i++) {
                const c = i & stereo;
                const delta = code(c * 2) | (code(c * 2 + 1) << 8);
                pred[c] = (pred[c] + delta) & 0xffff;
                out[i] = ((pred[c] << 16) >> 16) / 32768;
            }
            return out;
        }
        const out = new Float32Array(unpacked);
        const pred = [0, 0];
        for (let c = stereo; c >= 0; c--)
            pred[c] = b.read(8);
        for (let c = 0; c < channels && c < unpacked; c++)
            out[c] = (pred[c] - 128) / 128;
        for (let i = channels; i < unpacked; i++) {
            const c = i & stereo;
            pred[c] = (pred[c] + code(c)) & 0xff;
            out[i] = (pred[c] - 128) / 128;
        }
        return out;
    }
    function decodeVideo(start, end) {
        for (const t of [mmap, mclr, full, type])
            resetCache(t);
        const b = new Bits(bytes, start, end);
        const bw = width >> 2, blocks = bw * (height >> 2);
        const put = (blk, row, col, v) => {
            pixels[((blk / bw | 0) * 4 + row) * width + (blk % bw) * 4 + col] = v;
        };
        let blk = 0;
        while (blk < blocks) {
            const t = bigCode(type, b);
            let run = BLOCK_RUNS[(t >> 2) & 0x3f];
            switch (t & 3) {
                case MONO:
                    for (; run > 0 && blk < blocks; run--, blk++) {
                        const clr = bigCode(mclr, b);
                        let map = bigCode(mmap, b);
                        const hi = clr >> 8, lo = clr & 0xff;
                        for (let r = 0; r < 4; r++) {
                            for (let c = 0; c < 4; c++)
                                put(blk, r, c, map & (1 << c) ? hi : lo);
                            map >>= 4;
                        }
                    }
                    break;
                case FULL: {
                    let mode = 0;
                    if (version === "SMK4")
                        mode = b.one() ? 1 : b.one() ? 2 : 0;
                    for (; run > 0 && blk < blocks; run--, blk++) {
                        if (mode === 0) {
                            for (let r = 0; r < 4; r++) {
                                const right = bigCode(full, b), left = bigCode(full, b);
                                put(blk, r, 0, left & 0xff);
                                put(blk, r, 1, left >> 8);
                                put(blk, r, 2, right & 0xff);
                                put(blk, r, 3, right >> 8);
                            }
                        }
                        else if (mode === 1) {
                            for (let half = 0; half < 2; half++) {
                                const v = bigCode(full, b);
                                for (let r = half * 2; r < half * 2 + 2; r++) {
                                    put(blk, r, 0, v & 0xff);
                                    put(blk, r, 1, v & 0xff);
                                    put(blk, r, 2, v >> 8);
                                    put(blk, r, 3, v >> 8);
                                }
                            }
                        }
                        else {
                            for (let half = 0; half < 2; half++) {
                                const right = bigCode(full, b), left = bigCode(full, b);
                                for (let r = half * 2; r < half * 2 + 2; r++) {
                                    put(blk, r, 0, left & 0xff);
                                    put(blk, r, 1, left >> 8);
                                    put(blk, r, 2, right & 0xff);
                                    put(blk, r, 3, right >> 8);
                                }
                            }
                        }
                    }
                    break;
                }
                case SKIP:
                    blk += run;
                    break;
                case FILL: {
                    const colour = t >> 8;
                    for (; run > 0 && blk < blocks; run--, blk++)
                        for (let r = 0; r < 4; r++)
                            for (let c = 0; c < 4; c++)
                                put(blk, r, c, colour);
                    break;
                }
            }
        }
    }
    return {
        info,
        /** The next frame, or null after the last shown one (the ring frame is not shown). */
        next() {
            if (index >= frames)
                return null;
            const i = index++;
            let o = offsets[i];
            const end = o + sizes[i];
            if (end > bytes.length)
                throw new SmkError("Smacker frame runs past the end of the file");
            let paletteChanged = false;
            if (types[i] & 1) {
                const size = bytes[o] * 4;
                if (!size || o + size > end)
                    throw new SmkError("Smacker palette chunk out of range");
                decodePalette(o + 1, o + size);
                o += size;
                paletteChanged = true;
            }
            const sound = [];
            for (let k = 0; k < 7; k++) {
                if (!(types[i] & (2 << k)))
                    continue;
                const size = u32(bytes, o);
                if (size < 4 || o + size > end)
                    throw new SmkError("Smacker audio chunk out of range");
                const track = audio.find((a) => a.track === k);
                if (track)
                    sound.push({ track: k, samples: decodeAudio(track, o + 4, o + size) });
                o += size;
            }
            decodeVideo(o, end);
            return { index: i, pixels, palette, paletteChanged, audio: sound };
        },
        /** Back to the first frame (the picture and palette start again from black). */
        rewind() {
            index = 0;
            pixels.fill(0);
            palette.fill(0);
        },
    };
}
/** The header of a `.SMK` alone. */
export function smkInfo(bytes) {
    return openSmk(bytes).info;
}
