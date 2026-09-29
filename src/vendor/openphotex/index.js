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
export { parseBin, MRGL, MRGLMAT, MRGLMAT2, BIN_GEOMETRY_DIVISOR, BIN_TRANSPARENT_FACE_TYPES, BIN_SOLID_FACE_TYPE, BIN_TEXTURE_NAME_MAX, BIN_MAPPED_FACETS, BIN_UNMAPPED_FACETS, } from "./model/bin.js";
export { writeBin, binFaceNormal, binPlaneTerm } from "./model/bin-write.js";
export { TV_UNITS_PER_CELL, TV_UNITS_PER_HEIGHT_STEP, tvPlacementToEditor, tvHeightToAltitude, parseIntTriple, toDataLines, hbPlacementToEditor, placementToEditor, } from "./tv/coords.js";
export { TV_POWERUPS, tvPowerup, TV_LOGIC_NAMES, TV_WEAPON_NAMES, tvLogicName, tvWeaponName } from "./tv/tables.js";
export { NAV_TARGET_LIST, NAV_TUNNEL_ENTRANCE, NAV_CHECKPOINT, NAV_JUMP_ZONE, NAV_TUNNEL_EXIT, NAV_BOSS, NAV_START_POINT, NAV_TYPE_NAMES, parseNavPoints, findStartPoint, } from "./tv/nav.js";
export { HBNAV_TARGET_LIST, HBNAV_TUNNEL_ENTRANCE, HBNAV_CHECKPOINT, HBNAV_JUMP_ZONE, HBNAV_TUNNEL_EXIT, HBNAV_BOSS, HBNAV_START_POINT, HBNAV_SYNC_POINT, HBNAV_RESCUE_BEACON, HBNAV_END_OF_NAVS, HBNAV_ESCORT, HBNAV_RETRIEVE, HBNAV_PURSUE, HBNAV_TYPE_NAMES, parseHbNavPoints, } from "./tv/hb-nav.js";
export { parsePowerups } from "./tv/pup.js";
export { TUNNEL_LOGIC_NAMES, parseTunnelDefs } from "./tv/tdf.js";
export { ANIMATION_BASE_FPS, parseAnimations } from "./tv/ani.js";
export { parseHbBriefing } from "./tv/hb-briefing.js";
export { CPR_HEIGHT_DIVISOR, CPR_ALTITUDE_DIVISOR, CPR_HEIGHT_UNIT_SCALE, LEGACY_ALTITUDE_DIVISOR, decodeHeightSample, legacyWholeHeight16, heightAtCell, } from "./terrain/height.js";
export { parseMtmSit, parseMtmLvl, parseTexList, parseTty, detectSitOrigin, sitTrackTypeName, sitWorldTriplet, } from "./mtm/sit.js";
export { parseTvLvl, detectTvLvlOrigin, isNullAssetName, tvLvlFallbackName } from "./tv/lvl.js";
export { parseDef, defPlacementToEditor, TR_ANGLE_TO_RAD } from "./tv/def.js";
export { SKY_PALETTE_FIRST_SLOT, SKY_ACT_FIRST_COLOUR, SKY_GRADIENT_COLOURS, skyGradient, skyHorizon } from "./texture/sky.js";
export { decodeClrWord, decodeGroundBoxes } from "./terrain/ground-boxes.js";
export { HB_UNDERGROUND_BIAS, decodeHbUnderground } from "./terrain/hb-underground.js";
export { CPR_POINT_NAMES, CPR_SLOT_OFF_TRACK, CPR_SLOT_CURB, CPR_SLOT_ROAD, CPR_SLOT_NAMES, CPR_CROSS_SECTION_MIDPOINT, CPR_SURFACE_TYPES, CPR_WALL_TYPE_NAMES, CPR_TEXTURE_INDEX_MASK, CPR_TEXTURE_SLICE_COUNT, cprTextureIndex, cprTextureSlice, cprTextureU, CPR_WALL_LAYERS, CPR_CATCH_FENCE_NAMES, parseCprTrk, parseCprTtx, isDegenerateSlot, cprTrackIsClosed, cprSegmentPairs, cprVisibleSlots, CPR_COURSE_PURPOSES, CPR_CHECKPOINT_ROLES, cprCheckpointRole, isCprPitCheckpoint, } from "./cpr/track.js";
export { BUNDLED_PALETTE_IDS, bundledPalette } from "./texture/bundled-palettes.js";
export { BUNDLED_PALETTE_BY_ORIGIN, TEXTURE_SIBLING_DIRS, findTextureSibling, paletteCandidates, textureStem, } from "./texture/palette-rank.js";
export { EVO_CELL_SIZE, EVO_HEIGHT_DIVISOR, EVO_WATER_HEIGHT_DIVISOR, EVO_GRID_SIZE, EVO_WORLD_SIZE, evoHeightAtCell, evoHeightAt, } from "./evo/coords.js";
export { parseEvoAiLine, matchEvoAiLineName, lapRuns } from "./evo/ai-line.js";
export { sampleForPalette, medianCutPalette, colourCube, encodeRawTexture } from "./texture/encode.js";
export { MTM2_PALETTE_WHITE_INDEX, MTM2_PALETTE_FIRST_AUTHORED, MTM2_PALETTE_AUTHORED_COUNT, mtm2LevelPalette, buildFogMap, } from "./mtm/level-palette.js";
export { writeMtm2Sit, writeMtm2Lvl, writeTexList, writeEmptyList, emptyGroundBoxGrids, buildMtm2Lte, writeMtm2Trk, } from "./mtm/write.js";
export { PodFormatError } from "./errors.js";
/** The library version, as published in package.json. */
export const VERSION = "0.1.0";
