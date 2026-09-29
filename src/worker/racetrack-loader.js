import { resolveAsset } from "./pod-format.js";
import { replaceExtension, archiveTitle } from "../shared/path-utils.js";
import { CPR_CATCH_FENCE_NAMES, parseCprTrk, parseCprTtx } from "../vendor/openphotex/index.js";

/*
  Reading the .TRK road surface and the .TTX texture list is OpenPhotex's (parseCprTrk,
  parseCprTtx). This file finds the files beside the track and loads the textures they name.
*/
export function loadRaceTrackLayer(podIndex, getBytes, rawName, doc) {
  const trkName = replaceExtension(rawName, ".TRK");
  const trkEntry = resolveAsset(podIndex, trkName);
  if (!trkEntry) return;

  const trk = parseCprTrk(getBytes(trkEntry));
  if (!trk) return;

  const ttxEntry = resolveAsset(podIndex, replaceExtension(trkEntry.title ?? trkName, ".TTX")) ?? resolveAsset(podIndex, replaceExtension(trkName, ".TTX"));
  if (ttxEntry) loadRaceTrackTextures(podIndex, getBytes, ttxEntry, doc);
  doc.raceTrackFence = loadCatchFence(podIndex, getBytes);
  doc.raceTrackSurfaces.push(...trk.surfaces);
}

/*
  The catch fencing on wall types 3 and 5 is implied by the wall type and lives in
  STARTUP.POD, never in a .TTX (see CPR_WALL_LAYERS). Returning null is normal and expected
  when a single track POD is loaded on its own, and the worker synthesizes a stand-in in that
  case.
*/
function loadCatchFence(podIndex, getBytes) {
  for (const name of CPR_CATCH_FENCE_NAMES) {
    const entry = resolveAsset(podIndex, name);
    if (!entry) continue;
    const actEntry = resolveAsset(podIndex, replaceExtension(name, ".ACT"));
    return {
      name: archiveTitle(name),
      data: getBytes(entry),
      actData: actEntry ? getBytes(actEntry) : null,
    };
  }
  return null;
}

function loadRaceTrackTextures(podIndex, getBytes, ttxEntry, doc) {
  for (const { name, flags } of parseCprTtx(getBytes(ttxEntry))) {
    const dataEntry = resolveAsset(podIndex, name);
    const actEntry = resolveAsset(podIndex, replaceExtension(name, ".ACT"));
    doc.raceTrackTextures.push({
      name: archiveTitle(name),
      flags,
      data: dataEntry ? getBytes(dataEntry) : null,
      actData: actEntry ? getBytes(actEntry) : doc.palette,
    });
  }
}
