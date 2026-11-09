/*
  MODELS\<model>.SRF, Community Patch 4's surface-mesh sidecar: it makes a placed 3D model a
  drivable surface and gives its materials (the model's texture names) surface types. The
  engine reads it only from the same pod as the model's .BIN, 1 to 65535 bytes, and only for
  static props on the triangle collision path ([Game] collisionMode 1, the default): fog
  boxes, boxes with mass, moving boxes (types 10, 13) and types 6..9, 11, 12 are skipped.

  Text, one `material = type` line each (CP4 monster.exe 2.0.52.2, OpenMTM2
  docs/CP4_EXE_ANALYSIS.md 5, FUN_140205670 / FUN_1402062a0):

    - `;` and `#` start comments; at most 64 material lines;
    - a line with no '=' is rejected, as is an empty name or type;
    - type is one of the engine's surface table, stored as id x 100: cement 100, dirt 200,
      mud 400, sand 500, grass 600, gravel 700, ice 800, snow 900, metal 1000, wood 1100,
      rocks 1200, default 0; water and water2 are refused ("a mesh never sinks you");
    - '*' names the default for materials not listed; a name given twice: the later wins;
    - a NUL byte ends the text.

  A texture finds its line by its exact name (case-insensitive), then its stem without the
  extension, then its first 15 characters, then '*'; otherwise its triangles are "not a
  surface", and a model with no typed triangle is no surface at all.
*/
export const SRF_TYPE_CODES = {
    default: 0, cement: 100, dirt: 200, mud: 400, sand: 500, grass: 600, gravel: 700, ice: 800, snow: 900, metal: 1000, wood: 1100, rocks: 1200,
};
export const SRF_TYPES = Object.keys(SRF_TYPE_CODES);
export const SRF_MAX_LINES = 64;
const latin1 = new TextDecoder("latin1");
export function parseSrf(input) {
    let text = typeof input === "string" ? input : latin1.decode(input);
    const nul = text.indexOf("\0");
    if (nul >= 0)
        text = text.slice(0, nul);
    const out = { materials: {}, fallback: null, rejected: [] };
    const byLower = new Map();
    let accepted = 0;
    text.split(/\r\n|\r|\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith(";") || line.startsWith("#"))
            return;
        const reject = (reason) => out.rejected.push({ line: i + 1, text: raw, reason });
        const eq = line.indexOf("=");
        if (eq < 0)
            return reject("no '='");
        const name = line.slice(0, eq).trim();
        const type = line.slice(eq + 1).trim().toLowerCase();
        if (!name || !type)
            return reject("empty name or type");
        if (type === "water" || type === "water2")
            return reject(`${type} is not allowed on a mesh (a mesh never sinks you)`);
        if (!(type in SRF_TYPE_CODES))
            return reject(`unknown type '${type}'`);
        if (accepted >= SRF_MAX_LINES)
            return reject(`more than ${SRF_MAX_LINES} material lines`);
        accepted++;
        if (name === "*") {
            out.fallback = type;
            return;
        }
        const prev = byLower.get(name.toLowerCase());
        if (prev !== undefined)
            delete out.materials[prev];
        byLower.set(name.toLowerCase(), name);
        out.materials[name] = type;
    });
    return out;
}
/** The surface type of a model texture, or null (not a surface): exact name, stem, 15-character prefix, then '*'. */
export function srfTypeOf(srf, texture) {
    const entries = Object.entries(srf.materials).map(([n, t]) => [n.toLowerCase(), t]);
    const find = (key) => entries.find(([n]) => n === key)?.[1];
    const want = texture.toLowerCase();
    const dot = want.lastIndexOf(".");
    const stem = dot > 0 ? want.slice(0, dot) : want;
    return find(want) ?? find(stem) ?? find(want.slice(0, 15)) ?? srf.fallback;
}
/** The engine's type code (id x 100) of a surface type. */
export function srfTypeCode(type) {
    return SRF_TYPE_CODES[type];
}
