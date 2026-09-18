/*
  The MTM truck manifest (.TRK), as the drive mode reads it.

  Ported from JSTruckViewer's src/worker/trk-parser.js, with one deliberate difference: the
  4x4 Evolution dialect is not handled here. Evo manifests are a different shape (vec3 wheel
  anchors, counted lists, .SMF models) and, more to the point, drive mode is an MTM2 feature,
  so carrying the Evo branch would mean porting evo-trk-parser.js for a path nothing calls.
  An Evo manifest is refused by name rather than silently misparsed as MTM1.

  What a TRK does and does not contain matters for the sim. It is an assembly manifest: model
  names, the four static wheel centres, the scrape hull, axle-bar and driveshaft layout,
  lights and sounds. It holds no mass, no spring rate, no gearing and not even a tire radius,
  which is why the physics parameters live in drive/params/ and the wheel radius is measured
  from the tire model's own bounds at load.

  Units are feet, and the axes are x lateral (+ right), y up, z longitudinal (+ forward).
  BinEdit's Truck.h labels the light fields "(ft)" outright, and the stock corpus agrees:
  BIGFOOT's anchors are +-4.292 ft apart with a 6.00 ft tire.
*/

export function parseTruckManifestText(text) {
  const lines = text
    // NUL padding and the DOS end-of-file marker (0x1A) both show up in shipped manifests.
    .replace(/[\u0000\u001a]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Evo opens with a "version" / "6" or "7" pair. Say so rather than falling through to the
  // MTM1 branch, which would read "version" as the truck name and produce a truck with no
  // models at all.
  if ((lines[0] ?? "").toLowerCase() === "version") {
    throw new Error("This is a 4x4 Evolution truck manifest; drive mode supports MTM trucks.");
  }

  const headerLine = lines[0] ?? "";
  const upperHeader = headerLine.toUpperCase();

  // MTM2 manifests open with "MTM2 truckName" or "MTM2.1 truckName". MTM1 has no header at
  // all and opens with the bare "truckName" label, which is what separates the generations.
  const isMtm2 = upperHeader.startsWith("MTM2");
  const isMtm1 = !isMtm2 && upperHeader.startsWith("TRUCKNAME");
  if (isMtm2 || isMtm1) {
    lines.shift();
  }

  const truckName = lines.shift() ?? "";

  const manifest = {
    formatVersion: isMtm1 ? "MTM1" : upperHeader.startsWith("MTM2.1") ? "MTM2.1" : "MTM2",
    truckName,
    truckModelBaseName: "",
    tireModelBaseName: "",
    axleModelName: "",
    shockTextureName: undefined,
    barTextureName: undefined,
    axlebarOffset: undefined,
    superiorAxlebarOffset: undefined,
    driveshaftPos: undefined,
    wheelAnchors: {},
    scrapePoints: [],
    instrumentCluster: undefined,
    waveFiles: [],
    numberOfLights: undefined,
    lights: [],
    unknownFields: {},
  };

  const partialAnchors = new Map();

  for (let i = 0; i < lines.length; i += 1) {
    const label = lines[i];
    const value = lines[i + 1] ?? "";

    // MTM2 stores model stems ("bigfoot"); MTM1 stores full file names ("bigfoot.bin").
    if (label === "truckModelBaseName" || label === "truckModelName") {
      manifest.truckModelBaseName = value;
      i += 1;
      continue;
    }
    if (label === "tireModelBaseName" || label === "tireModelName") {
      manifest.tireModelBaseName = value;
      i += 1;
      continue;
    }
    if (label === "axleModelName") {
      manifest.axleModelName = value;
      i += 1;
      continue;
    }
    if (label === "shockTextureName") {
      manifest.shockTextureName = value;
      i += 1;
      continue;
    }
    if (label === "barTextureName") {
      manifest.barTextureName = value;
      i += 1;
      continue;
    }
    if (label === "axlebarOffset") {
      manifest.axlebarOffset = parseVec3(value);
      i += 1;
      continue;
    }
    if (label === "superiorAxlebarOffset") {
      manifest.superiorAxlebarOffset = parseSuperiorAxlebarOffset(value);
      i += 1;
      continue;
    }
    if (label === "driveshaftPos") {
      manifest.driveshaftPos = parseVec3(value);
      i += 1;
      continue;
    }
    // The scrape hull: the body points the game tests against the ground. Drive mode uses
    // these as its chassis contact points, so they are load bearing here rather than decor.
    if (label.startsWith("Scrape point ")) {
      manifest.scrapePoints.push(parseVec3(value));
      i += 1;
      continue;
    }
    if (label === "Instrument Cluster") {
      manifest.instrumentCluster = value;
      i += 1;
      continue;
    }
    if (label === "Wave File") {
      manifest.waveFiles.push(value);
      i += 1;
      while (i + 1 < lines.length && !isManifestLabel(lines[i + 1])) {
        manifest.waveFiles.push(lines[i + 1]);
        i += 1;
      }
      continue;
    }
    if (label === "Number of Lights") {
      manifest.numberOfLights = parseInt(value, 10) || 0;
      i += 1;
      continue;
    }
    const lightMatch = label.match(/^Light (\d+) /);
    if (lightMatch) {
      const idx = parseInt(lightMatch[1], 10);
      const prop = label.slice(lightMatch[0].length).trim();
      while (manifest.lights.length <= idx) manifest.lights.push(null);
      if (!manifest.lights[idx]) manifest.lights[idx] = { index: idx };
      const light = manifest.lights[idx];
      if (prop.startsWith("body axis pos")) {
        const parts = value.split(",").map((v) => parseFloat(v) || 0);
        light.pos = { x: parts[0] ?? 0, y: parts[1] ?? 0, z: parts[2] ?? 0 };
        light.bitmapRadius = parts[3] ?? 0.25;
      } else if (prop.startsWith("heading")) {
        const parts = value.split(",").map((v) => parseFloat(v) || 0);
        light.heading = parts[0] ?? 0;
        light.pitch = parts[1] ?? 0;
        light.spinSpeed = parts[2] ?? 0;
      } else if (prop.startsWith("cone:")) {
        const parts = value.split(",");
        light.coneLength = parseFloat(parts[0]) || 0;
        light.coneBaseRadius = parseFloat(parts[1]) || 0;
        light.coneRimRadius = parseFloat(parts[2]) || 0;
        light.coneTexture = (parts[3] ?? "").trim();
      } else if (prop.startsWith("source:")) {
        light.sourceBitmap = value.trim();
      } else if (prop.startsWith("ms on")) {
        const [on, off] = value.split(",").map((v) => parseInt(v, 10) || 0);
        light.msOn = on;
        light.msOff = off;
      } else if (prop.startsWith("type")) {
        /*
          Kept, where the viewer drops it. BinEdit's Truck.h enumerates these as 0 headlight,
          1 brake, 3 roof, 4 special, 5 backup, and drive mode needs the brake lights to come
          on with the brake rather than glowing for the whole session.
        */
        light.type = parseInt(value, 10) || 0;
      }
      i += 1;
      continue;
    }

    const axisMatch = label.match(/^(.*)\.(x|y|z)$/i);
    if (axisMatch) {
      const anchorKey = axisMatch[1];
      const axis = axisMatch[2].toLowerCase();
      const current = partialAnchors.get(anchorKey) ?? { x: 0, y: 0, z: 0 };
      current[axis] = parseFloat(value) || 0;
      partialAnchors.set(anchorKey, current);
      i += 1;
      continue;
    }

    manifest.unknownFields[label] = value;
    i += 1;
  }

  for (const [key, vec] of partialAnchors.entries()) {
    manifest.wheelAnchors[key] = vec;
  }

  manifest.lights = manifest.lights.filter(Boolean);

  return manifest;
}

function parseVec3(value) {
  const [x = "0", y = "0", z = "0"] = value.split(",");
  return {
    x: parseFloat(x) || 0,
    y: parseFloat(y) || 0,
    z: parseFloat(z) || 0,
  };
}

function parseSuperiorAxlebarOffset(value) {
  const [frontAxleY = "0", rearAxleY = "0", middleY = "0"] = value.split(",");
  return {
    frontAxleY: parseFloat(frontAxleY) || 0,
    rearAxleY: parseFloat(rearAxleY) || 0,
    middleY: parseFloat(middleY) || 0,
  };
}

function isManifestLabel(line) {
  return line === "truckModelBaseName"
    || line === "truckModelName"
    || line === "tireModelBaseName"
    || line === "tireModelName"
    || line === "axleModelName"
    || line === "shockTextureName"
    || line === "barTextureName"
    || line === "axlebarOffset"
    || line === "superiorAxlebarOffset"
    || line === "driveshaftPos"
    || line === "Instrument Cluster"
    || line === "Wave File"
    || line === "Number of Lights"
    || line.startsWith("Scrape point ")
    || /^Light \d+ /.test(line)
    || /^(.*)\.(x|y|z)$/i.test(line);
}

/*
  The four wheel anchor keys, in the order the sim indexes its wheels.

  Front pair first, then rear, and right before left within each axle, matching the order the
  TRK itself lists them and the order the SIT save-state reports `on_gnd` flags in.
*/
export const WHEEL_KEYS = [
  "faxle.rtire.static_bpos",
  "faxle.ltire.static_bpos",
  "raxle.rtire.static_bpos",
  "raxle.ltire.static_bpos",
];
