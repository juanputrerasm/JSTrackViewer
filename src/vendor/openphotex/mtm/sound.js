/*
  MTM2 sound data: the loop points beside each sample (`.KLP`) and the per-level ambient sound
  list (`DATA\SOUNDnnn.TXT`).

  .KLP (MONSTER.EXE 0x524730, loaded with the .WAV of the same stem from SOUND\):
    type                   0..6; anything else, or a malformed file, means no loop points
    type 1, 2:  "start end"           one loop; end is stored minus 1
    type 3..6:  count (1..20), then count lines "end start"
  An end of 0 or less means "to the end of the sample". The game rejects a loop whose start is
  negative or past the end, whose end is past the sample's length, or, for a single loop, one
  shorter than 200. Types 1 and 3/4 set the playback mode to 1, types 2 and 5/6 to 2; types 4
  and 6 also set a flag. What the two modes and the flag do is not traced yet.

  SOUNDnnn.TXT (0x42a1a0; nnn is the SIT's ambient sound number) is positional, a label line
  before each value:
    checkpoint wav file, finish lap wav file, number of one-shots, then
    "wavName, vol, timerMin, timerMax, weatherMask" per one-shot,
    number of looping sounds, then "wavName, vol, weatherMask" per loop.
  Weather masks have one bit per weather state (0 clear .. 8 pitch black; 511 is all).
*/
const decoder = new TextDecoder("latin1");
function textOf(input) {
    return typeof input === "string" ? input : decoder.decode(input);
}
function lines(input) {
    return textOf(input).split(/\r?\n|\r/);
}
/** Read a .KLP; null when the game would ignore it. Sample-length checks need the WAV. */
export function parseKlp(input) {
    const tokens = textOf(input).trim().split(/\s+/).filter(Boolean).map((t) => parseInt(t, 10));
    if (tokens.length === 0 || tokens.some((n) => !Number.isFinite(n)))
        return null;
    const type = tokens[0];
    if (type < 0 || type > 6)
        return null;
    const endOf = (raw) => (raw <= 0 ? null : raw);
    if (type === 0)
        return { type, mode: 0, flag: false, loops: [] };
    if (type < 3) {
        if (tokens.length < 3)
            return null;
        return { type, mode: type === 1 ? 1 : 2, flag: false, loops: [{ start: tokens[1], end: endOf(tokens[2] - 1) }] };
    }
    const count = tokens[1];
    if (!(count >= 1 && count <= 20) || tokens.length < 2 + count * 2)
        return null;
    const loops = [];
    for (let i = 0; i < count; i++)
        loops.push({ start: tokens[3 + i * 2], end: endOf(tokens[2 + i * 2]) });
    return { type, mode: type > 4 ? 2 : 1, flag: (type & 1) === 0, loops };
}
/** Read a SOUNDnnn.TXT. */
export function parseMtmAmbientSounds(input) {
    const rows = lines(input).map((l) => l.trim()).filter((l) => l.length > 0);
    let i = 0;
    const value = () => { i++; return rows[i++] ?? ""; };
    const fields = (row) => row.split(",").map((f) => f.trim());
    const out = { checkpointWav: value(), finishLapWav: value(), oneShots: [], loops: [] };
    const oneShotCount = parseInt(value(), 10) || 0;
    i++; // the column labels
    for (let n = 0; n < oneShotCount && i < rows.length; n++) {
        const [wav, vol, min, max, mask] = fields(rows[i++]);
        out.oneShots.push({ wav, volume: parseFloat(vol), timerMin: parseFloat(min), timerMax: parseFloat(max), weatherMask: parseInt(mask, 10) });
    }
    const loopCount = parseInt(value(), 10) || 0;
    i++;
    for (let n = 0; n < loopCount && i < rows.length; n++) {
        const [wav, vol, mask] = fields(rows[i++]);
        out.loops.push({ wav, volume: parseFloat(vol), weatherMask: parseInt(mask, 10) });
    }
    return out;
}
/** Whether a weather-masked sound plays in a weather state (0..8). */
export function weatherMaskIncludes(mask, weather) {
    return ((mask >> weather) & 1) === 1;
}
