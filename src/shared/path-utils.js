import { normalizePodPath, podPathTitle } from "../vendor/openphotex/index.js";

/*
  Archive path keys come from OpenPhotex, which builds every POD entry's normalizedName and
  title with these same rules, so a lookup key can never be spelled differently from the
  entries it is compared against.
*/
export const normalizeArchiveName = normalizePodPath;
export const archiveTitle = podPathTitle;

export function joinPath(...parts) {
  return parts
    .filter(Boolean)
    .map((p) => String(p).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

export function replaceExtension(name, extensionWithDot) {
  const value = normalizeArchiveName(name);
  const dot = value.lastIndexOf(".");
  return dot >= 0 ? value.slice(0, dot) + extensionWithDot.toUpperCase() : value + extensionWithDot.toUpperCase();
}

export function basenameWithoutExtension(name) {
  const title = archiveTitle(name);
  const dot = title.lastIndexOf(".");
  return dot >= 0 ? title.slice(0, dot) : title;
}

export function opfsDisplayPath(relativePath) {
  return `opfs:/${relativePath.replace(/^\/+/, "")}`;
}
