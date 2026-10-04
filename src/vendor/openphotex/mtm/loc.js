/*
  The TRI Message System (`.LOC`, MONSTER.EXE 0x522f50): message replacements. MTM2's UI.POD
  carries MTM2-FUN.LOC (joke wordings) and MTM2-PIG.LOC (Pig Latin).

    TRI Message System
    256
    LOC
    @@TAG        the message as the game writes it (one or more lines)
    @@STRING     what to show instead (one or more lines)
    @@COMMENT    ignored lines
    ...
    @@END        stops reading (so does the end of the file)

  Lines inside a TAG or STRING block are joined with "\n" (a leading empty line vanishes). A
  pair is stored when the next @@TAG, @@END or the end of the file arrives. Files whose first
  three lines differ are ignored.
*/
const decoder = new TextDecoder("latin1");
/** Read a .LOC; null when its header is not the TRI Message System's. */
export function parseLoc(input) {
    const text = typeof input === "string" ? input : decoder.decode(input);
    const rows = text.split(/\r?\n|\r/);
    if (rows[0] !== "TRI Message System" || parseInt(rows[1] ?? "", 10) !== 256 || rows[2] !== "LOC")
        return null;
    const out = [];
    let mode = null;
    let tag = "", body = "";
    // A line is appended after a "\n" only once the block holds something, as the game does.
    const append = (block, row) => (block ? `${block}\n${row}` : row);
    const flush = () => {
        if (mode !== null)
            out.push({ tag, text: body });
        tag = "";
        body = "";
    };
    for (let i = 3; i < rows.length; i++) {
        const row = rows[i];
        if (row.startsWith("@@TAG")) {
            flush();
            mode = "tag";
            continue;
        }
        if (row.startsWith("@@STRING")) {
            mode = "string";
            continue;
        }
        if (row.startsWith("@@COMMENT")) {
            mode = "comment";
            continue;
        }
        if (row.startsWith("@@END"))
            break;
        if (mode === "tag")
            tag = append(tag, row);
        else if (mode === "string")
            body = append(body, row);
    }
    flush();
    return out;
}
