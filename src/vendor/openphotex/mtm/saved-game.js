/*
  Monster Truck Madness 2's saved game (`*.mtm`, "Saved Game Files"): a race in progress, written by `CRace` in
  RACE.CPP (0x41ae80 / 0x41aea2) and read back by 0x41a557, then resumed (0x418c20). Text, one value per line:

    MonsterTruckMadness 2.00          the version line; another is refused ("Invalid saved game version string")
    <player's truck>                  a truck catalogue name (the TRK's file name), matched ignoring case
    <race>                            the race's index in the game's track catalogue (CRace + 0xa548)
    <laps>                            the race's laps (+0xa54c; a Summit Rumble's minutes)
    <trucks>                          how many trucks race (+0xa0f8), then for each:
      <truck>                           its catalogue name
      <tire cut>, <suspension>, <transfer>   its Garage setup, one per line (0x4c11e0, 0x4c1210, 0x4c1300)
    <weather>                         the weather (0x657878)
    <a SIT>                           the whole situation as the "Save situation" writer prints it (0x553230):
                                      the level's header with the race clock, every truck's record with its motion,
                                      damage and race progress, then the level's objects, course, stadium, backdrop

  The game reads the head with fgets and fscanf and hands the rest of the file to its SIT loader (0x551f90). Pure
  text, windows-1252, lines CR LF as the game writes them on Windows. Format only: what a port does with the race is
  its own.
*/
import { encodeWindows1252 } from "../text.js";
export const MTM2_SAVED_GAME_HEADER = "MonsterTruckMadness 2.00";
const decoder = new TextDecoder("latin1");
/** A saved game's text as bytes, CR LF line ends; `sit` is appended as given (its own line ends made CR LF). */
export function writeMtm2SavedGame(game) {
    const int = (v) => String(Math.trunc(Number(v) || 0));
    const head = [MTM2_SAVED_GAME_HEADER, game.playerTruck, int(game.raceIndex), int(game.laps), int(game.trucks.length)];
    for (const t of game.trucks)
        head.push(t.file, int(t.tireCut), int(t.suspension), int(t.transfer));
    head.push(int(game.weather));
    const sit = game.sit.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const textOut = `${head.join("\n")}\n${sit.endsWith("\n") ? sit : `${sit}\n`}`.replace(/\n/g, "\r\n");
    const bytes = encodeWindows1252(textOut);
    if (typeof bytes === "number")
        throw new RangeError(`"${textOut[bytes]}" cannot be written in a saved game.`);
    return bytes;
}
/** Read a saved game. Throws on a file whose first line is not the version line, as the game refuses it. */
export function parseMtm2SavedGame(input) {
    const lines = (typeof input === "string" ? input : decoder.decode(input)).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (lines[0]?.trim() !== MTM2_SAVED_GAME_HEADER)
        throw new Error(`Invalid saved game version string (${lines[0] ?? ""})`);
    let at = 1;
    const line = () => (lines[at++] ?? "").trim();
    const int = () => parseInt(line(), 10) || 0;
    const playerTruck = line();
    const raceIndex = int();
    const laps = int();
    const count = Math.max(0, Math.min(64, int()));
    const trucks = [];
    for (let i = 0; i < count; i++)
        trucks.push({ file: line(), tireCut: int(), suspension: int(), transfer: int() });
    const weather = int();
    return { playerTruck, raceIndex, laps, trucks, weather, sit: lines.slice(at).join("\n") };
}
