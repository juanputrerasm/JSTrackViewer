import { toDataLines } from "./coords.js";
/** Engine units per height step in a .QKE limit. */
export const HB_QUAKE_HEIGHT_UNIT = 128;
const isLabel = (line) => /^(--|!--|@--)/.test(line);
/**
 * Parses a Hellbender .QKE. Returns null when the file does not start with the ground quake
 * count; an entry that does not parse ends the reading, with `complete` false.
 */
export function parseHbQuakes(bytes) {
    if (!bytes || !bytes.length)
        return null;
    const lines = toDataLines(bytes).filter((line) => line !== "");
    let i = 0;
    const label = (pattern) => {
        if (i < lines.length && isLabel(lines[i]) && pattern.test(lines[i])) {
            i++;
            return true;
        }
        return false;
    };
    const numbers = (min) => {
        const line = lines[i];
        if (line === undefined || isLabel(line))
            return null;
        const values = line.split(",").map((v) => Number.parseInt(v.trim(), 10));
        if (values.length < min || !values.every(Number.isFinite))
            return null;
        i++;
        return values;
    };
    const name = () => {
        const line = lines[i];
        if (line === undefined || isLabel(line))
            return undefined;
        i++;
        return line.toUpperCase() === "NULL" ? null : line.toUpperCase();
    };
    const names = (n) => {
        const out = [];
        for (let k = 0; k < n; k++) {
            const value = name();
            if (value === undefined)
                return null;
            out.push(value);
        }
        return out;
    };
    if (!label(/ground quake count/i))
        return null;
    const groundCount = numbers(1)?.[0];
    if (groundCount === undefined || groundCount < 0)
        return null;
    const base = (index, mode, limits, unnamed, times, end, sounds, additionalInfo) => ({
        index,
        mode: mode[0],
        upper: limits[0],
        lower: limits[1],
        upperStep: limits[0] / HB_QUAKE_HEIGHT_UNIT,
        lowerStep: limits[1] / HB_QUAKE_HEIGHT_UNIT,
        startDirection: times[0],
        riseTime: times[1],
        topWait: times[2],
        fallTime: times[3],
        bottomWait: times[4],
        endMode: end[0],
        flags: end.slice(1),
        sounds,
        additionalInfo,
        unnamed: unnamed.slice(0, 4),
    });
    const groundQuakes = [];
    let complete = true;
    for (let n = 0; n < groundCount; n++) {
        label(/ground quake entry/i);
        const mode = numbers(1), limits = numbers(2), cells = numbers(5), unnamed = numbers(4), times = numbers(5), end = numbers(4);
        const sounds = mode && limits && cells && unnamed && times && end ? names(5) : null;
        const trigger = sounds && label(/additional quake info/i) ? numbers(1) : null;
        if (!mode || !limits || !cells || !unnamed || !times || !end || !sounds || !trigger) {
            complete = false;
            break;
        }
        groundQuakes.push({
            ...base(n, mode, limits, unnamed, times, end, sounds, trigger[0]),
            x0: cells[0], z0: cells[1], x1: cells[2], z1: cells[3], layer: cells[4],
        });
    }
    const boxQuakes = [];
    const boxCount = complete && label(/box quake count/i) ? numbers(1)?.[0] : undefined;
    if (boxCount === undefined)
        complete = complete && i >= lines.length;
    for (let n = 0; n < (boxCount ?? 0); n++) {
        label(/box quake entry/i);
        const mode = numbers(1), limits = numbers(2), cell = numbers(3), unnamed = numbers(4), times = numbers(5), end = numbers(5);
        const sounds = mode && limits && cell && unnamed && times && end ? names(5) : null;
        const trigger = sounds && label(/additional quake info/i) ? numbers(1) : null;
        const switchFlag = trigger && label(/box quake switch info/i) ? numbers(1) : null;
        const switchTextures = switchFlag ? names(2) : null;
        if (!mode || !limits || !cell || !unnamed || !times || !end || !sounds || !trigger || !switchFlag || !switchTextures) {
            complete = false;
            break;
        }
        boxQuakes.push({
            ...base(n, mode, limits, unnamed, times, end, sounds, trigger[0]),
            z: cell[0], x: cell[1], layer: cell[2],
            switchFlag: switchFlag[0],
            switchTextures,
        });
    }
    return { groundQuakes, boxQuakes, complete };
}
