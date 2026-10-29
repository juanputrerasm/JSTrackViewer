/*
  MTM2's drivers (`player.pro` in the game folder; OpenMTM2 docs/MONSTER_EXE_ANALYSIS.md 16): text, one value a
  line, CR LF. The file version, the number of drivers, the selected driver (1-based), then each driver. A driver's
  lines depend on the version (the game writes 103 and refuses anything newer):

    name                                   every version
    an integer                             103
    an integer, then seven text lines      102 and 103
    a count, then a text line and an integer for each   101 to 103
    three integers, a truck, a track, four integers     every version

  The four integers at the end default to 1, 1, 600, 1; read as the Garage setup they are the tire cut, the
  suspension and the transfer setting, then one more setting (a hypothesis in the analysis).
*/
const decoder = new TextDecoder("latin1");
/** The version MTM2 2.00.42 writes; the reader takes 100 to this. */
export const PLAYER_PRO_VERSION = 103;
/** A driver as the game makes a new one (`0x4da110`). */
export function newMtmDriver(name, truck = "", track = "") {
    return { name, extra: 0, flag: 0, texts: ["", "", "", "", "", "", ""], pairs: [], numbers: [0, 0, 0], truck, track, settings: [1, 1, 600, 1] };
}
const int = (line) => {
    const v = parseInt((line ?? "").trim(), 10);
    return Number.isFinite(v) ? v : 0;
};
/** Read `player.pro`; null when the file is not one (no version line, or a version the game would refuse). */
export function parseMtmPlayerPro(input) {
    const text = typeof input === "string" ? input : decoder.decode(input);
    const lines = text.split(/\r?\n|\r/);
    let i = 0;
    const next = () => lines[i++];
    const version = int(next());
    if (version < 100 || version > PLAYER_PRO_VERSION)
        return null;
    const count = int(next());
    const selected = int(next()) || 1;
    const drivers = [];
    for (let d = 0; d < count && i < lines.length; d++) {
        const driver = newMtmDriver(next() ?? "");
        if (version >= 103)
            driver.extra = int(next());
        if (version >= 102) {
            driver.flag = int(next()) & 0xff;
            driver.texts = Array.from({ length: 7 }, () => next() ?? "");
        }
        if (version >= 101) {
            const pairs = Math.max(0, int(next()));
            for (let p = 0; p < pairs && i < lines.length; p++)
                driver.pairs.push({ text: next() ?? "", value: int(next()) });
        }
        driver.numbers = [int(next()), int(next()), int(next())];
        driver.truck = next() ?? "";
        driver.track = next() ?? "";
        driver.settings = [int(next()), int(next()), int(next()), int(next())];
        drivers.push(driver);
    }
    return { version, selected, drivers };
}
/** The file's text, version 103, as the game writes it (CR LF lines). */
export function writeMtmPlayerPro(pro) {
    const out = [PLAYER_PRO_VERSION, pro.drivers.length, pro.selected ?? 1];
    for (const d of pro.drivers) {
        out.push(d.name, Math.trunc(d.extra), Math.trunc(d.flag) & 0xff);
        for (let t = 0; t < 7; t++)
            out.push(d.texts[t] ?? "");
        out.push(d.pairs.length);
        for (const p of d.pairs)
            out.push(p.text, Math.trunc(p.value));
        out.push(...d.numbers.map(Math.trunc), d.truck, d.track, ...d.settings.map(Math.trunc));
    }
    return `${out.map(String).join("\r\n")}\r\n`;
}
