import { placementToEditor, toDataLines } from "./coords.js";
import { tvPowerup } from "./tables.js";
export function parsePowerups(bytes, gridSize, origin) {
    if (!bytes || !bytes.length)
        return [];
    const lines = toDataLines(bytes);
    let i = 0;
    while (i < lines.length && lines[i] === "")
        i++;
    const count = parseInt(lines[i], 10);
    if (!Number.isFinite(count) || count < 0 || count > 8192)
        return [];
    i++;
    const powerups = [];
    for (let n = 0; n < count && i < lines.length; n++, i++) {
        const parts = lines[i].split(",");
        if (parts.length < 4)
            break;
        const values = parts.slice(0, 4).map((v) => parseInt(v.trim(), 10));
        if (values.some((v) => !Number.isFinite(v)))
            break;
        const known = origin === "HB" ? null : tvPowerup(values[3]);
        powerups.push({
            index: n,
            position: placementToEditor(values[0], values[1], values[2], gridSize, origin),
            type: values[3],
            name: known?.name ?? "",
            furyName: known?.furyName ?? "",
            modelName: known?.model ?? "",
        });
    }
    return powerups;
}
