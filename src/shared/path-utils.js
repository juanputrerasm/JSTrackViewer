export function normalizeArchiveName(name) {
  return (name ?? "").replace(/\\/g, "/").trim().toUpperCase();
}

export function archiveTitle(name) {
  const normalized = normalizeArchiveName(name);
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

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
