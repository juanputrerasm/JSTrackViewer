/*
  DEFLATE (RFC 1951) and zlib (RFC 1950) decompression, synchronous and dependency free, for the
  PNG reader. Browsers' DecompressionStream is asynchronous and Node's zlib is not portable, so
  the core keeps its own. A straightforward canonical-Huffman decoder after Mark Adler's puff.c.
*/
const MAXBITS = 15;
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function buildHuffman(lengths, n) {
    const count = new Uint16Array(MAXBITS + 1);
    const symbol = new Uint16Array(n);
    for (let s = 0; s < n; s++)
        count[lengths[s]]++;
    const offs = new Uint16Array(MAXBITS + 1);
    for (let len = 1; len < MAXBITS; len++)
        offs[len + 1] = offs[len] + count[len];
    for (let s = 0; s < n; s++)
        if (lengths[s])
            symbol[offs[lengths[s]]++] = s;
    return { count, symbol };
}
let FIXED = null;
function fixedTables() {
    if (!FIXED) {
        const l = new Uint8Array(288);
        l.fill(8, 0, 144);
        l.fill(9, 144, 256);
        l.fill(7, 256, 280);
        l.fill(8, 280, 288);
        FIXED = { lit: buildHuffman(l, 288), dist: buildHuffman(new Uint8Array(30).fill(5), 30) };
    }
    return FIXED;
}
class Inflater {
    pos;
    bitBuf = 0;
    bitCnt = 0;
    out;
    outLen = 0;
    src;
    constructor(src, start, sizeHint) {
        this.src = src;
        this.pos = start;
        this.out = new Uint8Array(Math.max(1024, sizeHint));
    }
    bits(need) {
        let val = this.bitBuf;
        while (this.bitCnt < need) {
            if (this.pos >= this.src.length)
                throw new RangeError("inflate: unexpected end of data");
            val |= this.src[this.pos++] << this.bitCnt;
            this.bitCnt += 8;
        }
        this.bitBuf = val >>> need;
        this.bitCnt -= need;
        return val & ((1 << need) - 1);
    }
    ensure(extra) {
        if (this.outLen + extra <= this.out.length)
            return;
        let size = this.out.length * 2;
        while (size < this.outLen + extra)
            size *= 2;
        const grown = new Uint8Array(size);
        grown.set(this.out.subarray(0, this.outLen));
        this.out = grown;
    }
    decode(h) {
        let code = 0, first = 0, index = 0;
        for (let len = 1; len <= MAXBITS; len++) {
            code |= this.bits(1);
            const count = h.count[len];
            if (code - count < first)
                return h.symbol[index + (code - first)];
            index += count;
            first += count;
            first <<= 1;
            code <<= 1;
        }
        throw new RangeError("inflate: bad Huffman code");
    }
    stored() {
        this.bitBuf = 0;
        this.bitCnt = 0;
        if (this.pos + 4 > this.src.length)
            throw new RangeError("inflate: truncated stored block");
        const len = this.src[this.pos] | (this.src[this.pos + 1] << 8);
        const nlen = this.src[this.pos + 2] | (this.src[this.pos + 3] << 8);
        this.pos += 4;
        if ((len ^ 0xffff) !== nlen)
            throw new RangeError("inflate: stored block length check failed");
        if (this.pos + len > this.src.length)
            throw new RangeError("inflate: truncated stored block");
        this.ensure(len);
        this.out.set(this.src.subarray(this.pos, this.pos + len), this.outLen);
        this.outLen += len;
        this.pos += len;
    }
    codes(lit, dist) {
        for (;;) {
            let sym = this.decode(lit);
            if (sym < 256) {
                this.ensure(1);
                this.out[this.outLen++] = sym;
            }
            else if (sym === 256) {
                return;
            }
            else {
                sym -= 257;
                if (sym >= 29)
                    throw new RangeError("inflate: bad length symbol");
                const len = LEN_BASE[sym] + this.bits(LEN_EXTRA[sym]);
                const ds = this.decode(dist);
                if (ds >= 30)
                    throw new RangeError("inflate: bad distance symbol");
                const d = DIST_BASE[ds] + this.bits(DIST_EXTRA[ds]);
                if (d > this.outLen)
                    throw new RangeError("inflate: distance too far back");
                this.ensure(len);
                const o = this.out;
                let p = this.outLen;
                for (let i = 0; i < len; i++, p++)
                    o[p] = o[p - d];
                this.outLen = p;
            }
        }
    }
    dynamic() {
        const nlen = this.bits(5) + 257;
        const ndist = this.bits(5) + 1;
        const ncode = this.bits(4) + 4;
        if (nlen > 286 || ndist > 30)
            throw new RangeError("inflate: bad dynamic block counts");
        const lengths = new Uint8Array(320);
        for (let i = 0; i < ncode; i++)
            lengths[CL_ORDER[i]] = this.bits(3);
        const lencode = buildHuffman(lengths, 19);
        lengths.fill(0);
        let index = 0;
        while (index < nlen + ndist) {
            const sym = this.decode(lencode);
            if (sym < 16) {
                lengths[index++] = sym;
                continue;
            }
            let len = 0, rep;
            if (sym === 16) {
                if (index === 0)
                    throw new RangeError("inflate: repeat with no previous length");
                len = lengths[index - 1];
                rep = 3 + this.bits(2);
            }
            else if (sym === 17)
                rep = 3 + this.bits(3);
            else
                rep = 11 + this.bits(7);
            if (index + rep > nlen + ndist)
                throw new RangeError("inflate: too many lengths");
            while (rep--)
                lengths[index++] = len;
        }
        if (lengths[256] === 0)
            throw new RangeError("inflate: no end-of-block code");
        const lit = buildHuffman(lengths.subarray(0, nlen), nlen);
        const dist = buildHuffman(lengths.subarray(nlen, nlen + ndist), ndist);
        this.codes(lit, dist);
    }
    run() {
        let last;
        do {
            last = this.bits(1);
            const type = this.bits(2);
            if (type === 0)
                this.stored();
            else if (type === 1) {
                const f = fixedTables();
                this.codes(f.lit, f.dist);
            }
            else if (type === 2)
                this.dynamic();
            else
                throw new RangeError("inflate: bad block type 3");
        } while (!last);
        return this.out.slice(0, this.outLen);
    }
}
/** Decompress a raw DEFLATE stream starting at `start`. `sizeHint` presizes the output. */
export function inflateRaw(data, start = 0, sizeHint = data.length * 4) {
    return new Inflater(data, start, sizeHint).run();
}
/** Decompress a zlib stream (2-byte header, DEFLATE body; the Adler-32 trailer is not checked). */
export function inflateZlib(data, sizeHint) {
    if (data.length < 2)
        throw new RangeError("inflate: zlib stream too short");
    const cmf = data[0], flg = data[1];
    if ((cmf & 15) !== 8 || ((cmf << 8) | flg) % 31 !== 0)
        throw new RangeError("inflate: not a zlib stream");
    if (flg & 0x20)
        throw new RangeError("inflate: zlib preset dictionary not supported");
    return inflateRaw(data, 2, sizeHint);
}
