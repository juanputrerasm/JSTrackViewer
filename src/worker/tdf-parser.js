import { placementToEditor, parseIntTriple, toDataLines } from "./tv-coords.js";

/*
  .TDF tunnel definitions (Terminal Velocity / Fury3 / F!Zone).

  Referenced from LVL header line 9. This is the table the F!Zone Tunnel Editor writes, and it
  is the complete list of a level's tunnels. Plain ASCII, CRLF, count-prefixed, ten lines per
  tunnel:

    <tunnelCount>
      <tunnel .LVL filename>
      <entranceX>,<entranceY>,<entranceZ>
      <exitX>,<exitY>,<exitZ>
      <entrance logic 0..3>
      <entrance ground texture>
      <entrance texture>
      <exit logic 0..3>
      <exit ground texture>
      <exit texture>
      <exits into chamber, 0 or 1>

  Verified against all 214 .TDF files in FURY3.POD, FURYSE.POD and TV.pod: 183 tunnels, every
  logic value inside 0..3, every chamber flag 0 or 1, and 208 of 214 files consumed exactly to
  EOF. The six exceptions are TV's MULTI1..MULTI6 multiplayer maps, which carry extra trailing
  zeros; their tunnel records still parse, so the trailing content is ignored rather than
  treated as an error.

  Hellbender writes the same record, at the same header line, on its own placement scale
  (see tv-coords.js), so the caller's origin picks the conversion. It declares one tunnel in
  each of JURASIC and JURASIC3 and none anywhere else, and three of its .TDF files are empty.

  This is a better source than .NAV for tunnel markers. The manual notes that a tunnel left
  out of the NAV list is a hidden bonus tunnel, and the counts bear that out: 183 tunnels here
  against only 78 tunnel-entrance NAV points.
*/

export const TUNNEL_LOGIC_NAMES = [
  "Hidden (ground texture)",
  "Remain open",
  "Open, closed for boss",
  "Closes on entry",
];

/**
 * Parses a .TDF file into tunnel records.
 *
 * Returns [] rather than throwing on malformed input.
 */
export function parseTunnelDefs(bytes, gridSize, origin) {
  if (!bytes || !bytes.length) return [];
  const lines = toDataLines(bytes);
  let i = 0;
  while (i < lines.length && lines[i] === "") i++;
  const count = parseInt(lines[i], 10);
  if (!Number.isFinite(count) || count < 0 || count > 1024) return [];
  i++;

  const tunnels = [];
  for (let n = 0; n < count; n++) {
    const levelName = (lines[i] ?? "").toUpperCase();
    if (!levelName.endsWith(".LVL")) break;
    const entrance = parseIntTriple(lines[i + 1]);
    const exit = parseIntTriple(lines[i + 2]);
    if (!entrance || !exit) break;

    const entranceLogic = parseInt(lines[i + 3], 10) || 0;
    const entranceGroundTexture = (lines[i + 4] ?? "").toUpperCase();
    const entranceTexture = (lines[i + 5] ?? "").toUpperCase();
    const exitLogic = parseInt(lines[i + 6], 10) || 0;
    const exitGroundTexture = (lines[i + 7] ?? "").toUpperCase();
    const exitTexture = (lines[i + 8] ?? "").toUpperCase();
    const exitsIntoChamber = (parseInt(lines[i + 9], 10) || 0) !== 0;
    i += 10;

    tunnels.push({
      index: n,
      levelName,
      entrancePosition: placementToEditor(entrance[0], entrance[1], entrance[2], gridSize, origin),
      exitPosition: placementToEditor(exit[0], exit[1], exit[2], gridSize, origin),
      entranceLogic,
      exitLogic,
      entranceLogicName: TUNNEL_LOGIC_NAMES[entranceLogic] ?? `Logic ${entranceLogic}`,
      exitLogicName: TUNNEL_LOGIC_NAMES[exitLogic] ?? `Logic ${exitLogic}`,
      entranceTexture,
      exitTexture,
      entranceGroundTexture,
      exitGroundTexture,
      exitsIntoChamber,
    });
  }
  return tunnels;
}
