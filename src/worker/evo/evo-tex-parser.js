import { splitEvoLines, evoNumbers } from "./evo-text.js";

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

  param0 and param1 are material/alignment metadata whose semantics are unknown. Observed
  param0 values are 0, 100, 20x, 50x, 60x, 701, 100x, 120x and observed param1 values are
  0..3. They are preserved verbatim rather than being named "friction" and "rotation" on a
  guess, because a wrong name in the normalized model is harder to undo than a missing one.
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
    if (!line) continue;
    // Split on the LAST two commas so a filename containing a comma cannot shift the fields.
    const first = line.indexOf(",");
    const second = line.indexOf(",", first + 1);
    if (first < 0 || second < 0) continue;
    records.push({
      param0: Number.parseInt(line.slice(0, first), 10) || 0,
      param1: Number.parseInt(line.slice(first + 1, second), 10) || 0,
      name: line.slice(second + 1).trim(),
    });
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
