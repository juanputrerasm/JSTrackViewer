import { BinaryReader } from "./binary-reader.js";

const SIGNATURE_LWO = 0x4d524f46;
const SIGNATURE_ANIMATED_BIN = 0x00000020;
const BLOCK_MRGL_MAGNIFY = 0x00000014;
const MAX_CORNERS_PER_FACE = 256;
const UV_SCALE = 0xff0000;
const TYPE_TRANSPARENT_MTM = 0x00000011;
const TYPE_TRANSPARENT_MTM2 = 0x00000033;

// Geometry divisors matching Java SoftwareModelRenderer constants
const DIVISOR_LEGACY    = 64.0;
const DIVISOR_HB        = 4096.0;
const DIVISOR_TV_F3     = 10922.667;

export function decodeBinModel(bytes, modelName, origin) {
  const model = {
    name: modelName, format: "UNKNOWN",
    magnifyPower: 65536, baseZ: 0,
    vertexCount: 0, polygonCount: 0,
    rawVertexBounds: null,
    textureNames: [], meshes: []
  };
  if (!bytes?.length || bytes.length < 4) return model;
  const reader = new BinaryReader(bytes);
  const firstType = reader.readInt32();
  if (firstType === SIGNATURE_LWO) { model.format = "LWO"; return model; }
  if (firstType === BLOCK_MRGL_MAGNIFY) {
    model.format = "BIN";
    if (reader.remaining() < 4) return model;
    const power = reader.readInt32();
    if (power > 0) model.magnifyPower = power;
    decodeBinPayload(reader, model, 8, true, origin);
    return buildMeshes(model);
  }
  if (firstType !== SIGNATURE_ANIMATED_BIN) {
    model.format = `0x${(firstType >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
    return model;
  }
  model.format = "ANIMATED_BIN";
  decodeBinPayload(reader, model, 12, false, origin);
  return buildMeshes(model);
}

function decodeBinPayload(reader, model, headerBytesBeforeVertexCount, applyMagnifyAtDecode, origin) {
  reader.skip(headerBytesBeforeVertexCount);
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
  let scale;
  if (applyMagnifyAtDecode) {
    // Java applies magnify scaling at decode time (65536/magnifyPower) then divides by
    // origin-based geometryDivisor at render time. Combined: 65536/(magnifyPower*divisor).
    // Legacy shorthand: 65536/(magnifyPower*64) = 1024/magnifyPower.
    let geometryDivisor;
    if (origin === "HB") geometryDivisor = DIVISOR_HB;
    else if (origin === "TV" || origin === "F3") geometryDivisor = DIVISOR_TV_F3;
    else geometryDivisor = DIVISOR_LEGACY;
    scale = 65536.0 / (model.magnifyPower * geometryDivisor);
    if (origin === "TV" || origin === "F3") scale *= 1.5;
  } else {
    scale = 1.0 / DIVISOR_LEGACY;  // ANIMATED_BIN always uses 1/64
  }
  model.vertices = rawVertices.map((v) => ({ x: v.x * scale, y: v.y * scale, z: v.z * scale }));
  model.baseZ = rawBaseZWithOffset * scale;
  const polygons = [];
  const textureNames = new Set();
  let currentTexture = "";
  const meshVerts = model.vertices.length;

  blocks:
  while (reader.remaining() >= 4) {
    const token = reader.readInt32();
    switch (token) {
      case 0x00000000: break blocks;
      case 0x00000002: {
        if (reader.remaining() < 8) break blocks;
        reader.skip(4);
        const nv = reader.readInt32();
        const strip = nv * 12;
        const tail80 = 20 * 4;
        if (nv >= 0 && nv <= MAX_CORNERS_PER_FACE && reader.remaining() >= strip + tail80) { reader.skip(strip); reader.skip(tail80); }
        else if (reader.remaining() >= 34 * 4) { reader.skip(34 * 4); }
        else break blocks;
        break;
      }
      case 0x00000003: {
        if (reader.remaining() < 8) break blocks;
        reader.skip(8);
        if (meshVerts < 1 || reader.remaining() < meshVerts * 12) break blocks;
        reader.skip(meshVerts * 12);
        break;
      }
      case 0x00000004: {
        if (reader.remaining() < 8) break blocks;
        reader.skip(4);
        const n = reader.readInt32();
        if (n < 0 || n > 4096 || reader.remaining() < n * 8) break blocks;
        reader.skip(n * 8);
        break;
      }
      case 0x0000000d:
        if (reader.remaining() < 20) break blocks;
        reader.skip(4);
        currentTexture = upper(reader.readFixedAscii(16));
        break;
      case 0x0000001d: {
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
      case 0x0000000a:
        if (reader.remaining() < 4) break blocks;
        reader.skip(4); currentTexture = "";
        break;
      case 0x0000000c:
        if (reader.remaining() < 24) break blocks;
        reader.skip(24); break;
      case 0x00000012:
        if (reader.remaining() < 4) break blocks;
        reader.skip(4); break;
      case BLOCK_MRGL_MAGNIFY:
        if (reader.remaining() < 4) break blocks;
        model.magnifyPower = reader.readInt32(); break;
      case 0x00000016:
        if (reader.remaining() < 12) break blocks;
        reader.skip(12); break;
      case 0x00000017:
        if (reader.remaining() < 8) break blocks;
        reader.skip(8); break;
      case 0x0000001f: {
        if (reader.remaining() < 8) break blocks;
        reader.skip(4);
        const n = reader.readInt32();
        if (n < 0 || n > 200000 || reader.remaining() < n * 4) break blocks;
        reader.skip(n * 4); break;
      }
      case 0x00000011: case 0x00000018: case 0x00000022:
      case 0x00000029: case 0x00000033: case 0x00000034: case 0x0000000e: {
        const polygon = readMappedFace(reader, token, currentTexture, meshVerts);
        if (polygon) { polygons.push(polygon); if (polygon.textureName) textureNames.add(polygon.textureName); }
        break;
      }
      case 0x00000005: case 0x00000019: case 0x00000006: case 0x0000000f: {
        const polygon = readUnmappedFace(reader, token, currentTexture, meshVerts);
        if (polygon) { polygons.push(polygon); if (polygon.textureName) textureNames.add(polygon.textureName); }
        break;
      }
      default: break blocks;
    }
  }
  model.polygons = polygons;
  model.textureNames = [...textureNames];
  model.vertexCount = model.vertices.length;
  model.polygonCount = model.polygons.length;
}

function buildMeshes(model) {
  const verts = model.vertices ?? [];
  // Compute model-space anchor (matches Java SoftwareModelRenderer.modelAnchor):
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

  const grouped = new Map();
  for (const polygon of model.polygons ?? []) {
    const transparent = polygon.type === TYPE_TRANSPARENT_MTM || polygon.type === TYPE_TRANSPARENT_MTM2;
    const key = `${polygon.textureName || "__flat__"}|${transparent ? "alpha" : "opaque"}`;
    if (!grouped.has(key)) grouped.set(key, { positions: [], normals: [], uvs: [], textureName: polygon.textureName || "", transparent });
    triangulatePolygon(verts, polygon, grouped.get(key), anchorX, anchorY, anchorZ);
  }
  model.meshes = [...grouped.values()].map((b) => ({
    textureName: b.textureName,
    transparent: b.transparent === true,
    positions: new Float32Array(b.positions),
    normals: new Float32Array(b.normals),
    uvs: new Float32Array(b.uvs),
    color: representativeColor(b.textureName)
  }));
  return model;
}

// Stores vertices in JTraxx local space with 0.75 scale on Z (height).
// Matches Java SoftwareModelRenderer.transformModelVertex local part BEFORE rotation:
//   localX = v.x - anchorX
//   localY = v.y - anchorY
//   localZ = (v.z - anchorZ) * 0.75
// The scene applies the full T*R group matrix to map JTraxx local → Three.js world.
function triangulatePolygon(vertices, polygon, bucket, anchorX, anchorY, anchorZ) {
  const { vertexIndices, textureU, textureV } = polygon;
  if (!vertexIndices || vertexIndices.length < 3) return;
  for (let i = 1; i < vertexIndices.length - 1; i++) {
    const idx = [0, i, i + 1];
    const jv = idx.map((k) => {
      const v = vertices[vertexIndices[k]];
      if (!v) return null;
      return [v.x - anchorX, v.y - anchorY, (v.z - anchorZ) * 0.75];
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

function readMappedFace(reader, type, textureName, meshVertexCount) {
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
  return { type, textureName, vertexIndices, textureU, textureV };
}

function readUnmappedFace(reader, type, textureName, meshVertexCount) {
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
  return { type, textureName, vertexIndices, textureU: new Array(n).fill(0), textureV: new Array(n).fill(0) };
}

function indicesValid(indices, count) { return indices.every((i) => i >= 0 && i < count); }
function indicesValidOneBased(indices, count) { return indices.every((i) => i - 1 >= 0 && i - 1 < count); }
function upper(v) { return (v ?? "").trim().toUpperCase(); }

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
