/*
  MTM2's Hall of Fame (the file `MTM2 High Scores` in the game folder, no extension; OpenMTM2
  docs/MONSTER_EXE_ANALYSIS.md 16). The text is enciphered in 8-byte blocks by a TEA-like cipher whose sum
  depends on where the block lies, so a block cannot be read without those before it:

    key k = 5657cd21 1e8ed81f f7041c22 75055f5e, D = 0x60cd2161, R = 64 rounds
    p = the bytes read so far, this block included; s = a running total from 0
    decipher: sum = (p + R) D + s, then R times
      v1 -= ((v0 >>> 7) + k3) ^ ((v0 << 6) + k2) ^ (sum + v0)
      v0 -= ((v1 << 6) + k0) ^ ((v1 >>> 7) + k1) ^ (sum + v1)
      sum -= D
    then s += floor(v0 / R) + floor(v1 / R), from the plain words

  The game ciphers whatever its last read returned, so a file ends with one block past the text: the zero-padded
  last bytes, or a block of zeros when the text filled its blocks exactly. A short last read counts only its own
  bytes in `p`, while reading the file back always counts 8, so the game deciphers that block with the wrong sum;
  the reader here tries each count for the last block and keeps the one that leaves zero padding.

  The plain text, one value a line, whitespace skipped after each: the number of tracks; per track its name, the
  number of entries, and per entry the date (MM/DD/YY), the driver, the truck's name, the time (seconds), the points,
  the skill level (0 Rookie, 1 Intermediate, 2 Professional) and 1 for a Summit Rumble or 0 for a race.
*/
const latin1 = new TextDecoder("latin1");
export const HIGH_SCORES_FILE = "MTM2 High Scores";
const KEY = [0x5657cd21, 0x1e8ed81f, 0xf7041c22, 0x75055f5e];
const DELTA = 0x60cd2161;
const ROUNDS = 64;
const mul = (a, b) => Math.imul(a, b) >>> 0;
function decipherBlock(v, p, s) {
    let v0 = v[0], v1 = v[1];
    let sum = (mul(p + ROUNDS, DELTA) + s) >>> 0;
    for (let n = 0; n < ROUNDS; n++) {
        v1 = (v1 - ((((v0 >>> 7) + KEY[3]) ^ ((v0 << 6) + KEY[2]) ^ (sum + v0)) >>> 0)) >>> 0;
        v0 = (v0 - ((((v1 << 6) + KEY[0]) ^ ((v1 >>> 7) + KEY[1]) ^ (sum + v1)) >>> 0)) >>> 0;
        sum = (sum - DELTA) >>> 0;
    }
    v[0] = v0;
    v[1] = v1;
}
function encipherBlock(v, p, s) {
    let v0 = v[0], v1 = v[1];
    let sum = (mul(p, DELTA) + s) >>> 0;
    for (let n = 0; n < ROUNDS; n++) {
        sum = (sum + DELTA) >>> 0;
        v0 = (v0 + ((((v1 << 6) + KEY[0]) ^ ((v1 >>> 7) + KEY[1]) ^ (sum + v1)) >>> 0)) >>> 0;
        v1 = (v1 + ((((v0 >>> 7) + KEY[3]) ^ ((v0 << 6) + KEY[2]) ^ (sum + v0)) >>> 0)) >>> 0;
    }
    v[0] = v0;
    v[1] = v1;
}
const runningTotal = (s, v0, v1) => (s + Math.floor(v0 / ROUNDS) + Math.floor(v1 / ROUNDS)) >>> 0;
/** The plain bytes of an enciphered file (whole blocks only; a trailing part of a block is dropped). */
export function decipherHighScores(bytes) {
    const blocks = Math.floor(bytes.length / 8);
    const out = new Uint8Array(blocks * 8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), put = new DataView(out.buffer);
    const v = new Uint32Array(2);
    let s = 0;
    for (let b = 0; b < blocks; b++) {
        const c0 = view.getUint32(b * 8, true), c1 = view.getUint32(b * 8 + 4, true);
        v[0] = c0;
        v[1] = c1;
        decipherBlock(v, (b + 1) * 8, s);
        if (b === blocks - 1) {
            // The closing block: the count it was ciphered with is 8b plus however many bytes the last read found.
            for (let k = 7; k >= 0; k--) {
                const t = new Uint32Array([c0, c1]);
                decipherBlock(t, b * 8 + k, s);
                const bytes = new Uint8Array(t.buffer);
                if (bytes.subarray(k).every((x) => x === 0) && (k === 0 || bytes[k - 1] !== 0)) {
                    v[0] = t[0];
                    v[1] = t[1];
                    break;
                }
            }
        }
        put.setUint32(b * 8, v[0], true);
        put.setUint32(b * 8 + 4, v[1], true);
        s = runningTotal(s, v[0], v[1]);
    }
    return out;
}
/** Plain bytes enciphered as the game writes them, with its closing block. */
export function encipherHighScores(plain) {
    const blocks = Math.floor(plain.length / 8) + 1;
    const padded = new Uint8Array(blocks * 8);
    padded.set(plain);
    const view = new DataView(padded.buffer);
    const v = new Uint32Array(2);
    let s = 0;
    for (let b = 0; b < blocks; b++) {
        // The bytes the game's read returned so far: 8 a block, then what the last read found (none after a full text).
        const p = Math.min(plain.length, (b + 1) * 8);
        v[0] = view.getUint32(b * 8, true);
        v[1] = view.getUint32(b * 8 + 4, true);
        const next = runningTotal(s, v[0], v[1]);
        encipherBlock(v, p, s);
        view.setUint32(b * 8, v[0], true);
        view.setUint32(b * 8 + 4, v[1], true);
        s = next;
    }
    return padded;
}
/** The Hall of Fame from the file's bytes; null when they do not read as one. */
export function parseMtmHighScores(bytes) {
    const text = latin1.decode(decipherHighScores(bytes)).replace(/\0[\s\S]*$/, "");
    let at = 0;
    const ws = () => { while (at < text.length && /\s/.test(text[at]))
        at++; };
    const line = () => {
        const end = text.indexOf("\n", at);
        const value = (end < 0 ? text.slice(at) : text.slice(at, end)).replace(/\r$/, "");
        at = end < 0 ? text.length : end + 1;
        ws();
        return value;
    };
    const number = () => {
        const m = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(text.slice(at, at + 64));
        if (!m)
            return NaN;
        at += m[0].length;
        ws();
        return Number(m[0]);
    };
    ws();
    const tracks = number();
    if (!Number.isInteger(tracks) || tracks < 0 || tracks > 10000)
        return null;
    const out = [];
    for (let t = 0; t < tracks; t++) {
        const track = line();
        const count = number();
        if (!Number.isInteger(count) || count < 0 || count > 10000)
            return null;
        const entries = [];
        for (let e = 0; e < count; e++) {
            const date = line(), driver = line(), truck = line();
            const time = number(), points = number(), skill = number();
            const flag = text[at] ?? "0";
            at++;
            ws();
            if (![time, points, skill].every(Number.isFinite))
                return null;
            entries.push({ date, driver, truck, time, points: Math.trunc(points), skill: Math.trunc(skill), summit: flag === "1" });
        }
        out.push({ track, entries });
    }
    return out;
}
/** The file's bytes for a Hall of Fame, enciphered as the game writes it. */
export function writeMtmHighScores(tracks) {
    const lines = [String(tracks.length)];
    const short = (n) => String(Math.max(-32768, Math.min(32767, Math.trunc(n) || 0)));
    for (const t of tracks) {
        lines.push(t.track, String(t.entries.length));
        for (const e of t.entries) {
            lines.push(e.date || "01/01/98", e.driver, e.truck, String(Math.round((Number.isFinite(e.time) ? e.time : 0) * 100) / 100), short(e.points), short(e.skill), e.summit ? "1" : "0");
        }
    }
    const text = `${lines.join("\n")}\n`;
    const plain = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++)
        plain[i] = text.charCodeAt(i) & 0xff;
    return encipherHighScores(plain);
}
