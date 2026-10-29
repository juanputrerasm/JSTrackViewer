/*
  Monster Truck Madness tournaments (`TOURNEY\*.TRN`, written by MONSTER.EXE 1.00 at 0x4c6960):
  text, a label line then its value, CRLF line ends, some files closed by a Ctrl+Z.

    == Tournament Name ==
    Monster Truck Triathlon
    == Tournament Description File ==
    tri.txt
    == Has Drag Race Flag ==
    1
    == Number Of Tracks ==
    3
    == Track Entry #1 ==
    DRAG5.SIT,0
    ...

  A track entry is `file,laps`; laps is 0 for a drag strip or a rally. The description file is
  plain text beside the tournament. The game takes at most 16 events (TRN_MAX_EVENTS) and a
  circuit's laps from 1 to 20. The drag flag says whether any event is a drag race, which is what
  makes the game ask for 2, 4 or 8 trucks. MTM2 ships the three stock files and reads none.
*/
const decoder = new TextDecoder("latin1");
export const TRN_MAX_EVENTS = 16;
export const TRN_MAX_LAPS = 20;
const isLabel = (line) => /^==.*==\s*$/.test(line);
/** Read a .TRN; null when it has no tournament name label. */
export function parseTrn(input) {
    const text = typeof input === "string" ? input : decoder.decode(input);
    // A Ctrl+Z ends a DOS text file; what follows is not read.
    const cut = text.indexOf("\x1a");
    const lines = (cut >= 0 ? text.slice(0, cut) : text).split(/\r?\n|\r/);
    const fields = new Map();
    const entries = [];
    for (let i = 0; i < lines.length; i++) {
        if (!isLabel(lines[i]))
            continue;
        const label = lines[i].replace(/^==\s*|\s*==\s*$/g, "").toLowerCase();
        const value = i + 1 < lines.length && !isLabel(lines[i + 1]) ? lines[++i].trim() : "";
        if (label.startsWith("track entry"))
            entries.push(value);
        else
            fields.set(label, value);
    }
    if (!fields.has("tournament name"))
        return null;
    const warnings = [];
    const events = [];
    for (const entry of entries) {
        const comma = entry.lastIndexOf(",");
        const file = (comma >= 0 ? entry.slice(0, comma) : entry).trim();
        if (!file) {
            warnings.push("An empty track entry was skipped");
            continue;
        }
        const laps = comma >= 0 ? parseInt(entry.slice(comma + 1), 10) : 0;
        events.push({ file, laps: Number.isFinite(laps) && laps > 0 ? laps : 0 });
    }
    const count = parseInt(fields.get("number of tracks") ?? "", 10);
    if (Number.isFinite(count) && count !== events.length)
        warnings.push(`Number Of Tracks says ${count}, the file lists ${events.length}`);
    if (events.length > TRN_MAX_EVENTS)
        warnings.push(`More than ${TRN_MAX_EVENTS} events: the game takes no more`);
    return {
        name: fields.get("tournament name") ?? "",
        descriptionFile: fields.get("tournament description file") ?? "",
        hasDrag: parseInt(fields.get("has drag race flag") ?? "0", 10) > 0,
        events,
        warnings,
    };
}
/** Write a .TRN as the game does: CRLF lines, no closing Ctrl+Z. */
export function writeTrn(trn) {
    const lines = [
        "== Tournament Name ==", trn.name,
        "== Tournament Description File ==", trn.descriptionFile,
        "== Has Drag Race Flag ==", trn.hasDrag ? "1" : "0",
        "== Number Of Tracks ==", String(trn.events.length),
    ];
    trn.events.forEach((event, index) => lines.push(`== Track Entry #${index + 1} ==`, `${event.file},${Math.max(0, Math.trunc(event.laps))}`));
    return `${lines.join("\r\n")}\r\n`;
}
