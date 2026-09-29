/**
 * The lookup key for an archive path: `\` becomes `/`, surrounding whitespace goes, and the
 * result is upper-cased. The games treat archive paths case-insensitively and mostly write
 * them with backslashes, while callers tend to write forward slashes.
 */
export function normalizePodPath(name) {
    return (name ?? "").replace(/\\/g, "/").trim().toUpperCase();
}
/** The last component of a normalized archive path, e.g. `ART/GRASS.RAW` becomes `GRASS.RAW`. */
export function podPathTitle(name) {
    const normalized = normalizePodPath(name);
    const slash = normalized.lastIndexOf("/");
    return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}
