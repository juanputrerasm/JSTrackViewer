import { resolveAsset } from "./pod-format.js";
import { archiveTitle, normalizeArchiveName, replaceExtension } from "../shared/path-utils.js";

/**
 * Loads ground-box layers from companion lower/upper/face entries.
 * lower = lower height byte per cell
 * upper = upper height byte per cell (0 = no box)
 * faces = 12 bytes per cell: 6 faces × 2 bytes (uint16LE texture index)
 *
 * A Hellbender level has two such layers on one grid: .RA0/.RA1/.CL0 above ground and
 * .RA4/.RA5/.CL2 in the cavern below it, the second on the biased altitude the cavern grids
 * use (see hb-underground.js). They are the same record in the same encoding, so the caller
 * names the extensions and the altitude bias rather than this growing a second reader.
 */
export function loadGroundBoxes(podIndex, getBytes, rawName, gridSize, layer = {}) {
  const { lower = ".RA0", upper = ".RA1", faces = ".CL0", heightOffset = 0 } = layer;
  const ra0Name = replaceExtension(rawName, lower);
  const ra1Name = replaceExtension(rawName, upper);
  const cl0Name = replaceExtension(rawName, faces);

  const ra0Entry = resolveDataAsset(podIndex, ra0Name);
  const ra1Entry = resolveDataAsset(podIndex, ra1Name);
  const cl0Entry = resolveDataAsset(podIndex, cl0Name);
  if (!ra0Entry || !ra1Entry) return [];

  const ra0 = getBytes(ra0Entry);
  const ra1 = getBytes(ra1Entry);
  const cl0 = cl0Entry ? getBytes(cl0Entry) : null;
  const cells = gridSize * gridSize;
  if (ra0.length < cells || ra1.length < cells) return [];
  if (cl0 && cl0.length < cells * 12) return [];

  const boxes = [];
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const idx = x + y * gridSize;
      const upper = ra1[idx];
      if (upper < 1) continue;
      const lower = ra0[idx];
      const faceTexture  = new Array(6).fill(-1);
      const faceRotation = new Array(6).fill(0);
      const faceMirror   = new Array(6).fill(0);
      if (cl0) {
        const cl0Base = idx * 12;
        for (let face = 0; face < 6; face++) {
          const off = cl0Base + face * 2;
          const raw = cl0[off] | (cl0[off + 1] << 8);
          // CL0 uses the same 2-byte CLR encoding as terrain:
          // bits 0-11 = texture index, bits 12-13 = mirror, bits 14-15 = rotation
          faceTexture[face]  = raw & 0x0FFF;
          faceMirror[face]   = (raw >> 12) & 3;
          faceRotation[face] = (raw >> 14) & 3;
        }
      }
      boxes.push({
        x, y,
        width: 1, height: 1,
        lower: lower + heightOffset,
        upper: upper + heightOffset,
        midX: (x << 6) + 32,
        midY: (y << 6) + 32,
        midZ: ((lower + upper) >> 1) + heightOffset,
        faceTexture, faceRotation, faceMirror
      });
    }
  }
  return boxes;
}

function resolveDataAsset(podIndex, name) {
  const normalized = normalizeArchiveName(name);
  if (!normalized) return null;
  if (/[\\/]/.test(normalized)) return resolveAsset(podIndex, normalized);
  const title = archiveTitle(normalized);
  return resolveAsset(podIndex, "DATA/" + title) ?? resolveAsset(podIndex, normalized);
}
