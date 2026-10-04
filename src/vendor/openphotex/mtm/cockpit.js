/*
  MTM2's cockpit layout (`DATA\POWERBIG.200`, `.400`, `.480` in COCKPIT.POD, one per screen
  height). Positional: each value (or group of values) follows a `;` comment naming it, and
  the three stock files carry the same 28 comments in the same order. Coordinates are pixels at
  that resolution.

  The fields, in order: background images (the main one, then by their names left, right and
  bottom parts), the 3D window, speedometer and tachometer (centre, radius, needle model, zero
  angle in degrees, degrees per mph or rpm, face redraw rectangle), steering wheel rectangle,
  erase window, steering wheel base name, mirror count, then per mirror (location, angles,
  translation, zoom, bitmap rectangle, bitmap name), the shifter base name and rectangle, and
  the shift light bitmap and rectangle. The stock mirror's angles (0, 0, 32768) and zoom (49152)
  suggest 1/65536 turns and 16.16 fixed point; the game's reader is not traced yet.
*/
const decoder = new TextDecoder("latin1");
/** The comments and their values. */
export function parseCockpitSections(input) {
    const text = typeof input === "string" ? input : decoder.decode(input);
    const out = [];
    for (const raw of text.split(/\r?\n|\r/)) {
        const line = raw.trim();
        if (!line)
            continue;
        if (line.startsWith(";"))
            out.push({ label: line.slice(1).trim(), values: [] });
        else if (out.length)
            out[out.length - 1].values.push(line);
        else
            out.push({ label: "", values: [line] });
    }
    return out;
}
/** Read a POWERBIG layout; null when it ends early. */
export function parseCockpitLayout(input) {
    const sections = parseCockpitSections(input);
    const values = sections.flatMap((s) => s.values);
    let i = 0;
    const next = () => values[i++];
    const nums = (v) => (v ?? "").split(",").map((s) => parseFloat(s.trim()));
    const rect = () => { const n = nums(next()); return [n[0], n[1], n[2], n[3]]; };
    const pair = () => { const n = nums(next()); return [n[0], n[1]]; };
    const triple = () => { const n = nums(next()); return [n[0], n[1], n[2]]; };
    const num = () => parseFloat(next() ?? "");
    const str = () => next() ?? "";
    const gauge = () => ({
        center: pair(), radius: num(), needleModel: str(), zeroAngle: num(), degreesPerUnit: num(), faceRedraw: rect(),
    });
    const backgrounds = sections[0]?.values.slice() ?? [];
    i = backgrounds.length;
    const layout = {
        sections, backgrounds, window3d: rect(), speedometer: gauge(), tachometer: gauge(),
        steeringWheel: rect(), eraseWindow: rect(), steeringWheelBase: str(), mirrors: [],
        shifter: "", shifterRect: [0, 0, 0, 0], shiftLight: "", shiftLightRect: [0, 0, 0, 0],
    };
    const mirrorCount = parseInt(next() ?? "0", 10) || 0;
    for (let m = 0; m < mirrorCount; m++) {
        layout.mirrors.push({ location: rect(), angles: triple(), translation: triple(), zoom: num(), bitmapRect: rect(), bitmap: str() });
    }
    layout.shifter = str();
    layout.shifterRect = rect();
    layout.shiftLight = str();
    layout.shiftLightRect = rect();
    return i > values.length ? null : layout;
}
