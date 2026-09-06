import { resolveAsset } from "./pod-format.js";
import { replaceExtension, normalizeArchiveName, archiveTitle } from "../shared/path-utils.js";

export function loadRaceTrackLayer(podIndex, getBytes, rawName, doc) {
  const trkName = replaceExtension(rawName, ".TRK");
  const trkEntry = resolveAsset(podIndex, trkName);
  if (!trkEntry) return;

  const lines = toLines(new TextDecoder("latin1").decode(getBytes(trkEntry)));
  const countLabel = indexOfLine(lines, "CRaceTrack.trackCount");
  if (countLabel < 0 || countLabel + 1 >= lines.length) return;

  const ttxEntry = resolveAsset(podIndex, replaceExtension(trkEntry.title ?? trkName, ".TTX")) ?? resolveAsset(podIndex, replaceExtension(trkName, ".TTX"));
  if (ttxEntry) parseRaceTrackTextures(podIndex, getBytes, ttxEntry, doc);
  doc.raceTrackFence = loadCatchFence(podIndex, getBytes);

  const surfaceCount = parseIntValue(lines[countLabel + 1], 0);
  let cursor = indexOfLine(lines, "pointCount", countLabel + 2);
  for (let i = 0; i < surfaceCount && cursor >= 0 && cursor < lines.length; i++) {
    const parsed = parseRaceTrackSurface(lines, cursor);
    if (!parsed) return;
    doc.raceTrackSurfaces.push(parsed.surface);
    cursor = parsed.nextIndex;
  }
}

/*
  The catch fencing on wall types 3 and 5 is not one of the four wallTexture entries.

  CPREDIT.EXE references art\catch3d.raw / art\catch.raw and their palettes by name, and both
  ship in STARTUP.POD rather than in any track POD, so they never appear in a .TTX. That is
  why the TRK has no fence texture to point at: the fence is implied by the wall type.

  Prefer CATCH3D, which is the 256x256 hardware-accelerated version, over the 64x64 software
  one. Returning null is normal and expected when a single track POD is loaded on its own,
  and the worker synthesizes a stand-in in that case.
*/
function loadCatchFence(podIndex, getBytes) {
  for (const name of ["ART/CATCH3D.RAW", "ART/CATCH.RAW"]) {
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

function parseRaceTrackTextures(podIndex, getBytes, ttxEntry, doc) {
  const lines = toLines(new TextDecoder("latin1").decode(getBytes(ttxEntry)));
  const textureCount = parseIntValue(lines[0] ?? "0", 0);
  for (let i = 0; i < textureCount && i + 1 < lines.length; i++) {
    const parts = lines[i + 1].split(",", -1);
    const name = normalizeArchiveName(parts[0] ?? "");
    if (!name) continue;
    const dataEntry = resolveAsset(podIndex, name);
    const actEntry = resolveAsset(podIndex, replaceExtension(name, ".ACT"));
    doc.raceTrackTextures.push({
      name: archiveTitle(name),
      flags: parts.length > 1 ? parseIntValue(parts[1], 0) : 0,
      data: dataEntry ? getBytes(dataEntry) : null,
      actData: actEntry ? getBytes(actEntry) : doc.palette,
    });
  }
}

function parseRaceTrackSurface(lines, cursor) {
  if (cursor + 8 >= lines.length || lines[cursor] !== "pointCount") return null;
  const pointCount = parseIntValue(lines[cursor + 1], -1);
  const segmentCount = readIntAfterLabel(lines, cursor + 2, "segmentCount", -1);
  const curveFlag = readIntAfterLabel(lines, cursor + 4, "curveFlag", 0);
  if (pointCount <= 0 || segmentCount <= 0) return null;

  const surface = {
    curveFlag,
    anchor: parseFloatList(lines[cursor + 7], 3),
    segmentTypes: [],
    points: [],
    textureIndexes: [],
    textureCoordinates: [],
    wallTypes: [],
    wallTextures: [],
    normal: [0, 0, 0],
    pointOffsets: [],
    altitude: 0,
    grade: 0,
    interpolatedGrade: 0,
    width: 0,
    interpolatedWidth: 0,
    heightOffsets: [],
  };

  let index = cursor + 8;
  if (lines[index] !== "type") return null;
  surface.segmentTypes = readIntList(lines, index + 1, segmentCount);
  index += 1 + segmentCount;

  if (lines[index] !== "plist") return null;
  surface.points = readFloatLists(lines, index + 1, pointCount, 3);
  index += 1 + pointCount;

  if (lines[index] !== "!texture") return null;
  for (let i = 0; i < segmentCount; i++) {
    const values = parseIntList(lines[index + 1 + i]);
    surface.textureIndexes.push(values.length ? values[0] : 0);
    surface.textureCoordinates.push(values);
  }
  index += 1 + segmentCount;

  if (lines[index] !== "wallType") return null;
  surface.wallTypes = readIntList(lines, index + 1, pointCount);
  index += 1 + pointCount;

  if (lines[index] !== "wallTexture") return null;
  for (let i = 0; i < pointCount; i++) {
    surface.wallTextures.push(parseIntList(lines[index + 1 + i]));
  }
  index += 1 + pointCount;

  if (lines[index] !== "h") return null;
  surface.normal = parseFloatList(lines[index + 1], 3);
  index += 2;

  if (lines[index] !== "pointOffset") return null;
  surface.pointOffsets = readFloatList(lines, index + 1, pointCount);
  index += 1 + pointCount;

  if (lines[index] !== "!altitude") return null;
  surface.altitude = parseFloatValue(lines[index + 1], 0);
  surface.grade = readFloatAfterLabel(lines, index + 2, "grade", 0);
  surface.interpolatedGrade = readFloatAfterLabel(lines, index + 4, "%interpGrade", 0);
  const widths = parseFloatList(lines[index + 7], 2);
  surface.width = widths[0] ?? 0;
  surface.interpolatedWidth = widths[1] ?? surface.width;
  index += 8;

  if (lines[index] !== "^heightOffset") return null;
  surface.heightOffsets = readFloatList(lines, index + 1, pointCount);
  return { surface, nextIndex: index + 1 + pointCount };
}

function readIntAfterLabel(lines, index, label, fallback) {
  return lines[index] === label ? parseIntValue(lines[index + 1], fallback) : fallback;
}

function readFloatAfterLabel(lines, index, label, fallback) {
  return lines[index] === label ? parseFloatValue(lines[index + 1], fallback) : fallback;
}

function readIntList(lines, start, count) {
  return Array.from({ length: count }, (_, i) => parseIntValue(lines[start + i], 0));
}

function readFloatList(lines, start, count) {
  return Array.from({ length: count }, (_, i) => parseFloatValue(lines[start + i], 0));
}

function readFloatLists(lines, start, count, maxCount) {
  return Array.from({ length: count }, (_, i) => parseFloatList(lines[start + i], maxCount));
}

function parseIntList(value) {
  return (value ?? "").split(",").map((part) => parseIntValue(part, 0));
}

function parseFloatList(value, maxCount) {
  return (value ?? "").split(",", maxCount).map((part) => parseFloatValue(part, 0));
}

function parseIntValue(value, fallback) {
  const n = parseInt((value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatValue(value, fallback) {
  const n = parseFloat((value ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function indexOfLine(lines, value, start = 0) {
  for (let i = Math.max(0, start); i < lines.length; i++) {
    if (lines[i] === value) return i;
  }
  return -1;
}

function toLines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
}
