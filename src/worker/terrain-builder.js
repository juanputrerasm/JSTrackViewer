import { decodeRawTexture } from "./texture-decoder.js";

const CELL_SIZE = 64;
const ATLAS_TILE_SIZE = 64;
const TERRAIN_OVERLAP_PIXELS = 2;
const MAX_ATLAS_COLS = 64;
const MAX_ATLAS_WIDTH = 8192;

/**
 * Builds GPU-ready terrain mesh data from RAW heightfield + CLR texture map + palette + texture list.
 * Returns transferable buffers: positions, normals, uvs, indices, atlas rgba.
 */
export function buildTerrainMesh(terrain, palette, textures, heightScale, origin) {
  const { gridSize, rawData, clrData, rawBytesPerCell, clrBytesPerCell } = terrain;
  const hs = heightScale ?? 4;

  // Build texture atlas
  const overlapPixels = usesHiddenTerrainOverlap(origin) ? TERRAIN_OVERLAP_PIXELS : 0;
  const {
    atlas, atlasWidth, atlasHeight, textureCount, atlasCols, atlasRows,
    atlasTileSize, atlasPadding, sourceTileSize, uvRects,
  } = buildAtlas(textures, palette, overlapPixels);

  // Allocate buffers: 4 unique vertices per cell (to allow per-cell UV)
  const cellCount = gridSize * gridSize;
  const vertexCount = cellCount * 4;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(cellCount * 6);

  for (let cz = 0; cz < gridSize; cz++) {
    for (let cx = 0; cx < gridSize; cx++) {
      const cell = cx + cz * gridSize;
      const vBase = cell * 4;
      const iBase = cell * 6;

      const h00 = sampleHeight(rawData, rawBytesPerCell, gridSize, cx,     cz);
      const h10 = sampleHeight(rawData, rawBytesPerCell, gridSize, cx + 1, cz);
      const h11 = sampleHeight(rawData, rawBytesPerCell, gridSize, cx + 1, cz + 1);
      const h01 = sampleHeight(rawData, rawBytesPerCell, gridSize, cx,     cz + 1);

      const x0 = cx * CELL_SIZE;
      const x1 = (cx + 1) * CELL_SIZE;
      // Flip Z so JTraxx Y=0 (south) maps to large Three.js Z (camera starts south, looks north/-Z)
      const z0 = (gridSize - cz) * CELL_SIZE;
      const z1 = (gridSize - cz - 1) * CELL_SIZE;

      // Positions (4 corners of the quad)
      const pOff = vBase * 3;
      positions[pOff + 0] = x0; positions[pOff + 1] = h00 * hs; positions[pOff + 2] = z0;
      positions[pOff + 3] = x1; positions[pOff + 4] = h10 * hs; positions[pOff + 5] = z0;
      positions[pOff + 6] = x1; positions[pOff + 7] = h11 * hs; positions[pOff + 8] = z1;
      positions[pOff + 9] = x0; positions[pOff + 10]= h01 * hs; positions[pOff + 11]= z1;

      // Quad face normal (from diagonal cross product)
      const d1x = x1 - x0, d1y = (h11 - h00) * hs, d1z = z1 - z0;
      const d2x = x0 - x1, d2y = (h01 - h10) * hs, d2z = z1 - z0;
      const nx = d1y * d2z - d1z * d2y;
      const ny = d1z * d2x - d1x * d2z;
      const nz = d1x * d2y - d1y * d2x;
      const nl = Math.hypot(nx, ny, nz) || 1;
      const nnx = nx / nl, nny = ny / nl, nnz = nz / nl;
      for (let v = 0; v < 4; v++) {
        normals[(vBase + v) * 3 + 0] = nnx;
        normals[(vBase + v) * 3 + 1] = nny;
        normals[(vBase + v) * 3 + 2] = nnz;
      }

      // UV from CLR texture index (with mirror + rotation support)
      let texIdx = 0;
      let rot = 0;
      let mirror = 0;
      if (clrData && clrData.length > 0) {
        const ci = cell * clrBytesPerCell;
        if (clrBytesPerCell === 1) {
          const b = clrData[ci] & 0xff;
          // Packed 6+2 format: bits 0-5 = texture index, bits 6-7 = 90° rotation steps
          // Matches Java TerrainTextureIndexCodec.clrPacked6Texture2Rotation:
          //   textureCount > 0 && textureCount <= 64 && (b & 0x3F) < textureCount
          const b6 = b & 0x3F;
          if (textureCount > 0 && textureCount <= 64 && b6 < textureCount) {
            texIdx = b6;
            rot = (b >> 6) & 3;
          } else {
            texIdx = textureCount > 0 ? Math.min(b, textureCount - 1) : 0;
          }
        } else {
          // 2-byte CLR: bits 0-11 = texture index, bits 12-13 = mirror, bits 14-15 = rotation
          const b0 = clrData[ci] & 0xff;
          const b1 = clrData[ci + 1] & 0xff;
          const value = b0 | (b1 << 8);
          texIdx = value & 0x0FFF;
          mirror = (value >> 12) & 3;
          rot = (value >> 14) & 3;
          if (textureCount > 0) texIdx = Math.min(texIdx, textureCount - 1);
        }
      }
      if (textureCount <= 1) texIdx = 0;
      const rect = uvRects[texIdx] ?? uvRects[0];
      const u0 = rect.x / atlasWidth;
      const u1 = (rect.x + rect.w) / atlasWidth;
      const v0 = rect.y / atlasHeight;
      const v1 = (rect.y + rect.h) / atlasHeight;

      // Base UV corners (indexed 0-3): BL=(u0,1), BR=(u1,1), TR=(u1,0), TL=(u0,0)
      // Matches JTraxx SoftwareTextureSampler.transformTextureCornerIndex:
      //   mirror bit 0 (alignment bit 12): result = (3 - result) & 3
      //   mirror bit 1 (alignment bit 13): result = (1 - result) & 3
      //   final: (rot + result) & 3
      const cU = [u0, u1, u1, u0];
      const cV = [v1, v1, v0, v0];
      // TV/F3: JTraxxMainWindow.flightTerrainTextureRotationQuarterTurns() = 3 extra turns.
      // JTraxx: (rot + result) & 3, applied after mirror. Corner indices match Three.js vi directly.
      const effectiveRot = isTvFamilyOrigin(origin) ? (rot + 3) & 3 : rot;
      const uOff = vBase * 2;
      for (let vi = 0; vi < 4; vi++) {
        let result = vi;
        if (mirror & 1) result = (3 - result) & 3;
        if (mirror & 2) result = (1 - result) & 3;
        const ci2 = (effectiveRot + result) & 3;
        uvs[uOff + vi * 2]     = cU[ci2];
        uvs[uOff + vi * 2 + 1] = cV[ci2];
      }

      // Indices (2 triangles)
      indices[iBase + 0] = vBase;     indices[iBase + 1] = vBase + 1; indices[iBase + 2] = vBase + 2;
      indices[iBase + 3] = vBase;     indices[iBase + 4] = vBase + 2; indices[iBase + 5] = vBase + 3;
    }
  }

  return {
    gridSize, cellSize: CELL_SIZE, heightScale: hs,
    positions: positions.buffer,
    normals: normals.buffer,
    uvs: uvs.buffer,
    indices: indices.buffer,
    atlas: {
      rgba: atlas.buffer, width: atlasWidth, height: atlasHeight,
      textureCount, atlasCols, atlasRows, atlasTileSize, atlasPadding, sourceTileSize,
    },
  };
}

function buildAtlas(textures, trackPalette, overlapPixels = 0) {
  const atlasPadding = Math.max(0, overlapPixels | 0);
  const decodedSlots = textures.map((tex) => decodeTerrainTexture(tex, trackPalette));
  const sourceTileSize = decodedSlots.reduce((max, slot) => Math.max(max, slot?.width ?? ATLAS_TILE_SIZE), ATLAS_TILE_SIZE);
  const atlasTileSize = sourceTileSize + atlasPadding * 2;
  // Use ALL slots (including missing ones) so CLR indices map directly to atlas positions.
  const slotCount = textures.length;
  if (slotCount === 0) {
    const atlas = new Uint8ClampedArray(atlasTileSize * atlasTileSize * 4);
    for (let y = 0; y < atlasTileSize; y++) {
      for (let x = 0; x < atlasTileSize; x++) {
        const o = (y * atlasTileSize + x) * 4;
        const v = ((x >> 3) ^ (y >> 3)) & 1 ? 120 : 80;
        atlas[o] = atlas[o+1] = atlas[o+2] = v; atlas[o+3] = 255;
      }
    }
    return {
      atlas, atlasWidth: atlasTileSize, atlasHeight: atlasTileSize,
      textureCount: 1, atlasCols: 1, atlasRows: 1, atlasTileSize, atlasPadding, sourceTileSize,
      uvRects: [{ x: atlasPadding, y: atlasPadding, w: sourceTileSize, h: sourceTileSize }],
    };
  }

  const atlasCols = Math.max(1, Math.min(slotCount, MAX_ATLAS_COLS, Math.floor(MAX_ATLAS_WIDTH / atlasTileSize)));
  const atlasRows = Math.ceil(slotCount / atlasCols);
  const atlasWidth = atlasCols * atlasTileSize;
  const atlasHeight = atlasRows * atlasTileSize;
  const atlas = new Uint8ClampedArray(atlasWidth * atlasHeight * 4);
  const uvRects = [];

  for (let ti = 0; ti < slotCount; ti++) {
    const decoded = decodedSlots[ti];
    const xOff = (ti % atlasCols) * atlasTileSize;
    const yOff = Math.floor(ti / atlasCols) * atlasTileSize;
    const sourceWidth = decoded?.width ?? sourceTileSize;
    const sourceHeight = decoded?.height ?? sourceTileSize;
    const insetX = atlasPadding > 0 ? atlasPadding * sourceTileSize / sourceWidth : 0;
    const insetY = atlasPadding > 0 ? atlasPadding * sourceTileSize / sourceHeight : 0;
    uvRects.push({
      x: xOff + atlasPadding + insetX,
      y: yOff + atlasPadding + insetY,
      w: Math.max(1, sourceTileSize - insetX * 2),
      h: Math.max(1, sourceTileSize - insetY * 2),
    });
    for (let y = 0; y < atlasTileSize; y++) {
      for (let x = 0; x < atlasTileSize; x++) {
        const sampleX = Math.max(0, Math.min(sourceTileSize - 1, x - atlasPadding));
        const sampleY = Math.max(0, Math.min(sourceTileSize - 1, y - atlasPadding));
        const dstOff = ((yOff + y) * atlasWidth + xOff + x) * 4;
        if (decoded) {
          const srcX = Math.min(decoded.width - 1, Math.floor(sampleX * decoded.width / sourceTileSize));
          const srcY = Math.min(decoded.height - 1, Math.floor(sampleY * decoded.height / sourceTileSize));
          const srcOff = (srcY * decoded.width + srcX) * 4;
          atlas[dstOff]     = decoded.rgba[srcOff];
          atlas[dstOff + 1] = decoded.rgba[srcOff + 1];
          atlas[dstOff + 2] = decoded.rgba[srcOff + 2];
          atlas[dstOff + 3] = 255;
        } else {
          const v = ti & 1 ? 160 : 100;
          atlas[dstOff] = atlas[dstOff+1] = atlas[dstOff+2] = v; atlas[dstOff+3] = 255;
        }
      }
    }
  }

  return { atlas, atlasWidth, atlasHeight, textureCount: slotCount, atlasCols, atlasRows, atlasTileSize, atlasPadding, sourceTileSize, uvRects };
}

function usesHiddenTerrainOverlap(origin) {
  return origin === "MTM2" || origin === "CPR";
}

function isTvFamilyOrigin(origin) {
  return origin === "TV" || origin === "F3" || origin === "TV/F3";
}

function decodeTerrainTexture(tex, trackPalette) {
  if (!tex?.data || tex.data.length < 4096) return null;
  const act = tex.actData ?? trackPalette;
  try {
    return decodeRawTexture(tex.data, act, tex.name);
  } catch {
    return null;
  }
}

function sampleHeight(rawData, rawBytesPerCell, gridSize, cx, cz) {
  if (!rawData) return 0;
  const x = Math.min(cx, gridSize - 1);
  const z = Math.min(cz, gridSize - 1);
  const off = (x + z * gridSize) * rawBytesPerCell;
  if (rawBytesPerCell === 1) return rawData[off] ?? 0;
  const lo = rawData[off] ?? 0;
  const hi = rawData[off + 1] ?? 0;
  if (hi === 0) return lo;
  return (lo | (hi << 8)) >>> 6;
}
