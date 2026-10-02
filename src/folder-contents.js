import { parseFlyScf } from "./vendor/openphotex/index.js";

/*
  Open from Folder: what a picked folder holds that the viewer can open.

  A browser hands over every file under the chosen folder, each with its path relative to it
  (webkitRelativePath), and nothing else: it cannot look beside a file it was given. Two kinds
  of thing are found in it, at any depth:

    - Fly! scenery sets, each an .SCF with the archives it lists (flySetsFromFolder)
    - every other archive, each POD and any EPD no set claims (looseArchives)

  So picking an MTM2 install offers every track of every POD in it, picking Fly!'s Scenery
  folder offers its five cities, and picking a folder above both offers all of them.

  A set is its .SCF and the archives it lists, looked up beside it ignoring case, as the game
  on Windows would. An archive the .SCF names but the folder lacks is reported, not fatal:
  the set still shows whatever terrain the others carry.
*/

/**
 * @param {File[]} files  everything under the picked folder
 * @returns {Promise<{ folder: string, sets: { name: string, scfName: string, directory: string,
 *   coverage: object|null, archives: File[], missing: string[] }[] }>}
 */
export async function flySetsFromFolder(files) {
  const pathOf = (file) => file.webkitRelativePath || file.name;
  const directoryOf = (path) => path.slice(0, path.lastIndexOf("/") + 1);
  const folder = pathOf(files[0] ?? { name: "" }).split("/")[0];

  const byDirectory = new Map();
  for (const file of files) {
    const dir = directoryOf(pathOf(file));
    if (!byDirectory.has(dir)) byDirectory.set(dir, new Map());
    byDirectory.get(dir).set(file.name.toLowerCase(), file);
  }

  const sets = [];
  for (const file of files) {
    if (!/\.scf$/i.test(file.name)) continue;
    const scf = parseFlyScf(new Uint8Array(await file.arrayBuffer()), file.name);
    const siblings = byDirectory.get(directoryOf(pathOf(file)));
    const archives = [];
    const missing = [];
    for (const name of scf.files) {
      const archive = siblings.get(name.toLowerCase());
      if (archive) archives.push(archive);
      else missing.push(name);
    }
    sets.push({
      name: scf.name || file.name.replace(/\.scf$/i, ""),
      scfName: file.name,
      directory: directoryOf(pathOf(file)).replace(/\/$/, ""),
      coverage: scf.coverage,
      archives,
      missing,
    });
  }
  sets.sort((a, b) => a.name.localeCompare(b.name));
  return { folder, sets };
}

/**
 * The archives in a picked folder that are not part of a Fly! scenery set: every .POD, and
 * any .EPD no set lists (a lone scenery tile; a sectional chart is offered and then reports
 * what it is). In path order.
 *
 * @param {File[]} files  everything under the picked folder
 * @param {{ archives: File[] }[]} sets  from flySetsFromFolder
 * @returns {File[]}
 */
export function looseArchives(files, sets) {
  const claimed = new Set(sets.flatMap((set) => set.archives));
  const pathOf = (file) => file.webkitRelativePath || file.name;
  return files
    .filter((file) => /\.(pod|epd)$/i.test(file.name) && !claimed.has(file))
    .sort((a, b) => pathOf(a).localeCompare(pathOf(b)));
}
