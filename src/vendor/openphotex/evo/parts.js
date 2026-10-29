/*
  4x4 Evolution 2's parts list, PARTS.POD PARTS\PARTS.TXT (OpenMTM2 docs/EVO2_PHYSICS.md §2.1).

  `partCount`, then one block per part opened by `--- Part n ---`: each field's label on one line
  and its value on the next (`Name`, `Code`, `Type`, `Cost`, the six modifiers, `Models`,
  `Prerequisite`, `Incompatible`, `Incompatible Trucks`, `Team Requirement`, `Notes`). The file ends
  with its signature line. Text is Latin-1.
*/
const decode = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i++)
        out += String.fromCharCode(bytes[i]);
    return out;
};
/** The parts of a PARTS.TXT, in file order. */
export function parseEvoParts(input) {
    const text = (typeof input === "string" ? input : decode(input)).replace(/\r/g, "");
    const blocks = text.split(/^--- Part \d+ ---$/m).slice(1);
    return blocks.map((block) => {
        const lines = block.split("\n");
        const fields = {};
        // Labels and values alternate; the first line is the rest of the separator's line.
        for (let i = 1; i + 1 < lines.length; i += 2) {
            const label = lines[i].trim();
            if (!label || label.startsWith("signature"))
                break;
            fields[label] = lines[i + 1].trim();
        }
        const n = (label) => {
            const v = Number(fields[label]);
            return Number.isFinite(v) ? v : 0;
        };
        return {
            name: fields.Name ?? "", code: fields.Code ?? "", type: fields.Type ?? "", cost: n("Cost"),
            aeroMod: n("Aero Mod"), brakeMod: n("Brake Mod"), cgMod: n("CG Mod"), tireCfMod: n("Tire CF Mod"),
            torqueMod: n("Torque Mod"), weightMod: n("Weight Mod"), models: fields.Models ?? "", fields,
        };
    });
}
