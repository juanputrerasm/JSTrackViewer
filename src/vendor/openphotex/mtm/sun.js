/*
  MTM2's sun and lens flare (`DATA\SUN.TXT`, MONSTER.EXE 0x578a50 via weather.cpp), used only in
  Clear and Cloudy weather. Positional, a `//` comment line before each value:

    type                0 point, 1 offset
    initial position    x, y, z in 1/256 ft
    master radius       a radius this size fills the screen
    layer count, then per layer (no comment lines between them):
                        texture, axis position, radius, texX1, texY1, texX2, texY2
    ray count, then per ray:  x, y, z in 1/256 ft (visibility-check offsets around the sun)

  The axis position places a flare layer along the line from the sun through the screen centre
  (1 at the sun, negative past the centre); the tex rectangle is the layer's part of its texture.
*/
const decoder = new TextDecoder("latin1");
export function parseMtmSun(input) {
    const text = typeof input === "string" ? input : decoder.decode(input);
    const rows = text.split(/\r?\n|\r/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("//"));
    let i = 0;
    const nums = (row) => (row ?? "").split(",").map((f) => parseFloat(f.trim()));
    const sun = { type: 0, position: [0, 0, 0], masterRadius: 0, layers: [], rays: [] };
    sun.type = parseInt(rows[i++] ?? "0", 10) || 0;
    const p = nums(rows[i++]);
    sun.position = [p[0] || 0, p[1] || 0, p[2] || 0];
    sun.masterRadius = parseFloat(rows[i++] ?? "0") || 0;
    const layerCount = parseInt(rows[i++] ?? "0", 10) || 0;
    for (let n = 0; n < layerCount && i < rows.length; n++) {
        const f = (rows[i++] ?? "").split(",").map((s) => s.trim());
        sun.layers.push({
            texture: f[0] ?? "", axisPosition: parseFloat(f[1]), radius: parseFloat(f[2]),
            tex: [parseInt(f[3], 10), parseInt(f[4], 10), parseInt(f[5], 10), parseInt(f[6], 10)],
        });
    }
    const rayCount = parseInt(rows[i++] ?? "0", 10) || 0;
    for (let n = 0; n < rayCount && i < rows.length; n++) {
        const r = nums(rows[i++]);
        sun.rays.push([r[0] || 0, r[1] || 0, r[2] || 0]);
    }
    return sun;
}
