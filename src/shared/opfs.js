import { joinPath } from "./path-utils.js";

export async function getOpfsRoot() {
  if (!navigator?.storage?.getDirectory) {
    throw new Error("Origin Private File System is unavailable. Open this viewer over localhost or HTTPS.");
  }
  return navigator.storage.getDirectory();
}

export async function ensureDirectory(relativePath) {
  const root = await getOpfsRoot();
  let current = root;
  for (const part of splitPath(relativePath)) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  return current;
}

export async function getFileHandle(relativePath, create = false) {
  const root = await getOpfsRoot();
  const parts = splitPath(relativePath);
  if (parts.length === 0) throw new Error("File path cannot be empty.");
  const fileName = parts.pop();
  let current = root;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create });
  }
  return current.getFileHandle(fileName, { create });
}

export async function writeStreamToFile(relativePath, readable) {
  const handle = await getFileHandle(relativePath, true);
  const writable = await handle.createWritable();
  await readable.pipeTo(writable);
}

export async function writeBytesToFile(relativePath, bytes) {
  const handle = await getFileHandle(relativePath, true);
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

export async function readFile(relativePath) {
  const handle = await getFileHandle(relativePath, false);
  return handle.getFile();
}

export async function readTextFile(relativePath) {
  const file = await readFile(relativePath);
  return file.text();
}

export async function removePath(relativePath) {
  const parts = splitPath(relativePath);
  if (parts.length === 0) return;
  const root = await getOpfsRoot();
  if (parts.length === 1) {
    try { await root.removeEntry(parts[0], { recursive: true }); } catch { /**/ }
    return;
  }
  const entryName = parts.pop();
  let current = root;
  for (const part of parts) {
    try { current = await current.getDirectoryHandle(part, { create: false }); }
    catch { return; }
  }
  try { await current.removeEntry(entryName, { recursive: true }); } catch { /**/ }
}

export async function resetSessionFolder(sessionId) {
  await removePath(joinPath("sessions", sessionId));
  await ensureDirectory(joinPath("sessions", sessionId, "source"));
}

function splitPath(value) {
  return String(value ?? "").split("/").map((p) => p.trim()).filter(Boolean);
}
