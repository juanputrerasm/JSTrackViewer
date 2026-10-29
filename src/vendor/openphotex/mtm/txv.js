/*
  DATA\<stem>.TXV, the MTM2 track version record that Community Patch 3 tools write beside a
  level: plain text, CRLF, `key=value` lines and `#` comments, for example

    # MTM2 track version record - written by Traxx
    formatVersion=1
    tool=Traxx
    toolVersion=1.6.5
    built=2026-09-26
    legacyFallback=0
    hdTextures=1

  The engine loads a track whatever its record says, so the record is a diagnostic. Unknown
  keys are the forward-compatibility mechanism: a tool keeps the keys it does not know, so the
  reader keeps every line in order and the writer puts them back.
*/
const decoder = new TextDecoder("latin1");
export function parseTxv(input) {
    const text = typeof input === "string" ? input : decoder.decode(input);
    const out = [];
    for (const line of text.split(/\r\n|\r|\n/)) {
        const clean = line.replace(/\x1a/g, "");
        if (!clean.trim())
            continue;
        const eq = clean.indexOf("=");
        if (clean.startsWith("#") || eq < 0)
            out.push({ text: clean });
        else
            out.push({ key: clean.slice(0, eq).trim(), value: clean.slice(eq + 1).trim() });
    }
    return out;
}
/** The value of a key, compared without case, or null. */
export function txvValue(lines, key) {
    const wanted = key.toLowerCase();
    for (const line of lines)
        if ("key" in line && line.key.toLowerCase() === wanted)
            return line.value;
    return null;
}
export function writeTxv(lines) {
    const text = lines.map((line) => `${"key" in line ? `${line.key}=${line.value}` : line.text}\r\n`).join("");
    return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}
