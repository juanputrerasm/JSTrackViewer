/*
  DATA\<name>_CP.CPT, Community Patch 4's 3D cockpit layout (VERSION 1), written by the MTM2
  BIN exporter for Blender and by BinEdit 2.4.2's Cockpit Editor. CRLF text, `;` comments,
  `KEY = value, value, ...` lines. The models it names live in MODELS\ of the same pod; the
  game's own default is cockpit.pod's DATA\_DEFAULT_CP.CPT. Example:

    VERSION = 1
    CAB = _DEFAULT_CP.BIN
    EYE = 0, 4, 1
    SPEEDO = _DEFAULT_CPN1.BIN, -1.206169, 3.198295, 2.728, 0, 0, 1, 304.5, 2.65
    TACH = _DEFAULT_CPN2.BIN, 0.830596, 3.284966, 2.728, 0, 0, 1, 153, 0.0261
    WHEEL = _DEFAULT_CPW.BIN, 0, 2.937722, 1.85, 0, 0, 1, 7
    SHIFTER = _DEFAULT_CPS.BIN, 1.252, 2.595936, 2.542021, 1, 0, 0, -5.42, 5.38, 17.74, 30.26, 42.62, 53.42
    GEARLAMP_P = _DEFAULT_CPLP.BIN          (also _R, _N, _1, _2, _3)
    SHIFTLIGHT = _DEFAULT_CPLS.BIN, 6500
    MIRROR = 1.023919, 4.46813, 2.75, 0, 0, -1, 1.152038, 0.351097, 65536

  What is settled from the files: a moving part is a model, then a pivot point and a rotation
  axis (three numbers each, truck feet), then part-specific numbers (`values`): two for a gauge
  needle, one for the wheel, six for the shifter (one per gear P R N 1 2 3), one for the shift
  light. The mirror has no model: nine numbers. The meaning of the part-specific numbers
  (a needle's zero angle and degrees per unit are the likely reading) is to be confirmed against
  the engine before a renderer relies on it; this parser keeps them as written. Unknown keys are
  kept, so a later VERSION does not lose data.
*/
const latin1 = new TextDecoder("latin1");
function part(values) {
    if (values.length < 7)
        return null;
    const n = values.slice(1).map(Number);
    return { model: values[0], pivot: [n[0], n[1], n[2]], axis: [n[3], n[4], n[5]], values: n.slice(6) };
}
export function parseCpt(input) {
    const text = typeof input === "string" ? input : latin1.decode(input);
    const out = { version: null, cab: null, eye: null, speedo: null, tach: null, wheel: null, shifter: null, gearLamps: {}, shiftLight: null, mirror: null, entries: [] };
    for (const raw of text.split(/\r\n|\r|\n/)) {
        const line = raw.replace(/\x1a/g, "").trim();
        if (!line || line.startsWith(";"))
            continue;
        const eq = line.indexOf("=");
        if (eq < 0)
            continue;
        const key = line.slice(0, eq).trim().toUpperCase();
        const values = line.slice(eq + 1).split(",").map((v) => v.trim()).filter((v) => v !== "");
        out.entries.push({ key, values });
        const nums = values.map(Number);
        if (key === "VERSION")
            out.version = nums[0] ?? null;
        else if (key === "CAB")
            out.cab = values[0] ?? null;
        else if (key === "EYE" && nums.length >= 3)
            out.eye = [nums[0], nums[1], nums[2]];
        else if (key === "SPEEDO")
            out.speedo = part(values);
        else if (key === "TACH")
            out.tach = part(values);
        else if (key === "WHEEL")
            out.wheel = part(values);
        else if (key === "SHIFTER")
            out.shifter = part(values);
        else if (key.startsWith("GEARLAMP_") && values[0])
            out.gearLamps[key.slice(9)] = values[0];
        else if (key === "SHIFTLIGHT" && values[0])
            out.shiftLight = { model: values[0], values: values.slice(1).map(Number) };
        else if (key === "MIRROR")
            out.mirror = nums;
    }
    return out;
}
