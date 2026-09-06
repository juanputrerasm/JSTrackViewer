import { BinaryReader } from "./binary-reader.js";
import { MATERIAL_FLAGS, MATERIAL2_FLAGS } from "../shared/mrgl-material.js";

const SIGNATURE_LWO = 0x4d524f46;
const SIGNATURE_ANIMATED_BIN = 0x00000020;
const MAX_CORNERS_PER_FACE = 256;
const UV_SCALE = 0xff0000;
const TYPE_TRANSPARENT_MTM = 0x00000011;
const TYPE_TRANSPARENT_MTM2 = 0x00000033;
const TRANSPARENT_FACE_TYPES = new Set([
  TYPE_TRANSPARENT_MTM,
  TYPE_TRANSPARENT_MTM2,
]);

/*
  MRGL record opcodes, transcribed from the engine's 3D.H by way of
  Traxx_OnGoing_Updates TrackPOD/TrackPODModel.cpp:27-78.

  These are DECIMAL in the engine. Writing them as hex here is what let MRGL_XTFACET (33
  decimal) sit one keystroke away from MRGL_UZFACETTTMAP (51 decimal = 0x33), so they are
  spelled out by name and used by name.
*/
const MRGL_EOL = 0,       MRGL_ORGIN = 1,        MRGL_VLIST = 2,      MRGL_ILIST = 3;
const MRGL_TLIST = 4,     MRGL_FACET = 5,        MRGL_GFACET = 6,     MRGL_TFACET = 7;
const MRGL_GTFACET = 8,   MRGL_ICALL = 9,        MRGL_COLOR = 10,     MRGL_SCALL = 11;
const MRGL_ORDER = 12,    MRGL_TEXTURE = 13,     MRGL_FACETTMAP = 14, MRGL_TTFACET = 15;
const MRGL_TCALL = 16,    MRGL_FACETTTMAP = 17,  MRGL_JUMP = 18,      MRGL_MAGNIFY = 20;
const MRGL_PTFACET = 21,  MRGL_OUTLINE = 22,     MRGL_ZBUFFERPOLY = 23;
const MRGL_ZFACETTMAP = 24, MRGL_ZFACET = 25,    MRGL_ZTFACET = 26,   MRGL_ZGFACET = 27;
const MRGL_TEXTURECYCLE = 29, MRGL_FFACETTMAP = 30, MRGL_CLIST = 31,  MRGL_KEYFRAME = 32;
const MRGL_XTFACET = 33,  MRGL_ZPFACETTMAP = 34, MRGL_ZGFACETTMAP = 41;
const MRGL_UZFACETTTMAP = 51, MRGL_UZFACETTMAP = 52, MRGL_ZXFACETTMAP = 56;
const MRGL_OPACITY = 61,  MRGL_TEXTURE64 = 62,   MRGL_MATERIAL = 63,  MRGL_MATFACET = 64;
const MRGL_MATERIAL2 = 66, MRGL_NORMALMAP = 67;
// Not in the Traxx fork's table; found by JSPod against real models.
const MRGL_KEYFRAME64 = 65;

const MRGLMAT_BLEND      = MATERIAL_FLAGS.BLEND;
const MRGLMAT_ALPHATEST  = MATERIAL_FLAGS.ALPHATEST;
const MRGLMAT_TEXSOLID   = MATERIAL_FLAGS.TEXSOLID;
const MRGLMAT2_NORMALMAP = MATERIAL2_FLAGS.NORMALMAP;

// Untextured face type that takes its colour from the preceding MRGL_COLOR block.
const TYPE_IGNORE_TEX = 0x19;

// Record sizes in ints, including the opcode word itself.
const MRGLINTS_TEXTURE    = 6;
const MRGLINTS_TEXTURE64  = 18;
const MRGLINTS_MATERIAL   = 12;
const MRGLINTS_MATERIAL2  = 8;
const MRGLINTS_NORMALMAP  = 18;
const MRGLINTS_FACETHEADER = 6;   // type, n, then the normal and funk (4 ints)

// The fork caps stored model texture names at MODELTEXNAMELEN, the POD1 name budget. A name
// that fills all 64 bytes of a TEXTURE64 record is not NUL-terminated in the file.
const MODEL_TEX_NAME_MAX = 31;

/*
  Stride table for records this decoder does not otherwise handle, mirroring the engine's
  MRGLSizeRaw() via the fork's mrglSkipInts (TrackPODModel.cpp:104-192).

  Returns the record's TOTAL length in ints, 0 if it runs past the end of the buffer, or -1
  if the opcode has no known stride. Anything with a stride can simply be stepped over; a
  decoder that stops at the first record it does not draw loses every polygon after it, which
  is exactly how MRGL_MATERIAL2 and MRGL_NORMALMAP silently truncated models.
*/
const MRGL_FIXED_INTS = new Map([
  [MRGL_ORGIN, 4], [MRGL_ICALL, 8], [MRGL_SCALL, 2], [MRGL_ORDER, 7],
  [MRGL_TCALL, 5], [MRGL_MAGNIFY, 2], [MRGL_ZBUFFERPOLY, 3], [MRGL_OPACITY, 2],
  [MRGL_MATERIAL, MRGLINTS_MATERIAL],
  [MRGL_MATERIAL2, MRGLINTS_MATERIAL2],
  [MRGL_NORMALMAP, MRGLINTS_NORMALMAP],
  // keyFrameStruct is 344 bytes, a size the engine asserts precisely because it is the
  // on-disk stride.
  [MRGL_KEYFRAME, 86],
  // keyFrame64Struct, the wide-name keyframe record: 4376 bytes.
  [MRGL_KEYFRAME64, 1094],
  // jumpStruct. At render time a jump is followed rather than stepped over, but the engine's
  // own load-time validate walk strides it linearly by 8, and that walk is the one this
  // mirrors.
  [MRGL_JUMP, 2],
]);

// Counted records with a 3-int header and the count at word 2.
const MRGL_COUNTED3 = new Map([
  [MRGL_VLIST, 3], [MRGL_TLIST, 2], [MRGL_CLIST, 1],
]);

// Facet-shaped records: 6-int header, count at word 1.
const MRGL_FACET_1PV = new Set([
  MRGL_FACET, MRGL_GFACET, MRGL_TFACET, MRGL_GTFACET, MRGL_TTFACET,
  MRGL_PTFACET, MRGL_ZTFACET, MRGL_ZGFACET, MRGL_XTFACET,
]);
const MRGL_FACET_3PV = new Set([
  MRGL_FFACETTMAP, MRGL_ZPFACETTMAP, MRGL_ZXFACETTMAP,
]);

/**
 * @param {number} token   the opcode, already consumed from the reader
 * @param {BinaryReader} reader positioned just after the opcode
 * @returns {number} total record length in ints, 0 = truncated, -1 = unknown opcode
 */
function mrglRecordInts(token, reader) {
  // `avail` counts the opcode word too, matching the fork's pointer arithmetic.
  const avail = 1 + Math.floor(reader.remaining() / 4);
  const word = (i) => {
    const at = reader.position + (i - 1) * 4;
    if (i < 1 || at + 4 > reader.bytes.byteLength) return null;
    return reader.view.getInt32(at, true);
  };

  const fixed = MRGL_FIXED_INTS.get(token);
  if (fixed !== undefined) return avail < fixed ? 0 : fixed;

  const per3 = MRGL_COUNTED3.get(token);
  if (per3 !== undefined) {
    if (avail < 3) return 0;
    const n = word(2);
    // Bounded via `avail` so a hostile count cannot overflow the test meant to catch it.
    if (n === null || n < 0 || n > Math.floor((avail - 3) / per3)) return 0;
    return 3 + n * per3;
  }

  if (token === MRGL_OUTLINE) {
    if (avail < 2) return 0;
    const n = word(1);
    if (n === null || n < 0 || n > avail - 2) return 0;
    return 2 + n;
  }

  if (MRGL_FACET_1PV.has(token) || MRGL_FACET_3PV.has(token)) {
    if (avail < MRGLINTS_FACETHEADER) return 0;
    const per = MRGL_FACET_3PV.has(token) ? 3 : 1;
    const n = word(1);
    if (n === null || n < 0 || n > Math.floor((avail - MRGLINTS_FACETHEADER) / per)) return 0;
    return MRGLINTS_FACETHEADER + n * per;
  }

  return -1;
}

// Geometry divisors matching JTraxx constants
const DIVISOR_LEGACY    = 64.0;
const DIVISOR_HB        = 4096.0;
const DIVISOR_TV_F3     = 10922.667;

export function decodeBinModel(bytes, modelName, origin) {
  const model = {
    name: modelName, format: "UNKNOWN",
    magnifyPower: 65536, baseZ: 0,
    vertexCount: 0, polygonCount: 0,
    rawVertexBounds: null,
    textureNames: [], meshes: [],
    // Frame model names, for a keyframe control file (ANIMATED_BIN).
    frameNames: [], warnings: [],
    // A model whose record walk stopped early is still a valid model with fewer polygons,
    // and nothing else about it looks wrong, so say so rather than failing silently.
    incomplete: false, loadWarning: "",
  };
  if (!bytes?.length || bytes.length < 4) return model;
  const reader = new BinaryReader(bytes);
  const firstType = reader.readInt32();
  if (firstType === SIGNATURE_LWO) { model.format = "LWO"; return model; }
  if (firstType === MRGL_MAGNIFY) {
    model.format = "BIN";
    if (reader.remaining() < 4) return model;
    const power = reader.readInt32();
    if (power > 0) model.magnifyPower = power;
    decodeBinPayload(reader, model, origin);
    return buildMeshes(model);
  }
  if (firstType !== SIGNATURE_ANIMATED_BIN) {
    model.format = `0x${(firstType >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
    return model;
  }
  /*
    An ANIMATED_BIN is a keyframe CONTROL file, not geometry: it holds nothing but the names
    of the frame models, each of which is a separate .BIN entry in the pod. Its layout is
    fixed by the engine and read the same way by CTrackPODModel::GetAniName
    (TrackPOD/TrackPODModel.cpp:408-452):

      int[0]   0x00000020
      int[2]   frame count
      int[6..] frame names, 16 bytes each

    It was previously fed through the geometry decoder, which read a frame name as a vertex
    count and produced nothing usable. That is why keyframed objects (top-crush cabs and the
    like) drew as empty wireframes: the model that actually has the polygons is the frame,
    and nothing ever went and got it.
  */
  model.format = "ANIMATED_BIN";
  model.frameNames = readAnimatedFrameNames(reader, bytes);
  return model;
}

function readAnimatedFrameNames(reader, bytes) {
  const names = [];
  if (bytes.length < 12) return names;
  reader.position = 8;                       // int[2]
  const frameCount = reader.readInt32();
  if (frameCount < 1 || frameCount > 4096) return names;

  reader.position = 24;                      // int[6]
  for (let i = 0; i < frameCount; i++) {
    if (reader.remaining() < 16) break;
    const name = upper(reader.readFixedAscii(16));
    if (name) names.push(name);
  }
  return names;
}

// The MRGL_MAGNIFY record and the opcode/slot words of the MRGL_VLIST that follows it have
// already been consumed by the caller; the vertex count is the third word of that VLIST.
const BIN_HEADER_BYTES_BEFORE_VERTEX_COUNT = 8;

function decodeBinPayload(reader, model, origin) {
  reader.skip(BIN_HEADER_BYTES_BEFORE_VERTEX_COUNT);
  const vertexCount = reader.readInt32();
  if (vertexCount < 0 || vertexCount > 200000) return;
  const rawVertices = [];
  let rawBaseZ = 0;
  let rawMinX = Infinity, rawMaxX = -Infinity;
  let rawMinY = Infinity, rawMaxY = -Infinity;
  let rawMinZ = Infinity, rawMaxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const x = reader.readInt32() >> 1;
    const z = reader.readInt32() >> 1;
    const y = reader.readInt32() >> 1;
    rawVertices.push({ x, y, z });
    if (x < rawMinX) rawMinX = x; if (x > rawMaxX) rawMaxX = x;
    if (y < rawMinY) rawMinY = y; if (y > rawMaxY) rawMaxY = y;
    if (z < rawMinZ) rawMinZ = z; if (z > rawMaxZ) rawMaxZ = z;
    if (z < rawBaseZ) rawBaseZ = z;
  }
  const rawBaseZWithOffset = rawBaseZ - 31;
  model.rawVertexBounds = { vertexCount: rawVertices.length, baseZ: rawBaseZWithOffset, minX: rawMinX, maxX: rawMaxX, minY: rawMinY, maxY: rawMaxY, minZ: rawMinZ, maxZ: rawMaxZ };
  // JTraxx applies magnify scaling at decode time (65536/magnifyPower) then divides by
  // origin-based geometryDivisor at render time. Combined: 65536/(magnifyPower*divisor).
  // Legacy shorthand: 65536/(magnifyPower*64) = 1024/magnifyPower.
  let geometryDivisor;
  if (origin === "HB") geometryDivisor = DIVISOR_HB;
  else if (isTvFamilyOrigin(origin)) geometryDivisor = DIVISOR_TV_F3;
  else geometryDivisor = DIVISOR_LEGACY;
  const scale = 65536.0 / (model.magnifyPower * geometryDivisor);
  model.vertices = rawVertices.map((v) => ({ x: v.x * scale, y: v.y * scale, z: v.z * scale }));
  model.baseZ = rawBaseZWithOffset * scale;
  const polygons = [];
  const textureNames = new Set();
  let currentTexture = "";
  let currentSolidColor = 0;
  let currentMaterial = null;
  let currentMaterial2 = null;
  let materialSerial = 0;
  const meshVerts = model.vertices.length;

  blocks:
  while (reader.remaining() >= 4) {
    const token = reader.readInt32();
    switch (token) {
      // The REAL terminator. This used to share an arm with `default`, and that is exactly how
      // new engine opcodes came to truncate models in silence: an opcode nobody had heard of
      // was indistinguishable from a clean end of file.
      case MRGL_EOL:
        break blocks;
      // A second vertex list. The first one is consumed as part of the header, above.
      // Strided per the fork's table: 3 header ints then 3 per vertex, nothing trailing.
      case MRGL_VLIST: {
        const ints = mrglRecordInts(token, reader);
        if (ints <= 0) break blocks;
        reader.skip((ints - 1) * 4);
        break;
      }
      case MRGL_ILIST: {
        if (reader.remaining() < 8) break blocks;
        reader.skip(8);
        if (meshVerts < 1 || reader.remaining() < meshVerts * 12) break blocks;
        reader.skip(meshVerts * 12);
        break;
      }
      case MRGL_TLIST: {
        if (reader.remaining() < 8) break blocks;
        reader.skip(4);
        const n = reader.readInt32();
        if (n < 0 || n > 4096 || reader.remaining() < n * 8) break blocks;
        reader.skip(n * 8);
        break;
      }
      case MRGL_TEXTURE:
        if (reader.remaining() < (MRGLINTS_TEXTURE - 1) * 4) break blocks;
        reader.skip(4);                       // slot
        currentTexture = upper(reader.readFixedAscii(16));
        break;

      /*
        MRGL_TEXTURE64 is MRGL_TEXTURE with a wider name field, added to the engine because a
        texture name can now be longer than the old record could hold. It carries the NAME, so
        it has to be PARSED, not merely strided over: skipping it swaps "the model has no
        polygons" for "the model has no textures", the same bug wearing a different hat.
        `type` and `slot` sit at the same offsets as the narrow record by design.
      */
      case MRGL_TEXTURE64: {
        if (reader.remaining() < (MRGLINTS_TEXTURE64 - 1) * 4) break blocks;
        reader.skip(4);                       // slot
        const name = upper(reader.readFixedAscii(64));
        currentTexture = name.slice(0, MODEL_TEX_NAME_MAX);
        break;
      }

      // A state change selecting the current material. Its flags decide how every facet after
      // it is shaded, so it is read, not just strided over.
      case MRGL_MATERIAL:
        if (reader.remaining() < (MRGLINTS_MATERIAL - 1) * 4) {
          model.warnings.push("Truncated MRGL_MATERIAL record");
          break blocks;
        }
        currentMaterial = readMaterial(reader, ++materialSerial);
        break;

      case MRGL_MATERIAL2:
        if (reader.remaining() < (MRGLINTS_MATERIAL2 - 1) * 4) {
          model.warnings.push("Truncated MRGL_MATERIAL2 record");
          break blocks;
        }
        currentMaterial2 = readMaterial2(reader);
        break;

      // Carries a normal map name for the current material. Nothing samples it yet, so it is
      // strided; the point is that it must not stop the walk.
      case MRGL_NORMALMAP: {
        if (reader.remaining() < (MRGLINTS_NORMALMAP - 1) * 4) break blocks;
        reader.skip((MRGLINTS_NORMALMAP - 1) * 4);
        break;
      }
      case MRGL_TEXTURECYCLE: {
        if (reader.remaining() < 24) break blocks;
        reader.skip(4);
        const num = reader.readInt32();
        reader.skip(16);
        if (num < 0 || num > 1024) break blocks;
        if (reader.remaining() >= num * 32) { for (let i = 0; i < num; i++) { const f = upper(reader.readFixedAscii(32)); if (i === 0) currentTexture = f; } }
        else if (reader.remaining() >= num * 8) { reader.skip(num * 8); }
        else break blocks;
        break;
      }
      /*
        Face-colour block (a COLORREF) preceding flat 0x19 / FT_IGNORE_TEX faces.

        It sets the solid colour for those untextured faces and must NOT clear the active
        texture, which stays in effect for later mapped faces. Clearing it here is what
        silently ended texture mapping partway through a model: every face after the first
        colour block rendered untextured.

        NOTE this deliberately diverges from Traxx, whose MRGL_COLOR arm does
        `memset(currtexturename, 0, ...)` (TrackPODModel.cpp:716-724). JSPod's BIN viewer
        established the behaviour here against real models, and it is what makes them render
        correctly; Traxx's editor preview is not the authority on this one.
      */
      case MRGL_COLOR:
        if (reader.remaining() < 4) break blocks;
        currentSolidColor = reader.readInt32() & 0x00ffffff;
        break;
      case MRGL_ORDER:
        if (reader.remaining() < 24) break blocks;
        reader.skip(24); break;
      case MRGL_JUMP:
        if (reader.remaining() < 4) break blocks;
        reader.skip(4); break;
      case MRGL_MAGNIFY:
        if (reader.remaining() < 4) break blocks;
        model.magnifyPower = reader.readInt32(); break;
      // outlineStruct + n ints, counted. It was previously strided as a fixed 4 ints, which
      // desynchronised the walk on any outline longer than two words.
      case MRGL_OUTLINE: {
        const ints = mrglRecordInts(token, reader);
        if (ints <= 0) break blocks;
        reader.skip((ints - 1) * 4);
        break;
      }
      case MRGL_ZBUFFERPOLY:
        if (reader.remaining() < 8) break blocks;
        reader.skip(8); break;
      case MRGL_CLIST: {
        if (reader.remaining() < 8) break blocks;
        reader.skip(4);
        const n = reader.readInt32();
        if (n < 0 || n > 200000 || reader.remaining() < n * 4) break blocks;
        reader.skip(n * 4); break;
      }
      // MRGL_MATFACET is deliberately facetStruct-shaped with 3 ints per vertex (engine 3D.H),
      // so it strides exactly like the rest of this arm, which is the whole reason it was
      // given that shape. The material's appearance is not rendered; the geometry is.
      case MRGL_FACETTTMAP: case MRGL_ZFACETTMAP: case MRGL_ZPFACETTMAP:
      case MRGL_ZGFACETTMAP: case MRGL_UZFACETTTMAP: case MRGL_UZFACETTMAP:
      case MRGL_FACETTMAP: case MRGL_MATFACET: {
        // Only MRGL_MATFACET consumes the current material; the legacy face types predate it.
        const mat = token === MRGL_MATFACET ? currentMaterial : null;
        const mat2 = token === MRGL_MATFACET ? currentMaterial2 : null;
        const polygon = readMappedFace(reader, token, currentTexture, meshVerts, mat, mat2, currentSolidColor);
        if (polygon) { polygons.push(polygon); if (polygon.textureName) textureNames.add(polygon.textureName); }
        break;
      }
      case MRGL_FACET: case MRGL_ZFACET: case MRGL_GFACET: case MRGL_TTFACET: {
        const polygon = readUnmappedFace(reader, token, currentTexture, meshVerts, currentSolidColor);
        if (polygon) { polygons.push(polygon); if (polygon.textureName) textureNames.add(polygon.textureName); }
        break;
      }
      /*
        Everything with no bespoke arm above. Most of it is still a record whose length the
        engine knows, so step over it and carry on. Only an opcode with no stride anywhere is
        genuinely unwalkable, and that is the one case that stops the walk.

        A truncated model is a VALID model with fewer polygons and nothing else about it looks
        wrong, so the reason is recorded rather than swallowed.
      */
      default: {
        const ints = mrglRecordInts(token, reader);
        if (ints > 0) { reader.skip((ints - 1) * 4); break; }
        model.loadWarning = ints === 0
          ? `record type ${token} runs past the end of the file`
          : `unknown record type ${token}`;
        model.incomplete = true;
        break blocks;
      }
    }
  }
  model.polygons = polygons;
  model.textureNames = [...textureNames];
  model.vertexCount = model.vertices.length;
  model.polygonCount = model.polygons.length;
}

function buildMeshes(model) {
  const verts = model.vertices ?? [];
  // Compute model-space anchor (matches JTraxx SoftwareModelRenderer.modelAnchor):
  // X,Y centered on bounding box midpoint; Z anchored to minimum (model bottom = 0)
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity;
  for (const v of verts) {
    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    if (v.z < minZ) minZ = v.z;
  }
  const anchorX = verts.length ? (minX + maxX) / 2 : 0;
  const anchorY = verts.length ? (minY + maxY) / 2 : 0;
  const anchorZ = verts.length ? minZ : 0;

  model.anchor = { x: anchorX, y: anchorY, z: anchorZ };

  /*
    Batch by everything that has to become one Three.js material.

    A face with a material states its own blending; one without falls back to the legacy rule
    that face types 0x11 / 0x33 are cutouts. A 0x19 face is flat-shaded in the colour the
    preceding MRGL_COLOR block set, so its colour is part of the key: batching two differently
    coloured flat faces together would silently pick one of the two colours.
  */
  const grouped = new Map();
  for (const polygon of model.polygons ?? []) {
    const flags = polygon.material?.flags ?? 0;
    const transparent = polygon.material
      ? !!(flags & (MRGLMAT_BLEND | MRGLMAT_ALPHATEST | MRGLMAT_TEXSOLID))
      : TRANSPARENT_FACE_TYPES.has(polygon.type);
    const solid = polygon.type === TYPE_IGNORE_TEX;
    const materialKey = polygon.material
      ? `material:${polygon.material.id}:${polygon.material2?.normalStrength ?? 1}`
      : "legacy";
    const facetKey = solid ? `solid:${polygon.solidColor ?? 0}` : "textured";
    const key = `${polygon.textureName || "__flat__"}|${transparent ? "alpha" : "opaque"}|${facetKey}|${materialKey}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        positions: [], normals: [], uvs: [],
        textureName: polygon.textureName || "",
        transparent, solid,
        solidColor: polygon.solidColor ?? 0,
        material: polygon.material ?? null,
        material2: polygon.material2 ?? null,
      });
    }
    triangulatePolygon(verts, polygon, grouped.get(key), anchorX, anchorY, anchorZ);
  }
  model.meshes = [...grouped.values()].map((b) => ({
    textureName: b.textureName,
    transparent: b.transparent === true,
    solid: b.solid === true,
    material: b.material,
    material2: b.material2,
    positions: new Float32Array(b.positions),
    normals: new Float32Array(b.normals),
    uvs: new Float32Array(b.uvs),
    // A flat face carries the authored COLORREF. Only a face with no colour of its own falls
    // back to the name-derived placeholder.
    color: b.solid ? (b.solidColor >>> 0) : representativeColor(b.textureName),
  }));
  return model;
}

// Stores vertices in raw Traxx local space, with NO height scaling.
//   localX = v.x - anchorX
//   localY = v.y - anchorY
//   localZ = v.z - anchorZ
// The 0.75 vertical world scale belongs in the scene's object matrix, not here: Traxx pushes
// it as PushZStretch(768) UNDER the rotations (TraxxViewDisplay.cpp:2782-2785), so it is
// applied to the already-rotated vertex. It is non-uniform and does not commute with a
// rotation, so pre-scaling the local Z sheared every pitched or rolled model.
// The scene applies the full T*S*R group matrix to map Traxx local → Three.js world.
function triangulatePolygon(vertices, polygon, bucket, anchorX, anchorY, anchorZ) {
  const { vertexIndices, textureU, textureV } = polygon;
  if (!vertexIndices || vertexIndices.length < 3) return;
  for (let i = 1; i < vertexIndices.length - 1; i++) {
    const idx = [0, i, i + 1];
    const jv = idx.map((k) => {
      const v = vertices[vertexIndices[k]];
      if (!v) return null;
      return [v.x - anchorX, v.y - anchorY, v.z - anchorZ];
    });
    if (!jv[0] || !jv[1] || !jv[2]) continue;
    const normal = computeNormal(jv[0], jv[1], jv[2]);
    for (let ki = 0; ki < 3; ki++) {
      const k = idx[ki];
      bucket.positions.push(jv[ki][0], jv[ki][1], jv[ki][2]);
      bucket.normals.push(normal[0], normal[1], normal[2]);
      bucket.uvs.push((textureU[k] ?? 0) / UV_SCALE, (textureV[k] ?? 0) / UV_SCALE);
    }
  }
}

function computeNormal(a, b, c) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function readMappedFace(reader, type, textureName, meshVertexCount, material = null, material2 = null, solidColor = 0) {
  if (meshVertexCount < 1) return null;
  const n = reader.readInt32();
  if (n < 3 || n > MAX_CORNERS_PER_FACE || reader.remaining() < 16 + n * 12) return null;
  reader.skip(16);
  const vertexIndices = [], textureU = [], textureV = [];
  for (let i = 0; i < n; i++) { vertexIndices.push(reader.readInt32()); textureU.push(reader.readInt32()); textureV.push(reader.readInt32()); }
  if (!indicesValid(vertexIndices, meshVertexCount)) {
    if (!indicesValidOneBased(vertexIndices, meshVertexCount)) return null;
    for (let i = 0; i < vertexIndices.length; i++) vertexIndices[i]--;
  }
  return { type, textureName, vertexIndices, textureU, textureV, material, material2, solidColor };
}

function readUnmappedFace(reader, type, textureName, meshVertexCount, solidColor = 0) {
  if (meshVertexCount < 1) return null;
  const n = reader.readInt32();
  if (n < 3 || n > MAX_CORNERS_PER_FACE || reader.remaining() < 16 + n * 4) return null;
  reader.skip(16);
  const vertexIndices = [];
  for (let i = 0; i < n; i++) vertexIndices.push(reader.readInt32());
  if (!indicesValid(vertexIndices, meshVertexCount)) {
    if (!indicesValidOneBased(vertexIndices, meshVertexCount)) return null;
    for (let i = 0; i < vertexIndices.length; i++) vertexIndices[i]--;
  }
  return { type, textureName, vertexIndices, textureU: new Array(n).fill(0), textureV: new Array(n).fill(0), solidColor };
}

/*
  MRGL_MATERIAL payload: 11 ints after the opcode. Everything but `flags` and `foliage` is
  16.16 fixed point.
*/
function readMaterial(reader, id) {
  const flags = reader.readInt32() >>> 0;
  const reflectivity = fixed16(reader.readInt32());
  const fresnelBias = fixed16(reader.readInt32());
  const fresnelStrength = fixed16(reader.readInt32());
  const baseAlpha = fixed16(reader.readInt32());
  const specPower = fixed16(reader.readInt32());
  const emissive = fixed16(reader.readInt32());
  const tint = [fixed16(reader.readInt32()), fixed16(reader.readInt32()), fixed16(reader.readInt32())];
  const foliage = reader.readInt32() >>> 0;
  return {
    id, flags, reflectivity, fresnelBias, fresnelStrength, baseAlpha, specPower, emissive, tint,
    alphaRef: foliage & 0xffff,
    translucency: foliage >>> 16,
  };
}

// MRGL_MATERIAL2 payload: 7 ints after the opcode. normalStrength is only meaningful when
// the record says it carries a normal map.
function readMaterial2(reader) {
  const flags2 = reader.readInt32() >>> 0;
  const normalStrength = fixed16(reader.readInt32());
  const reserved = [];
  for (let i = 0; i < 5; i++) reserved.push(reader.readInt32());
  return {
    flags2,
    normalStrength: flags2 & MRGLMAT2_NORMALMAP ? normalStrength : 1,
    reserved,
  };
}

function fixed16(value) { return value / 65536; }

function indicesValid(indices, count) { return indices.every((i) => i >= 0 && i < count); }
function indicesValidOneBased(indices, count) { return indices.every((i) => i - 1 >= 0 && i - 1 < count); }
function upper(v) { return (v ?? "").trim().toUpperCase(); }
function isTvFamilyOrigin(origin) { return origin === "TV" || origin === "F3" || origin === "TV/F3"; }

function representativeColor(textureName) {
  const seed = [...(textureName || "__flat__")].reduce((s, c) => s + c.charCodeAt(0), 0);
  return hslToRgb((seed % 360) / 360, 0.22, 0.64);
}

function hslToRgb(h, s, l) {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  return (Math.round(hue2rgb(h + 1/3) * 255) << 16) | (Math.round(hue2rgb(h) * 255) << 8) | Math.round(hue2rgb(h - 1/3) * 255);
}
