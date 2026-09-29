/*
  OpenPhotex: reference implementation of Terminal Reality game data formats.

  Environment-neutral: everything here takes bytes and returns plain data, and runs unchanged
  in browsers, Web Workers and Node.js. Reading files is the caller's job.
*/
export { parsePod, podDirectoryEnd } from "./pod/parse.js";
export { findPodEntry, findPodEntryByTitle, findPodEntriesByExtension, readPodEntry } from "./pod/lookup.js";
export { normalizePodPath, podPathTitle } from "./pod/paths.js";
export { buildPod1Directory, writePod1, pod1DirectoryEntries, PodWriteError } from "./pod/write.js";
export { crc32Mpeg2, verifyPodChecksums, readPod2AuditTrail } from "./pod/pod2.js";
export { ACT_PALETTE_SIZE, decodeActPalette, actPaletteDepth } from "./texture/act.js";
export { rawTextureSide, decodeRawTexture, decodeIndexedImage, applyOpacityPlane } from "./texture/raw.js";
export { isTiff, decodeTiff } from "./texture/tiff.js";
export { splitEvoLines, evoLabel, evoNumbers, evoUnquote, evoFieldLine } from "./evo/text.js";
export { parseEvoLvl, parseEvoWat } from "./evo/lvl.js";
export { parseEvoTex } from "./evo/tex.js";
export { parseEvoVeg } from "./evo/veg.js";
export { isEvoSit, evoGameForSitVersion, parseEvoSit, evoTrackTypeName } from "./evo/sit.js";
export { isSmfModel, parseSmf, smfTextureReference } from "./evo/smf.js";
export { truckManifestLines, isEvoTrk, isEvoTrkLines, parseEvoTrk, parseEvoTrkLines, trkSpecValue, EVO_WHEEL_KEYS } from "./evo/trk.js";
export { parseMtmTrkLines, MTM_WHEEL_KEYS } from "./truck/mtm-trk.js";
export { isCprCarLines, parseCprCarLines, CPR_WHEEL_KEYS_IN_FILE_ORDER } from "./truck/cpr-car.js";
export { detectTruckManifest, parseTruckManifest } from "./truck/manifest.js";
export { parseCprCmd, cmdWingPackages, cmdFaceTriangles, CMD_POSITION_SCALE, CMD_NORMAL_SCALE, CMD_UV_SCALE, CMD_FACE_TYPE, } from "./cpr/cmd.js";
export { parseBin, MRGL, MRGLMAT, MRGLMAT2, BIN_GEOMETRY_DIVISOR, BIN_TRANSPARENT_FACE_TYPES, BIN_SOLID_FACE_TYPE, BIN_TEXTURE_NAME_MAX, } from "./model/bin.js";
export { PodFormatError } from "./errors.js";
/** The library version, as published in package.json. */
export const VERSION = "0.1.0";
