import { resolveAsset } from "./pod-format.js";
import { decodeBinModel } from "./bin-decoder.js";
import { TR_ANGLE_TO_RAD, defPlacementToEditor, parseDef } from "../vendor/openphotex/index.js";
import { tvLogicName, tvPowerup, tvWeaponName } from "./tv-tables.js";
import { hbPowerup } from "../vendor/openphotex/index.js";
import { binCornerRadius } from "./engine-placement.js";

/*
  Reading the .DEF (definitions, placements, and where a placement stands) is OpenPhotex's:
  parseDef and defPlacementToEditor carry the record-shape rules and the evidence for them. This
  file loads the models the placements name and builds the viewer's boxes.
*/
/**
 * Loads TV/F3/HB object placements from a .DEF file.
 * Returns { boxes, models } where boxes are placed instances and models are decoded BIN meshes.
 */
export function loadDefObjects(podIndex, getBytes, defTitle, gridSize, origin) {
  const entry = resolveAsset(podIndex, defTitle);
  if (!entry) return { boxes: [], models: {} };

  const parsed = parseDef(getBytes(entry));
  if (!parsed) return { boxes: [], models: {} };

  const boxes = [];
  const models = {};
  // The engine's radius per simple model, which it writes over the DEF hit radius at load.
  const radii = new Map();
  const modelRadius = (def) => {
    const name = (def.simpleAsset ?? "").toUpperCase();
    if (!name.endsWith(".BIN")) return null;
    if (!radii.has(name)) {
      const simpleEntry = resolveAsset(podIndex, name);
      radii.set(name, simpleEntry ? binCornerRadius(getBytes(simpleEntry)) : null);
    }
    return radii.get(name);
  };

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

    const [px, py, pz] = defPlacementToEditor(pl, def, gridSize, origin);

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
      ...(origin === "HB" ? hbDefinitionInfo(def, modelRadius(def)) : tvDefinitionInfo(def, modelRadius(def))),
      /*
        What engine-placement.js needs to settle the placement the way the game does: the
        header's X, Y, Z offsets (world units), the logic and the model radius.
      */
      engine: {
        offset: [def.groundOffsetX ?? 0, def.groundOffsetY ?? 0, def.groundOffsetZ ?? 0],
        logic: def.logic ?? -1,
        modelRadius: modelRadius(def),
      },
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

/*
  What an object is, in words, for a TV/F3 placement: its behaviour, weapon and what it drops.

  `hitRadius` is the radius the game uses: it recomputes it at load from the simple model
  (engine-placement.js binCornerRadius) and writes it over the DEF's value, which is kept as
  `editorHitRadius`.
*/
function tvDefinitionInfo(def, engineRadius) {
  const info = {
    logic: def.logic, logicName: tvLogicName(def.logic),
    hitRadius: engineRadius ?? def.hitRadius,
    editorHitRadius: def.hitRadius,
  };
  if (def.weapon !== undefined) info.weaponName = tvWeaponName(def.weapon);
  if (def.dropChance > 0) {
    info.dropChance = def.dropChance;
    info.dropType = def.dropType;
    info.dropName = def.dropType === -1 ? "Random" : (tvPowerup(def.dropType)?.name ?? "");
  }
  return info;
}

/*
  The same, for a Hellbender placement: what it drops, named from Hellbender's own 31-type table
  (HB_POWERUPS), and its hit radius, recomputed the same way (HELLBEND.EXE 0x404d40). Its logic numbers are not TVCAD's, so they are not named.
*/
function hbDefinitionInfo(def, engineRadius) {
  const info = { hitRadius: engineRadius ?? def.hitRadius, editorHitRadius: def.hitRadius };
  if (def.dropChance > 0) {
    info.dropChance = def.dropChance;
    info.dropType = def.dropType;
    info.dropName = def.dropType === -1 ? "Random" : (hbPowerup(def.dropType)?.name ?? "");
  }
  return info;
}
