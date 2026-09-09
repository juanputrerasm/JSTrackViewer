import { hbPlacementToEditor, parseIntTriple, toDataLines } from "./tv-coords.js";

/*
  .NAV navigation points (Hellbender).

  Referenced from LVL header line 13, the same slot Terminal Velocity and Fury3 use, but the
  record is not theirs. Hellbender interleaves four named sections the TV form has no place
  for - a priority/time pair, a completion sound and its briefing line, a proximity sound -
  and terminates every entry with a rule of dashes:

    <entryCount>
      <type>
      <x>,<y>,<z>
      !priority,time
      <priority>,<time>
      @Completion sound & completion text (39 chars max)
      <completion .wav, or null>
      null: line ignored
      ; Proximity Sound file
      <proximity .wav, or null>
      <objective text>
      <type-specific payload>
      -------------------------------------------------

  Parsing that with the TV reader yields one bogus point and stops, which is why the viewer
  used to leave Hellbender's .NAV unread. The grammar above is verified against all 26 .NAV
  files shipped in Hellbender's GAME.POD: 441 entries, every file consumed exactly to EOF
  with nothing left over, and every placement index in a target list, boss, escort or
  retrieve payload resolving into that level's .DEF placement list - 786 indices, no misses.

  Coordinates are the .DEF's 16.16 fixed point world units, not the TV scale; see
  tv-coords.js for the measurement that settles it.
*/

export const HBNAV_TARGET_LIST      = 0;
export const HBNAV_TUNNEL_ENTRANCE  = 1;
export const HBNAV_CHECKPOINT       = 2;
export const HBNAV_JUMP_ZONE        = 3;
export const HBNAV_TUNNEL_EXIT      = 4;
export const HBNAV_BOSS             = 5;
export const HBNAV_START_POINT      = 6;
export const HBNAV_SYNC_POINT       = 7;
export const HBNAV_RESCUE_BEACON    = 8;
export const HBNAV_END_OF_NAVS      = 9;
export const HBNAV_ESCORT           = 12;
export const HBNAV_RETRIEVE         = 13;
export const HBNAV_PURSUE           = 14;

/*
  Type names.

  Types 0 to 6 are the TV/F3 seven in the same order and with the same payloads, so they keep
  those names. The six above them are Hellbender's own and no editor for this game survives
  to name them, so each is named from what the shipped levels do with it and nothing more is
  claimed:

    7   position is always (0, level height, 0) and the text is always "Sync Point" or
        "Sync point: auto added". 69 entries, no payload. It separates the objectives that
        can be done in any order from the ones that come after them.
    8   two entries, both "Locate the prison and drop a Rescue Beacon".
    9   the last entry of all 26 files, text "End of Navs", no payload. A terminator.
    12  three entries, all "Escort ... to the Jump Zone". One placement index.
    13  one entry, "Retrieve the Message Pod". One placement index.
    14  one entry, "It's Nyx again! ... take him down". One placement index, and the only
        one of the three that carries a real map position.
*/
export const HBNAV_TYPE_NAMES = {
  [HBNAV_TARGET_LIST]:     "Target list",
  [HBNAV_TUNNEL_ENTRANCE]: "Tunnel entrance",
  [HBNAV_CHECKPOINT]:      "Checkpoint",
  [HBNAV_JUMP_ZONE]:       "Jump zone",
  [HBNAV_TUNNEL_EXIT]:     "Tunnel exit",
  [HBNAV_BOSS]:            "Boss",
  [HBNAV_START_POINT]:     "Start point",
  [HBNAV_SYNC_POINT]:      "Sync point",
  [HBNAV_RESCUE_BEACON]:   "Rescue beacon",
  [HBNAV_END_OF_NAVS]:     "End of navs",
  [HBNAV_ESCORT]:          "Escort",
  [HBNAV_RETRIEVE]:        "Retrieve",
  [HBNAV_PURSUE]:          "Pursue",
};

/** The literal label lines, kept out of the objective text. */
const LABEL_PRIORITY  = "!priority,time";
const LABEL_COMPLETION = "@completion sound";
const LABEL_IGNORED   = "null: line ignored";
const LABEL_PROXIMITY = "; proximity sound";
const ENTRY_TERMINATOR = "---";

/*
  The three types whose stored position is not a map position.

  An escort or retrieve objective follows an object that moves, so the file has no fixed
  place to name and the editor left the field at whatever it held: IOWAH2 stores
  x = -2105071345 and z = 2, which is not a point on any 128-cell map. The placement index in
  the payload is the real answer, and the loader resolves the marker onto that object instead.

  Type 14 is listed here as an escort-style objective but ROID4's single entry does carry a
  usable position, so its own coordinates are kept when they are in range.
*/
const FOLLOWS_AN_OBJECT = new Set([HBNAV_ESCORT, HBNAV_RETRIEVE, HBNAV_PURSUE]);

/** "null" in these files means the field is empty, not that it names a file called null. */
function optionalName(line) {
  const value = (line ?? "").trim();
  return !value || value.toLowerCase() === "null" ? null : value.toUpperCase();
}

/**
 * Parses a Hellbender .NAV into ordered navigation points.
 *
 * Returns whatever it read rather than throwing, so a malformed side file costs its own
 * marker layer and nothing else - the same contract as the TV reader.
 */
export function parseHbNavPoints(bytes, gridSize) {
  if (!bytes || !bytes.length) return [];
  const lines = toDataLines(bytes);
  let i = 0;
  while (i < lines.length && lines[i] === "") i++;
  const count = parseInt(lines[i], 10);
  if (!Number.isFinite(count) || count < 0 || count > 4096) return [];
  i++;

  const points = [];
  for (let n = 0; n < count; n++) {
    const type = parseInt(lines[i], 10);
    if (!Number.isFinite(type)) break;
    i++;
    const raw = parseIntTriple(lines[i]);
    if (!raw) break;
    i++;

    // The four label lines are fixed, so a file that does not have them is not this format
    // and is abandoned rather than read as if the labels were data.
    if ((lines[i] ?? "").toLowerCase() !== LABEL_PRIORITY) break;
    i++;
    const [priority, time] = (lines[i] ?? "").split(",").map((v) => parseInt(v, 10) || 0);
    i++;
    if (!(lines[i] ?? "").toLowerCase().startsWith(LABEL_COMPLETION)) break;
    i++;
    const completionSound = optionalName(lines[i]);
    i++;
    if ((lines[i] ?? "").toLowerCase() !== LABEL_IGNORED) break;
    i++;
    if (!(lines[i] ?? "").toLowerCase().startsWith(LABEL_PROXIMITY)) break;
    i++;
    const proximitySound = optionalName(lines[i]);
    i++;
    const description = lines[i] ?? "";
    i++;

    // Everything between the objective text and the rule of dashes is the payload. Reading it
    // as a run rather than by a per-type line count means an unrecognised type costs its
    // payload and nothing else: the walk still resynchronizes on the terminator.
    const payload = [];
    while (i < lines.length && !lines[i].startsWith(ENTRY_TERMINATOR)) payload.push(lines[i++]);
    if (i >= lines.length) break;
    i++;

    const point = {
      index: n,
      type,
      typeName: HBNAV_TYPE_NAMES[type] ?? `Type ${type}`,
      position: hbPlacementToEditor(raw[0], raw[1], raw[2], gridSize),
      // Hellbender authors its underground sections below zero, and the viewer draws only the
      // surface heightfield, so a marker down there must not be snapped up onto it.
      underground: raw[1] < 0,
      description,
      priority,
      time,
      completionSound,
      proximitySound,
      targets: [],
      secondaryTargets: [],
      followsPlacement: -1,
      bossEnemy: -1,
      musicName: null,
      heading: 0,
      positionIsPlaceholder: false,
    };

    if (type === HBNAV_TARGET_LIST) {
      const listed = parseInt(payload[0], 10) || 0;
      for (let k = 0; k < listed; k++) point.targets.push(parseInt(payload[k + 1], 10) || 0);
    } else if (type === HBNAV_BOSS) {
      point.bossEnemy = parseInt(payload[0], 10) || 0;
      point.musicName = optionalName(payload[1]);
      // payload[2] is the editor's ";place4" placeholder and payload[3] the "!NewH" marker.
      const listed = parseInt(payload[4], 10) || 0;
      for (let k = 0; k < listed; k++) point.secondaryTargets.push(parseInt(payload[k + 5], 10) || 0);
    } else if (type === HBNAV_START_POINT) {
      // Pitch and bank are stored but unused by the game; only the heading is real.
      const pbh = parseIntTriple(payload[0]);
      if (pbh) point.heading = pbh[2];
    } else if (FOLLOWS_AN_OBJECT.has(type)) {
      point.followsPlacement = parseInt(payload[0], 10);
      if (!Number.isFinite(point.followsPlacement)) point.followsPlacement = -1;
      // Out-of-range coordinates are the editor's uninitialised field, not a position.
      point.positionIsPlaceholder = Math.abs(raw[0]) > 0x40000000 || Math.abs(raw[2]) > 0x40000000;
    }

    points.push(point);
  }
  return points;
}
