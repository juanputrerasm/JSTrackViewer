import { tvPlacementToEditor, parseIntTriple, toDataLines } from "./tv-coords.js";

/*
  .NAV navigation points (Terminal Velocity / Fury3 / F!Zone).

  Referenced from LVL header line 13. Plain ASCII, CRLF, count-prefixed:

    <entryCount>
      <type>
      <x>,<y>,<z>
      <description>
      <type-specific payload>

  The seven types are the F!Zone editor's own menu, in menu order, and all seven occur in
  shipped content. Verified by parsing all 69 .NAV files in FURY3.POD, FURYSE.POD and TV.pod:
  683 entries, every file consumed to EOF, no failures. Enemy indices resolve into the .DEF
  placement list in every case, and every tunnel filename names a real POD entry.

  The `;place1` style lines in the tunnel and boss payloads are literal editor placeholders,
  not data, so they are read past and dropped.
*/

export const NAV_TARGET_LIST = 0;
export const NAV_TUNNEL_ENTRANCE = 1;
export const NAV_CHECKPOINT = 2;
export const NAV_JUMP_ZONE = 3;
export const NAV_TUNNEL_EXIT = 4;
export const NAV_BOSS = 5;
export const NAV_START_POINT = 6;

export const NAV_TYPE_NAMES = {
  [NAV_TARGET_LIST]: "Target list",
  [NAV_TUNNEL_ENTRANCE]: "Tunnel entrance",
  [NAV_CHECKPOINT]: "Checkpoint",
  [NAV_JUMP_ZONE]: "Jump zone",
  [NAV_TUNNEL_EXIT]: "Tunnel exit",
  [NAV_BOSS]: "Boss",
  [NAV_START_POINT]: "Start point",
};

/** The editor writes this into every entry it creates; it carries no information. */
const PLACEHOLDER_DESCRIPTION = "put descr here";

/**
 * Parses a .NAV file into ordered navigation points.
 *
 * Returns [] rather than throwing on malformed input: a viewer that loses its marker layer
 * should still show the track.
 */
export function parseNavPoints(bytes, gridSize) {
  if (!bytes || !bytes.length) return [];
  const lines = toDataLines(bytes);
  let i = 0;
  while (i < lines.length && lines[i] === "") i++;
  const count = parseInt(lines[i], 10);
  if (!Number.isFinite(count) || count < 0 || count > 4096) return [];
  i++;

  const points = [];
  try {
    for (let n = 0; n < count; n++) {
      const type = parseInt(lines[i], 10);
      if (!Number.isFinite(type)) break;
      i++;
      const raw = parseIntTriple(lines[i]);
      if (!raw) break;
      i++;
      const description = lines[i] ?? "";
      i++;

      const point = {
        index: n,
        type,
        typeName: NAV_TYPE_NAMES[type] ?? `Type ${type}`,
        position: tvPlacementToEditor(raw[0], raw[1], raw[2], gridSize),
        description: description.toLowerCase() === PLACEHOLDER_DESCRIPTION ? "" : description,
        targets: [],
        secondaryTargets: [],
        tunnelLevel: null,
        bossEnemy: -1,
        musicName: null,
        heading: 0,
      };

      if (type === NAV_TARGET_LIST) {
        const t = parseInt(lines[i], 10) || 0;
        i++;
        for (let k = 0; k < t; k++, i++) point.targets.push(parseInt(lines[i], 10) || 0);
      } else if (type === NAV_TUNNEL_ENTRANCE) {
        point.tunnelLevel = (lines[i] ?? "").toUpperCase();
        i += 2;                       // filename, then one placeholder line
      } else if (type === NAV_TUNNEL_EXIT) {
        i += 2;                       // two placeholder lines
      } else if (type === NAV_BOSS) {
        point.bossEnemy = parseInt(lines[i], 10) || 0;
        i++;
        point.musicName = (lines[i] ?? "").toUpperCase();
        i += 3;                       // music, placeholder, "!NewH" marker
        const s = parseInt(lines[i], 10) || 0;
        i++;
        for (let k = 0; k < s; k++, i++) point.secondaryTargets.push(parseInt(lines[i], 10) || 0);
      } else if (type === NAV_START_POINT) {
        // Pitch and bank are stored but unused by the game; only the heading is real.
        const pbh = parseIntTriple(lines[i]);
        i++;
        if (pbh) point.heading = pbh[2];
      }
      points.push(point);
    }
  } catch {
    return points;
  }
  return points;
}

/**
 * The level's start point, or null. Multiplayer maps carry several, in which case the first
 * is the one to open on.
 */
export function findStartPoint(navPoints) {
  return navPoints?.find((p) => p.type === NAV_START_POINT) ?? null;
}
