/*
  Sound files by their first bytes: RIFF WAVE, Ogg (Vorbis or Opus) and MPEG audio (MP3, with or
  without an ID3v2 tag). Nothing here decodes sound, a browser does that; a reader learns which
  format a file is and the sample rate it was made at, which `.KLP` loop points (counted in the
  file's own samples) need once a decoder has resampled the sound to its own rate.

  WAV: "RIFF", size, "WAVE", then chunks; "fmt " holds format, channels, then the rate (32-bit LE).
  Ogg: pages start "OggS"; the first page's segment count is byte 26, its first packet follows the
  segment table. A Vorbis identification packet is 0x01 "vorbis", version (4), channels (1), rate
  (4, LE). An Opus head is "OpusHead"; Opus always decodes at 48000 Hz.
  MP3: an optional ID3v2 tag ("ID3", version, flags, a 28-bit sync-safe size, a 10 byte footer when
  flag 0x10 is set), then frames: 11 sync bits, the version (MPEG 1, 2 or 2.5), the layer, and a
  sample rate index giving 44100, 48000 or 32000 Hz for MPEG 1, half that for 2, a quarter for 2.5.
*/
/** The format of a sound file, or null when it is none of WAV, Ogg and MP3. */
export function detectAudioFormat(bytes) {
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE")
        return "wav";
    if (ascii(bytes, 0, 4) === "OggS")
        return "ogg";
    if (mp3FrameAt(bytes, id3End(bytes)) !== null)
        return "mp3";
    return null;
}
/** The rate, in samples per second, the file was made at; null when it cannot be read. */
export function audioSampleRate(bytes) {
    switch (detectAudioFormat(bytes)) {
        case "wav": return wavRate(bytes);
        case "ogg": return oggRate(bytes);
        case "mp3": return mp3FrameAt(bytes, id3End(bytes));
        default: return null;
    }
}
function ascii(bytes, at, length) {
    if (at + length > bytes.length)
        return "";
    let out = "";
    for (let i = 0; i < length; i++)
        out += String.fromCharCode(bytes[at + i]);
    return out;
}
function u32(bytes, at) {
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}
function wavRate(bytes) {
    for (let at = 12; at + 8 <= bytes.length;) {
        const size = u32(bytes, at + 4);
        if (ascii(bytes, at, 4) === "fmt ")
            return at + 16 <= bytes.length ? u32(bytes, at + 12) || null : null;
        at += 8 + size + (size & 1);
    }
    return null;
}
function oggRate(bytes) {
    if (bytes.length < 27)
        return null;
    const packet = 27 + bytes[26];
    if (bytes[packet] === 1 && ascii(bytes, packet + 1, 6) === "vorbis" && packet + 16 <= bytes.length)
        return u32(bytes, packet + 12) || null;
    if (ascii(bytes, packet, 8) === "OpusHead")
        return 48000;
    return null;
}
/** Where the audio starts: after an ID3v2 tag, or 0. */
function id3End(bytes) {
    if (ascii(bytes, 0, 3) !== "ID3" || bytes.length < 10)
        return 0;
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    return 10 + size + (bytes[5] & 0x10 ? 10 : 0);
}
const MPEG1_RATES = [44100, 48000, 32000];
/** The sample rate of an MPEG audio frame header at `at`, or null when there is none. */
function mp3FrameAt(bytes, at) {
    if (at + 4 > bytes.length)
        return null;
    const b1 = bytes[at + 1], b2 = bytes[at + 2];
    if (bytes[at] !== 0xff || (b1 & 0xe0) !== 0xe0)
        return null;
    const version = (b1 >> 3) & 3, layer = (b1 >> 1) & 3, rate = (b2 >> 2) & 3, bitrate = b2 >> 4;
    if (version === 1 || layer === 0 || rate === 3 || bitrate === 15)
        return null;
    const base = MPEG1_RATES[rate];
    return version === 3 ? base : version === 2 ? base / 2 : base / 4;
}
