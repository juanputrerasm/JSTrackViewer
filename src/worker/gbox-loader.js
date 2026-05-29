import { resolveAsset } from "./pod-format.js";
import { replaceExtension } from "../shared/path-utils.js";

/**
 * Loads ground-box layers from companion RA0, RA1, CL0 entries.
 * RA0 = lower height byte per cell
 * RA1 = upper height byte per cell (0 = no box)
 * CL0 = 12 bytes per cell: 6 faces × 2 bytes (uint16LE texture index)
 */
export function loadGroundBoxes(podIndex, getBytes, rawName, gridSize) {
  const ra0Name = replaceExtension(rawName, ".RA0");
  const ra1Name = replaceExtension(rawName, ".RA1");
  const cl0Name = replaceExtension(rawName, ".CL0");

  const ra0Entry = resolveAsset(podIndex, ra0Name);
  const ra1Entry = resolveAsset(podIndex, ra1Name);
  const cl0Entry = resolveAsset(podIndex, cl0Name);
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
        lower, upper,
        midX: (x << 6) + 32,
        midY: (y << 6) + 32,
        midZ: (lower + upper) >> 1,
        faceTexture, faceRotation, faceMirror
      });
    }
  }
  return boxes;
}
