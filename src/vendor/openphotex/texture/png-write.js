/*
  A small PNG writer for grey samples at 8 or 16 bits: what a track's height map needs (Community
  Patch 4's DATA\<stem>_H.PNG, track format version 6's terrainHeightMap). Browsers cannot write a
  16-bit grey PNG through a canvas, so the core carries its own.

  Each row takes the scanline filter (None, Sub, Up, Average, Paeth) with the least sum of
  absolute differences, the usual heuristic. The image data is compressed with deflateZlib below:
  LZ77 over a 32 KiB window with hash chains, coded in one fixed-Huffman block (RFC 1951 3.2.6).
  It is not zlib's best ratio, but every inflater reads it and smooth height maps shrink well.
*/
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
let crcTable = null;
/** CRC-32 (ISO 3309, the PNG and zlib one). */
export function crc32(bytes, crc = 0) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++)
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let c = ~crc >>> 0;
    for (let i = 0; i < bytes.length; i++)
        c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
}
function adler32(bytes) {
    let a = 1, b = 0;
    for (let i = 0; i < bytes.length;) {
        const end = Math.min(bytes.length, i + 5552);
        for (; i < end; i++) {
            a += bytes[i];
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
}
class BitWriter {
    buf = new Uint8Array(1 << 16);
    len = 0;
    bits = 0;
    count = 0;
    ensure(n) {
        if (this.len + n <= this.buf.length)
            return;
        const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
    }
    /** `n` bits of `value`, least significant first. */
    write(value, n) {
        this.bits |= value << this.count;
        this.count += n;
        this.ensure(4);
        while (this.count >= 8) {
            this.buf[this.len++] = this.bits & 0xff;
            this.bits >>>= 8;
            this.count -= 8;
        }
    }
    /** A Huffman code of `n` bits, most significant first. */
    code(value, n) {
        let r = 0;
        for (let i = 0; i < n; i++)
            r |= ((value >> i) & 1) << (n - 1 - i);
        this.write(r, n);
    }
    byte(b) {
        this.ensure(1);
        this.buf[this.len++] = b;
    }
    flush() {
        if (this.count > 0)
            this.write(0, 8 - this.count);
    }
    result() {
        return this.buf.slice(0, this.len);
    }
}
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
function literal(w, sym) {
    if (sym < 144)
        w.code(0x30 + sym, 8);
    else if (sym < 256)
        w.code(0x190 + sym - 144, 9);
    else if (sym < 280)
        w.code(sym - 256, 7);
    else
        w.code(0xc0 + sym - 280, 8);
}
function match(w, length, distance) {
    let li = 28;
    while (LEN_BASE[li] > length)
        li--;
    literal(w, 257 + li);
    if (LEN_EXTRA[li])
        w.write(length - LEN_BASE[li], LEN_EXTRA[li]);
    let di = 29;
    while (DIST_BASE[di] > distance)
        di--;
    w.code(di, 5);
    if (DIST_EXTRA[di])
        w.write(distance - DIST_BASE[di], DIST_EXTRA[di]);
}
/** A zlib stream (RFC 1950) of `data`: one fixed-Huffman deflate block with LZ77 matches. */
export function deflateZlib(data) {
    const w = new BitWriter();
    w.byte(0x78);
    w.byte(0x9c);
    w.write(1, 1); // BFINAL
    w.write(1, 2); // BTYPE 01, fixed Huffman
    const WINDOW = 32768, HASH = 1 << 15, CHAIN = 48, MAX = 258;
    const head = new Int32Array(HASH).fill(-1);
    const prev = new Int32Array(WINDOW);
    const hash = (i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH - 1);
    const insert = (i) => {
        if (i + 2 >= data.length)
            return;
        const h = hash(i);
        prev[i & (WINDOW - 1)] = head[h];
        head[h] = i;
    };
    let i = 0;
    while (i < data.length) {
        let bestLen = 0, bestDist = 0;
        if (i + 2 < data.length) {
            let j = head[hash(i)];
            const limit = Math.min(MAX, data.length - i);
            for (let n = 0; j >= 0 && i - j <= WINDOW && n < CHAIN; n++) {
                if (data[j + bestLen] === data[i + bestLen]) {
                    let l = 0;
                    while (l < limit && data[j + l] === data[i + l])
                        l++;
                    if (l > bestLen) {
                        bestLen = l;
                        bestDist = i - j;
                        if (l === limit)
                            break;
                    }
                }
                const p = prev[j & (WINDOW - 1)];
                if (p >= j)
                    break;
                j = p;
            }
        }
        if (bestLen >= 3) {
            match(w, bestLen, bestDist);
            for (let k = 0; k < bestLen; k++)
                insert(i + k);
            i += bestLen;
        }
        else {
            literal(w, data[i]);
            insert(i);
            i++;
        }
    }
    literal(w, 256);
    w.flush();
    const a = adler32(data);
    w.byte(a >>> 24);
    w.byte((a >>> 16) & 0xff);
    w.byte((a >>> 8) & 0xff);
    w.byte(a & 0xff);
    return w.result();
}
function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    for (let i = 0; i < 4; i++)
        out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}
function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
/**
 * A grey PNG (colour type 0) of `width` x `height` samples, row by row, at 8 or 16 bits. A sample
 * outside the depth's range throws.
 */
export function encodeGreyPng(samples, width, height, bitDepth = 16) {
    if (!(width > 0 && height > 0 && samples.length === width * height))
        throw new RangeError(`png: ${samples.length} samples for ${width} x ${height}`);
    const bpp = bitDepth / 8, rowBytes = width * bpp, max = bitDepth === 16 ? 65535 : 255;
    const raw = new Uint8Array(rowBytes * height);
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (!(Number.isInteger(s) && s >= 0 && s <= max))
            throw new RangeError(`png: sample ${i} = ${s} does not fit ${bitDepth} bits`);
        if (bitDepth === 16) {
            raw[2 * i] = s >> 8;
            raw[2 * i + 1] = s & 0xff;
        }
        else
            raw[i] = s;
    }
    const filtered = new Uint8Array((rowBytes + 1) * height);
    const trial = new Uint8Array(rowBytes);
    for (let y = 0; y < height; y++) {
        const row = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
        const up = y > 0 ? raw.subarray((y - 1) * rowBytes, y * rowBytes) : null;
        let bestCost = Infinity;
        for (let type = 0; type < 5; type++) {
            let cost = 0;
            for (let x = 0; x < rowBytes; x++) {
                const a = x >= bpp ? row[x - bpp] : 0, b = up ? up[x] : 0, c = up && x >= bpp ? up[x - bpp] : 0;
                const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
                const d = (row[x] - pred) & 0xff;
                trial[x] = d;
                cost += d < 128 ? d : 256 - d;
            }
            if (cost < bestCost) {
                bestCost = cost;
                filtered[y * (rowBytes + 1)] = type;
                filtered.set(trial, y * (rowBytes + 1) + 1);
            }
        }
    }
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, width);
    v.setUint32(4, height);
    ihdr[8] = bitDepth;
    ihdr[9] = 0;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const parts = [Uint8Array.from(SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", deflateZlib(filtered)), chunk("IEND", new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}
