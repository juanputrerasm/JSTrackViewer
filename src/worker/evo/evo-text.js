/*
  Shared text handling for the 4x4 Evolution world files.

  .SIT, .LVL, .TEX, .VEG and .WAT are all line-oriented ASCII written by the same era of
  Terminal Reality tooling: CRLF, occasional trailing blank line, and label lines that carry
  a leading sigil (!, @, #, $, %, &) chosen per record rather than per field. The sigil is
  decoration - the same field is spelled `castShadowOnMe` in one file and `%castShadowOnMe`
  in another - so every reader here strips it before matching.
*/

export function splitEvoLines(bytes) {
  return new TextDecoder("latin1")
    .decode(bytes)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
}

/** Strips the per-record sigil and surrounding space from a label line. */
export function evoLabel(line) {
  return (line ?? "").trim().replace(/^[!@#$%&]+/, "").trim();
}

/** Parses `a,b,c` into numbers, tolerating spaces and a trailing separator. */
export function evoNumbers(line) {
  if (!line) return [];
  return String(line)
    .split(",")
    .map((part) => Number.parseFloat(part.trim()))
    .filter((value) => Number.isFinite(value));
}

/** Unquotes a v7 string field: `"AUSTART.SMF"` -> `AUSTART.SMF`. */
export function evoUnquote(value) {
  const trimmed = (value ?? "").trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1)
    : trimmed;
}

/*
  Splits a v7 instance line into its value and its `// fieldName` comment.

  This is the whole reason the v7 reader needs no per-class schema table: every field in
  every brace instance names itself. Verified across all 874 instances of the four stock
  Evo 2 tracks - 11 distinct classes, zero unlabeled lines.
*/
export function evoFieldLine(line) {
  const marker = line.indexOf("//");
  if (marker < 0) return { value: line.trim(), field: null };
  return { value: line.slice(0, marker).trim(), field: line.slice(marker + 2).trim() };
}
