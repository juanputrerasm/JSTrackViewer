/*
  ProTracker modules (`.MOD`), the music MTM2 plays through its built-in "%u-channel MOD" player
  (MONSTER.EXE 0x5580f0): `MUSIC\SEX.MOD` in SOUND.POD is a 6-channel one.

  parseMod reads the file; renderMod plays it into a stereo buffer, offline, once through to where
  the song loops back on itself. A browser then loops that buffer. The player follows ProTracker 2
  as far as the effects go: arpeggio, slides, tone portamento, vibrato, tremolo, sample offset,
  volume slides, position jump, pattern break, set volume, speed and tempo, and the E effects
  (fine slides, glissando, waveforms, finetune, pattern loop, retrigger, note cut and delay,
  pattern delay). Panning follows the Amiga's left, right, right, left, repeating, narrowed by
  `separation`.

  Layout: 20 byte title; 31 samples of 30 bytes (22 name, length in words, finetune, volume,
  loop start and loop length in words, all big-endian); song length; a restart byte; 128 order
  numbers; a 4 byte signature (`M.K.`, `4CHN`, `6CHN`, `8CHN`, `FLT4`, `FLT8`, `nnCH`); the
  patterns (64 rows of `channels` 4 byte cells: sample, period, effect); the 8-bit samples.
*/
const dec = new TextDecoder("latin1");
const cString = (bytes) => dec.decode(bytes).replace(/\0[\s\S]*$/, "").trim();
/** The channel count a signature means, or 0. */
export function modChannels(signature) {
    if (signature === "M.K." || signature === "M!K!" || signature === "FLT4" || signature === "4CHN")
        return 4;
    if (signature === "6CHN")
        return 6;
    if (signature === "8CHN" || signature === "FLT8" || signature === "OCTA" || signature === "CD81")
        return 8;
    const m = /^(\d\d)CH$/.exec(signature);
    if (m)
        return Number(m[1]);
    return 0;
}
/** Read a 31-sample module; null when it is not one. */
export function parseMod(bytes) {
    if (bytes.length < 1084)
        return null;
    const channels = modChannels(dec.decode(bytes.subarray(1080, 1084)));
    if (channels === 0)
        return null;
    const samples = [];
    for (let i = 0; i < 31; i++) {
        const o = 20 + i * 30;
        const word = (at) => (bytes[at] << 8) | bytes[at + 1];
        let finetune = bytes[o + 24] & 15;
        if (finetune > 7)
            finetune -= 16;
        samples.push({
            name: cString(bytes.subarray(o, o + 22)), length: word(o + 22) * 2, finetune, volume: Math.min(64, bytes[o + 25]),
            loopStart: word(o + 26) * 2, loopLength: word(o + 28) * 2, data: new Int8Array(0),
        });
    }
    const songLength = Math.min(128, Math.max(1, bytes[950]));
    const orders = Array.from(bytes.subarray(952, 952 + 128));
    const patternCount = Math.max(...orders.slice(0, 128)) + 1;
    const patterns = [];
    let at = 1084;
    for (let p = 0; p < patternCount; p++) {
        const cells = [];
        for (let c = 0; c < 64 * channels; c++, at += 4) {
            const b0 = bytes[at] ?? 0, b1 = bytes[at + 1] ?? 0, b2 = bytes[at + 2] ?? 0, b3 = bytes[at + 3] ?? 0;
            cells.push({ sample: (b0 & 0xf0) | (b2 >> 4), period: ((b0 & 0x0f) << 8) | b1, effect: b2 & 0x0f, param: b3 });
        }
        patterns.push(cells);
    }
    for (const s of samples) {
        const end = Math.min(bytes.length, at + s.length);
        s.data = new Int8Array(bytes.buffer, bytes.byteOffset + at, Math.max(0, end - at)).slice();
        at += s.length;
    }
    return { title: cString(bytes.subarray(0, 20)), channels, songLength, orders, patterns, samples };
}
/** Period for each note, finetune 0: C-1 to B-3 (ProTracker's table). */
const PERIODS = [
    856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
    428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
    214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
];
const finetuned = (period, finetune) => Math.round(period * 2 ** (-finetune / 96));
const SINE = Array.from({ length: 32 }, (_, i) => Math.round(255 * Math.sin((i * Math.PI) / 32)));
const PAULA = 3546894.6;
function waveValue(wave, pos) {
    const p = pos & 31;
    switch (wave & 3) {
        case 1: return 255 - p * 8; // ramp down
        case 2: return 255; // square
        default: return SINE[p]; // sine
    }
}
/** The mix level of one channel at full volume, before the square root of the channel count (see `renderMod`). */
export const MOD_MIX_GAIN = 1.35;
/**
 * Play a module into a stereo buffer. Stops where the song ends, or runs into a row it has
 * already played (the loop point), or after `maxSeconds`.
 */
export function renderMod(song, options = {}) {
    const sampleRate = options.sampleRate ?? 22050;
    const separation = options.separation ?? 0.5;
    const maxFrames = Math.floor((options.maxSeconds ?? 600) * sampleRate);
    const chans = Array.from({ length: song.channels }, () => ({
        sample: 0, period: 0, target: 0, volume: 0, pos: 0, step: 0, portamento: 0,
        vibrato: { speed: 0, depth: 0, pos: 0 }, tremolo: { speed: 0, depth: 0, pos: 0 }, vibratoWave: 0, tremoloWave: 0,
        offset: 0, loopRow: 0, loopCount: 0, glissando: false, cell: { sample: 0, period: 0, effect: 0, param: 0 },
        active: false, arpIndex: 0, finetune: 0, delayTicks: 0, pendingNote: null,
    }));
    const pan = chans.map((_, i) => ((i & 3) === 1 || (i & 3) === 2 ? 0.5 + 0.5 * separation : 0.5 - 0.5 * separation));
    const out = { l: new Float32Array(1 << 20), r: new Float32Array(1 << 20), n: 0 };
    const ensure = (n) => {
        if (n <= out.l.length)
            return;
        const size = Math.max(n, out.l.length * 2);
        const l = new Float32Array(size), r = new Float32Array(size);
        l.set(out.l);
        r.set(out.r);
        out.l = l;
        out.r = r;
    };
    let speed = 6, tempo = 125;
    let order = 0, row = 0, nextOrder = -1, nextRow = -1, patternDelay = 0;
    const visited = new Map();
    let loopStartFrame = -1;
    const channelCount = chans.length;
    // Channels add up as unrelated signals, not in step: dividing by their count left a 6-channel song some 12 dB under
    // a WAV track. Their square root keeps a full song at about -16 dBFS RMS, as loud as MTM2's WAV music.
    const mixGain = MOD_MIX_GAIN / Math.sqrt(Math.max(1, channelCount));
    const periodOfNote = (period, finetune) => finetuned(period, finetune);
    const noteIndexOf = (period, finetune) => {
        let best = 0, bestDiff = Infinity;
        for (let i = 0; i < PERIODS.length; i++) {
            const d = Math.abs(periodOfNote(PERIODS[i], finetune) - period);
            if (d < bestDiff) {
                bestDiff = d;
                best = i;
            }
        }
        return best;
    };
    const clampPeriod = (p) => Math.max(113, Math.min(856, p));
    const retrigger = (ch) => { ch.pos = 0; ch.active = true; };
    const setPeriod = (ch, p) => { ch.period = p; };
    const triggerNote = (ch, sampleNo, period, tonePortamento) => {
        if (sampleNo > 0) {
            ch.sample = sampleNo;
            const s = song.samples[sampleNo - 1];
            if (s) {
                ch.volume = s.volume;
                ch.finetune = s.finetune;
            }
        }
        if (period > 0) {
            const base = noteIndexOf(period, 0);
            const adjusted = periodOfNote(PERIODS[base], ch.finetune);
            if (tonePortamento)
                ch.target = adjusted;
            else {
                ch.target = adjusted;
                setPeriod(ch, adjusted);
                retrigger(ch);
                if (ch.vibratoWave < 4)
                    ch.vibrato.pos = 0;
                if (ch.tremoloWave < 4)
                    ch.tremolo.pos = 0;
            }
        }
    };
    const doRow = (tick, ch, index) => {
        const { effect, param } = ch.cell;
        const x = param >> 4, y = param & 15;
        if (tick === 0) {
            switch (effect) {
                case 0x3:
                    if (param)
                        ch.portamento = param;
                    break;
                case 0x4:
                    if (x)
                        ch.vibrato.speed = x;
                    if (y)
                        ch.vibrato.depth = y;
                    break;
                case 0x7:
                    if (x)
                        ch.tremolo.speed = x;
                    if (y)
                        ch.tremolo.depth = y;
                    break;
                case 0x9:
                    if (param)
                        ch.offset = param * 256;
                    break;
                case 0xb:
                    nextOrder = param;
                    nextRow = 0;
                    break;
                case 0xc:
                    ch.volume = Math.min(64, param);
                    break;
                case 0xd:
                    nextRow = x * 10 + y;
                    if (nextOrder < 0)
                        nextOrder = order + 1;
                    break;
                case 0xf:
                    if (param === 0) { /* stop: treat as end */
                        nextOrder = song.songLength;
                        nextRow = 0;
                    }
                    else if (param < 32)
                        speed = param;
                    else
                        tempo = param;
                    break;
                case 0xe:
                    switch (x) {
                        case 0x1:
                            setPeriod(ch, clampPeriod(ch.period - y));
                            break;
                        case 0x2:
                            setPeriod(ch, clampPeriod(ch.period + y));
                            break;
                        case 0x3:
                            ch.glissando = y !== 0;
                            break;
                        case 0x4:
                            ch.vibratoWave = y;
                            break;
                        case 0x5:
                            ch.finetune = y > 7 ? y - 16 : y;
                            break;
                        case 0x6:
                            if (y === 0)
                                ch.loopRow = row;
                            else if (ch.loopCount === 0) {
                                ch.loopCount = y;
                                nextRow = ch.loopRow;
                                if (nextOrder < 0)
                                    nextOrder = order;
                            }
                            else if (--ch.loopCount > 0) {
                                nextRow = ch.loopRow;
                                if (nextOrder < 0)
                                    nextOrder = order;
                            }
                            break;
                        case 0x7:
                            ch.tremoloWave = y;
                            break;
                        case 0xa:
                            ch.volume = Math.min(64, ch.volume + y);
                            break;
                        case 0xb:
                            ch.volume = Math.max(0, ch.volume - y);
                            break;
                        case 0xe:
                            patternDelay = y;
                            break;
                        default: break;
                    }
                    break;
                default: break;
            }
            if (effect === 0x9 && ch.cell.period > 0)
                ch.pos = Math.min(ch.offset, 1e9);
            return;
        }
        switch (effect) {
            case 0x0:
                if (param) {
                    const base = noteIndexOf(ch.target || ch.period, ch.finetune);
                    const step = tick % 3 === 0 ? 0 : tick % 3 === 1 ? x : y;
                    const idx = Math.min(PERIODS.length - 1, base + step);
                    ch.arpIndex = idx;
                }
                break;
            case 0x1:
                setPeriod(ch, clampPeriod(ch.period - param));
                break;
            case 0x2:
                setPeriod(ch, clampPeriod(ch.period + param));
                break;
            case 0x3:
            case 0x5: {
                if (ch.target && ch.period !== ch.target) {
                    if (ch.period > ch.target)
                        setPeriod(ch, Math.max(ch.target, ch.period - ch.portamento));
                    else
                        setPeriod(ch, Math.min(ch.target, ch.period + ch.portamento));
                }
                if (effect === 0x5)
                    ch.volume = Math.max(0, Math.min(64, ch.volume + (x ? x : -y)));
                break;
            }
            case 0x4:
            case 0x6: {
                if (effect === 0x6)
                    ch.volume = Math.max(0, Math.min(64, ch.volume + (x ? x : -y)));
                else { /* speed and depth were set on tick 0 */ }
                ch.vibrato.pos = (ch.vibrato.pos + ch.vibrato.speed) & 63;
                break;
            }
            case 0x7:
                ch.tremolo.pos = (ch.tremolo.pos + ch.tremolo.speed) & 63;
                break;
            case 0xa:
                ch.volume = Math.max(0, Math.min(64, ch.volume + (x ? x : -y)));
                break;
            case 0xe:
                if (x === 0x9 && y > 0 && tick % y === 0)
                    retrigger(ch);
                else if (x === 0xc && tick === y)
                    ch.volume = 0;
                else if (x === 0xd && tick === y && ch.pendingNote) {
                    triggerNote(ch, ch.pendingNote.sample, ch.pendingNote.period, false);
                    ch.pendingNote = null;
                }
                break;
            default: break;
        }
        void index;
    };
    while (out.n < maxFrames) {
        const key = order * 64 + row;
        if (order >= song.songLength)
            break;
        if (patternDelay === 0) {
            if (visited.has(key)) {
                loopStartFrame = visited.get(key);
                break;
            }
            visited.set(key, out.n);
        }
        const pattern = song.patterns[song.orders[order]];
        nextOrder = -1;
        nextRow = -1;
        const delayed = patternDelay > 0;
        // The row's cells.
        chans.forEach((ch, c) => {
            const cell = pattern?.[row * channelCount + c] ?? { sample: 0, period: 0, effect: 0, param: 0 };
            ch.cell = cell;
            if (delayed)
                return;
            const x = cell.param >> 4;
            if (cell.effect === 0xe && x === 0xd && cell.param & 15) {
                ch.pendingNote = { sample: cell.sample, period: cell.period };
                return;
            }
            triggerNote(ch, cell.sample, cell.period, cell.effect === 0x3 || cell.effect === 0x5);
        });
        // A speed change on a row applies to the rest of that row.
        const repeat = patternDelay + 1;
        for (let tick = 0; tick < speed * repeat; tick++) {
            chans.forEach((ch, c) => doRow(tick % speed, ch, c));
            const frames = Math.round((sampleRate * 2.5) / tempo);
            ensure(out.n + frames);
            for (let f = 0; f < frames; f++) {
                let l = 0, r = 0;
                for (let c = 0; c < channelCount; c++) {
                    const ch = chans[c];
                    const smp = song.samples[ch.sample - 1];
                    if (!ch.active || !smp || smp.data.length === 0 || ch.period === 0)
                        continue;
                    let period = ch.period;
                    if (ch.cell.effect === 0x0 && ch.cell.param)
                        period = periodOfNote(PERIODS[ch.arpIndex], ch.finetune);
                    if (ch.cell.effect === 0x4 || ch.cell.effect === 0x6) {
                        period += Math.trunc((waveValue(ch.vibratoWave, ch.vibrato.pos) * ch.vibrato.depth) / 128) * (ch.vibrato.pos & 32 ? -1 : 1);
                    }
                    let volume = ch.volume;
                    if (ch.cell.effect === 0x7)
                        volume += Math.trunc((waveValue(ch.tremoloWave, ch.tremolo.pos) * ch.tremolo.depth) / 64) * (ch.tremolo.pos & 32 ? -1 : 1);
                    volume = Math.max(0, Math.min(64, volume));
                    const step = PAULA / Math.max(113, period) / sampleRate;
                    const i = Math.floor(ch.pos);
                    const looped = smp.loopLength > 2;
                    let value = smp.data[Math.min(i, smp.data.length - 1)] / 128;
                    if (i + 1 < smp.data.length || looped) {
                        const nextIndex = looped && i + 1 >= smp.loopStart + smp.loopLength ? smp.loopStart : i + 1;
                        const nextValue = (smp.data[Math.min(nextIndex, smp.data.length - 1)] ?? 0) / 128;
                        value += (nextValue - value) * (ch.pos - i);
                    }
                    const level = (value * volume) / 64 * mixGain;
                    l += level * (1 - pan[c]);
                    r += level * pan[c];
                    ch.pos += step;
                    if (looped) {
                        const end = smp.loopStart + smp.loopLength;
                        if (ch.pos >= end)
                            ch.pos = smp.loopStart + ((ch.pos - end) % smp.loopLength);
                    }
                    else if (ch.pos >= smp.length)
                        ch.active = false;
                }
                out.l[out.n + f] = Math.max(-1, Math.min(1, l));
                out.r[out.n + f] = Math.max(-1, Math.min(1, r));
            }
            out.n += frames;
            if (out.n >= maxFrames)
                break;
        }
        if (patternDelay > 0)
            patternDelay = 0;
        // Where next.
        if (nextOrder >= 0 || nextRow >= 0) {
            if (nextOrder >= 0)
                order = nextOrder;
            else
                order += 1;
            row = nextRow >= 0 ? nextRow : 0;
            if (row >= 64) {
                row = 0;
                order += 1;
            }
        }
        else if (++row >= 64) {
            row = 0;
            order += 1;
        }
    }
    return { sampleRate, left: out.l.slice(0, out.n), right: out.r.slice(0, out.n), loopStartFrame: Math.max(0, loopStartFrame) };
}
