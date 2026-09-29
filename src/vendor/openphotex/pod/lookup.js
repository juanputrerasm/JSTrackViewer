import { PodFormatError } from "../errors.js";
import { normalizePodPath, podPathTitle } from "./paths.js";
/**
 * The entry at `path`, compared case-insensitively and with `/` and `\` treated alike.
 * `null` when the archive has no such path.
 */
export function findPodEntry(archive, path) {
    const key = normalizePodPath(path);
    return archive.entries.find((entry) => entry.normalizedName === key) ?? null;
}
/**
 * The first entry, in directory order, whose file name (last path component) matches the
 * last component of `name`, ignoring case. Useful where the games refer to assets by bare name.
 */
export function findPodEntryByTitle(archive, name) {
    const title = podPathTitle(name);
    return archive.entries.find((entry) => entry.title === title) ?? null;
}
/**
 * Every entry whose file name ends with `suffix`, ignoring case, in directory order.
 * Pass the dot (".RAW") to match an extension exactly.
 */
export function findPodEntriesByExtension(archive, suffix) {
    const upper = suffix.toUpperCase();
    return archive.entries.filter((entry) => entry.title.endsWith(upper));
}
/**
 * A copy of an entry's payload.
 *
 * Always a new buffer, never a view into `bytes`, so the result can be transferred to another
 * worker or mutated without touching the archive. Pass `{ offset, length }` with a smaller
 * length to read just the start of an entry.
 *
 * @throws PodFormatError (ENTRY_OUT_OF_BOUNDS) if the range does not lie inside `bytes`.
 */
export function readPodEntry(input, entry) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const { offset, length } = entry;
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
        throw new PodFormatError("ENTRY_OUT_OF_BOUNDS", `Entry range ${offset}+${length} lies outside the ${bytes.length}-byte archive.`);
    }
    return bytes.slice(offset, offset + length);
}
