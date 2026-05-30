import { resolveAsset } from "./pod-format.js";
import { decodeBinModel } from "./bin-decoder.js";

const TR_ANGLE_TO_RAD = Math.PI * 2.0 / 65536.0;

/**
 * Loads TV/F3/HB object placements from a .DEF file.
 * Returns { boxes, models } where boxes are placed instances and models are decoded BIN meshes.
 */
export function loadDefObjects(podIndex, getBytes, defTitle, gridSize, origin) {
  const entry = resolveAsset(podIndex, defTitle);
  if (!entry) return { boxes: [], models: {} };

  const bytes = getBytes(entry);
  const text = new TextDecoder("latin1").decode(bytes);
  const lines = toLines(text);
  if (!lines.length) return { boxes: [], models: {} };

  const parsed = parseDefStructure(lines);
  if (!parsed) return { boxes: [], models: {} };

  const boxes = [];
  const models = {};

  for (const pl of parsed.placements) {
    if (pl.strength === 0) continue;
    if (pl.defIndex < 0 || pl.defIndex >= parsed.definitions.length) continue;
    const def = parsed.definitions[pl.defIndex];
    const binName = def.binForHydration;
    if (!binName || !binName.endsWith(".BIN")) continue;

    const modelEntry = resolveAsset(podIndex, binName);
    if (modelEntry && !models[binName]) {
      const modelBytes = getBytes(modelEntry);
      models[binName] = decodeBinModel(modelBytes, binName, origin);
    }

    const g = gridSize;
    let px, py, pz;
    if (origin === "HB") {
      // HellbenderFlightTerrainDefMapper: 16.16 fixed-point coords, groundXZScale=8
      const worldX = pl.x / 65536.0;
      const worldZ = pl.z / 65536.0;
      const gx = ((worldX / 8.0) % g + g) % g;
      const gz = ((worldZ / 8.0) % g + g) % g;
      px = Math.round(gx * 64);
      py = Math.round(gz * 64);
      pz = Math.round((pl.y / 65536.0) * 2.0);
    } else {
      // TV/F3: 2^20 units per cell
      const cell = 64;
      const half = 32;
      const gx = Math.floor(pl.x / (1 << 20));
      const gz = Math.floor(pl.z / (1 << 20));
      const wrappedX = ((gx % g) + g) % g;
      const wrappedZ = ((gz % g) + g) % g;
      px = wrappedX * cell + half;
      py = wrappedZ * cell + half;
      pz = Math.max(0, pl.y >> 15);
    }

    boxes.push({
      position: [px, py, pz],
      theta: pl.pitch * TR_ANGLE_TO_RAD,
      phi: pl.roll * TR_ANGLE_TO_RAD,
      psi: pl.yaw * TR_ANGLE_TO_RAD,
      modelName: binName,
      length: 32, width: 32, height: 24,
      type: 0, flags: 0,
      hellbenderUndergroundHidden: origin === "HB" && pl.y < 0,
    });
  }
  return { boxes, models };
}

function parseDefStructure(lines) {
  let idx = skipEmpty(lines, 0);
  if (idx >= lines.length) return null;
  const numDef = parseInt(lines[idx++].trim(), 10);
  if (isNaN(numDef) || numDef < 0) return null;

  const definitions = [];
  for (let d = 0; d < numDef; d++) {
    idx = findNextEnemyDefinitionHeaderLine(lines, idx);
    if (idx >= lines.length) return null;
    definitions.push(parseEnemyDefinition(lines[idx++]));
    idx = skipDefinitionBody(lines, idx, d === numDef - 1);
  }

  idx = skipEmpty(lines, idx);
  if (idx >= lines.length) return null;
  const numPl = parseInt(lines[idx++].trim(), 10);
  if (isNaN(numPl) || numPl < 0) return null;

  const placements = [];
  for (let p = 0; p < numPl; p++) {
    idx = skipEmpty(lines, idx);
    if (idx >= lines.length) break;
    const pl = parsePlacementLine(lines[idx++]);
    if (pl) placements.push(pl);
  }
  return { definitions, placements };
}

function skipEmpty(lines, idx) {
  while (idx < lines.length && lines[idx].trim() === "") idx++;
  return idx;
}

function isEnemyDefinitionHeaderLine(line) {
  const lower = line.toLowerCase();
  if (!lower.includes(".bin")) return false;
  const p = line.split(",");
  if (p.length < 2) return false;
  const complex = p[p.length - 2].trim().toLowerCase();
  const simple = p[p.length - 1].trim().toLowerCase();
  return simple.endsWith(".bin") && (complex.endsWith(".bin") || complex.endsWith(".txt"));
}

function findNextEnemyDefinitionHeaderLine(lines, start) {
  for (let i = start; i < lines.length; i++) {
    if (isEnemyDefinitionHeaderLine(lines[i])) return i;
  }
  return lines.length;
}

function parseEnemyDefinition(line) {
  const p = line.split(",");
  if (p.length < 2) return { binForHydration: "" };
  const complexAsset = p[p.length - 2].trim();
  const simpleAsset = p[p.length - 1].trim();
  const cu = complexAsset.toUpperCase();
  const su = simpleAsset.toUpperCase();
  const binForHydration = cu.endsWith(".BIN") ? cu : su.endsWith(".BIN") ? su : cu;
  return { complexAsset, simpleAsset, binForHydration };
}

function skipDefinitionBody(lines, idx, lastDefinition) {
  while (idx < lines.length) {
    const t = lines[idx].trim();
    if (t === "") { idx++; continue; }
    if (!lastDefinition && isEnemyDefinitionHeaderLine(t)) return idx;
    if (lastDefinition && isProbableNumPlacementsLine(lines, idx)) return idx;
    idx++;
  }
  return idx;
}

function isSolitaryInt(t) { return t !== "" && /^-?\d+$/.test(t); }

function isProbableNumPlacementsLine(lines, idx) {
  const t0 = lines[idx].trim();
  if (!isSolitaryInt(t0)) return false;
  const n = parseInt(t0, 10);
  if (n < 0 || n > 500000) return false;
  if (idx + 1 >= lines.length) return n === 0;
  return isPlacementLine(lines[idx + 1]) || (n === 0 && lines[idx + 1].trim() === "");
}

function isPlacementLine(raw) {
  if (raw.toLowerCase().includes(".bin")) return false;
  const p = raw.split(",");
  if (p.length < 8) return false;
  for (let i = 0; i < 8; i++) { if (isNaN(parseInt(p[i].trim(), 10))) return false; }
  return true;
}

function parsePlacementLine(line) {
  if (!isPlacementLine(line)) return null;
  const p = line.split(",");
  return {
    defIndex: parseInt(p[0].trim(), 10),
    strength: parseInt(p[1].trim(), 10),
    x: parseInt(p[2].trim(), 10),
    y: parseInt(p[3].trim(), 10),
    z: parseInt(p[4].trim(), 10),
    pitch: parseInt(p[5].trim(), 10),
    roll: parseInt(p[6].trim(), 10),
    yaw: parseInt(p[7].trim(), 10)
  };
}

function toLines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}
