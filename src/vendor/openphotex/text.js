/*
  8-bit text, as every Terminal Reality format stores it.

  Readers decode with TextDecoder("latin1"), which the WHATWG Encoding standard defines as
  windows-1252: bytes 0x80..0x9F become the cp1252 characters (0x80 is U+20AC) and every other
  byte maps to the same code point. encodeWindows1252 is the exact inverse, so a string read
  from an archive always writes back to the same bytes.
*/
/** The code points bytes 0x80..0x9F decode to. Five bytes are unassigned and decode to themselves. */
const HIGH = [
    0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
    0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];
const REVERSE = new Map(HIGH.map((code, i) => [code, 0x80 + i]));
/**
 * Encode `text` as windows-1252, or return the index of the first character it cannot store.
 */
export function encodeWindows1252(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        const byte = REVERSE.get(code) ?? (code <= 0xff && (code < 0x80 || code > 0x9f) ? code : undefined);
        if (byte === undefined)
            return i;
        out[i] = byte;
    }
    return out;
}
