import { parseFlyScf } from "./vendor/openphotex/index.js";

/*
  Open from Folder: the Fly! scenery sets in a folder the user picked.

  A browser hands over every file under the chosen folder, each with its path relative to it
  (webkitRelativePath), and nothing else: it cannot look beside a file it was given. So the
  folder to pick is the one holding the set's .SCF, such as Scenery\SANFRAN, or any folder
  above it, Scenery itself for example, in which case every set under it is offered.

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
