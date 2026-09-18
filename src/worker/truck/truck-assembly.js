/*
  Building a drivable truck out of a POD.

  Ported from JSTruckViewer's assembleTruck, with three deliberate differences:

  1. It reads bytes through the caller's synchronous accessor rather than extracting every
     entry to OPFS and reading it back. The track worker already caches every entry's bytes
     for the track load, and a truck is four models and a handful of textures.

  2. It reuses THIS repo's bin-decoder, which carries the MRGL material and HD art handling
     the track path needs, and converts the result to feet. The two decoders differ by exactly
     a factor of two and nothing else, which was checked vertex by vertex against BIGFOOT1,
     BFC16L, AXLE3 and CRUSHER1: max |track/2 - truck| came out at exactly 0. See
     UNITS_PER_FOOT_H in drive/world-frame.js for why that factor is the same number the
     scene conversion uses.

  3. It measures the tire radius. No TRK field states it, and the simulation needs it for the
     wheel rays, so it comes from the tire model's own bounds (BIGFOOT: 3.00 ft, a 72 inch
     tire).

  Everything returned is in feet, in TRK axes: x lateral (+ right), y up, z longitudinal
  (+ forward). The renderer converts to scene axes; the simulation does not.
*/
import { decodeBinModel } from "../bin-decoder.js";
import { decodeRawTexture, podRawSide } from "../texture-decoder.js";
import { decodeTrueColorTexture } from "../image-decoder.js";
import { createPaletteResolver, findArtSibling, findHdSibling } from "../palette-resolver.js";
import { normalizeArchiveName } from "../../shared/path-utils.js";
import { UNITS_PER_FOOT_H } from "../../drive/world-frame.js";
import { WHEEL_KEYS } from "./trk-parser.js";
import { resolveMtm1WheelEntries, resolveSingleModelEntry, resolveWheelEntries } from "./model-resolve.js";

/*
  Chassis hardware offsets, in feet.

  MTM2 draws the axle bars, shocks and driveshaft as generated geometry rather than as models,
  and the offsets are not in the TRK. These are JSTruckViewer's reconstruction, which is why
  they are all n/256: they were read off the game as 1/256 ft fixed point values.
*/
const FIXED_POINT = 1 / 256;
const SHOCK_OFFSET_X = 542 * FIXED_POINT;
const SHOCK_OFFSET_Y = 85 * FIXED_POINT;
const SHOCK_PAIR_Z_OFFSET = 70 * FIXED_POINT;
const AXLE_BAR_OFFSET_X = 535 * FIXED_POINT;
const AXLE_BAR_OFFSET_Y = -80 * FIXED_POINT;
const AXLE_BAR_OFFSET_Z = -83 * FIXED_POINT;
const AXLE_BAR_MIDDLE_Y_BIAS = 45 * FIXED_POINT;

/*
  How a small-tire truck says "no axle bars" and "no driveshaft".

  There is no flag for turning them off, so the community idiom is to put the mount where the
  geometry cannot be seen: the Dodge Viper GTS-R ships an axlebarOffset of "-2,999,0". Taken
  literally that draws a pair of 999 foot columns. Across the 20 stock trucks the mount sits
  2.156 to 3.250 ft from the body, so anything past 50 ft is a sentinel, not a position.
*/
const AXLE_BAR_SENTINEL_DISTANCE = 50;

/**
 * @param {object}   podIndex  an indexed POD holding TRUCK\, MODELS\ and ART\
 * @param {Function} getBytes  synchronous entry -> Uint8Array
 * @param {object}   manifest  from parseTruckManifestText
 */
export async function assembleTruck(podIndex, getBytes, manifest) {
  const warnings = [];
  const isMtm1 = manifest.formatVersion === "MTM1";
  // MTM1 trucks are body plus four tires: no axle model, bars, shocks, driveshaft or lights.
  const hasChassisHardware = !isMtm1;

  const bodyEntry = resolveSingleModelEntry(podIndex, manifest.truckModelBaseName, "body", warnings);
  const axleEntry = hasChassisHardware
    ? resolveSingleModelEntry(podIndex, manifest.axleModelName, "axle", warnings)
    : null;
  const wheelPlan = isMtm1
    ? resolveMtm1WheelEntries(podIndex, manifest.tireModelBaseName, warnings)
    : resolveWheelEntries(podIndex, manifest.tireModelBaseName, warnings);

  const body = decodeModelInFeet(bodyEntry, getBytes, "body");
  const axle = decodeModelInFeet(axleEntry, getBytes, "axle");

  const wheels = WHEEL_KEYS.map((key) => {
    const model = decodeModelInFeet(wheelPlan.mapping[key] ?? null, getBytes, key);
    const radius = tireRadiusOf(model);
    if (model && !radius) warnings.push(`Could not measure a radius for the ${key} tire.`);
    return {
      key,
      position: manifest.wheelAnchors[key] ?? { x: 0, y: 0, z: 0 },
      model,
      radius,
    };
  });

  const models = [body, axle, ...wheels.map((w) => w.model)].filter(Boolean);
  const textures = await loadTextures(podIndex, getBytes, models, manifest, hasChassisHardware, warnings);

  const frontCenter = midpoint(
    manifest.wheelAnchors["faxle.ltire.static_bpos"],
    manifest.wheelAnchors["faxle.rtire.static_bpos"]
  );
  const rearCenter = midpoint(
    manifest.wheelAnchors["raxle.ltire.static_bpos"],
    manifest.wheelAnchors["raxle.rtire.static_bpos"]
  );

  for (const model of models) {
    warnings.push(...(model.warnings ?? []).map((w) => `${model.name}: ${w}`));
  }

  return {
    truckName: manifest.truckName,
    formatVersion: manifest.formatVersion,
    body,
    wheels,
    axles: hasChassisHardware ? [
      buildAxlePlacement(axle, "axle_0", frontCenter),
      buildAxlePlacement(axle, "axle_1", rearCenter),
    ] : [],
    axleBars: hasChassisHardware && !suppressesAxleBars(manifest.axlebarOffset)
      ? buildAxleBarDescriptors(frontCenter, rearCenter, manifest.axlebarOffset, manifest.superiorAxlebarOffset)
      : [],
    shocks: hasChassisHardware ? buildShockDescriptors(frontCenter, rearCenter) : [],
    driveshaft: hasChassisHardware && !suppressesDriveshaft(manifest.driveshaftPos)
      ? buildDriveshaftDescriptor(frontCenter, rearCenter, manifest.driveshaftPos)
      : null,
    barTextureName: hasChassisHardware ? (manifest.barTextureName ?? "") : "",
    shockTextureName: hasChassisHardware ? (manifest.shockTextureName ?? "") : "",
    // The sim's chassis contact points, not decoration.
    scrapePoints: manifest.scrapePoints ?? [],
    lights: (manifest.lights ?? [])
      .filter((light) => light?.pos)
      .map((light) => ({
        pos: light.pos,
        radius: Math.max(light.bitmapRadius ?? 0.15, 0.1),
        index: light.index,
        type: light.type ?? 0,
      })),
    textures,
    // Handy for the spawn: how far the body origin sits above the ground with the suspension
    // fully extended. Phase 0 measured 6.00 ft for BIGFOOT on SUMMIT1 against 6.80 ft here,
    // and that gap is still unexplained, so the spawn snaps to terrain rather than using it.
    restHeight: restHeightOf(wheels),
    warnings,
  };
}

/*
  Decode one model and convert it to feet.

  The decoder is this repo's, so its output is in track world units. Scaling here rather than
  at draw time keeps one rule: everything a truck hands out is feet.
*/
function decodeModelInFeet(entry, getBytes, partKey) {
  if (!entry) return null;
  const model = decodeBinModel(getBytes(entry), entry.title, "MTM2");
  const k = 1 / UNITS_PER_FOOT_H;

  model.partKey = partKey;
  model.vertices = (model.vertices ?? []).map((v) => ({ x: v.x * k, y: v.y * k, z: v.z * k }));
  model.baseZ = (model.baseZ ?? 0) * k;
  for (const mesh of model.meshes ?? []) {
    // Positions only. Normals are directions and uvs are unitless, so both are scale free.
    if (mesh.positions?.length) {
      const scaled = new Float32Array(mesh.positions.length);
      for (let i = 0; i < mesh.positions.length; i++) scaled[i] = mesh.positions[i] * k;
      mesh.positions = scaled;
    }
  }
  alignMeshesToVertices(model);
  return model;
}

/*
  Put a model's triangles back in the same space as its vertices.

  This repo's BIN decoder emits mesh positions with the model's base normalised to z = 0 and
  hands back `baseZ` separately, because the track renderer wants exactly that: _buildBinModel
  places an object at `wz * hs + baseZ * 0.75`, so the mesh sitting on zero is what lets one
  model drop onto terrain at any height. The `vertices` array keeps the authored coordinates.

  For a truck that split is wrong in a way that is easy to miss and ugly on screen. Every
  measurement here is taken from `vertices` (the wheel radius, the axle centring, the body
  bounds) while the renderer draws `mesh.positions`, so the two disagreed by the model's own
  base offset: the body was drawn 2.81 ft high, the axle 0.85 ft high, and each tire a full
  3.00 ft above its own hub, which made the wheels orbit their mounting point instead of
  spinning. The axle bars and driveshaft, drawn from TRK coordinates, then looked far too low
  because everything around them had risen.

  Only the z normalisation is undone, and only when the decoder has actually applied it. The
  tempting general fix, matching the two bounding boxes on every axis, would silently shift any
  model whose meshes do not reference every vertex it carries.
*/
function alignMeshesToVertices(model) {
  const vertices = model?.vertices;
  if (!vertices?.length || !model.meshes?.length) return;

  let vertexMinZ = Infinity;
  for (const v of vertices) {
    if (v.z < vertexMinZ) vertexMinZ = v.z;
  }

  let meshMinZ = Infinity;
  for (const mesh of model.meshes) {
    const positions = mesh.positions;
    if (!positions?.length) continue;
    for (let i = 2; i < positions.length; i += 3) {
      if (positions[i] < meshMinZ) meshMinZ = positions[i];
    }
  }
  if (!Number.isFinite(meshMinZ) || !Number.isFinite(vertexMinZ)) return;

  // The decoder's signature is a mesh floor at zero. Anything else is left alone.
  const shift = vertexMinZ - meshMinZ;
  if (Math.abs(meshMinZ) > 1e-3 || Math.abs(shift) < 1e-6) return;

  for (const mesh of model.meshes) {
    const positions = mesh.positions;
    if (!positions?.length) continue;
    for (let i = 2; i < positions.length; i += 3) positions[i] += shift;
  }
}

/*
  A tire's radius, from its own geometry.

  A wheel model is a disc: two of its three spans are the diameter and the third is the tread
  width. Taking half the largest span therefore gives the radius without knowing which axis
  the model was authored on, which matters because the decoder relabels BIN's axes.
*/
function tireRadiusOf(model) {
  const b = boundsOf(model);
  if (!b) return 0;
  return Math.max(b.span.x, b.span.y, b.span.z) / 2;
}

function restHeightOf(wheels) {
  const front = wheels.find((w) => w.key.startsWith("faxle")) ?? wheels[0];
  if (!front?.radius) return 0;
  return Math.abs(front.position?.y ?? 0) + front.radius;
}

function boundsOf(model) {
  if (!model?.vertices?.length) return null;
  let min = { x: Infinity, y: Infinity, z: Infinity };
  let max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const v of model.vertices) {
    if (v.x < min.x) min.x = v.x;
    if (v.y < min.y) min.y = v.y;
    if (v.z < min.z) min.z = v.z;
    if (v.x > max.x) max.x = v.x;
    if (v.y > max.y) max.y = v.y;
    if (v.z > max.z) max.z = v.z;
  }
  return {
    min,
    max,
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    span: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
  };
}

/*
  Textures, by the same rules the track path uses.

  A true-colour sibling (Community Patch 3 art) wins outright; otherwise the 8-bit .RAW is
  decoded against whatever palette the resolver's chain settles on. Reusing
  createPaletteResolver matters for trucks specifically: their art is authored against
  METALCR2, which lives in STARTUP.POD and is therefore absent from a truck pod, and the
  resolver is what supplies the bundled copy.
*/
async function loadTextures(podIndex, getBytes, models, manifest, hasChassisHardware, warnings) {
  const names = new Set();
  for (const model of models) {
    for (const name of model.textureNames ?? []) {
      if (name) names.add(name);
    }
  }
  if (hasChassisHardware) {
    for (const extra of [manifest.shockTextureName, manifest.barTextureName]) {
      if (extra) names.add(normalizeArchiveName(extra));
    }
  }

  const palettes = createPaletteResolver(podIndex, getBytes, "MTM2", null);
  const textures = [];

  for (const name of names) {
    try {
      const hd = findHdSibling(podIndex, name);
      if (hd) {
        const decoded = await decodeTrueColorTexture(getBytes(hd.entry), hd.entry.title, hd.extension === ".TGA" ? "TGA" : "PNG");
        decoded.name = name;
        textures.push(decoded);
        continue;
      }
      const rawEntry = findArtSibling(podIndex, name, ".RAW");
      if (!rawEntry) {
        warnings.push(`Texture ${name} was referenced but not found in ART.`);
        continue;
      }
      const bytes = getBytes(rawEntry);
      if (!podRawSide(bytes.length)) {
        warnings.push(`Texture ${name} is ${bytes.length} bytes, which is not a legal tile size.`);
        continue;
      }
      textures.push(decodeRawTexture(bytes, palettes.paletteFor(name, rawEntry, "model"), name));
    } catch (error) {
      warnings.push(`Texture ${name}: ${error?.message ?? error}`);
    }
  }
  return textures;
}

/*
  The axle model, centred on its own bounds and placed at the midpoint of its two wheels.

  The model is authored wherever its artist left it, so centring is what makes one axle model
  serve both ends of the truck.
*/
function buildAxlePlacement(axleModel, key, center) {
  if (!axleModel) return { key, model: null, position: center };
  const b = boundsOf(axleModel);
  const offset = b ? { x: -b.center.x, y: -b.center.y, z: -b.center.z } : { x: 0, y: 0, z: 0 };
  return { key, position: center, model: translateModel(axleModel, offset) };
}

function translateModel(model, t) {
  const moved = {
    ...model,
    vertices: (model.vertices ?? []).map((v) => ({ x: v.x + t.x, y: v.y + t.y, z: v.z + t.z })),
    meshes: (model.meshes ?? []).map((mesh) => {
      if (!mesh.positions?.length) return mesh;
      const out = new Float32Array(mesh.positions.length);
      for (let i = 0; i < mesh.positions.length; i += 3) {
        out[i] = mesh.positions[i] + t.x;
        out[i + 1] = mesh.positions[i + 1] + t.y;
        out[i + 2] = mesh.positions[i + 2] + t.z;
      }
      return { ...mesh, positions: out };
    }),
  };
  return moved;
}

/*
  Shocks: an inner and an outer cylinder at each corner, from the body down to the axle.

  Each endpoint is tagged "body" or "axle" so the renderer can let them stretch as the
  suspension moves, which is the whole reason they are descriptors rather than baked geometry.
*/
function buildShockDescriptors(frontCenter, rearCenter) {
  const pair = (prefix, center, side) => {
    const x = center.x + side * SHOCK_OFFSET_X;
    return [-1, 1].map((zSide) => ({
      key: `${prefix}_${zSide < 0 ? "inner" : "outer"}`,
      base: { x, y: 0, z: center.z + zSide * SHOCK_PAIR_Z_OFFSET },
      top: { x, y: center.y + SHOCK_OFFSET_Y, z: center.z + zSide * SHOCK_PAIR_Z_OFFSET },
      baseAttachment: "body",
      topAttachment: "axle",
    }));
  };
  return [
    ...pair("shock_fl", frontCenter, -1),
    ...pair("shock_fr", frontCenter, 1),
    ...pair("shock_rl", rearCenter, -1),
    ...pair("shock_rr", rearCenter, 1),
  ];
}

function buildAxleBarDescriptors(frontCenter, rearCenter, barOffset, superiorBarOffset) {
  const sets = [buildAxleBarSet("lower", frontCenter, rearCenter, barOffset, 0)];
  // MTM2.1's second set stores three Y offsets relative to the lower layout, in 1/256 ft.
  if (superiorBarOffset) {
    sets.push(buildAxleBarSet("upper", frontCenter, rearCenter, barOffset, 1, superiorBarOffset));
  }
  return sets.flat();
}

function buildAxleBarSet(prefix, frontCenter, rearCenter, barOffset, _tier, superior = null) {
  const base = barOffset ?? { x: 0, y: 0, z: 0 };
  const middleRight = {
    x: base.x ?? 0,
    y: (base.y ?? 0) + AXLE_BAR_MIDDLE_Y_BIAS + (superior?.middleY ?? 0) * FIXED_POINT,
    z: base.z ?? 0,
  };
  const middleLeft = { x: -middleRight.x, y: middleRight.y, z: middleRight.z };

  const frontRight = {
    x: frontCenter.x + AXLE_BAR_OFFSET_X,
    y: frontCenter.y + AXLE_BAR_OFFSET_Y + (superior?.frontAxleY ?? 0) * FIXED_POINT,
    z: frontCenter.z + AXLE_BAR_OFFSET_Z,
  };
  const frontLeft = { x: frontRight.x - 2 * AXLE_BAR_OFFSET_X, y: frontRight.y, z: frontRight.z };
  const rearRight = {
    x: rearCenter.x + AXLE_BAR_OFFSET_X,
    y: rearCenter.y + AXLE_BAR_OFFSET_Y + (superior?.rearAxleY ?? 0) * FIXED_POINT,
    z: rearCenter.z - AXLE_BAR_OFFSET_Z,
  };
  const rearLeft = { x: rearRight.x - 2 * AXLE_BAR_OFFSET_X, y: rearRight.y, z: rearRight.z };

  return [
    { key: `${prefix}_bar_left_front`, start: middleLeft, end: frontLeft },
    { key: `${prefix}_bar_left_rear`, start: middleLeft, end: rearLeft },
    { key: `${prefix}_bar_right_front`, start: middleRight, end: frontRight },
    { key: `${prefix}_bar_right_rear`, start: middleRight, end: rearRight },
  ].map((seg) => ({ ...seg, startAttachment: "body", endAttachment: "axle" }));
}

function buildDriveshaftDescriptor(frontCenter, rearCenter, driveshaftPos) {
  return {
    key: "driveshaft",
    hub: { x: 0, y: driveshaftPos?.y ?? 0, z: driveshaftPos?.z ?? 0 },
    front: frontCenter,
    rear: rearCenter,
    hubAttachment: "body",
    frontAttachment: "axle",
    rearAttachment: "axle",
  };
}

function suppressesAxleBars(offset) {
  if (!offset) return false;
  return Math.abs(offset.x ?? 0) >= AXLE_BAR_SENTINEL_DISTANCE
    || Math.abs(offset.y ?? 0) >= AXLE_BAR_SENTINEL_DISTANCE
    || Math.abs(offset.z ?? 0) >= AXLE_BAR_SENTINEL_DISTANCE;
}

function suppressesDriveshaft(position) {
  return !!position && !(position.x ?? 0) && !(position.y ?? 0) && !(position.z ?? 0);
}

function midpoint(a, b) {
  return {
    x: ((a?.x ?? 0) + (b?.x ?? 0)) / 2,
    y: ((a?.y ?? 0) + (b?.y ?? 0)) / 2,
    z: ((a?.z ?? 0) + (b?.z ?? 0)) / 2,
  };
}
