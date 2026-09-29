import { resolveAsset } from "./pod-format.js";
import { decodeBinModel } from "./bin-decoder.js";
import { TR_ANGLE_TO_RAD, defPlacementToEditor, parseDef } from "../vendor/openphotex/index.js";
import { tvLogicName, tvPowerup, tvWeaponName } from "./tv-tables.js";

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
      ...(origin === "HB" ? {} : tvDefinitionInfo(def)),
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
*/
function tvDefinitionInfo(def) {
  const info = { logic: def.logic, logicName: tvLogicName(def.logic), hitRadius: def.hitRadius };
  if (def.weapon !== undefined) info.weaponName = tvWeaponName(def.weapon);
  if (def.dropChance > 0) {
    info.dropChance = def.dropChance;
    info.dropType = def.dropType;
    info.dropName = def.dropType === -1 ? "Random" : (tvPowerup(def.dropType)?.name ?? "");
  }
  return info;
}
