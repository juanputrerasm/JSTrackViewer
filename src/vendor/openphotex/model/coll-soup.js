/*
  A .BIN model as a collision triangle soup: every facet fanned (v0, vi, vi+1), in feet, in the game
  frame (x right, y up, z forward) about the model's own origin. This is how Community Patch 4 builds
  the triangles its collision solver tests (OpenMTM2 docs/CP4_EXE_ANALYSIS.md 11.2; CP4's author
  published no source code, this is our reading of the binary).

  CP4 walks the facet records itself: index lists 5, 6, 7, 8, 15, 21, 25, 26, 27, 33 and index plus UV
  14, 17, 24, 30, 34, 41, 51, 52, 56, 64. `parseBin` returns faces for twelve of these (BIN_MAPPED_FACETS
  and BIN_UNMAPPED_FACETS); the other eight it strides over, and they occur in none of the 2,277 stock and
  community models the BIN walk was checked against (bin.ts), so on real data the soups agree.

  Units follow the model loaders: (word >> 1) * 65536 / (magnify * 128) feet, the last MRGL_MAGNIFY
  winning. CP4 refuses a model with no magnify; so does this (null).
*/
import { parseBin } from "./bin.js";
/** The soup of a parsed model, or null when it has no geometry or no magnify. */
export function binCollisionSoup(model) {
    if (model.kind !== "mrgl" || !model.vertexListValid)
        return null;
    const magnify = model.magnifyRecords.length ? model.magnifyRecords[model.magnifyRecords.length - 1] : model.magnify;
    if (!magnify)
        return null;
    const scale = 65536 / (magnify * 128);
    const w = model.vertices;
    const count = Math.floor(w.length / 3);
    const tris = [];
    const texIdx = [];
    const textures = [];
    const texMap = new Map();
    let skipped = 0;
    for (const face of model.faces) {
        const idx = face.vertexIndices;
        if (!idx || idx.length < 3 || idx.some((n) => n < 0 || n >= count)) {
            skipped++;
            continue;
        }
        const name = (face.textureName ?? "").toUpperCase();
        let ti = -1;
        if (name) {
            ti = texMap.get(name) ?? -1;
            if (ti < 0) {
                ti = textures.length;
                textures.push(name);
                texMap.set(name, ti);
            }
        }
        for (let k = 1; k < idx.length - 1; k++) {
            for (const n of [idx[0], idx[k], idx[k + 1]]) {
                tris.push((w[n * 3] >> 1) * scale, (w[n * 3 + 1] >> 1) * scale, (w[n * 3 + 2] >> 1) * scale);
            }
            texIdx.push(ti);
        }
    }
    return { positions: new Float32Array(tris), textureIndex: new Int16Array(texIdx), textures, skipped };
}
/** The soup of a .BIN's bytes. */
export function binBytesCollisionSoup(bytes) {
    return binCollisionSoup(parseBin(bytes));
}
