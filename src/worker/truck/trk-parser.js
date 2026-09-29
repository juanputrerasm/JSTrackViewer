/*
  The MTM truck manifest (.TRK), as the drive mode reads it.

  Parsing is OpenPhotex's (parseMtmTrkLines). Drive mode is an MTM2 feature, so a 4x4
  Evolution manifest is refused by name rather than being read as something it is not.

  What a TRK does and does not contain matters for the sim. It is an assembly manifest: model
  names, the four static wheel centres, the scrape hull, axle-bar and driveshaft layout, lights
  and sounds. It holds no mass, no spring rate, no gearing and not even a tire radius, which is
  why the physics parameters live in drive/params/ and the wheel radius is measured from the
  tire model's own bounds at load. Units are feet; x lateral (+ right), y up, z forward.
*/
import { MTM_WHEEL_KEYS, detectTruckManifest, parseMtmTrkLines, truckManifestLines } from "../../vendor/openphotex/index.js";

export function parseTruckManifestText(text) {
  const lines = truckManifestLines(text);
  if (detectTruckManifest(lines) === "evo" || (lines[0] ?? "").toLowerCase() === "version") {
    throw new Error("This is a 4x4 Evolution truck manifest; drive mode supports MTM trucks.");
  }
  const trk = parseMtmTrkLines(lines);
  return {
    formatVersion: trk.dialect,
    truckName: trk.truckName,
    truckModelBaseName: trk.truckModelBaseName ?? "",
    tireModelBaseName: trk.tireModelBaseName ?? "",
    axleModelName: trk.axleModelName ?? "",
    shockTextureName: trk.shockTextureName ?? undefined,
    barTextureName: trk.barTextureName ?? undefined,
    axlebarOffset: trk.axlebarOffset ?? undefined,
    superiorAxlebarOffset: trk.superiorAxlebarOffset ?? undefined,
    driveshaftPos: trk.driveshaftPos ?? undefined,
    wheelAnchors: trk.wheelAnchors,
    scrapePoints: trk.scrapePoints,
    instrumentCluster: trk.instrumentCluster ?? undefined,
    waveFiles: trk.waveFiles,
    numberOfLights: trk.numberOfLights ?? undefined,
    lights: trk.lights.map(({ propertyLabels, ...light }) => {
      // The light's type is kept (BinEdit's Truck.h: 0 headlight, 1 brake, 3 roof, 4 special,
      // 5 backup) so brake lights come on with the brake. A flare with no radius is 0.25 ft.
      if ("bitmapRadius" in light) light.bitmapRadius = light.bitmapRadius ?? 0.25;
      return light;
    }),
    unknownFields: trk.unknownFields,
  };
}

/*
  The four wheel anchor keys, in the order the sim indexes its wheels: front pair first, then
  rear, and right before left within each axle, matching the order the TRK itself lists them
  and the order the SIT save-state reports on_gnd flags in.
*/
export const WHEEL_KEYS = [...MTM_WHEEL_KEYS];
