/*
  The level file (.LVL) of Terminal Velocity, Fury3 and Hellbender.

  Positional: each header line names one side file or holds one value. `NULL.xxx` in a slot
  means the level has none (see isNullAssetName).

    1   Hellbender briefing .TXT (null.txt in every TV and Fury3 level)
    2   the .RAW heightfield, or a .TNL spine for a tunnel level
    3   .CLR colour grid          4   .ACT palette (its fog map: same stem, .MAP)
    5   .TEX texture list (its type table: same stem, .TTY)
    7   .PUP powerups             8   .ANI texture animations       9   .TDF tunnels
    10  the sky: a 64x64 .RAW, or STARS.VOX / SPACE.VOX for a star field
    11  the sky's .ACT (see skyGradient)
    12  .DEF object placements    13  .NAV navigation points
    14  music                     16  .LTE lighting map
    17-21  sun vector, shadow intensity, sun position, sun intensity, level value
    22  the display name, in levels that carry one

  Hellbender adds records (its "!New ground additions" block is what identifies it) and reads
  its side files on its own placement scale; see coords.ts.

  Ported from JSTrackViewer's src/worker/lvl-parser.js, which read the file and resolved the
  assets it names in one pass. This is the reading half.
*/
import { normalizePodPath, podPathTitle } from "../pod/paths.js";
const decoder = new TextDecoder("latin1");
/** `NULL.xxx`, or nothing: the slot names no file. */
export function isNullAssetName(name) {
    return !name || name.startsWith("NULL.");
}
/** Hellbender's .LVL carries a "!New ground additions" block; TV and Fury3 never do. */
export function detectTvLvlOrigin(lines) {
    return lines.some((line) => line.trim() === "!New ground additions") ? "HB" : "TV/F3";
}
export function parseTvLvl(input) {
    const lines = (typeof input === "string" ? input : decoder.decode(input))
        .replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const name = (i) => (lines.length > i ? normalizePodPath(lines[i]) : null);
    let displayName = null;
    if (lines.length > 22) {
        const candidate = lines[22].trim();
        if (candidate && !candidate.startsWith("!") && !candidate.startsWith(";") && candidate.toLowerCase() !== "null")
            displayName = candidate;
    }
    return {
        origin: detectTvLvlOrigin(lines),
        lineCount: lines.length,
        complete: lines.length >= 22,
        displayName,
        briefingName: name(1),
        rawOrTnlName: name(2),
        clrName: name(3),
        actName: name(4),
        texName: name(5),
        pupName: name(7),
        aniName: name(8),
        tdfName: name(9),
        skyName: name(10),
        skyActName: name(11),
        defName: name(12),
        navName: name(13),
        musicLine: lines.length > 14 ? lines[14] : null,
        lteName: name(16),
        sunVector: lines.length > 17 ? intTriplet(lines[17]) : null,
        shadowIntensity: lines.length > 18 ? leadingInt(lines[18]) : null,
        sunPosition: lines.length > 19 ? intTriplet(lines[19]) : null,
        sunIntensity: lines.length > 20 ? leadingInt(lines[20]) : null,
        levelValue: lines.length > 21 ? leadingInt(lines[21]) : null,
    };
}
/** A level's name from its entry name when the header carries none: the title without .LVL. */
export function tvLvlFallbackName(entryName) {
    const title = podPathTitle(entryName);
    return title.endsWith(".LVL") ? title.slice(0, -4) : title;
}
function intTriplet(value) {
    const parts = value.split(",");
    if (parts.length < 3)
        return null;
    return [parseInt(parts[0].trim(), 10), parseInt(parts[1].trim(), 10), parseInt(parts[2].trim(), 10)];
}
function leadingInt(value) {
    return parseInt((value ?? "").trim(), 10) || 0;
}
