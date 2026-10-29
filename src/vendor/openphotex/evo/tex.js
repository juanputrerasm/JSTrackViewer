import { splitEvoLines, evoNumbers } from "./text.js";
/** Vegetation density classes of a .TEX record (the game's names, `0x673038`). */
export const EVO_VEG_CLASS = Object.freeze({ NONE: 0, SPARSE: 1, MEDIUM: 2, DENSE: 3 });
/*
  Evo .TEX v1: the terrain and shadow texture table.

    Version
    1
    textureCount,shadowTextureCount
    <ordinaryCount>,<shadowCount>
    <param0>,<param1>,<filename>
    ...

  There are exactly ordinaryCount + shadowCount records, verified across all four stock
  tracks (ASPEN 374+602=976, THEHILL 548+444=992, BAJBEACH 191+598=789, PEAK 383+617=1000).

  The two groups are indexed by different files and must not be merged:

    - .CLR indexes the ORDINARY group. Every stock grid stays inside 0..ordinaryCount-1.
    - .SDW references the appended SHADOW group. Its non-sentinel values land exactly on
      ordinaryCount..ordinaryCount+shadowCount-1 in every sample.

  The two numbers are read by 4x4 Evolution 2's CTextureList::load (0x5cb530): the first is the
  texture's surface value, `type * 100 + depth` as in MTM2's .TTY (1 cement, 2 dirt, 3 water,
  4 mud, 5 sand, 6 grass, 7 gravel, 8 ice, 9 snow, 10 metal, 11 wood, 12 rock, 14 train track),
  the second its vegetation class (0 none, 1 sparse, 2 medium, 3 dense), which sets the grass
  density and the tree spacing. Observed first values are 0, 100, 20x, 50x, 60x, 701, 100x,
  120x and second values 0..3, as the game expects.

  Ported from JSTrackViewer's src/worker/evo/evo-tex-parser.js (identical in JSMTM2Converter).
*/
const TEX_RECORD_START = 4;
export function parseEvoTex(bytes, sourceName) {
    const lines = splitEvoLines(bytes);
    const version = Number.parseInt((lines[1] ?? "").trim(), 10);
    const [ordinaryCount, shadowCount] = evoNumbers(lines[3] ?? "");
    if (!Number.isFinite(ordinaryCount) || !Number.isFinite(shadowCount)) {
        throw new Error(`${sourceName}: unreadable .TEX counts line`);
    }
    const records = [];
    for (let i = TEX_RECORD_START; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line)
            continue;
        // Split on the LAST two commas so a filename containing a comma cannot shift the fields.
        const first = line.indexOf(",");
        const second = line.indexOf(",", first + 1);
        if (first < 0 || second < 0)
            continue;
        const surfaceValue = Number.parseInt(line.slice(0, first), 10) || 0;
        const vegClass = Number.parseInt(line.slice(first + 1, second), 10) || 0;
        records.push({ surfaceValue, vegClass, param0: surfaceValue, param1: vegClass, name: line.slice(second + 1).trim() });
    }
    const expected = ordinaryCount + shadowCount;
    const warnings = [];
    if (records.length !== expected) {
        warnings.push(`${sourceName}: expected ${expected} texture records, read ${records.length}`);
    }
    return {
        version,
        sourceName,
        ordinaryCount,
        shadowCount,
        // Slots the .CLR grid indexes.
        ordinary: records.slice(0, ordinaryCount),
        // Slots the .SDW grid references, by an index that is still offset by ordinaryCount.
        shadow: records.slice(ordinaryCount, expected),
        warnings,
    };
}
