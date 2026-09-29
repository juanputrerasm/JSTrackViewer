/*
  .SMF models for JSTrackViewer (and JSMTM2Converter, which shared this decoder).

  Parsing is OpenPhotex's (parseSmf returns the model in Evo's own axes, as written). This
  adapter only reshapes it for the viewer: frame 0, in Three.js axes, indexed.
*/
import { parseSmf } from "../../vendor/openphotex/index.js";

export function decodeSmfModel(bytes, modelName) {
  const smf = parseSmf(bytes, modelName);
  const meshes = [];
  const textureNames = new Set();
  for (const group of smf.groups) {
    const { positions: p, normals: n, uvs: t } = group.frames[0];
    const count = group.vertexCount;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    for (let v = 0; v < count; v++) {
      // Evo (x, y up, z) -> Three.js (x, y up, -z). See evo-scene.js.
      positions[v * 3] = p[v * 3];
      positions[v * 3 + 1] = p[v * 3 + 1];
      positions[v * 3 + 2] = -p[v * 3 + 2];
      normals[v * 3] = n[v * 3];
      normals[v * 3 + 1] = n[v * 3 + 1];
      normals[v * 3 + 2] = -n[v * 3 + 2];
      /*
        V is used as written, NOT flipped. Evo's V runs top-down, and so does the viewer's
        texture upload: a THREE.DataTexture defaults to flipY = false, so row 0 of the decoded
        image is v = 0.
      */
      uvs[v * 2] = t[v * 2];
      uvs[v * 2 + 1] = t[v * 2 + 1];
    }
    // Negating Z flipped handedness, so the winding is reversed to keep faces outward.
    const indices = new Uint32Array(group.indices.length);
    for (let i = 0; i < indices.length; i += 3) {
      indices[i] = group.indices[i];
      indices[i + 1] = group.indices[i + 2];
      indices[i + 2] = group.indices[i + 1];
    }
    const { textureName, bumpTextureName } = group.material;
    if (textureName) textureNames.add(textureName.toUpperCase());
    meshes.push({
      groupName: group.name,
      visible: group.visible,
      objectVersion: group.objectVersion,
      lod: group.lodGroup,
      textureName: textureName ? textureName.toUpperCase() : null,
      bumpTextureName: bumpTextureName ? bumpTextureName.replace(/"/g, "").toUpperCase() || null : null,
      transparent: group.material.transparent,
      reflective: group.material.reflective,
      materialScalars: [...group.material.scalars],
      objectInfo: group.objectInfo,
      frameCount: group.frameCount,
      positions,
      normals,
      uvs,
      indices,
    });
  }
  return {
    name: modelName,
    format: "SMF",
    fileVersion: smf.fileVersion,
    lodEnabled: smf.lodEnabled,
    lodSwitchHeight: smf.lodSwitchHeight,
    meshes,
    textureNames: [...textureNames],
    warnings: smf.warnings,
  };
}
