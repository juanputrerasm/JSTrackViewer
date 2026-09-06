import { splitEvoLines } from "./evo-text.js";

/*
  .SMF v2-v4, the Evo static model format ("C3DModel").

    "C3DModel"
    fileVersion
    objectCount
    if fileVersion >= 4: lodEnabled,lodSwitchHeight

    repeat objectCount:
        objectName
        if fileVersion >= 2: visible
        objectVersion
        vertexCount,frameCount,faceCount,unknown0
        ["v1"]                                        optional Evo 2 material marker
        material0,material1,material2,transparent,reflective,textureName
        if v1: bumpTextureName
        repeat frameCount:
            repeat vertexCount: x,y,z,nx,ny,nz,u,v
        repeat faceCount: i0,i1,i2

  Written as a counted state machine rather than by sniffing where the vertex block ends,
  because a vertex line and a face line are both just comma-separated numbers - the counts
  are the only thing that says which is which. Every count and every face index is checked
  against the vertex block before it is used.

  Verified against all 118 models in ASPEN, THEHILL, BAJBEACH and PEAK: 115 v4, 2 v2, 1 v3,
  every file consumed exactly to its trailing blank line. That corpus includes the v1
  bump-material form (10 groups), a genuine 30-frame animated group (ISSHK), and the v2/v3
  files that have no LOD header.

  Axes: SMF is Y-up and in feet, and the model's XYZ extent is exactly the `size` triple the
  Evo 2 .SIT records for it - checked on all 57 distinct stock models, which is what pins the
  axis order down rather than leaving it inferred from a few tree bounding boxes. Vertices
  are emitted here in Three.js axes (Z negated, see evo-scene.js for why) with the triangle
  winding reversed to match, so nothing downstream has to know about Evo's handedness.
*/

const SMF_MAGIC = "C3DModel";
const MAX_OBJECTS = 4096;
const MAX_VERTICES = 1 << 20;
const MAX_FACES = 1 << 20;

/*
  A reduced-detail LOD group is named by suffixing its high-detail partner with "L":
  OPAQUE/OPAQUEL, TRANSP/TRANSPL. Observed spellings across the stock corpus are case
  variants of OPAQUE, OPAQUEL, TRANSP, TRANSPI, TRANSPE and TRANSPL, so matching is
  case-insensitive and only the trailing L is significant - TRANSPI and TRANSPE are full
  detail groups, not LODs.
*/
const LOD_GROUP_PATTERN = /^(opaque|transp)l$/i;

export function decodeSmfModel(bytes, modelName) {
  const lines = splitEvoLines(bytes);
  let cursor = 0;
  const warnings = [];

  const next = () => (cursor < lines.length ? lines[cursor++].trim() : null);
  const peek = () => (cursor < lines.length ? lines[cursor].trim() : null);

  if (next() !== SMF_MAGIC) throw new Error(`${modelName}: not a C3DModel`);
  const fileVersion = int(next());
  if (!(fileVersion >= 1 && fileVersion <= 4)) {
    throw new Error(`${modelName}: unsupported .SMF version ${fileVersion}`);
  }
  const objectCount = int(next());
  if (!(objectCount >= 0 && objectCount <= MAX_OBJECTS)) {
    throw new Error(`${modelName}: implausible object count ${objectCount}`);
  }

  let lodEnabled = false;
  let lodSwitchHeight = 0;
  if (fileVersion >= 4) {
    const parts = (next() ?? "").split(",");
    lodEnabled = parts[0]?.trim() !== "0";
    lodSwitchHeight = float(parts[1]);
  }

  const meshes = [];
  const textureNames = new Set();

  for (let o = 0; o < objectCount; o++) {
    const groupName = next();
    if (groupName === null) {
      warnings.push(`ran out of lines at object ${o + 1} of ${objectCount}`);
      break;
    }
    const visible = fileVersion >= 2 ? next() !== "0" : true;
    const objectVersion = int(next());

    const counts = (next() ?? "").split(",");
    const vertexCount = int(counts[0]);
    const frameCount = Math.max(1, int(counts[1]));
    const faceCount = int(counts[2]);
    const objectInfo = counts[3]?.trim() ?? "";
    if (!(vertexCount >= 0 && vertexCount <= MAX_VERTICES) || !(faceCount >= 0 && faceCount <= MAX_FACES)) {
      throw new Error(`${modelName}: implausible counts in group "${groupName}" (${vertexCount} verts, ${faceCount} faces)`);
    }

    // The Evo 2 bump form announces itself with a bare "v1" line before the material.
    const bumpForm = peek() === "v1";
    if (bumpForm) next();

    const material = (next() ?? "").split(",");
    const textureName = (material[5] ?? "").trim();
    const bumpTextureName = bumpForm ? (next() ?? "").trim() : null;

    // Frame 0 is what gets drawn; later frames are read to keep the cursor aligned. Their
    // counted position is known, so skipping them cannot desynchronize the face block.
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    for (let f = 0; f < frameCount; f++) {
      for (let v = 0; v < vertexCount; v++) {
        const line = next();
        if (line === null) throw new Error(`${modelName}: truncated vertex block in "${groupName}"`);
        if (f !== 0) continue;
        const p = line.split(",");
        // Evo (x, y up, z) -> Three.js (x, y up, -z). See evo-scene.js.
        positions[v * 3 + 0] = float(p[0]);
        positions[v * 3 + 1] = float(p[1]);
        positions[v * 3 + 2] = -float(p[2]);
        normals[v * 3 + 0] = float(p[3]);
        normals[v * 3 + 1] = float(p[4]);
        normals[v * 3 + 2] = -float(p[5]);
        uvs[v * 2 + 0] = float(p[6]);
        /*
          V is used as written, NOT flipped.

          Evo's V runs top-down, and so does the viewer's texture upload: a THREE.DataTexture
          defaults to flipY = false, so row 0 of the decoded image is v = 0. The two
          conventions already agree, and the existing .BIN path likewise emits its V straight
          through. Flipping here - which the Blender add-on does, because Blender's V is
          bottom-up - would render every model texture upside down.

          Measured rather than reasoned: correlating model Y against V over every .SMF group
          in the four stock tracks, 50 of the 53 groups with a clear vertical gradient have
          higher Y mapping to LOWER V.
        */
        uvs[v * 2 + 1] = float(p[7]);
      }
    }

    const indices = new Uint32Array(faceCount * 3);
    let emitted = 0;
    for (let f = 0; f < faceCount; f++) {
      const line = next();
      if (line === null) throw new Error(`${modelName}: truncated face block in "${groupName}"`);
      const parts = line.split(",");
      const i0 = int(parts[0]), i1 = int(parts[1]), i2 = int(parts[2]);
      if (i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount || i0 < 0 || i1 < 0 || i2 < 0) {
        warnings.push(`"${groupName}" face ${f} indexes outside its ${vertexCount} vertices`);
        continue;
      }
      // Negating Z flipped handedness, so the winding is reversed to keep faces outward.
      indices[emitted * 3 + 0] = i0;
      indices[emitted * 3 + 1] = i2;
      indices[emitted * 3 + 2] = i1;
      emitted++;
    }

    if (textureName) textureNames.add(textureName.toUpperCase());
    meshes.push({
      groupName,
      visible,
      objectVersion,
      lod: LOD_GROUP_PATTERN.test(groupName),
      textureName: textureName ? textureName.toUpperCase() : null,
      bumpTextureName: bumpTextureName ? bumpTextureName.replace(/"/g, "").toUpperCase() || null : null,
      // Fields 3 and 4 are the transparency and reflectivity flags. Fields 0-2 are three
      // scalars whose meaning is unknown; every stock model writes 1.0, 1.0, 32.0.
      transparent: (material[3] ?? "0").trim() !== "0",
      reflective: (material[4] ?? "0").trim() !== "0",
      materialScalars: [float(material[0]), float(material[1]), float(material[2])],
      objectInfo,
      frameCount,
      positions,
      normals,
      uvs,
      indices: emitted === faceCount ? indices : indices.slice(0, emitted * 3),
    });
  }

  return {
    name: modelName,
    format: "SMF",
    fileVersion,
    lodEnabled,
    lodSwitchHeight,
    meshes,
    textureNames: [...textureNames],
    warnings,
  };
}

function int(value) {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function float(value) {
  const parsed = Number.parseFloat((value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}
