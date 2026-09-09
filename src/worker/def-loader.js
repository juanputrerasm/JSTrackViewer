import { resolveAsset } from "./pod-format.js";
import { decodeBinModel } from "./bin-decoder.js";
import { TV_UNITS_PER_HEIGHT_STEP } from "./tv-coords.js";

const TR_ANGLE_TO_RAD = Math.PI * 2.0 / 65536.0;

/*
  A TV-family enemy definition is a header line followed by a body carrying named separator
  lines. Terminal Velocity and Fury3 use a 14-line record:

     0  <6 ints>,<complex>.bin,<simple>.bin
     1  thrust, rotation, fire speed, fire strength, flag
     2  ...
     3  ...
     4  ;NewHit
     5  <hit / weapon table>
     6  !NewAtakRet
     7  attack distance, retreat distance, ...
     8  <description text>
     9  #New2ndweapon
    10  <secondary weapon data>
    11  %SFX
    12  <boss fire wav, or null>
    13  <boss yell wav, or null>

  Hellbender extends the SAME record to 25 lines, appending four more named sections after the
  boss sound files:

    14  null
    15  : Path to follow
    16  0
    17  = cannonDamage, laserDamage, missileDamage
    18  65536 / 32768 / 65536
    21  @ Friendly flag
    22  0
    23  { Escape and destroy sound files
    24  null / <wav>

  The first four separators sit at identical offsets in both, so their presence identifies the
  shared prefix but NOT the record's length. Treating 14 lines as the whole record breaks
  Hellbender outright: the last definition's skip lands on ": Path to follow", which is then
  read as the placement count, and parseDefStructure bails with no objects at all. So the
  fixed offsets are used only to locate the description, and the body scan still decides where
  the record ends.

  The description sits at header + 8 in both games ("Cryogenic Container." in HB's HOTH.DEF,
  "Boss - This crazy guy drives the factories on this world." in Fury3's ATMOS.DEF) and is
  kept on the placement so the viewer can name what an object actually is.
*/
const DEF_BODY_LINES_AFTER_HEADER = 13;
const DEF_DESCRIPTION_OFFSET = 8;
const DEF_SEPARATORS = [";NewHit", "!NewAtakRet", "#New2ndweapon", "%SFX"];
const DEF_SEPARATOR_OFFSETS = [4, 6, 9, 11];

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

  for (let placementIndex = 0; placementIndex < parsed.placements.length; placementIndex++) {
    const pl = parsed.placements[placementIndex];
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
      /*
        The definition's own Y offset is the ONLY thing that lifts a TV/F3 object.

        Placements are authored flush with the ground: across ATMOS.DEF every placement's
        (y >> 15) equals the heightfield sample at its own cell, with zero error. So an
        object that hovers in the game hovers because of Enemy Editor field C, "Ground
        Position from Centroid (X, Y, Z)", which the manual describes as the way "to move an
        object in any direction from where it would normally be placed into the world" and
        notes is only ever used on Y.

        The data agrees. Over 1532 definitions in FURY3.POD, FURYSE.POD and TV.pod the X slot
        is never non-zero and the Z slot is non-zero only in three copies of one line whose
        intended 51200 was typed "51,200". The 72 definitions that do set Y are the ones that
        should float: hovercft, octoani, mother, forcegen, bionmssl, radar, roofgun. Without
        this, every one of them is drawn resting on the terrain.

        The base term keeps its truncating shift rather than becoming a division. More than
        half of all placement Y values are not multiples of 2^15 (8052 of 15046), so dividing
        would raise every existing object by a fraction of a step. That is arguably the more
        faithful reading of a world-unit height, but it is a separate question from this fix,
        and changing both at once would hide which one moved an object.
      */
      pz = Math.max(0, (pl.y >> 15) + def.groundOffsetY / TV_UNITS_PER_HEIGHT_STEP);
    }

    boxes.push({
      position: [px, py, pz],
      theta: pl.pitch * TR_ANGLE_TO_RAD,
      phi: pl.roll * TR_ANGLE_TO_RAD,
      psi: pl.yaw * TR_ANGLE_TO_RAD,
      modelName: binName,
      length: 32, width: 32, height: 24,
      type: 0, flags: 0,
      /*
        The index into the RAW placement list, which is what .NAV target lists and boss
        entries name. It is NOT this box's own index: a placement whose definition has no
        .BIN never becomes a box, so the two lists drift apart.
      */
      placementIndex,
      strength: pl.strength,
      description: def.description ?? "",
      /*
        A Hellbender placement below zero stands in the cavern under the level, not on the
        ground: 2,862 of the 2,950 such placements in the shipped game land between the cavern
        floor and ceiling their own cell states (hb-underground.js). The viewer used to drop
        them, because with no cavern drawn they were objects buried in a hillside; now that it
        draws one, they are that room's contents and travel with it.
      */
      hellbenderUnderground: origin === "HB" && pl.y < 0,
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
    const headerIdx = idx;
    const description = isFixedDefinitionRecord(lines, headerIdx)
      ? lines[headerIdx + DEF_DESCRIPTION_OFFSET].trim()
      : scanDefinitionDescription(lines, headerIdx);
    definitions.push(parseEnemyDefinition(lines[headerIdx], description));
    /*
      Skip past the shared prefix when the separators confirm it, then let the scan find the
      real end of the record. The jump keeps the scan from mistaking a body line for the next
      header inside the part of the record whose shape is known; the scan is what copes with
      Hellbender's longer tail.
    */
    const bodyStart = isFixedDefinitionRecord(lines, headerIdx)
      ? headerIdx + 1 + DEF_BODY_LINES_AFTER_HEADER
      : headerIdx + 1;
    idx = skipDefinitionBody(lines, bodyStart, d === numDef - 1);
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

/*
  Parses a definition header: N leading integers, then the complex and simple asset names.

  Every definition in the three shipped archives has exactly six leading integers. Slot 2 is
  field B (Size) and slots 3, 4, 5 are field C, the (X, Y, Z) ground offset. Slots 0 and 1 are
  not identified; they are kept so a later reading of them costs nothing.
*/
function parseEnemyDefinition(line, description) {
  const p = line.split(",");
  if (p.length < 2) return { binForHydration: "", groundOffsetY: 0, description: "" };
  const complexAsset = p[p.length - 2].trim();
  const simpleAsset = p[p.length - 1].trim();
  const cu = complexAsset.toUpperCase();
  const su = simpleAsset.toUpperCase();
  const binForHydration = cu.endsWith(".BIN") ? cu : su.endsWith(".BIN") ? su : cu;

  const prefix = [];
  for (let i = 0; i < p.length - 2; i++) {
    const v = parseInt(p[i].trim(), 10);
    prefix.push(Number.isFinite(v) ? v : 0);
  }
  // Only the canonical six-integer shape is trusted to carry the offset in a known slot.
  const groundOffsetY = prefix.length === 6 ? prefix[4] : 0;
  const size = prefix.length === 6 ? prefix[2] : 0;

  return {
    complexAsset, simpleAsset, binForHydration,
    prefix, size, groundOffsetY,
    description: description ?? "",
  };
}

/*
  Recovers the description from a definition that is not in the 14-line form.

  About one definition in ten is a shorter record with no separators, typically four numeric
  lines then the text (FURY3's CITY-T1.DEF: "Data not available"). The description is the
  first body line that is neither a numeric CSV row nor an asset name, which recovers all 154
  of them across the three shipped archives with no false positives.
*/
function scanDefinitionDescription(lines, headerIdx) {
  const limit = Math.min(lines.length, headerIdx + 1 + DEF_BODY_LINES_AFTER_HEADER);
  for (let i = headerIdx + 1; i < limit; i++) {
    const t = lines[i].trim();
    if (t === "" || t.toLowerCase() === "null") continue;
    if (DEF_SEPARATORS.includes(t)) continue;
    if (/^-?\d+(\s*,\s*-?\d+)*$/.test(t)) continue;
    if (/\.(BIN|TXT|WAV|RAW)$/i.test(t)) continue;
    return t;
  }
  return "";
}

/*
  True when the four named separators sit at their fixed offsets from this header.

  This identifies the record prefix that Terminal Velocity, Fury3 and Hellbender share. It
  does NOT mean the record is 14 lines long; see the note at the top of this file.
*/
function isFixedDefinitionRecord(lines, headerIdx) {
  if (headerIdx + DEF_BODY_LINES_AFTER_HEADER >= lines.length) return false;
  for (let i = 0; i < DEF_SEPARATORS.length; i++) {
    if (lines[headerIdx + DEF_SEPARATOR_OFFSETS[i]].trim() !== DEF_SEPARATORS[i]) return false;
  }
  return true;
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
