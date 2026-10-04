/*
  The MTM2 water level (MTM2_PHYSICS.md §2.4).

  - The level's `!waterHeight` is in half feet: the game keeps it as `value << 7` in its height
    units of 1/256 ft (terrain heights are the RAW byte << 9). 0 means the level has no water,
    and the level then stays at 0 ft.
  - During a race the surface bobs: level = base + sin(phase) × 0.25 ft, the phase turning once
    every 8 s. In Snow it stays at the base (the water is frozen).
  - The game advances the phase by dt / 8 each frame in 16.16 fixed point; here it is a function
    of race time, which is the same up to per-frame truncation.

  The sine is the game's 256-step table: sin(i · 2π / 256) × 65536, truncated, interpolated
  linearly on the low byte of a 16-bit phase.
*/
/** Height units of the game's level geometry: 256 per foot (a 2 ft height step is 512). */
const UNITS_PER_FT = 256;
const WAVE_PERIOD_S = 8;
let sineTable = null;
function table() {
    if (!sineTable) {
        sineTable = new Int32Array(257);
        for (let i = 0; i < 257; i++)
            sineTable[i] = Math.trunc(Math.sin(i * 0.02454369260546875) * 65536);
    }
    return sineTable;
}
/** The game's fixed-point sine: phase 0..0xffff is one turn, result ±65536. */
export function fixedSin(phase) {
    const t = table();
    const i = (phase >> 8) & 0xff;
    const a = t[i];
    return a + Math.trunc((t[i + 1] - a) * (phase & 0xff) / 256);
}
/**
 * The water level in feet at `raceTimeS` seconds into the race, or null when the level has no
 * water. `lvlValue` is the LVL `!waterHeight` (half feet).
 */
export function waterLevelFt(lvlValue, raceTimeS = 0, snow = false) {
    if (!lvlValue)
        return null;
    const base = lvlValue * 128;
    if (snow)
        return base / UNITS_PER_FT;
    const phase = Math.trunc((raceTimeS * 0x10000) / WAVE_PERIOD_S) & 0xffff;
    const wave = Math.trunc(Math.trunc(fixedSin(phase) / 256) / 4);
    return (base + wave) / UNITS_PER_FT;
}
