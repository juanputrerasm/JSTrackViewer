/*
  A small PNG reader for the samples themselves, at their stored bit depth.

  Browsers decode PNG art for display, but they flatten a 16-bit grey image to 8 bits, and
  Community Patch 4 stores track heights as 16-bit grey PNGs (DATA\<stem>_H.PNG). This reader
  keeps every sample exact. It covers 8- and 16-bit samples of every colour type, palette
  images at 1, 2, 4 or 8 bits (the samples are the palette indices, with the PLTE colours and
  the tRNS alphas beside them), the five scanline filters, no interlace. tRNS is kept as stored;
  the other ancillary chunks are skipped.
*/
import { inflateZlib } from "./inflate.js";
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
export function isPng(bytes) {
    return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}
function u32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
/** Decode a PNG's samples. Throws RangeError on sub-byte grey, interlace or damage. */
export function decodePngSamples(bytes) {
    if (!isPng(bytes))
        throw new RangeError("png: bad signature");
    let o = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = -1;
    let plte = null;
    let trns = null;
    const idat = [];
    let idatLen = 0;
    while (o + 8 <= bytes.length) {
        const len = u32(bytes, o);
        const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
        const data = o + 8;
        if (data + len > bytes.length)
            throw new RangeError(`png: chunk ${type} runs past the end`);
        if (type === "IHDR") {
            width = u32(bytes, data);
            height = u32(bytes, data + 4);
            bitDepth = bytes[data + 8];
            colorType = bytes[data + 9];
            if (bytes[data + 10] !== 0 || bytes[data + 11] !== 0)
                throw new RangeError("png: unknown compression or filter method");
            if (bytes[data + 12] !== 0)
                throw new RangeError("png: interlaced images are not supported");
        }
        else if (type === "PLTE") {
            if (len % 3 !== 0 || len === 0 || len > 768)
                throw new RangeError("png: bad PLTE");
            plte = bytes.slice(data, data + len);
        }
        else if (type === "tRNS") {
            trns = bytes.slice(data, data + len);
        }
        else if (type === "IDAT") {
            idat.push(bytes.subarray(data, data + len));
            idatLen += len;
        }
        else if (type === "IEND") {
            break;
        }
        o = data + len + 4;
    }
    if (!width || !height)
        throw new RangeError("png: no IHDR");
    const channels = CHANNELS[colorType];
    if (!channels)
        throw new RangeError(`png: unknown colour type ${colorType}`);
    const indexed = colorType === 3;
    if (indexed) {
        if (bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4 && bitDepth !== 8)
            throw new RangeError(`png: bit depth ${bitDepth} is not valid for a palette image`);
        if (!plte)
            throw new RangeError("png: palette image without PLTE");
    }
    else if (colorType === 0) {
        if (bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4 && bitDepth !== 8 && bitDepth !== 16)
            throw new RangeError(`png: bit depth ${bitDepth} is not valid for a grey image`);
    }
    else if (bitDepth !== 8 && bitDepth !== 16)
        throw new RangeError(`png: bit depth ${bitDepth} is not supported`);
    // Palette and grey images may pack 1, 2 or 4 bits a sample (unscaled: 0 .. 2^bits - 1).
    const z = new Uint8Array(idatLen);
    let p = 0;
    for (const c of idat) {
        z.set(c, p);
        p += c.length;
    }
    // The filters work on whole bytes: a sub-byte row is ceil(width * bits / 8) bytes, one byte per "pixel".
    const packed = bitDepth < 8;
    const bpp = packed ? 1 : channels * (bitDepth / 8);
    const stride = packed ? Math.ceil((width * bitDepth) / 8) : width * bpp;
    const raw = inflateZlib(z, (stride + 1) * height);
    if (raw.length < (stride + 1) * height)
        throw new RangeError("png: image data too short");
    const cur = new Uint8Array(stride);
    const prev = new Uint8Array(stride);
    const samples = new Uint16Array(width * height * channels);
    let s = 0;
    for (let y = 0; y < height; y++) {
        const r = y * (stride + 1);
        const filter = raw[r];
        for (let i = 0; i < stride; i++) {
            const x = raw[r + 1 + i];
            const a = i >= bpp ? cur[i - bpp] : 0;
            const b = prev[i];
            const c = i >= bpp ? prev[i - bpp] : 0;
            let v;
            switch (filter) {
                case 0:
                    v = x;
                    break;
                case 1:
                    v = x + a;
                    break;
                case 2:
                    v = x + b;
                    break;
                case 3:
                    v = x + ((a + b) >> 1);
                    break;
                case 4:
                    v = x + paeth(a, b, c);
                    break;
                default: throw new RangeError(`png: bad filter type ${filter} on row ${y}`);
            }
            cur[i] = v & 255;
        }
        if (bitDepth === 8)
            for (let i = 0; i < stride; i++)
                samples[s++] = cur[i];
        else if (bitDepth === 16)
            for (let i = 0; i < stride; i += 2)
                samples[s++] = (cur[i] << 8) | cur[i + 1];
        else {
            // Packed indices or grey levels, most significant bits first; the row's spare low bits are padding.
            const mask = (1 << bitDepth) - 1;
            for (let x = 0; x < width; x++) {
                const bit = x * bitDepth;
                samples[s++] = (cur[bit >> 3] >> (8 - bitDepth - (bit & 7))) & mask;
            }
        }
        prev.set(cur);
    }
    let paletteAlpha = null, transparentKey = null;
    if (trns) {
        if (indexed)
            paletteAlpha = trns.slice(0, Math.min(trns.length, plte.length / 3));
        else if (colorType === 0 && trns.length >= 2)
            transparentKey = [(trns[0] << 8) | trns[1]];
        else if (colorType === 2 && trns.length >= 6)
            transparentKey = [0, 2, 4].map((k) => (trns[k] << 8) | trns[k + 1]);
    }
    return {
        width, height, bitDepth: bitDepth, colorType: colorType, channels, samples,
        palette: indexed ? plte : null, paletteAlpha, transparentKey,
    };
}
