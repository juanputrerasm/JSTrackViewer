import { decodeRawTexture, podRawSide } from "./texture-decoder.js";

export const CELL_SIZE = 64;
const ATLAS_TILE_SIZE = 64;
const TERRAIN_OVERLAP_PIXELS = 2;
const MAX_ATLAS_COLS = 64;
const MAX_ATLAS_WIDTH = 8192;
const MAX_ATLAS_HEIGHT = 8192;

/**
 * Builds GPU-ready terrain mesh data from RAW heightfield + CLR texture map + palette + texture list.
 * Returns transferable buffers: positions, normals, uvs, indices, atlas rgba.
 */
export function buildTerrainMesh(terrain, palette, textures, heightScale, origin, animations) {
  const { gridSize, rawData, clrData, rawBytesPerCell, clrBytesPerCell } = terrain;
  const hs = heightScale ?? 4;

  /*
    Horizontal and vertical scale are properties of the terrain, not constants.

    The MTM family is 64 world units per cell and encodes a 16-bit height as a 10.6 fixed
    point value, which is what the historical `>>> 6` was. 4x4 Evolution is 32 units per cell
    with a 11.5 fixed point height, so it sets cellSize 32 and heightDivisor 32 and keeps its
    own units - see evo-coords.js. A descriptor that says nothing gets the MTM values, so
    every existing track builds exactly as before.
  */
  const cellSize = terrain.cellSize ?? CELL_SIZE;
  const heightDivisor = terrain.heightDivisor ?? null;

  // Build texture atlas
  const overlapPixels = usesHiddenTerrainOverlap(origin) ? TERRAIN_OVERLAP_PIXELS : 0;
  const {
    atlas, atlasWidth, atlasHeight, textureCount, atlasCols, atlasRows,
    atlasTileSize, atlasPadding, sourceTileSize, uvRects, decodedSlots,
  } = buildAtlas(textures, palette, overlapPixels);

  const atlasAnimations = buildAtlasAnimations(
    animations, textures, decodedSlots,
    { atlasCols, atlasTileSize, sourceTileSize, atlasPadding });

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

      const h00 = sampleHeight(rawData, rawBytesPerCell, gridSize, cx,     cz,     heightDivisor);
      const h10 = sampleHeight(rawData, rawBytesPerCell, gridSize, cx + 1, cz,     heightDivisor);
      const h11 = sampleHeight(rawData, rawBytesPerCell, gridSize, cx + 1, cz + 1, heightDivisor);
      const h01 = sampleHeight(rawData, rawBytesPerCell, gridSize, cx,     cz + 1, heightDivisor);

      const x0 = cx * cellSize;
      const x1 = (cx + 1) * cellSize;
      // Flip Z so JTraxx Y=0 (south) maps to large Three.js Z (camera starts south, looks north/-Z)
      const z0 = (gridSize - cz) * cellSize;
      const z1 = (gridSize - cz - 1) * cellSize;

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
    gridSize, cellSize, heightScale: hs,
    positions: positions.buffer,
    normals: normals.buffer,
    uvs: uvs.buffer,
    indices: indices.buffer,
    atlas: {
      rgba: atlas.buffer, width: atlasWidth, height: atlasHeight,
      textureCount, atlasCols, atlasRows, atlasTileSize, atlasPadding, sourceTileSize,
      animations: atlasAnimations,
    },
  };
}

/*
  Terrain texture animations, resolved to atlas blits.

  A .ANI names a base texture slot and the frames that replace it. Since every slot already
  occupies a fixed tile in the atlas, an animation is just a tile-sized RGBA block written
  over that tile, which is far cheaper than rebuilding the atlas or giving animated tiles
  their own material.

  Frames are resampled here, in the worker, exactly the way the static tile was, so the
  renderer only has to copy bytes. A frame that names a texture the level does not carry is
  dropped; an animation left with fewer than two usable frames is dropped entirely, which
  leaves the static base tile already in the atlas.
*/
function buildAtlasAnimations(animations, textures, decodedSlots, layout) {
  if (!animations?.length || !textures?.length) return [];
  const { atlasCols, atlasTileSize, sourceTileSize, atlasPadding } = layout;

  const slotByName = new Map();
  for (let i = 0; i < textures.length; i++) {
    const title = textureTitle(textures[i]?.name);
    if (title && !slotByName.has(title)) slotByName.set(title, i);
  }

  const out = [];
  for (const animation of animations) {
    const slot = slotByName.get(textureTitle(animation.baseName));
    if (slot === undefined) continue;

    const frames = [];
    for (const frameName of animation.frames) {
      const frameSlot = slotByName.get(textureTitle(frameName));
      // A frame is itself a terrain slot in every shipped level, so its decode is already done.
      const decoded = frameSlot !== undefined ? decodedSlots[frameSlot] : null;
      if (!decoded) continue;
      frames.push(renderTile(decoded, atlasTileSize, sourceTileSize, atlasPadding).buffer);
    }
    if (frames.length < 2) continue;

    out.push({
      slot,
      x: (slot % atlasCols) * atlasTileSize,
      y: Math.floor(slot / atlasCols) * atlasTileSize,
      size: atlasTileSize,
      fps: animation.fps > 0 ? animation.fps : 8,
      frames,
    });
  }
  return out;
}

function textureTitle(name) {
  if (!name) return "";
  const upper = String(name).toUpperCase();
  const slash = Math.max(upper.lastIndexOf("/"), upper.lastIndexOf("\\"));
  return slash >= 0 ? upper.slice(slash + 1) : upper;
}

/*
  Resamples one decoded texture into a standalone atlas tile.

  Same sampling as the atlas build below, including the padding skirt, so a blitted frame is
  indistinguishable from the tile it replaces.
*/
function renderTile(decoded, atlasTileSize, sourceTileSize, atlasPadding) {
  const tile = new Uint8ClampedArray(atlasTileSize * atlasTileSize * 4);
  for (let y = 0; y < atlasTileSize; y++) {
    for (let x = 0; x < atlasTileSize; x++) {
      const sampleX = Math.max(0, Math.min(sourceTileSize - 1, x - atlasPadding));
      const sampleY = Math.max(0, Math.min(sourceTileSize - 1, y - atlasPadding));
      const srcX = Math.min(decoded.width - 1, Math.floor(sampleX * decoded.width / sourceTileSize));
      const srcY = Math.min(decoded.height - 1, Math.floor(sampleY * decoded.height / sourceTileSize));
      const srcOff = (srcY * decoded.width + srcX) * 4;
      const dstOff = (y * atlasTileSize + x) * 4;
      tile[dstOff]     = decoded.rgba[srcOff];
      tile[dstOff + 1] = decoded.rgba[srcOff + 1];
      tile[dstOff + 2] = decoded.rgba[srcOff + 2];
      tile[dstOff + 3] = 255;
    }
  }
  return tile;
}

function buildAtlas(textures, trackPalette, overlapPixels = 0) {
  const atlasPadding = Math.max(0, overlapPixels | 0);
  const decodedSlots = textures.map((tex) => decodeTerrainTexture(tex, trackPalette));
  let sourceTileSize = decodedSlots.reduce((max, slot) => Math.max(max, slot?.width ?? ATLAS_TILE_SIZE), ATLAS_TILE_SIZE);

  /*
    HD art can outgrow the atlas. A track with 173 terrain slots at 1024 px would want roughly
    25 rows of 1028 px, far past what WebGL accepts as one texture, and the upload would just
    fail. Halve the tile size until the grid fits; tiles are resampled into their cell anyway,
    so this costs resolution rather than losing the track.
  */
  while (sourceTileSize > ATLAS_TILE_SIZE) {
    const tile = sourceTileSize + atlasPadding * 2;
    const cols = Math.max(1, Math.min(textures.length, MAX_ATLAS_COLS, Math.floor(MAX_ATLAS_WIDTH / tile)));
    if (Math.ceil(textures.length / cols) * tile <= MAX_ATLAS_HEIGHT) break;
    sourceTileSize >>= 1;
  }
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
      decodedSlots,
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
    // Inset by a fraction of the tile, derived from the legacy tile size, rather than by a
    // fixed count of the source image's own pixels. See hdLegacySide above.
    const borderSide = decoded?.legacySide ?? decoded?.width ?? sourceTileSize;
    const insetX = atlasPadding > 0 ? atlasPadding * sourceTileSize / borderSide : 0;
    const insetY = insetX;
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

  return { atlas, atlasWidth, atlasHeight, textureCount: slotCount, atlasCols, atlasRows, atlasTileSize, atlasPadding, sourceTileSize, uvRects, decodedSlots };
}

function usesHiddenTerrainOverlap(origin) {
  return origin === "MTM2" || origin === "CPR";
}

function isTvFamilyOrigin(origin) {
  return origin === "TV" || origin === "F3" || origin === "TV/F3";
}

/*
  `legacySide` is the size of the 8-bit tile a slot stands for, which once HD art is in play
  is NOT the size of the image finally sampled.

  It matters because of the terrain border ring. Traxx samples a tile's interior rather than
  its full extent (tseq64 runs 2..62, OpenGLTerrainRenderer.cpp:8498) and normalises those
  texel coordinates by the LEGACY width even when a 512 or 1024 pixel HD image has been
  uploaded in the tile's place. The inset is therefore a fixed FRACTION of the tile, 2/64,
  not a fixed number of pixels. Insetting an HD tile by two of its own pixels would sample
  2/512 of it and put the baked border ring back on screen.
*/
function hdLegacySide(width) {
  // Mirrors the fork's HDTexLegacySize: an HD source stands in for a 256 tile if it is at
  // least that big, and for a 64 tile otherwise.
  return width >= 256 ? 256 : 64;
}

function decodeTerrainTexture(tex, trackPalette) {
  // A true-colour source, already decoded by the worker, wins outright. An HD-only pod has
  // no .RAW for this slot at all, so it is also the only thing such a pod can use.
  if (tex?.hdImage?.rgba) {
    const legacySide = (tex.data && podRawSide(tex.data.length)) || hdLegacySide(tex.hdImage.width);
    return {
      name: tex.name,
      width: tex.hdImage.width,
      height: tex.hdImage.height,
      rgba: tex.hdImage.rgba,
      legacySide,
    };
  }
  // decodeRawTexture is the authority on which byte counts are legal tiles; a 32x32 tile is
  // 1024 bytes and used to be rejected by a hardcoded 4096 floor here.
  if (!tex?.data || !podRawSide(tex.data.length)) return null;
  const act = tex.actData ?? trackPalette;
  try {
    const decoded = decodeRawTexture(tex.data, act, tex.name);
    return { ...decoded, legacySide: decoded.width };
  } catch {
    return null;
  }
}

function sampleHeight(rawData, rawBytesPerCell, gridSize, cx, cz, heightDivisor) {
  if (!rawData) return 0;
  const x = Math.min(cx, gridSize - 1);
  const z = Math.min(cz, gridSize - 1);
  const off = (x + z * gridSize) * rawBytesPerCell;
  if (rawBytesPerCell === 1) return rawData[off] ?? 0;
  const lo = rawData[off] ?? 0;
  const hi = rawData[off + 1] ?? 0;
  /*
    An explicit divisor means the grid's encoding is known, so divide and keep the fraction.
    Evo's low five bits are real elevation - ASPEN alone uses 8,617 distinct heights - and
    shifting them away terraces every slope into 1-unit steps.
  */
  if (heightDivisor) return (lo | (hi << 8)) / heightDivisor;
  // MTM-family fallback: a zero high byte is treated as an 8-bit grid stored two bytes wide.
  if (hi === 0) return lo;
  return (lo | (hi << 8)) >>> 6;
}
