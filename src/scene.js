import * as THREE from "three";
import { MATERIAL_FLAGS } from "./shared/mrgl-material.js";
import { heightAtCell, LEGACY_ALTITUDE_DIVISOR } from "./shared/terrain-height.js";
import { TrackCamera } from "./nav.js";
import { SunShadows } from "./sun-shadows.js";
import { SunFlare } from "./sun-flare.js";
import { TruckLightRig } from "./drive/truck-lights.js";
import { buildTruckObject } from "./drive/truck-object.js";
import { createWorldFrame } from "./drive/world-frame.js";
import { UNITS_PER_FOOT_H, UNITS_PER_FOOT_V } from "./drive/world-frame.js";
import { groundForSpawn, spawnAt, trackSpawnPoint } from "./drive/spawn-point.js";
import { createRaceTrackSupport } from "./drive/racetrack-collider.js";
import { createMovers } from "./drive/moving-objects.js";
import {
  CPR_WALL_LAYERS,
  CPR_WALL_PART_HEIGHT_FT,
  CPR_TEXTURE_SLICE_COUNT,
  CPR_CROSS_SECTION_MIDPOINT,
  cprTextureIndex,
  cprTextureSlice,
  cprTextureU,
  cprFeetToWorldY,
  cprPointToScene,
  cprSegmentPairs,
  cprVisibleSlots,
  isDegenerateSlot,
  CPR_COURSE_PURPOSES,
  CPR_CHECKPOINT_LABELS,
  isCprPitCheckpoint,
} from "./shared/cpr-track-schema.js";

// The u1..u4 a CPR section falls back to when the .TRK has none: 16.16 fixed point for 4.0
// and 250.0 over a 0..256 space, i.e. one mapping across the section with a two pixel inset.
const CPR_DEFAULT_SECTION_U_INNER = 262144;
const CPR_DEFAULT_SECTION_U_OUTER = 16384000;

/*
  The racetrack layer sits on the terrain rather than above it, so where the two are coplanar
  they can z-fight at distance. A constant depth nudge fixes that without moving anything.

  Units only, with no slope factor: these materials are shared between the road and the
  walls, and a slope factor would be amplified enormously on a wall seen edge on, which would
  pull it in front of geometry it should be behind.
*/
const CPR_DEPTH_NUDGE = { polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: -2 };
/** The road coverage mask: about a foot per texel, capped so a long circuit stays small. */
const ROAD_MASK_UNITS_PER_TEXEL = 2;
const ROAD_MASK_MAX_SIZE = 4096;

/** Pixels of a legacy tile the 2px overlap crops from each side; terrain-builder.js's constant. */
const TERRAIN_OVERLAP_PIXELS = 2;
const WATER_COLOR = 0x1a6090;
const COURSE_COLOR = 0xffdd00;
const GBOX_COLOR = 0x00ff88;
// Traxx box types (Include/TrackPODBox.h and cursh2\core\sim.h's enum BoxType).
const BOXTYPE_CHECKPOINT        = 6;
const BOXTYPE_NO_COLLIDE_FACING = 8;
/** "Collide (facing)", Traxx's help: a facing tree with a solid trunk ("New Tree" in tracked2). */
const BOXTYPE_COLLIDE_FACING    = 9;
const BOXTYPE_RAMP              = 99;

// Collision box colors matching JTraxx Java constants
const CBOX_TOP    = 0x8D42FF;
const CBOX_SIDE   = 0x6A20C8;
const CBOX_BOTTOM = 0x3F0A80;
const CBOX_WIRE   = 0x9A4DFF;
// Traxx draws ramps in a yellow family to tell them apart from the purple collision prisms:
// BestMatch(200,200,0) / (150,150,0) / (100,100,0) for top, sides and bottom
// (Traxx/TraxxView.cpp:900-906).
const RAMP_TOP    = 0xC8C800;
const RAMP_SIDE   = 0x969600;
const RAMP_BOTTOM = 0x646400;
const RAMP_WIRE   = 0xE0E040;
/*
  TV-family marker colours.

  The marker layers stand in for content the viewer cannot draw as geometry: navigation
  points, tunnel mouths and powerup pickups. They are colour-coded by role rather than
  textured, and drawn with depth testing off so a marker inside a hill is still findable.
*/
const NAV_COLORS = {
  0: 0xff4444,   // target list
  1: 0x00ccff,   // tunnel entrance
  2: 0xffdd00,   // checkpoint
  3: 0x44ff44,   // jump zone
  4: 0x0088cc,   // tunnel exit
  5: 0xff00ff,   // boss
  6: 0xffffff,   // start point
  // Hellbender's own types. Its 0..6 are the TV seven, so only these need colours.
  7: 0x8899aa,   // sync point
  8: 0xff9933,   // rescue beacon
  9: 0x667788,   // end of navs
  12: 0x66ddaa,  // escort
  13: 0x66ddaa,  // retrieve
  14: 0xff00ff,  // pursue
};
const NAV_DEFAULT_COLOR = 0xaaaaaa;
const NAV_START_POINT = 6;

/*
  The two Hellbender navigation types that are bookkeeping rather than places.

  A sync point is stored at (0, level height, 0) in every one of the 69 that ship, and an
  "End of navs" terminator at the same spot in 20 of its 26 levels. Drawing them would put a
  stack of markers in one corner of every Hellbender map standing for nothing on the ground.
  They stay in the Navigation Points list, where the sequence is what matters.
*/
const NAV_TYPES_WITHOUT_A_PLACE = new Set([7, 9]);
const TUNNEL_ENTRANCE_COLOR = 0x00ccff;
const TUNNEL_EXIT_COLOR = 0x0066aa;
const POWERUP_COLOR = 0x66ff99;
const MARKER_HEAD_RADIUS = 22;
/** Where the label floats above the ground, in world units. */
const MARKER_LABEL_HEIGHT = 90;
/** Label height as a fraction of the viewport, since labels do not scale with distance. */
const LABEL_SCREEN_HEIGHT = 0.035;
// Course segment numbers (Traxx course style) are smaller: a course has dozens of them.
const SEGMENT_LABEL_SCREEN_HEIGHT = 0.03;
const COURSE_STYLES = new Set(["smooth", "joined", "traxx"]);
const HEADING_ARROW_LENGTH = 220;

/*
  The short type tag on a navigation marker.

  Enough to tell an objective from a checkpoint at a glance, and to say which tunnel a tunnel
  point leads to, without turning the label into a sentence. The full detail is in the
  Navigation Points panel.
*/
function navLabelSuffix(point) {
  switch (point.type) {
    // A Hellbender tunnel entrance names no level, so the tag falls back to the plain word.
    case 1: return point.tunnelLevel ? `enter ${point.tunnelLevel.replace(/\.LVL$/, "")}` : "tunnel entrance";
    case 0: return `target x${point.targets?.length ?? 0}`;
    case 2: return "checkpoint";
    case 3: return "jump zone";
    case 4: return "tunnel exit";
    case 5: return "boss";
    case 6: return "start";
    default: return point.typeName ?? "";
  }
}

/*
  Checkpoint markers, for the games that have no .NAV.

  Same colour as a .NAV checkpoint, because it is the same thing: the yellow means checkpoint
  whichever game the track came from.
*/
const CHECKPOINT_MARKER_COLOR = 0xffdd00;
/** CPR's pit lane checkpoints, which are not part of a lap, and its start/finish line. */
const PIT_CHECKPOINT_MARKER_COLOR = 0x39a0ff;
const START_FINISH_MARKER_COLOR = 0xffffff;
/** One colour per CPR course, in course order: three AI lines, pit road, pit row. */
const CPR_COURSE_COLORS = [0xff4040, 0xff9a30, 0xffdd00, 0x35c95a, 0x39a0ff];
/** The SIT games' courses: the main course in its usual yellow, then the AI lines. */
const SIT_COURSE_COLORS = [COURSE_COLOR, 0xff4040, 0xff9a30, 0x35c95a, 0x39a0ff];
/** Wireframe colour for the cavern surfaces, cool against the ground boxes' warmer edges. */
const UNDERGROUND_WIRE_COLOR = 0x66aacc;
/** How far out the directional light is placed; only its direction matters. */
const SUN_DISTANCE = 5000;
/** The furthest the shadow cascades reach: the camera's far plane at the longest view distance. */
const SHADOW_MAX_FAR = 256 * 64 * 1.5;
/** Frames between checks for lit materials the shadow cascades have not been set up for. */
const SHADOW_MATERIAL_SWEEP_FRAMES = 60;
const GRID_COLOR = 0x444466;
const UP_AXIS = new THREE.Vector3(0, 1, 0);
const SUN_COLOR = 0xfff4e0;
/*
  The fly camera's vertical field of view: MTM2's.

  The TRI engine projects with a fixed 512 pixel focal length (Traxx models the same pinhole,
  TRAXX_GL_CAMERA_FOCAL_X/Y), so its field of view depends on the resolution it runs at. At
  1280x720 that is 2 * atan(360 / 512), about 70 degrees vertically and 103 across; measured
  off an MTM2 screenshot at that size, the backdrop is 8.2 pixels per degree against the 8.9
  that predicts. The viewer used 60, which drew the backdrop and everything else larger and
  its mountains less often across the screen than the game does.
*/
const NAV_FOV = 2 * Math.atan(360 / 512) * 180 / Math.PI;
const AMBIENT_COLOR = 0x888888;
const AMBIENT_INTENSITY = 1.4;

/*
  Weather, as MTM2 offers it: a sky, and the light that goes with it.

  Each preset scales the Sun panel's own intensity and the ambient light rather than
  replacing them, so the sliders keep working under any weather. The backdrop is flat,
  unlit geometry that would otherwise stay in full daylight against a dusk or night sky, so
  it is tinted instead. At night the moon takes the sun's place, as a dim cool light that
  still casts shadows.

  Only the games whose own weather this imitates get it: MTM, MTM2, CPR, Evo, and Fly!, which
  flies day or night and lights its cities after dark. TV, Fury3 and Hellbender keep their own
  sky textures.
*/
const WEATHER_ORIGINS = new Set(["MTM1", "MTM2", "CPR", "EVO1", "EVO2", "FLY"]);
/** How brightly Fly!'s city lights glow under each weather: at night, a little at dusk. */
const FLY_NIGHT_LIGHTS = { night: 1, dusk: 0.35 };
/*
  `gradient` is the sky MTM1 and MTM2 draw with their textured sky switched off: one colour
  overhead that turns into a lighter horizon colour over the last few degrees above the
  horizon. The colours are read off MTM2's own screenshots with the option off.
*/
const WEATHERS = {
  clear:  { sky: "CLOUDY2.PNG", celestial: "sun", sun: 1.0, sunColor: SUN_COLOR, ambient: 1.0, ambientColor: AMBIENT_COLOR,
            backdrop: 0xffffff, backdropSaturation: 1.0, shadows: true,
            gradient: { zenith: 0x6b9ac2, horizon: 0xe4f1f6 } },
  cloudy: { sky: "CCLOUDS.PNG", celestial: "none", sun: 0.6, sunColor: SUN_COLOR, ambient: 1.05, ambientColor: AMBIENT_COLOR,
            backdrop: 0xb4b4b8, backdropSaturation: 0.45, shadows: true,
            gradient: { zenith: 0x9d9d9d, horizon: 0xf6f6f6 } },
  dusk:   { sky: "DUSKSKY.png", celestial: "sun", sun: 0.65, sunColor: 0xffb070, ambient: 0.85, ambientColor: 0x8f7a7a,
            backdrop: 0x7a6466, backdropSaturation: 0.9, shadows: true,
            gradient: { zenith: 0x0b090d, horizon: 0xe8653e } },
  // Moonlight: a faint, cool light from where the moon is drawn, which is the sun's place.
  night:  { sky: "NITESKY.PNG", celestial: "moon", sun: 0.16, sunColor: 0xa8b4ff, ambient: 0.38, ambientColor: 0x6a70a0,
            backdrop: 0x3c3d58, backdropSaturation: 0.8, shadows: true,
            gradient: { zenith: 0x020308, horizon: 0x1c2238 } },
};
/** How far above the horizon the gradient sky reaches its overhead colour, in radians (12 degrees). */
const SKY_GRADIENT_BAND = Math.PI / 15;
/** Sky styles: the weather's photograph, MTM's plain gradient, or MTM1's own flat ceiling. */
const SKY_STYLES = new Set(["textured", "gradient", "classic"]);
/** Seconds each keyframe of an animated BIN is held for, blending into the next over it. */
const KEYFRAME_SECONDS = 0.5;
/*
  three.js lights physically: a Lambert surface reflects irradiance / pi. The light levels
  above were set as display brightnesses, so every light is scaled by this to bring a flat
  surface under the default sun to about the brightness MTM2 draws its ground at (88% of the
  texture, the stock tracks' mean baked light; see terrain-builder.js).
*/
const LIGHT_SCALE = 2.5;
/** The lowest sun elevation, as a sine, the baked terrain light is normalised against. */
const LTE_MIN_SUN_HEIGHT = 0.1;
/** How far, in world units, a flare visibility ray is followed over the terrain. */
const SUN_RAY_REACH = 16384;
/** How many times the sky texture goes round the horizon. */
const SKY_REPEATS = 3;
/** The width of the cross-fade that hides each repeat's seam, as a fraction of one repeat. */
const SKY_SEAM_BLEND = 0.18;
/** How far below the horizon the sky texture's bottom row sits, in radians (20 degrees). */
const SKY_BELOW_HORIZON = Math.PI / 9;
const BACKGROUND_COLOR = 0xbcd6e7;

/*
  The TV/F3/HB sky, as GAME.EXE draws it (0x18b60).

  A single flat square at the world's ceiling: altitude 256 (0x800000 world units, one step
  above the highest terrain and the same constant as the flight ceiling), spanning +-512 cells
  around world origin, with the 64x64 sky texture repeated 64 times across it, i.e. once every
  16 cells. The engine draws it with the camera offset divided by 256, which is the same
  picture as a square 256 times smaller around the camera. The scene does the same, but picks
  the factor each frame from the far plane: fixed at 1/256, the ceiling overhead would sit
  closer than the near plane and be clipped away.
*/
const CELL_SIZE_UNITS = 64;
const TV_SKY_ALTITUDE = 256;
const TV_SKY_HALF_CELLS = 512;
const TV_SKY_CELLS_PER_REPEAT = 16;
/*
  MTM1 draws the same kind of ceiling with its one 64x64 sky tile stretched far wider: in the game
  a single cloud spans a third of the screen, where TV's spacing repeats it every tenth. Twice
  TV's spacing, matched by eye against MTM1 screenshots; the executable's own figure has not
  been traced.
*/
const CLASSIC_SKY_CELLS_PER_REPEAT = 64;
const TV_STAR_COUNT = 2000;
// Fog runs from this fraction of the view distance to the full view distance.
const TV_FOG_START = 0.4;
const EMPTY_BACKGROUND_COLOR = 0x151417;

/**
 * Traxx object rotation, in Traxx space (x east, y north/depth, z up).
 *
 * Source of truth is the Traxx editor's object stack, which is identical in the original
 * and in the Community Patch 3 fork:
 *
 *   Traxx/TraxxViewDisplay.cpp:2782-2785     Traxx/OpenGLTerrainRenderer.cpp:2382-2396
 *     PushZStretch(768)                        ViewStateApplyYRotation(-phi)
 *     PushZRotation(psi)                       ViewStateApplyXRotation(-theta)
 *     PushXRotation(theta)                     ViewStateApplyZRotation(-psi)
 *     PushYRotation(-phi)                      pz *= zstretch/1024
 *
 * giving  v_world = S_z(0.75) * Rz(-psi) * Rx(-theta) * Ry(-phi) * v_model + worldpos.
 *
 * Note the Z stretch is applied AFTER the rotation, in world space. It is non-uniform, so
 * it does not commute with the rotation: baking it into the model vertex shears anything
 * that is pitched or rolled. Callers apply it to the returned r2 row, never to the vertex.
 *
 * Returns the three rows of R as arrays of 3.
 */
function traxxRotationRows(psi, theta, phi) {
  const Cp = Math.cos(psi),   Sp = Math.sin(psi);
  const Ct = Math.cos(theta), St = Math.sin(theta);
  const Cf = Math.cos(phi),   Sf = Math.sin(phi);
  return [
    [ Cp * Cf + Sp * St * Sf,  Sp * Ct,  -Cp * Sf + Sp * St * Cf ],
    [ -Sp * Cf + Cp * St * Sf, Cp * Ct,   Sp * Sf + Cp * St * Cf ],
    [ Ct * Sf,                -St,        Ct * Cf ],
  ];
}

// Vertical world scale relative to the horizontal one: Traxx is 128 world units per foot
// horizontally and 96 vertically (Traxx/TraxxView.h:45-61). The 0.75 ratio is exactly the
// PushZStretch(768) the object stack applies.
const TRAXX_Z_STRETCH = 0.75;

/*
  Fly! detail streaming: how many 8 x 8 cell chunks near the camera hold a full-resolution
  texture at once, and how near, in Fly! cells of about 2 km, a chunk must be to get one. The
  tile orthophoto's 60 m texels start to show as blur within about that distance.
*/
const FLY_DETAIL_BUDGET = 12;
const FLY_DETAIL_RANGE_CELLS = 25;

/**
 * Object matrix for geometry authored in Traxx local space (BIN models): T * S * R,
 * where T maps Traxx (jx,jy,jz) -> Three.js (jx, jz, -jy).
 */
function traxxModelMatrix(psi, theta, phi, posX, posY, posZ, zStretch = TRAXX_Z_STRETCH) {
  const [r0, r1, r2] = traxxRotationRows(psi, theta, phi);
  const z = zStretch;
  return new THREE.Matrix4().set(
        r0[0],     r0[1],     r0[2], posX,
    z * r2[0], z * r2[1], z * r2[2], posY,
       -r1[0],    -r1[1],    -r1[2], posZ,
            0,         0,         0,    1
  );
}

/**
 * Object matrix for geometry already authored in Three.js axes (the collision prisms and the
 * ramp wedge): T * S * R * T^-1, i.e. the same rows with columns permuted [c0, c2, -c1].
 *
 * Traxx builds its prism from half-extents (width, length, height) on Traxx (x, y, z) and
 * pushes it through the very same stack as a model (TraxxViewDisplay.cpp:2745-2785), so the
 * rotation here must match traxxModelMatrix exactly. It previously used +psi, which yawed
 * every model-less object the wrong way.
 */
function traxxPrismMatrix(psi, theta, phi, posX, posY, posZ) {
  const [r0, r1, r2] = traxxRotationRows(psi, theta, phi);
  const z = TRAXX_Z_STRETCH;
  return new THREE.Matrix4().set(
        r0[0],     r0[2],    -r0[1], posX,
    z * r2[0], z * r2[2], -z * r2[1], posY,
       -r1[0],    -r1[2],     r1[1], posZ,
            0,         0,         0,    1
  );
}

/*
  True for the SIT family (MTM1, MTM2, CPR) and the TV family (Terminal Velocity, Fury3,
  F!Zone), whose models the scene turns about their own origin.

  ⛔ A SIT ALTITUDE IS WHERE THE MODEL'S ORIGIN GOES, AND THE MODEL TURNS ABOUT THAT ORIGIN.
  Traxx rotates the raw vertices and adds ipos (OpenGLTerrainRenderer.cpp
  NativeObjectStackLocalStackPoint; CalculateBoxLocations for the altitude), and basez is only
  the editor's "assign model" step, which raises ipos by the model's depth below its origin so
  the base lands on the ground. The decoder instead recentres every mesh on its bounding box
  with the base at zero (buildMeshes), and this scene used to turn that recentred mesh and then
  add baseZ straight down in world space. Upright, the two agree to within the -31 in basez.
  Turned over, they do not: an upside-down model hung from its base and was then pushed down
  again, a whole model height too low. Terramar's upper bridge rails, rolled 180 degrees, sank
  into the deck beside the rails beneath it, where MTM2 draws them standing on it. Recentring
  also moved any model whose bounds are not centred on its origin sideways by the difference.
  TV and Fury3 follow the same rule: a placement is where the model's origin goes (the model
  data puts that origin at the base of every ground model), and FuryEdit sizes and places
  models from the raw vertices, not from recentred bounds. Hellbender keeps the old placement.
*/
function traxxTrueOrigin(origin) {
  return !isEvoOrigin(origin) && origin !== "HB";
}

/** Terminal Velocity, Fury3 and F!Zone. */
function isTvFamilyOrigin(origin) {
  return origin === "TV" || origin === "F3" || origin === "TV/F3";
}

/*
  Vertical stretch applied to a model after it is turned.

  A TV/F3 model is drawn in its true proportions. Its vertices are world units on every axis
  (bin-decoder.js), and the engine treats them that way: each definition's hit radius is a
  sphere that just encloses the model. So no stretch is applied, whatever the terrain height
  scale; that setting exaggerates the ground, not the objects standing on it. Their placement
  heights still follow it, so they stay on the surface.

  Stretching by heightScale / 2 to "match" the terrain was tried and drew FIRSMALL.BIN at 2.5
  times as tall as wide against its authored 1.7.

  Hellbender keeps the Traxx 0.75, which its terrain shares.
*/
function modelZStretch(origin) {
  return isTvFamilyOrigin(origin) ? 1 : TRAXX_Z_STRETCH;
}

/** True for the two 4x4 Evolution generations, which share one placement convention. */
function isEvoOrigin(origin) {
  return origin === "EVO1" || origin === "EVO2";
}

/**
 * Object matrix for 4x4 Evolution geometry.
 *
 * Evo is Y-up in both its .SIT placements and its .SMF models, so it needs none of the Traxx
 * stack: no 0.75 vertical stretch (that ratio is Traxx's 128-vs-96 units per foot, and Evo
 * has one uniform scale), and no baseZ, which is a .BIN field with no .SMF equivalent.
 *
 * The viewer presents the world with Z flipped, which the terrain builder has always done.
 * That flip is a reflection, so an Evo rotation R becomes F.R.F with F = diag(1,1,-1):
 * a heading psi about the up axis becomes -psi, a pitch about X becomes -theta, and a roll
 * about Z is unchanged. Model vertices arrive with Z already negated and their winding
 * reversed to match (see smf-parser.js), so this only has to carry the rotation.
 *
 * The heading is verified against the stock tracks; see evo-coords.js for how, and for why
 * the pitch/roll assignment is correlated rather than verified.
 */
function evoModelMatrix(psi, theta, phi, posX, posY, posZ) {
  const yaw = new THREE.Matrix4().makeRotationY(-psi);
  const pitch = new THREE.Matrix4().makeRotationX(-theta);
  const roll = new THREE.Matrix4().makeRotationZ(phi);
  const matrix = yaw.multiply(pitch).multiply(roll);
  matrix.setPosition(posX, posY, posZ);
  return matrix;
}

export class TrackScene {
  constructor(container) {
    this._container = container;
    this._trackData = null;
    this._renderFlags = {
      terrain: true, textures: true, grid: false,
      objects: true, gboxes: true,
      cboxes: false, water: true, backdrop: true, sunlight: true, shadows: true, terrainOverlap: true,
      wireframe: false, trucks: true, billboards: true, checkpoints: false,
      navpoints: true, cpmarkers: true, tunnels: true, powerups: true, animate: true,
      racetrack: true, underground: true, lensflare: true, sky: true, fog: true,
      movingObjects: true,
    };
    this._heightScale = 4;
    this._textureSmoothingEnabled = true;
    this._undergroundSurfaces = [];
    this._terrainUvTargets = [];
    this._courses = [];
    // Shared by both terrain materials, which survive a texture toggle; see _buildRoadMask.
    this._roadMaskTarget = null;
    this._roadMaskUniforms = {
      roadMask: { value: null },
      roadMaskBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      roadMaskEnabled: { value: 0 },
      // Scales the lit result of LTE terrain back to its baked brightness; see _applyLighting.
      lteGain: { value: 1 },
    };
    this._backdropUniforms = {
      backdropTint: { value: new THREE.Color(0xffffff) },
      backdropSaturation: { value: 1 },
    };
    this._labelTextures = [];
    this._keyframeAnimations = [];
    this._keyframeClock = 0;
    this._crushCabs = new Map();
    this._movers = null;
    this._skyStyle = "textured";
    this._courseStyle = "smooth";
    this._lastTime = 0;
    this._driveGeneration = 0;
    this._terrainAtlasN = 1;
    this._terrainAtlasCols = 1;
    this._terrainAtlasRows = 1;
    this._terrainAtlasWidth = 1;
    this._terrainAtlasHeight = 1;
    this._terrainAtlasTileSize = 64;
    this._terrainAtlasPadding = 0;
    this._terrainAtlasSourceTileSize = 64;

    this._initRenderer();
    this._initScene();
    this._initCamera();
    this._initLights();
    this._startLoop();
    this._initResize();
  }

  _initRenderer() {
    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setClearColor(EMPTY_BACKGROUND_COLOR);
    this._renderer.toneMapping = THREE.LinearToneMapping;
    this._renderer.toneMappingExposure = 1.0;
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.PCFShadowMap;
    // Checked every frame, but each cascade redraws only when SunShadows marks it; see there.
    this._renderer.shadowMap.autoUpdate = true;
    this._container.appendChild(this._renderer.domElement);
    const { width, height } = this._container.getBoundingClientRect();
    this._renderer.setSize(width || 800, height || 600);
  }

  _initScene() {
    this._scene = new THREE.Scene();

    this._groups = {
      terrain:    new THREE.Group(),
      terrainGrid:new THREE.Group(),
      courses:    new THREE.Group(),
      objects:    new THREE.Group(),
      objectsWire:new THREE.Group(),
      billboards: new THREE.Group(),
      billboardsWire:new THREE.Group(),
      checkpoints:new THREE.Group(),
      checkpointsWire:new THREE.Group(),
      racetrack:  new THREE.Group(),
      racetrackWire:new THREE.Group(),
      gboxes:     new THREE.Group(),
      gboxesWire: new THREE.Group(),
      underground:     new THREE.Group(),
      undergroundWire: new THREE.Group(),
      cboxes:     new THREE.Group(),
      cboxesWire: new THREE.Group(),
      ramps:      new THREE.Group(),
      rampsWire:  new THREE.Group(),
      navPoints:  new THREE.Group(),
      checkpointMarkers: new THREE.Group(),
      tunnels:    new THREE.Group(),
      powerups:   new THREE.Group(),
      water:      new THREE.Group(),
      trucks:     new THREE.Group(),
      // The drivable truck. Separate from `trucks`, which holds the start-grid arrows: one is
      // a marker layer the viewer toggles, the other is the vehicle drive mode moves.
      driveTruck: new THREE.Group(),
      // Wireframes around what the SIMULATION collides with, which is not always what the
      // viewer draws. See drive/collider-markers.js.
      hitboxes:   new THREE.Group(),
      vegetation: new THREE.Group(),
      vegetationWire: new THREE.Group(),
      backdrop:   new THREE.Group(),
      // A track's own sky texture on a dome (Evo). Sky, not backdrop: the Backdrop toggle leaves it.
      skyBox:     new THREE.Group(),
      // The TV/F3/HB sky ceiling or star field, which stands in for a backdrop in those games.
      tvSky:      new THREE.Group(),
    };
    for (const g of Object.values(this._groups)) this._scene.add(g);
    // Drawn before the backdrop (-1), whose mountains stand in front of MTM1's Classic sky.
    this._groups.tvSky.renderOrder = -2;
  }

  _initCamera() {
    const { width, height } = this._container.getBoundingClientRect();
    this._camera = new THREE.PerspectiveCamera(NAV_FOV, (width || 800) / (height || 600), 1, 120000);
    this._nav = new TrackCamera(this._camera);
    this._nav.bindElement(this._container);
    this._nav.setGridSpanChangeCallback((gs) => { this._onGridSpanChange?.(gs); });
  }

  setGridSpanChangeCallback(fn) { this._onGridSpanChange = fn; }
  setNavigationChangeCallback(fn) { this._nav?.setChangeCallback(fn); }

  _initLights() {
    this._ambient = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_INTENSITY);
    this._scene.add(this._ambient);
    this._sun = new THREE.DirectionalLight(SUN_COLOR, 1.0);
    this._sun.position.set(1, 2, 0.5);
    // Lights only when shadows are off; with them on, the cascades light instead.
    this._sun.castShadow = false;
    this._scene.add(this._sun.target);
    this._scene.add(this._sun);
    this._shadows = new SunShadows({
      scene: this._scene, camera: this._camera, color: SUN_COLOR, intensity: 1.0,
      maxFar: Math.min(this._camera.far, SHADOW_MAX_FAR),
    });
    this._shadowMaterialsDirty = true;
    this._frameCount = 0;
    this._sunDirection = new THREE.Vector3(-1, -2, -0.5).normalize();
    this._sunIntensity = 1.0;
    this._weather = "clear";
    this._skyTextures = {};
    this._buildSky();
  }

  setSunIntensity(v) {
    this._sunIntensity = v;
    this._applyLighting();
  }

  /*
    The sky dome for weather: a sphere around the camera, drawn first and without depth so
    the backdrop and everything else lands on top of it. The textures run from zenith (top)
    to horizon (bottom), so V follows elevation. The bottom row is placed SKY_BELOW_HORIZON
    under the horizon, because from a raised camera the sky shows past the edge of the map
    there, and a clamped row stretched over that band draws as vertical streaks.

    U goes round the horizon SKY_REPEATS times. The skies are photographs, not tiles, so
    their left and right edges do not meet; mirroring them hides the join but turns every
    seam into a symmetric inkblot. Instead each seam is cross-faded with the same sky read
    half a repeat further on, where that second read has no seam of its own.
  */
  _buildSky() {
    const geo = new THREE.SphereGeometry(1, 64, 32);
    const uv = geo.attributes.uv;
    const pos = geo.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      const elevation = Math.asin(Math.max(-1, Math.min(1, pos.getY(i))));
      uv.setXY(i, uv.getX(i) * SKY_REPEATS,
        Math.max(0, (elevation + SKY_BELOW_HORIZON) / (Math.PI / 2 + SKY_BELOW_HORIZON)));
    }
    const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, fog: false, depthTest: false, depthWrite: false });
    /*
      Below the texture's bottom row every texel along a column is the same, which draws as
      vertical streaks wherever the sky shows past the edge of the map. Reading ever smaller
      mip levels the further below the horizon a pixel is smooths that band into the sky's
      average colour.
    */
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying float vSkyHeight;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSkyHeight = position.y;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vSkyHeight;")
        .replace("#include <map_fragment>", `
        #ifdef USE_MAP
          float skySeam = fract(vMapUv.x);
          float skyFade = 1.0 - smoothstep(0.0, ${SKY_SEAM_BLEND.toFixed(3)}, min(skySeam, 1.0 - skySeam) * 2.0);
          float skyBlur = 8.0 * smoothstep(${(-Math.sin(SKY_BELOW_HORIZON * 0.6)).toFixed(3)}, -0.7, vSkyHeight);
          vec4 skyA = texture2D(map, vMapUv, skyBlur);
          vec4 skyB = texture2D(map, vec2(vMapUv.x + 0.5, vMapUv.y), skyBlur);
          diffuseColor *= mix(skyA, skyB, skyFade);
        #endif`);
    };
    this._sky = new THREE.Mesh(geo, mat);
    this._sky.frustumCulled = false;
    this._sky.visible = false;
    /*
      Ordered through a group, not on the mesh: the backdrop is a Group at renderOrder -1, and
      three.js sorts by the enclosing group's order before an object's own, so a lone mesh at
      -2 still drew after the backdrop and covered its mountains.
    */
    const skyGroup = new THREE.Group();
    skyGroup.renderOrder = -2;
    skyGroup.add(this._sky);
    this._scene.add(skyGroup);
    this._flare = new SunFlare(skyGroup);
    this._flareRay = new THREE.Raycaster();
    this._sunBlocked = (origin, direction) => this._isSunBlocked(origin, direction);
  }

  _skyTexture(file) {
    if (!this._skyTextures[file]) {
      const tex = new THREE.TextureLoader().load(new URL(`./resources/${file}`, import.meta.url).href);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      this._skyTextures[file] = tex;
    }
    return this._skyTextures[file];
  }

  /** "clear", "cloudy", "dusk" or "night". Applies to the tracks in WEATHER_ORIGINS only. */
  setWeather(name) {
    this._weather = WEATHERS[name] ? name : "clear";
    this._applyWeather();
  }

  get weather() { return this._weather; }

  /** Whether the loaded track takes weather at all. */
  weatherApplies() {
    return WEATHER_ORIGINS.has(this._trackData?.origin);
  }

  _weatherPreset() {
    return this.weatherApplies() ? WEATHERS[this._weather] : null;
  }

  /** "textured", "gradient" or "classic" (MTM1 only; see classicSkyApplies). */
  setSkyStyle(name) {
    this._skyStyle = SKY_STYLES.has(name) ? name : "textured";
    this._applyWeather();
  }

  /** Whether the loaded track has a sky of its own the Classic style can show: MTM1's. */
  classicSkyApplies() {
    return !!this._classicSky && this.weatherApplies();
  }

  /** The style actually in use: Classic falls back to Textured on a track without one. */
  _effectiveSkyStyle() {
    if (this._skyStyle === "classic") return this.classicSkyApplies() ? "classic" : "textured";
    return this._skyStyle;
  }

  /*
    The gradient sky for one weather, as a texture for the same sky dome the photographs use,
    so it picks up the dome's placement and its blur below the horizon unchanged. Rows follow
    the dome's V, which is elevation from SKY_BELOW_HORIZON under the horizon up to the zenith.
  */
  _gradientTexture(name) {
    const key = `gradient:${name}`;
    if (this._skyTextures[key]) return this._skyTextures[key];
    const { zenith, horizon } = WEATHERS[name].gradient;
    const top = new THREE.Color(zenith), low = new THREE.Color(horizon), mixed = new THREE.Color();
    const rows = 256, cols = 4;
    const data = new Uint8Array(rows * cols * 4);
    for (let row = 0; row < rows; row++) {
      const elevation = (row / (rows - 1)) * (Math.PI / 2 + SKY_BELOW_HORIZON) - SKY_BELOW_HORIZON;
      const t = Math.max(0, Math.min(1, elevation / SKY_GRADIENT_BAND));
      mixed.copy(low).lerp(top, t);
      for (let col = 0; col < cols; col++) {
        const o = (row * cols + col) * 4;
        data[o] = Math.round(mixed.r * 255);
        data[o + 1] = Math.round(mixed.g * 255);
        data[o + 2] = Math.round(mixed.b * 255);
        data[o + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    this._skyTextures[key] = tex;
    return tex;
  }

  _applyWeather() {
    const preset = this._weatherPreset();
    const style = this._effectiveSkyStyle();
    this._sky.material.map = !preset ? null
      : style === "gradient" ? this._gradientTexture(this._weather)
      : this._skyTexture(preset.sky);
    this._sky.material.needsUpdate = true;
    // A track's own sky texture (Evo) gives way to the weather's.
    if (this._skyTextureMesh) this._skyTextureMesh.visible = !preset;
    // The sun in a clear or dusk sky, the moon at night, neither behind cloud.
    this._flare.setMode(preset?.celestial ?? "none");

    // The backdrop is unlit, so the weather tints and greys it directly; see _installBackdropShader.
    this._backdropUniforms.backdropTint.value.set(preset?.backdrop ?? 0xffffff);
    this._backdropUniforms.backdropSaturation.value = preset?.backdropSaturation ?? 1;
    this._applyLighting();
    this._applyVisibility();
    this._applyFlyNight();
  }

  /** Turn Fly!'s city lights up or down with the weather. */
  _applyFlyNight() {
    const intensity = this.weatherApplies() ? (FLY_NIGHT_LIGHTS[this._weather] ?? 0) : 0;
    for (const mesh of this._flyTileMeshes ?? []) {
      if (!mesh.userData.nightTexture) continue;
      mesh.userData.tileMaterial.emissiveIntensity = intensity;
      if (mesh.userData.fly.detail) mesh.userData.fly.detail.material.emissiveIntensity = intensity;
    }
  }

  /*
    Whether one of the flare's visibility rays is stopped before it reaches the sun: by the
    ground, marched along the ray over the heightfield, or by a placed object or tree.
    SUN.TXT's rays are MTM2's own occlusion test; what they are tested against here is the
    viewer's choice, and the backdrop is left out because it is mostly transparent sky
    above its mountains.
  */
  _isSunBlocked(origin, direction) {
    const td = this._trackData;
    if (!td) return false;
    this._flareFrame ??= createWorldFrame(td);
    const frame = this._flareFrame;
    const world = this._worldSize(td);
    for (let t = 16; t < SUN_RAY_REACH; t += 16 + t * 0.02) {
      const x = origin.x + direction.x * t, y = origin.y + direction.y * t, z = origin.z + direction.z * t;
      if (x < 0 || z < 0 || x > world || z > world) break;
      const ground = frame.heightAtFeet(x / UNITS_PER_FOOT_H, z / UNITS_PER_FOOT_H) * UNITS_PER_FOOT_V;
      if (y < ground) return true;
    }
    const ray = this._flareRay;
    ray.set(origin, direction);
    ray.far = this._camera.far;
    ray.camera = this._camera;
    const g = this._groups;
    return ray.intersectObjects([g.objects, g.billboards, g.vegetation], true).length > 0;
  }

  _applyLighting() {
    const preset = this._weatherPreset();
    const sun = this._sunIntensity * (preset?.sun ?? 1);
    const sunColor = preset?.sunColor ?? SUN_COLOR;
    this._sun.intensity = sun * LIGHT_SCALE;
    this._sun.color.set(sunColor);
    this._shadows.setIntensity(sun * LIGHT_SCALE);
    this._shadows.setColor(sunColor);
    this._ambient.intensity = AMBIENT_INTENSITY * LIGHT_SCALE * (preset?.ambient ?? 1);
    this._ambient.color.set(preset?.ambientColor ?? AMBIENT_COLOR);

    /*
      The baked-light gain for LTE terrain: pi over the irradiance an unshadowed, level patch
      of ground gets on a clear day at the default sun strength. Under those conditions the
      ground draws at exactly its LTE brightness; in shade, under weather, or with the Sun
      slider moved, it draws that much darker or brighter. Measured against a fixed reference
      rather than the current lights, or the weather would cancel itself out.
    */
    const height = Math.max(LTE_MIN_SUN_HEIGHT, -(this._sunDirection?.y ?? -1));
    const ambient = new THREE.Color(AMBIENT_COLOR).multiplyScalar(AMBIENT_INTENSITY * LIGHT_SCALE);
    const direct = new THREE.Color(SUN_COLOR).multiplyScalar(LIGHT_SCALE * height);
    const reference = (ambient.r + direct.r + ambient.g + direct.g + ambient.b + direct.b) / 3;
    this._roadMaskUniforms.lteGain.value = Math.PI / reference;
  }

  /** Lets the weather tint and grey an unlit backdrop material. */
  _installBackdropShader(material) {
    const uniforms = this._backdropUniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform vec3 backdropTint;\nuniform float backdropSaturation;")
        .replace("#include <map_fragment>", `#include <map_fragment>
          float backdropGrey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          diffuseColor.rgb = mix(vec3(backdropGrey), diffuseColor.rgb, backdropSaturation) * backdropTint;`);
    };
  }

  setGamma(v) {
    this._renderer.toneMappingExposure = v;
  }

  // Set view distance in grid-cell units: 64 world units, or a Fly! cell of about 12,800
  setViewDistance(cells) {
    this._viewDistanceCells = cells;
    const cell = this._trackData?.origin === "FLY" ? this._trackData.terrain.cellSize : 64;
    const dist = cells * cell;
    this._viewDistance = dist;
    if (this._tvFog) {
      this._tvFog.near = dist * TV_FOG_START;
      this._tvFog.far = dist;
    }
    this._camera.far = dist * 3;
    this._camera.updateProjectionMatrix();
    this._shadows?.setMaxFar(Math.min(this._camera.far, SHADOW_MAX_FAR));
  }

  _initResize() {
    const ro = new ResizeObserver(() => this._onResize());
    ro.observe(this._container);
  }

  _onResize() {
    const { width, height } = this._container.getBoundingClientRect();
    if (!width || !height) return;
    this._camera.aspect = width / height;
    this._camera.updateProjectionMatrix();
    this._shadows?.refit();
    this._renderer.setSize(width, height);
  }

  _startLoop() {
    const loop = (time) => {
      requestAnimationFrame(loop);
      const dt = Math.min((time - this._lastTime) / 1000, 0.1);
      this._lastTime = time;
      /*
        Driving and flying are the same loop, and only one of them may move the camera.

        Drive mode owns the camera while it is active, so the fly camera is not merely ignored
        here, it is disabled (see startDrive): its key handlers stay live so that releases are
        still seen, but it must not steer.
      */
      if (this._drive?.isActive) this._drive.update(dt);
      else this._nav.update(dt);
      // Keep backdrop centered on camera so it never appears to move
      if (this._backdropMesh) this._backdropMesh.position.copy(this._camera.position);
      this._updateTvSky();
      if (this._sky.visible) {
        // Inside the far plane whatever the view distance, and always around the camera.
        this._sky.position.copy(this._camera.position);
        this._sky.scale.setScalar(this._camera.far * 0.9);
      }
      this._updateMovers(dt);
      this._updateBillboards();
      this._truckLights?.update(this._camera, time);
      this._updateTextureAnimations(dt);
      this._updateKeyframes(dt);
      this._updateFlyDetail(dt);
      this._updateFlyNearPlane();
      this._updateShadows();
      const f = this._renderFlags;
      this._flare.update(this._camera, this._sunDirection, this._sky.visible && f.sunlight !== false,
        f.lensflare !== false && f.sunlight !== false && !!this._trackData, this._sunBlocked);
      this._renderer.render(this._scene, this._camera);
      this._flare.render(this._renderer, this._camera);
    };
    requestAnimationFrame((t) => { this._lastTime = t; requestAnimationFrame(loop); });
  }

  get nav() { return this._nav; }

  setRenderFlags(flags) {
    Object.assign(this._renderFlags, flags);
    if (this._movers && this._movers.enabled !== (this._renderFlags.movingObjects !== false)) {
      this._movers.setEnabled(this._renderFlags.movingObjects !== false);
      this._applyMoverTransforms(true);
    }
    this._updateTerrainOverlap();
    this._applyVisibility();
  }

  /*
    Animated BINs, played as the game plays them: each keyframe blends into the next rather
    than snapping to it, looping back from the last to the first. The stock animations are
    all cycles (PUMPJACK's eight frames, REX's four), so the loop closes on itself. The
    Animations toggle holds them in their current pose.
  */
  _updateKeyframes(dt) {
    if (!this._keyframeAnimations.length || this._renderFlags.animate === false) return;
    this._keyframeClock += dt;
    const phase = this._keyframeClock / KEYFRAME_SECONDS;
    for (const animation of this._keyframeAnimations) {
      const n = animation.frameCount;
      const p = phase % n;
      const from = Math.floor(p);
      for (const mesh of animation.meshes) setKeyframeBlend(mesh.morphTargetInfluences, from, (from + 1) % n, p - from);
    }
    this._shadows.invalidateDynamic();
  }

  /*
    Trains and aircraft. The viewer steps them once a frame; while driving, drive mode steps
    the same movers on the simulation clock instead, so only the drawing happens here.
  */
  _updateMovers(dt) {
    if (!this._movers?.count) return;
    if (!this._drive?.isActive) this._movers.step(dt);
    this._applyMoverTransforms();
  }

  /*
    Put each moving object, and anything riding on it, where its mover says: turned by the
    mover's yaw about where it started, then carried by its offset. Composed onto the object's
    placed matrix as the drive colliders' shoves are (see applyColliderOffsets).
  */
  _applyMoverTransforms(force = false) {
    const movers = this._movers;
    if (!movers?.count || !this._objectsByBox) return;
    if (!force && this._moverAppliedTime === movers.time) return;
    this._moverAppliedTime = movers.time;
    const H = UNITS_PER_FOOT_H, V = UNITS_PER_FOOT_V;
    const move = new THREE.Matrix4();
    const turn = new THREE.Matrix4();
    for (const [index, mover] of movers.placements()) {
      const drawn = this._objectsByBox.get(index);
      if (!drawn) continue;
      const px = mover.start.x * H, pz = mover.start.z * H;
      move.makeTranslation(px + mover.offset.x * H, mover.offset.y * V, pz + mover.offset.z * H)
        .multiply(turn.makeRotationY(mover.yaw))
        .multiply(new THREE.Matrix4().makeTranslation(-px, 0, -pz));
      for (const node of [drawn.group, drawn.wireGroup]) {
        if (!node) continue;
        if (drawn.billboard) {
          // A facing prop is placed by position; it turns to the camera by itself.
          node.userData.placedPosition ??= node.position.clone();
          node.position.copy(node.userData.placedPosition).add(
            new THREE.Vector3(mover.offset.x * H, mover.offset.y * V, mover.offset.z * H));
          continue;
        }
        node.userData.placedMatrix ??= node.matrix.clone();
        node.matrix.multiplyMatrices(move, node.userData.placedMatrix);
        node.matrixWorldNeedsUpdate = true;
      }
    }
    this._shadows.invalidateDynamic();
  }

  /*
    Draw each top-crush cab as flat as drive mode has crushed it: a blend from its first frame
    to its last. A fresh drive starts every cab upright again, as its colliders do.
  */
  _applyCrush(colliders) {
    for (const solid of colliders?.crushables ?? []) {
      const cab = this._crushCabs.get(solid.sourceIndex);
      if (!cab || cab.amount === solid.crush.amount) continue;
      cab.amount = solid.crush.amount;
      for (const mesh of cab.meshes) setKeyframeBlend(mesh.morphTargetInfluences, 0, cab.frameCount - 1, cab.amount);
      this._shadows.invalidateDynamic();
    }
  }

  _resetCrush() {
    for (const cab of this._crushCabs.values()) {
      cab.amount = 0;
      for (const mesh of cab.meshes) mesh.morphTargetInfluences?.fill(0);
    }
  }

  _updateTerrainOverlap() {
    const enabled = this._renderFlags.terrainOverlap === true;
    if (enabled === this._terrainOverlapApplied) return;
    for (const target of this._terrainUvTargets) {
      target.geometry.attributes.uv.array.set(enabled ? target.overlap : target.full);
      target.geometry.attributes.uv.needsUpdate = true;
    }
    this._terrainOverlapApplied = enabled;
  }

  _registerTerrainUvs(geometry, data) {
    const full = new Float32Array(data.uvs);
    const overlap = new Float32Array(data.uvsOverlap ?? data.uvs);
    geometry.setAttribute("uv", new THREE.BufferAttribute(
      new Float32Array(this._renderFlags.terrainOverlap === true ? overlap : full), 2));
    this._terrainUvTargets.push({ geometry, full, overlap });
  }

  /*
    Once a frame: set up any lit material the cascades have not seen, refit them to the
    camera, and redraw the shadow maps only when something they depend on changed. The
    sweep runs when the scene is known to have changed and once a second besides, so a
    material created somewhere unexpected is never lit several times over for long.
  */
  _updateShadows() {
    this._frameCount++;
    if (this._shadowMaterialsDirty || this._frameCount % SHADOW_MATERIAL_SWEEP_FRAMES === 0) {
      this._shadows.setupMaterials();
      this._shadowMaterialsDirty = false;
    }
    // A driven truck moves every frame; the near cascades follow it closely, far ones in turn.
    if (this._drive?.isActive) this._shadows.invalidateDynamic();
    this._shadows.update();
  }

  setTextureSmoothingEnabled(enabled) {
    this._textureSmoothingEnabled = enabled;
    const textures = [this._terrainAtlasTex, ...Object.values(this._modelTexCache ?? {})];
    for (const mesh of this._groups.racetrack.children) {
      if (mesh.material?.map) textures.push(mesh.material.map);
    }
    // The TV sky keeps its mipmaps: a tiled 64x64 ceiling shimmers badly without them.
    const skyMap = this._tvSkyPlane?.material?.map;
    if (skyMap) {
      skyMap.magFilter = enabled ? THREE.LinearFilter : THREE.NearestFilter;
      skyMap.needsUpdate = true;
    }
    for (const texture of textures) {
      if (!texture) continue;
      texture.magFilter = enabled ? THREE.LinearFilter : THREE.NearestFilter;
      texture.minFilter = enabled ? THREE.LinearFilter : THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
    }
  }

  /*
    Which layers the loaded track actually has, keyed by render flag.

    Answered from what got built rather than from a table of what each game is supposed to
    carry. A toggle for a layer with nothing in it is a control that does nothing, and there
    are a lot of them: an MTM track has no navigation points, tunnels or powerups, a TV level
    has no checkpoints or trucks, Evo has no ground boxes, and only CPR has a road surface.
    Reading the groups keeps that list correct on its own - a layer added later shows up here
    the moment it builds geometry, and a track that unexpectedly does carry one is not hidden
    because a table said its game never does.

    Grid and wireframe are drawn from other layers; sunlight and its shadows use the scene's
    directional light. Those controls are always available.
  */
  layerPresence() {
    const g = this._groups;
    const has = (...groups) => groups.some((name) => g[name].children.length > 0);
    const objects = has("objects", "billboards", "vegetation", "checkpoints", "ramps");
    return {
      terrain:    !!this._terrainMesh || !!this._flyTileMeshes?.length,
      textures:   !!this._terrainMesh || !!this._flyTileMeshes?.length,
      terrainOverlap: !!this._terrainMesh,
      grid:       !!this._terrainMesh || !!this._flyTileMeshes?.length,
      objects,
      billboards: has("billboards"),
      checkpoints: has("checkpoints"),
      racetrack:  has("racetrack"),
      underground: has("underground"),
      gboxes:     has("gboxes"),
      cboxes:     has("cboxes"),
      wireframe:  objects || has("racetrack", "gboxes", "cboxes"),
      trucks:     has("trucks"),
      navpoints:  has("navPoints"),
      cpmarkers:  has("checkpointMarkers"),
      tunnels:    has("tunnels"),
      powerups:   has("powerups"),
      water:      has("water"),
      backdrop:   has("backdrop"),
      sky:        !!this._trackData?.tvSky,
      // MTM1's Classic sky brings the TV fog with it.
      fog:        !!this._trackData?.tvSky || this._effectiveSkyStyle() === "classic",
      animate:    (this._textureAnimations?.length ?? 0) > 0 || this._keyframeAnimations.length > 0,
      movingObjects: (this._movers?.count ?? 0) > 0,
      sunlight:   true,
      shadows:    true,
      lensflare:  this.weatherApplies(),
    };
  }

  _applyVisibility() {
    const f = this._renderFlags;
    this._groups.terrain.visible = f.terrain;
    // CPR's road surface is its own layer, not one of the placed objects, and only CPR has
    // one. It gets its own toggle rather than riding on `objects`.
    this._groups.racetrack.visible = f.racetrack !== false;
    // With the road hidden, the ground it covers is shown again.
    this._roadMaskUniforms.roadMaskEnabled.value = this._roadMaskTarget && f.racetrack !== false ? 1 : 0;
    this._groups.terrainGrid.visible = f.grid;
    this._groups.objects.visible = f.objects;
    this._groups.objectsWire.visible = f.objects && (f.wireframe === true);
    this._groups.billboards.visible = f.objects;
    this._groups.vegetation.visible = f.objects;
    this._groups.vegetationWire.visible = f.objects && (f.wireframe === true);
    this._groups.billboardsWire.visible = f.objects && (f.wireframe === true);
    this._groups.checkpoints.visible = f.objects && f.checkpoints !== false;
    this._groups.checkpointsWire.visible = f.objects && f.checkpoints !== false && (f.wireframe === true);
    this._groups.racetrackWire.visible = f.racetrack !== false && (f.wireframe === true);
    this._groups.gboxes.visible = f.gboxes;
    this._groups.gboxesWire.visible = f.gboxes && (f.wireframe === true);
    /*
      The cavern is one toggle covering its floor, its ceiling, its ground boxes and the
      objects standing in it. They are one place, and showing the room without what is in it
      is not a view anyone wants.
    */
    this._groups.underground.visible = f.underground !== false;
    this._groups.undergroundWire.visible = f.underground !== false && (f.wireframe === true);
    this._groups.cboxes.visible = f.cboxes;
    this._groups.cboxesWire.visible = f.cboxes && (f.wireframe === true);
    // A ramp is track the player drives on, not an invisible collision helper, so it is one of
    // the objects rather than a layer of its own: only MTM 1 and MTM 2 author any, CPR writes
    // the section and always leaves it empty, and Evo has no such section at all.
    this._groups.ramps.visible = f.objects;
    this._groups.rampsWire.visible = f.objects && (f.wireframe === true);
    this._groups.navPoints.visible = f.navpoints !== false;
    this._groups.checkpointMarkers.visible = f.cpmarkers !== false;
    this._groups.tunnels.visible = f.tunnels !== false;
    this._groups.powerups.visible = f.powerups !== false;
    this._groups.water.visible = f.water;
    this._groups.trucks.visible = f.trucks !== false;
    // Not tied to the `trucks` toggle: that one hides the start-grid markers, and hiding the
    // vehicle you are driving with it would be a surprise. It is empty outside drive mode.
    this._groups.driveTruck.visible = true;
    this._groups.hitboxes.visible = f.hitboxes === true;
    this._groups.backdrop.visible = f.backdrop;
    this._applyTvSky();
    /*
      Backdrop hides the scenery around the world (the mountains, an arena) and nothing else:
      the sky, whether the weather's, a track's own texture or MTM1's Classic one, stays.
    */
    if (this._sky) {
      this._sky.visible = !!this._weatherPreset() && this._effectiveSkyStyle() !== "classic";
    }
    if (this._sun) {
      // The cascades light the scene while they cast; otherwise the plain sun does.
      const sunlight = f.sunlight !== false;
      const shadows = sunlight && f.shadows !== false && !!this._trackData
        && this._weatherPreset()?.shadows !== false;
      if (shadows !== this._shadows.enabled) this._shadows.setEnabled(shadows);
      this._sun.visible = sunlight && !shadows;
      if (shadows) this._shadows.invalidate();
      // The terrain material may just have been swapped for one not set up yet.
      this._shadowMaterialsDirty = true;
    }

    // texture toggle: swap between textured and flat terrain material
    const terrainMaterial = f.textures ? this._terrainMatTextured : this._terrainMatFlat;
    if (this._terrainMesh) this._terrainMesh.material = terrainMaterial;
    for (const mesh of this._flyTileMeshes ?? []) {
      mesh.material = f.textures ? mesh.userData.texturedMaterial : this._terrainMatFlat;
    }
    const undergroundMaterial = f.textures
      ? (this._undergroundMatTextured ?? this._terrainMatFlat)
      : this._terrainMatFlat;
    for (const surface of this._undergroundSurfaces ?? []) surface.material = undergroundMaterial;
  }

  setHeightScale(hs) {
    this._heightScale = hs;
  }

  clearTrack() {
    this.stopDrive();
    /*
      The truck disposes itself, because the loop below cannot.

      That loop frees each child's own geometry and material, which is right for a layer built
      from meshes. The truck's child is a Group with the whole vehicle nested under it, so the
      loop would free nothing at all and leak every mesh and material on each track change.
    */
    this._truckLights?.dispose();
    this._truckLights = null;
    this._driveTruck?.dispose();
    this._driveTruck = null;
    // Course groups nest their line and label, which the flat loop below does not reach.
    for (const { group } of this._courses) {
      for (const child of group.children) { child.geometry?.dispose(); child.material?.dispose(); }
    }
    this._courses = [];
    for (const g of Object.values(this._groups)) {
      while (g.children.length) {
        const child = g.children[0];
        g.remove(child);
        child.geometry?.dispose();
        if (child.material) {
          (Array.isArray(child.material) ? child.material : [child.material]).forEach((m) => m.dispose());
        }
      }
    }
    this._terrainMesh = null;
    // The loop above frees the material each Fly! chunk wears now, which is the flat one while
    // textures are off, and never the textures themselves. Replies still on their way belong
    // to this scenery and are dropped when they land.
    this._flyDetailGeneration = (this._flyDetailGeneration ?? 0) + 1;
    for (const mesh of this._flyTileMeshes ?? []) {
      this._dropFlyDetail(mesh);
      mesh.userData.tileMaterial?.dispose();
    }
    for (const texture of this._flyTileTextures ?? []) texture.dispose();
    for (const resource of this._flyObjectResources ?? []) resource.dispose();
    this._flyObjectResources = [];
    this._flyTileTextures = [];
    // Fly! moves the near plane with the camera's height (_updateFlyNearPlane); put it back.
    if (this._camera.near !== 1) {
      this._camera.near = 1;
      this._camera.updateProjectionMatrix();
    }
    this._flyTileMeshes = [];
    /*
      The cavern surfaces share the terrain material rather than owning one, so the loop above
      disposes that material once per mesh that references it. Dropping the references here is
      what keeps the next track from swapping a disposed material back in.
    */
    this._undergroundSurfaces = [];
    this._trackSunDirection = null;
    this._undergroundMatTextured = null;
    this._undergroundWireMat = null;
    this._terrainMatTextured = null;
    this._terrainMatFlat = null;
    this._terrainAtlasTex?.dispose();
    this._terrainAtlasTex = null;
    this._roadMaskTarget?.dispose();
    this._roadMaskTarget = null;
    this._roadMaskUniforms.roadMask.value = null;
    this._roadMaskUniforms.roadMaskEnabled.value = 0;
    this._terrainAtlasN = 1;
    this._terrainAtlasCols = 1;
    this._terrainAtlasRows = 1;
    this._terrainAtlasWidth = 1;
    this._terrainAtlasHeight = 1;
    this._terrainAtlasTileSize = 64;
    this._terrainAtlasPadding = 0;
    this._terrainAtlasSourceTileSize = 64;
    this._backdropMesh = null;
    this._skyTextureMesh = null;
    this._tvSkyPlane = null;
    this._tvSkyFollowsCamera = false;
    this._tvStars = null;
    this._tvFog = null;
    this._scene.fog = null;
    this._flareFrame = null;
    this._arenaMesh = null;
    this._terrainRaw = null;
    this._terrainUvTargets = [];
    this._terrainOverlapApplied = null;
    for (const texture of this._labelTextures ?? []) texture.dispose();
    this._labelTextures = [];
    this._textureAnimations = [];
    this._animationClock = 0;
    this._keyframeAnimations = [];
    this._keyframeClock = 0;
    this._crushCabs = new Map();
    this._objectsByBox = new Map();
    this._movers = null;
    this._classicSky = false;
    this._modelTexCache = {};
    this._trackData = null;
    this._shadows.setEnabled(false);
    this._shadows.forgetMaterials();
    this._scene.background = null;
    this._renderer.setClearColor(EMPTY_BACKGROUND_COLOR);
  }

  setTrack(trackData, renderFlags, heightScale) {
    this.clearTrack();
    this._trackData = trackData;
    this._renderer.setClearColor(BACKGROUND_COLOR);
    if (renderFlags) Object.assign(this._renderFlags, renderFlags);
    if (heightScale !== undefined) this._heightScale = heightScale;
    if (trackData.terrain?.heightScale) this._heightScale = trackData.terrain.heightScale;
    this._modelTexCache = {};

    if (trackData.modelTextures) this._loadModelTextures(trackData.modelTextures);
    if (trackData.flyTiles) this._buildFlyTerrain(trackData.flyTiles, trackData.fly);
    else if (trackData.terrain) this._buildTerrain(trackData.terrain);
    // An arena REPLACES the backdrop rather than joining it: Traxx suppresses the backdrop
    // model at load (TrackPODFile.cpp:2758-2759) and again at draw
    // (TraxxViewDisplay.cpp:307-311, `openglbackdrop = arena.arena == FALSE && ...`).
    // The stadium is a closed shell, so there is no sky left to show behind it.
    // Otherwise: prefer BIN model (MTM2), fall back to RAW sky texture (TV/F3/HB).
    if (trackData.arena && trackData.models?.[trackData.arena.modelName]) {
      this._buildArena(trackData);
    } else if ((trackData.backdropModelNames?.length || trackData.backdropModelName) &&
               (trackData.backdropModelNames ?? [trackData.backdropModelName]).some((name) => trackData.models?.[name])) {
      for (const name of trackData.backdropModelNames ?? [trackData.backdropModelName]) {
        this._buildBackdropModel(name, trackData);
      }
    } else if (trackData.tvSky) {
      this._buildTvSky(trackData);
    } else if (trackData.skyTexture) {
      this._buildBackdropFromTexture(trackData.skyTexture);
    }
    if (trackData.classicSky && trackData.skyTexture?.rgba && trackData.origin === "MTM1") {
      this._buildClassicSky(trackData);
    }
    if (trackData.waterLevel > 0) this._buildWater(trackData);
    if (trackData.raceTrackSurfaces?.length) this._buildRaceTrackLayer(trackData);
    this._buildCourses(trackData);
    if (trackData.boxes?.length) this._buildObjects(trackData);
    if (trackData.flyObjects?.length) this._buildFlyObjects(trackData);
    this._reportMissingModelTextures(trackData);
    if (trackData.groundBoxes?.length) this._buildGroundBoxes(trackData.groundBoxes, this._heightScale, trackData);
    this._buildUnderground(trackData);
    if (trackData.trucks?.length) this._buildTrucks(trackData);
    if (trackData.vegetation?.trees?.length) this._buildVegetation(trackData);
    if (trackData.navPoints?.length) this._buildNavPoints(trackData);
    if (trackData.checkpoints?.length) this._buildCheckpointMarkers(trackData);
    if (trackData.tunnels?.length) this._buildTunnelMarkers(trackData);
    this._buildPowerups(trackData);
    // Markers are map legends, not scenery: fog must not fade them out.
    for (const name of ["navPoints", "checkpointMarkers", "tunnels", "powerups"]) {
      this._groups[name].traverse((child) => { if (child.material) child.material.fog = false; });
    }
    this._installTextureAnimations(trackData);
    // Trains and aircraft; the same movers carry on into drive mode's colliders.
    this._flareFrame = createWorldFrame(trackData);
    this._movers = createMovers(trackData, this._flareFrame);
    this._movers.setEnabled(this._renderFlags.movingObjects !== false);

    this._nav.resetToCourseStart(trackData, this._heightScale);
    // A Fly! world's cells are 200 times the others', and the far plane counts them.
    if (this._viewDistanceCells) this.setViewDistance(this._viewDistanceCells);

    this._applyVisibility();
    this._updateSunFromTrackData(trackData);
    this._applyWeather();
    this._shadowMaterialsDirty = true;
  }

  /*
    Hellbender's cavern: a floor, a ceiling, and the ground boxes standing between them.

    The two surfaces are ordinary terrain meshes - same builder, same grid, same texture atlas
    as the ground above - offset into the altitude band the cavern grids are biased into and
    masked to the cells the level says are hollow. See hb-underground.js for what that band is
    and how it was measured.

    They share the surface terrain's material, which is why they are built after it. That is
    not only a memory saving: the atlas is a transferable buffer, so the worker builds one and
    hands it over once, and the two cavern meshes arrive with no atlas of their own.
  */
  _buildUnderground(trackData) {
    const group = this._groups.underground;

    /*
      The cavern is drawn unlit.

      The scene has one directional light standing in for the sun, and underground there is no
      sun: the ceiling faces away from it by definition and the floor is shadowed by the whole
      map above it, so a Lambert cavern renders almost black however the sun slider is set.
      Hellbender's own art is already shaded into the texture - these are the same 64x64 tiles
      the surface uses - so drawing the two cavern surfaces at texture brightness shows what
      the level actually contains, which is the entire point of the layer.
    */
    if (this._terrainAtlasTex && !this._undergroundMatTextured) {
      /*
        DoubleSide, unlike the surface terrain.

        A heightfield quad is wound to be seen from above, which is the only side there is when
        the surface you are drawing is the ground. A cavern has two: its floor folds into
        cliffs and overhangs that are approached from either hand, and the seam that closes it
        against solid rock is a near-vertical quad whose facing depends on which way the cavern
        happens to end. With FrontSide, roughly half of those walls vanish - the ones leaning
        away from the camera - which reads as a cave with two of its four sides missing.
      */
      this._undergroundMatTextured = new THREE.MeshBasicMaterial({
        map: this._terrainAtlasTex, side: THREE.DoubleSide,
      });
    }
    if (!this._undergroundWireMat) {
      this._undergroundWireMat = new THREE.MeshBasicMaterial({
        color: UNDERGROUND_WIRE_COLOR, wireframe: true,
      });
    }
    const addSurface = (mesh) => {
      if (!mesh) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
      geo.setAttribute("normal",   new THREE.BufferAttribute(new Float32Array(mesh.normals), 3));
      this._registerTerrainUvs(geo, mesh);
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
      geo.computeBoundingSphere();
      const surface = new THREE.Mesh(geo, this._undergroundMatTextured ?? this._terrainMatFlat);
      group.add(surface);
      this._undergroundSurfaces.push(surface);

      /*
        The wireframe shares the geometry rather than building an edge list of its own. A
        cavern surface is one quad per grid cell, so an EdgesGeometry over it would be tens of
        thousands of segments for a view that is only ever glanced at; a second mesh on the
        same buffers costs nothing but a draw call.
      */
      const wire = new THREE.Mesh(geo, this._undergroundWireMat);
      this._groups.undergroundWire.add(wire);
    };
    addSurface(trackData.undergroundFloor);
    addSurface(trackData.undergroundCeiling);

    if (trackData.undergroundBoxes?.length) {
      this._buildGroundBoxes(trackData.undergroundBoxes, this._heightScale, trackData,
        group, this._groups.undergroundWire);
    }
  }

  _buildTerrain(terrainData) {
    const { gridSize, cellSize, positions, normals, indices, atlas } = terrainData;

    // Kept for marker placement: the raw heightfield is what puts a marker on the ground.
    this._terrainRaw = terrainData.rawData ? new Uint8Array(terrainData.rawData) : null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("normal",   new THREE.BufferAttribute(new Float32Array(normals), 3));
    this._registerTerrainUvs(geo, terrainData);
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    const baked = !!terrainData.lights;
    if (baked) geo.setAttribute("lteLight", new THREE.BufferAttribute(new Float32Array(terrainData.lights), 1));

    // Atlas texture
    const atlasImg = new ImageData(new Uint8ClampedArray(atlas.rgba), atlas.width, atlas.height);
    const atlasTex = new THREE.DataTexture(atlasImg.data, atlas.width, atlas.height, THREE.RGBAFormat);
    atlasTex.wrapS = atlasTex.wrapT = THREE.ClampToEdgeWrapping;
    atlasTex.magFilter = this._textureSmoothingEnabled ? THREE.LinearFilter : THREE.NearestFilter;
    atlasTex.minFilter = atlasTex.magFilter;
    atlasTex.generateMipmaps = false;
    atlasTex.colorSpace = THREE.SRGBColorSpace;
    atlasTex.needsUpdate = true;

    this._terrainMatTextured = new THREE.MeshLambertMaterial({ map: atlasTex, side: THREE.FrontSide });
    this._terrainMatFlat = new THREE.MeshLambertMaterial({ color: 0x4a7a4a, side: THREE.FrontSide });
    this._installTerrainShader(this._terrainMatTextured, baked);
    this._installTerrainShader(this._terrainMatFlat, baked);
    this._terrainAtlasTex = atlasTex;
    this._terrainAtlasN = atlas.textureCount;
    this._terrainAtlasCols = atlas.atlasCols ?? atlas.textureCount ?? 1;
    this._terrainAtlasRows = atlas.atlasRows ?? 1;
    this._terrainAtlasWidth = atlas.width ?? 1;
    this._terrainAtlasHeight = atlas.height ?? 1;
    this._terrainAtlasTileSize = atlas.atlasTileSize ?? 64;
    this._terrainAtlasPadding = atlas.atlasPadding ?? 0;
    this._terrainAtlasSourceTileSize = atlas.sourceTileSize ?? 64;
    this._terrainAtlasLegacySides = atlas.slotLegacySides ?? [];

    this._terrainMesh = new THREE.Mesh(geo, this._terrainMatTextured);
    this._terrainMesh.receiveShadow = true;
    this._groups.terrain.add(this._terrainMesh);

    // Grid overlay: quad edges only (no triangle diagonals)
    const posArr = geo.attributes.position.array;
    const lineVerts = [];
    const pushV = (vi) => { const i = vi * 3; lineVerts.push(posArr[i], posArr[i + 1], posArr[i + 2]); };
    for (let cz = 0; cz < gridSize; cz++) {
      for (let cx = 0; cx < gridSize; cx++) {
        const vb = (cx + cz * gridSize) * 4;
        pushV(vb); pushV(vb + 1);        // top edge (v0→v1)
        pushV(vb); pushV(vb + 3);        // left edge (v0→v3)
        if (cx === gridSize - 1) { pushV(vb + 1); pushV(vb + 2); } // right border
        if (cz === gridSize - 1) { pushV(vb + 3); pushV(vb + 2); } // bottom border
      }
    }
    const gridLinGeo = new THREE.BufferGeometry();
    gridLinGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(lineVerts), 3));
    const gridMat = new THREE.LineBasicMaterial({ color: 0x8888cc, opacity: 0.65, transparent: true });
    this._groups.terrainGrid.add(new THREE.LineSegments(gridLinGeo, gridMat));
  }

  /*
    Fly! scenery: each globe tile is 8 x 8 chunk meshes of 8 x 8 cells, draped in its imagery.
    The worker's grid has 4 points a cell side, where the game's finer .AL2 heights need them.

    The worker stitches a tile's 4,096 cell textures into one orthophoto at 32 px a cell (see
    fly-loader.js). It is a single continuous texture per tile, so unlike the other games'
    atlases it can be mipmapped: from altitude a tile is mostly seen at a steep angle and a long
    way off, where an unfiltered photo shimmers. Every chunk of the tile draws it through the
    first UV set.

    Close to the ground that is 60 m a pixel, so the chunks nearest the camera are redrawn at
    the textures' own 128 px a cell, fetched from the worker one chunk at a time and mapped
    through a second UV set that runs 0 to 1 across the chunk (_updateFlyDetail). The Textures
    toggle swaps in the shared flat material, as for any other terrain.
  */
  _buildFlyTerrain(tiles, fly) {
    this._terrainMatFlat = new THREE.MeshLambertMaterial({ color: 0x4a7a4a, side: THREE.FrontSide });
    this._flyTileMeshes = [];
    this._flyTileTextures = [];
    this._flyDetailCells = fly?.detailChunkCells ?? 8;
    const anisotropy = this._renderer.capabilities.getMaxAnisotropy();
    const cellsPerChunk = this._flyDetailCells;
    const gridMat = new THREE.LineBasicMaterial({ color: 0x8888cc, opacity: 0.65, transparent: true });
    for (const tile of tiles) {
      // The worker refines the grid to `subdivisions` points a cell side (fly-loader.js).
      const sub = tile.subdivisions ?? 1;
      const side = 64 * sub + 1;
      const n = cellsPerChunk * sub;
      const positions = new Float32Array(tile.positions);
      const normals = new Float32Array(tile.normals);
      const uvs = new Float32Array(tile.uvs);

      const { rgba, width, height } = tile.image;
      const texture = new THREE.DataTexture(new Uint8Array(rgba.buffer ?? rgba), width, height, THREE.RGBAFormat);
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = anisotropy;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      this._flyTileTextures.push(texture);
      const material = new THREE.MeshLambertMaterial({ map: texture, side: THREE.FrontSide });
      // A tile with city lights glows with them after dark (_applyFlyNight).
      let nightTexture = null;
      if (tile.night) {
        nightTexture = new THREE.DataTexture(new Uint8Array(tile.night.rgba.buffer ?? tile.night.rgba), tile.night.width, tile.night.height, THREE.RGBAFormat);
        nightTexture.magFilter = THREE.LinearFilter;
        nightTexture.minFilter = THREE.LinearMipmapLinearFilter;
        nightTexture.generateMipmaps = true;
        nightTexture.colorSpace = THREE.SRGBColorSpace;
        nightTexture.needsUpdate = true;
        this._flyTileTextures.push(nightTexture);
        material.emissiveMap = nightTexture;
        material.emissive = new THREE.Color(0xffffff);
        material.emissiveIntensity = 0;
      }

      for (let cz = 0; cz < 64 / cellsPerChunk; cz++) {
        for (let cx = 0; cx < 64 / cellsPerChunk; cx++) {
          const count = (n + 1) * (n + 1);
          const p = new Float32Array(count * 3), nr = new Float32Array(count * 3);
          const uv = new Float32Array(count * 2), uv1 = new Float32Array(count * 2);
          let ground = 0;
          for (let r = 0; r <= n; r++) {
            for (let c = 0; c <= n; c++) {
              const from = (cz * n + r) * side + cx * n + c, to = r * (n + 1) + c;
              p.set(positions.subarray(from * 3, from * 3 + 3), to * 3);
              nr.set(normals.subarray(from * 3, from * 3 + 3), to * 3);
              uv.set(uvs.subarray(from * 2, from * 2 + 2), to * 2);
              uv1[to * 2] = c / n;
              uv1[to * 2 + 1] = r / n;
              ground += positions[from * 3 + 1];
            }
          }
          const index = new Uint32Array(n * n * 6);
          let k = 0;
          for (let r = 0; r < n; r++) {
            for (let c = 0; c < n; c++) {
              const a = r * (n + 1) + c, b = a + 1, d = a + n + 1, e = d + 1;
              index[k++] = a; index[k++] = d; index[k++] = b;
              index[k++] = b; index[k++] = d; index[k++] = e;
            }
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(p, 3));
          geo.setAttribute("normal", new THREE.BufferAttribute(nr, 3));
          geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
          geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
          geo.setIndex(new THREE.BufferAttribute(index, 1));
          geo.computeBoundingSphere();

          const mesh = new THREE.Mesh(geo, material);
          mesh.name = `${tile.folder} ${cx},${cz}`;
          mesh.userData.tileMaterial = material;
          mesh.userData.texturedMaterial = material;
          mesh.userData.nightTexture = nightTexture;
          mesh.userData.fly = {
            folder: tile.folder, chunkX: cx, chunkZ: cz,
            minX: p[0], minZ: p[2], maxX: p[(count - 1) * 3], maxZ: p[(count - 1) * 3 + 2],
            ground: ground / count, detail: null, pending: false,
          };
          mesh.receiveShadow = true;
          this._groups.terrain.add(mesh);
          this._flyTileMeshes.push(mesh);
        }
      }
      this._groups.terrainGrid.add(this._flyGridLines(positions, side, sub, gridMat));
    }
  }

  /*
    The Grid layer for a Fly! tile: every cell edge, about 2 km apart, drawn through the
    refined mesh's points so the lines follow the relief rather than cutting through it. They
    are lifted a thousandth of a cell (about 8 ft) so the ground does not hide them from far
    off, where a depth buffer spread over a 1.6 million unit world cannot tell them apart.
  */
  _flyGridLines(positions, side, sub, material) {
    const lift = this._trackData.terrain.cellSize / 1000;
    const vertices = [];
    const point = (col, row) => {
      const i = (row * side + col) * 3;
      vertices.push(positions[i], positions[i + 1] + lift, positions[i + 2]);
    };
    for (let line = 0; line < side; line += sub) {
      for (let k = 0; k < side - 1; k++) {
        point(k, line); point(k + 1, line);   // along a row of cell edges, west to east
        point(line, k); point(line, k + 1);   // along a column, north to south
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices), 3));
    return new THREE.LineSegments(geo, material);
  }

  /*
    A Fly! world is 1.6 million units across and seen from anywhere between a truck's bumper
    and 30,000 ft, which no single near plane serves: 1 unit keeps the truck but spends the
    depth buffer's precision on the first few feet. So the near plane follows the camera's
    height above the ground, a hundredth of it and at least 1 unit, and the far plane stays
    where the view distance puts it.
  */
  _updateFlyNearPlane() {
    if (this._trackData?.origin !== "FLY" || !this._flareFrame) return;
    const cam = this._camera.position;
    const ground = this._flareFrame.heightAtFeet(cam.x / UNITS_PER_FOOT_H, cam.z / UNITS_PER_FOOT_H) * UNITS_PER_FOOT_V;
    const near = Math.min(2000, Math.max(1, (cam.y - ground) / 100));
    if (Math.abs(near - this._camera.near) > this._camera.near * 0.1) {
      this._camera.near = near;
      this._camera.updateProjectionMatrix();
    }
  }

  /** Where Fly! detail chunks come from: (folder, chunkX, chunkZ) => Promise<{rgba, width, height}>. */
  setFlyDetailProvider(provider) {
    this._flyDetailProvider = provider;
  }

  /*
    Keep the chunks nearest the camera at full resolution.

    Nearness is the distance from the camera to the chunk's ground: across to its nearest edge
    and down to its average height, so flying high over a chunk counts as being far from it.
    Up to FLY_DETAIL_BUDGET chunks within FLY_DETAIL_RANGE hold a full-resolution texture
    (4 MB each, a third more with mipmaps); the rest fall back to their tile's orthophoto, and
    a chunk that drops out of the nearest set gives its texture up. Requests go to the worker
    two at a time, nearest first, and a reply that arrives after the scenery changed is
    dropped.
  */
  _updateFlyDetail(dt) {
    if (!this._flyTileMeshes?.length || !this._flyDetailProvider) return;
    this._flyDetailClock = (this._flyDetailClock ?? 0) + dt;
    if (this._flyDetailClock < 0.25) return;
    this._flyDetailClock = 0;

    const cam = this._camera.position;
    const ranked = [];
    for (const mesh of this._flyTileMeshes) {
      const f = mesh.userData.fly;
      const dx = Math.max(f.minX - cam.x, 0, cam.x - f.maxX);
      const dz = Math.max(f.minZ - cam.z, 0, cam.z - f.maxZ);
      const distance = Math.hypot(dx, dz, Math.max(0, cam.y - f.ground));
      if (distance < FLY_DETAIL_RANGE_CELLS * this._trackData.terrain.cellSize) ranked.push({ mesh, distance });
    }
    ranked.sort((a, b) => a.distance - b.distance);
    const wanted = new Set(ranked.slice(0, FLY_DETAIL_BUDGET).map((r) => r.mesh));

    for (const mesh of this._flyTileMeshes) {
      if (mesh.userData.fly.detail && !wanted.has(mesh)) this._dropFlyDetail(mesh);
    }
    let inFlight = this._flyTileMeshes.filter((m) => m.userData.fly.pending).length;
    const generation = this._flyDetailGeneration;
    for (const { mesh } of ranked.slice(0, FLY_DETAIL_BUDGET)) {
      if (inFlight >= 2) break;
      const f = mesh.userData.fly;
      if (f.detail || f.pending) continue;
      f.pending = true;
      inFlight++;
      this._flyDetailProvider(f.folder, f.chunkX, f.chunkZ).then((image) => {
        f.pending = false;
        if (generation !== this._flyDetailGeneration || !this._flyTileMeshes.includes(mesh)) return;
        this._applyFlyDetail(mesh, image);
      }, (err) => {
        f.pending = false;
        console.warn(`Fly! detail ${mesh.name}: ${err?.message ?? err}`);
      });
    }
  }

  _applyFlyDetail(mesh, { rgba, width, height }) {
    const texture = new THREE.DataTexture(new Uint8Array(rgba), width, height, THREE.RGBAFormat);
    texture.channel = 1;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = this._renderer.capabilities.getMaxAnisotropy();
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    const material = new THREE.MeshLambertMaterial({ map: texture, side: THREE.FrontSide });
    // The lights stay on the tile's own UV set; only the daylight imagery is sharper.
    if (mesh.userData.nightTexture) {
      material.emissiveMap = mesh.userData.nightTexture;
      material.emissive = new THREE.Color(0xffffff);
      material.emissiveIntensity = mesh.userData.tileMaterial.emissiveIntensity;
    }
    mesh.userData.fly.detail = { texture, material };
    mesh.userData.texturedMaterial = material;
    if (this._renderFlags.textures !== false) mesh.material = material;
    this._shadowMaterialsDirty = true;
  }

  _dropFlyDetail(mesh) {
    const { detail } = mesh.userData.fly;
    if (!detail) return;
    mesh.userData.texturedMaterial = mesh.userData.tileMaterial;
    if (mesh.material === detail.material) mesh.material = mesh.userData.tileMaterial;
    detail.material.dispose();
    detail.texture.dispose();
    mesh.userData.fly.detail = null;
  }

  /*
    Fly! buildings and landmarks.

    The worker has already put each object in scene space: `position` is the bottom centre of
    its model (see fly-loader.js), and the decoder's units are the scene's. What is left is the
    Traxx-local to scene axis swap every BIN model needs, traxxModelMatrix as for MTM, and
    putting the recentred mesh back on the model's own vertical axis. One geometry per model
    mesh is shared by every placement of it.
  */
  _buildFlyObjects(trackData) {
    const geometries = new Map();
    const materials = new Map();
    const wireMat = new THREE.LineBasicMaterial({ color: 0xF5E287 });
    for (const object of trackData.flyObjects) {
      const model = trackData.models?.[object.modelName];
      if (!model?.meshes?.length) continue;
      if (!geometries.has(object.modelName)) {
        geometries.set(object.modelName, model.meshes.map((mesh) => {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
          geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(mesh.normals), 3));
          geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(mesh.uvs), 2));
          geo.computeBoundingSphere();
          return { geo, edges: new THREE.EdgesGeometry(geo), mesh };
        }));
      }
      const [x, y, z] = object.position;
      // Heading is clockwise from north, which is traxxModelMatrix's own sense: matched against
      // the imagery at SFO, where the terminal's piers only land on the photographed ones so.
      // The decoder's units are the scene's, and the 0.75 height stretch is the terrain's too.
      const matrix = traxxModelMatrix(object.heading, 0, 0, x, y, z)
        .multiply(new THREE.Matrix4().makeTranslation(model.anchor?.x ?? 0, model.anchor?.y ?? 0, 0));
      const group = new THREE.Group();
      const wire = new THREE.Group();
      group.name = wire.name = object.name;
      for (const part of [group, wire]) {
        part.matrixAutoUpdate = false;
        part.matrix.copy(matrix);
        part.matrixWorldNeedsUpdate = true;
      }
      for (const { geo, edges, mesh } of geometries.get(object.modelName)) {
        const key = `${object.modelName}|${model.meshes.indexOf(mesh)}`;
        if (!materials.has(key)) materials.set(key, this._createModelMaterial(mesh));
        const material = materials.get(key);
        const solid = new THREE.Mesh(geo, material);
        if (!material.transparent && material.depthWrite && material.blending === THREE.NormalBlending) {
          solid.castShadow = true;
          material.shadowSide = material.side;
        }
        group.add(solid);
        wire.add(new THREE.LineSegments(edges, wireMat));
      }
      this._groups.objects.add(group);
      this._groups.objectsWire.add(wire);
    }
    // Nested under a group per placement, so clearTrack's flat loop cannot reach them.
    this._flyObjectResources = [
      ...[...geometries.values()].flat().flatMap(({ geo, edges }) => [geo, edges]),
      ...materials.values(),
      wireMat,
    ];
  }

  /*
    The arena is ordinary world geometry, not a sky.

    That distinction is the whole implementation. A backdrop is drawn with depth testing off,
    at renderOrder -1, and is re-centred on the camera every frame so it never appears to
    move. An arena is a stadium standing on the terrain at a fixed grid position: it has to
    occlude and be occluded, and it must stay put. So it goes through the normal model
    material and the normal object matrix, and it is deliberately NOT assigned to
    `_backdropMesh`, which is what the render loop follows the camera with.

    It still lives in the backdrop GROUP, so the existing Backdrop toggle hides it - Traxx
    gates it on the same `reg.show_backdrop` (TraxxViewDisplay.cpp:275-279).

    Placement (worldX/worldY/groundZ) is computed in the worker; see placeArena there for why
    the ground sample is taken under the model's lowest vertex rather than under its origin.
  */
  _buildArena(trackData) {
    const arena = trackData.arena;
    const model = trackData.models?.[arena?.modelName];
    if (!model?.meshes?.length) return;

    const ws = this._worldSize(trackData);
    const modelAnchor = model.anchor ?? { x: 0, y: 0, z: 0 };

    /*
      Traxx transforms the model's own coordinates; this viewer stores them anchor-relative.
      Rather than rewriting every vertex, fold the anchor into the translation - the arena
      transform is a translate composed with a Z stretch, so the anchor lands in the offset
      exactly, and the 0.75 applies to its Z the same way it applies to a vertex.

      With no rotation this is traxxModelMatrix at zero angles, which is used rather than a
      hand-built matrix so the arena cannot drift from the object path if that math changes.
    */
    const posX = arena.worldX + modelAnchor.x;
    const posY = arena.groundZ + TRAXX_Z_STRETCH * modelAnchor.z;
    const posZ = (ws - arena.worldY) - modelAnchor.y;

    const group = new THREE.Group();
    for (const mesh of model.meshes) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
      geo.setAttribute("normal",   new THREE.BufferAttribute(new Float32Array(mesh.normals), 3));
      geo.setAttribute("uv",       new THREE.BufferAttribute(new Float32Array(mesh.uvs), 2));
      geo.computeBoundingSphere();
      group.add(new THREE.Mesh(geo, this._createModelMaterial(mesh)));
    }

    group.matrixAutoUpdate = false;
    group.matrix.copy(traxxModelMatrix(0, 0, 0, posX, posY, posZ));
    group.matrixWorldNeedsUpdate = true;

    this._arenaMesh = group;
    this._groups.backdrop.add(group);
  }

  /*
    The TV/F3/HB sky: a textured ceiling, or a star field on a level whose line 10 names the
    STARS.VOX / SPACE.VOX sentinel. Either way the level's horizon colour (sky ACT colour 207,
    black for stars) is what the engine clears the screen to, and what its fog ends in.
  */
  _buildTvSky(trackData) {
    const sky = trackData.tvSky;
    this._initFlatSkyFog(sky.horizon);

    if (sky.stars) {
      this._tvStars = this._buildTvStars();
      this._groups.tvSky.add(this._tvStars);
      return;
    }
    const skyTexture = trackData.skyTexture;
    if (!skyTexture?.rgba) return;
    this._buildSkyCeiling(skyTexture, trackData, TV_SKY_ALTITUDE * this._heightScale);
  }

  /*
    MTM1's own sky: the Terminal Velocity ceiling, from the same pair of .LVL lines and recoloured
    the same way (see parseLvlSection in sit-parser.js). The difference is that MTM1's sky can
    never be reached: there is no flight ceiling to climb to, so the plane keeps a fixed height
    above the camera wherever it goes, and only slides past overhead as the camera moves.
    Offered as the Classic sky style; the weather still sets the light.
  */
  _buildClassicSky(trackData) {
    this._classicSky = true;
    this._initFlatSkyFog(trackData.classicSky.horizon);
    this._buildSkyCeiling(trackData.skyTexture, trackData, TV_SKY_ALTITUDE * this._heightScale,
      CLASSIC_SKY_CELLS_PER_REPEAT);
    this._tvSkyFollowsCamera = true;
  }

  /** The horizon colour, the fog that fades into it, and the ceiling shader's uniforms. */
  _initFlatSkyFog(rgb) {
    const horizon = new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
    this._tvHorizon = horizon;
    const dist = this._viewDistance ?? 128 * 64;
    this._tvFog = new THREE.Fog(horizon.clone(), dist * TV_FOG_START, dist);
    this._tvSkyUniforms = {
      skyHorizon: { value: horizon.clone() },
      skyFogNear: { value: this._tvFog.near },
      skyFogFar:  { value: this._tvFog.far },
      skyFogOn:   { value: 1 },
      skyShrink:  { value: 1 },
    };
  }

  /** The flat, tiled sky ceiling, `y` units up; see _buildTvSky and _buildClassicSky. */
  _buildSkyCeiling(skyTexture, trackData, y, cellsPerRepeat = TV_SKY_CELLS_PER_REPEAT) {
    const tex = new THREE.DataTexture(new Uint8ClampedArray(skyTexture.rgba), skyTexture.width, skyTexture.height,
      THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = this._textureSmoothingEnabled ? THREE.LinearFilter : THREE.NearestFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;

    /*
      World origin is scene (0, y, worldSize): editor Y runs opposite to scene Z. Texture u
      follows +X and v follows +editor Y, as the engine's corner UVs do, and the phase is
      anchored at world 0 so a 256-cell map holds exactly 16 repeats and wraps without a seam.
    */
    const ws = this._worldSize(trackData);
    const half = TV_SKY_HALF_CELLS * CELL_SIZE_UNITS;
    const repeats = (2 * TV_SKY_HALF_CELLS) / cellsPerRepeat;
    const corners = [[-half, -half], [half, -half], [half, half], [-half, half]];
    const positions = [];
    const uvs = [];
    for (const [ex, ey] of corners) {
      positions.push(ex, y, ws - ey);
      uvs.push(((ex + half) / (2 * half)) * repeats, ((ey + half) / (2 * half)) * repeats);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    const mat = new THREE.MeshBasicMaterial({
      map: tex, side: THREE.DoubleSide, fog: false, depthTest: false, depthWrite: false,
    });
    /*
      The plane is drawn shrunk around the camera, so its fog is worked out on the true
      distance: the view-space distance divided by the shrink factor, per fragment (the four
      corners are all far away, so an interpolated per-vertex distance would fade everything).
      It fades into the horizon colour over the same range as the terrain fog, which is what
      the engine's fog table does to every colour on screen.
    */
    const uniforms = this._tvSkyUniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vSkyView;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvSkyView = mvPosition.xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying vec3 vSkyView;
          uniform float skyShrink;
          uniform vec3 skyHorizon;
          uniform float skyFogNear;
          uniform float skyFogFar;
          uniform float skyFogOn;`)
        .replace("#include <map_fragment>", `#include <map_fragment>
          float skyFade = skyFogOn * smoothstep(skyFogNear, skyFogFar, length(vSkyView) / skyShrink);
          diffuseColor.rgb = mix(diffuseColor.rgb, skyHorizon, skyFade);`);
    };
    const plane = new THREE.Mesh(geo, mat);
    plane.matrixAutoUpdate = false;
    plane.frustumCulled = false;
    plane.renderOrder = -1;
    this._tvSkyPlane = plane;
    this._groups.tvSky.add(plane);
  }

  /*
    The star field of a space level. GAME.EXE generates 2000 stars at load (0x17b50) and
    draws them as points; the positions here are a fixed pseudo-random set, so a level looks
    the same on every load.
  */
  _buildTvStars() {
    let seed = 0x2f6b1d;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const positions = new Float32Array(TV_STAR_COUNT * 3);
    const colors = new Float32Array(TV_STAR_COUNT * 3);
    for (let i = 0; i < TV_STAR_COUNT; i++) {
      const z = random() * 2 - 1;
      const a = random() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      positions.set([r * Math.cos(a), z, r * Math.sin(a)], i * 3);
      const b = 0.35 + random() * 0.65;
      colors.set([b, b, b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const stars = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 2, sizeAttenuation: false, vertexColors: true, fog: false, depthTest: false, depthWrite: false,
    }));
    stars.frustumCulled = false;
    stars.renderOrder = -1;
    return stars;
  }

  // Sky and fog follow their toggles; the clear colour is the horizon while either is on.
  _applyTvSky() {
    const f = this._renderFlags;
    // MTM1's Classic sky is chosen by the Sky style, so it has no toggle of its own.
    const classic = this._effectiveSkyStyle() === "classic";
    const sky = !!this._trackData?.tvSky || classic;
    this._groups.tvSky.visible = sky && (classic || f.sky !== false);
    const fog = sky && f.fog !== false && !!this._tvFog;
    this._scene.fog = fog ? this._tvFog : null;
    if (this._tvSkyUniforms) this._tvSkyUniforms.skyFogOn.value = fog ? 1 : 0;
    if (!this._trackData) return;
    const horizonClear = sky && (this._groups.tvSky.visible || fog);
    if (horizonClear && this._tvHorizon) this._renderer.setClearColor(this._tvHorizon);
    else this._renderer.setClearColor(BACKGROUND_COLOR);
  }

  // The ceiling drawn shrunk about the camera, and the star field kept around it.
  _updateTvSky() {
    if (!this._groups.tvSky.visible) return;
    const cam = this._camera.position;
    if (this._tvSkyPlane) {
      // Farthest corner inside half the far plane; the picture is the same at any factor.
      const reach = TV_SKY_HALF_CELLS * CELL_SIZE_UNITS * 2 * Math.SQRT2;
      const k = Math.min(1, (this._camera.far * 0.5) / reach);
      if (this._tvSkyUniforms) this._tvSkyUniforms.skyShrink.value = k;
      // A ceiling that follows the camera up is first lifted by its height, then shrunk.
      const lift = this._tvSkyFollowsCamera ? k * cam.y : 0;
      this._tvSkyPlane.matrix.makeScale(k, k, k).setPosition(cam.x * (1 - k), cam.y * (1 - k) + lift, cam.z * (1 - k));
      this._tvSkyPlane.matrixWorldNeedsUpdate = true;
    }
    if (this._tvStars) {
      this._tvStars.position.copy(cam);
      this._tvStars.scale.setScalar(this._camera.far * 0.9);
    }
    if (this._tvSkyUniforms && this._tvFog) {
      this._tvSkyUniforms.skyFogNear.value = this._tvFog.near;
      this._tvSkyUniforms.skyFogFar.value = this._tvFog.far;
    }
  }

  _buildBackdropFromTexture(skyTexture) {
    const { rgba, width, height } = skyTexture;
    const tex = new THREE.DataTexture(new Uint8ClampedArray(rgba), width, height, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    this._backdropMesh = new THREE.Mesh(
      new THREE.SphereGeometry(80000, 32, 16),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthTest: false, depthWrite: false })
    );
    this._backdropMesh.renderOrder = -1;
    this._skyTextureMesh = this._backdropMesh;
    this._groups.skyBox.add(this._backdropMesh);
  }

  _buildBackdropModel(modelName, trackData) {
    const model = trackData.models?.[modelName];
    if (!model?.meshes?.length) return;
    const anchor = model.anchor ?? { x: 0, y: 0, z: 0 };

    const group = this._backdropMesh ?? new THREE.Group();

    for (const mesh of model.meshes) {
      const srcPos = new Float32Array(mesh.positions);
      const backdropPos = new Float32Array(srcPos.length);

      // Stored positions are raw Traxx local space, (v - anchor), unscaled.
      // The backdrop is NOT an object: Traxx gives it its own stack, PushZStretch(1200)
      // rather than the objects' 768 (OpenGLTerrainRenderer.cpp:2720-2721), so the object
      // height stretch must not be applied here. Un-anchor and swap to Three.js axes:
      //   three.x = local.x + anchor.x    (Traxx X → Three.js X)
      //   three.y = local.z + anchor.z    (Traxx Z → Three.js Y)
      //   three.z = -(local.y + anchor.y) (Traxx Y depth → Three.js -Z)
      for (let i = 0; i < srcPos.length; i += 3) {
        backdropPos[i]     = srcPos[i]     + anchor.x;
        backdropPos[i + 1] = srcPos[i + 2] + anchor.z;
        backdropPos[i + 2] = -(srcPos[i + 1] + anchor.y);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(backdropPos, 3));
      geo.setAttribute("uv",       new THREE.BufferAttribute(new Float32Array(mesh.uvs), 2));
      geo.computeVertexNormals();

      const texName = mesh.textureName;
      // Legacy BIN meshes are wound opposite to Three.js' default front-face expectation.
      // Using BackSide matches the original renderer path, which culls front faces.
      const alphaOpts = mesh.transparent ? { alphaTest: 0.5 } : {};
      const mat = texName && this._modelTexCache[texName]
        ? new THREE.MeshBasicMaterial({ map: this._modelTexCache[texName], side: THREE.BackSide, fog: false, depthTest: false, depthWrite: false, ...alphaOpts })
        : new THREE.MeshBasicMaterial({ color: mesh.color ?? 0x334466, side: THREE.BackSide, fog: false, depthTest: false, depthWrite: false });

      this._installBackdropShader(mat);
      group.add(new THREE.Mesh(geo, mat));
    }

    group.renderOrder = -1;
    this._backdropMesh = group;
    if (!group.parent) this._groups.backdrop.add(group);
  }

  _buildWater(trackData) {
    const { terrain, waterLevel } = trackData;
    if (!terrain || !waterLevel) return;
    const gs = terrain.gridSize ?? 256;
    const cs = terrain.cellSize ?? 64;
    const worldSize = gs * cs;
    const y = waterLevel * (this._heightScale);
    const geo = new THREE.PlaneGeometry(worldSize, worldSize);
    /*
      Evo states its water colour and opacity in the .LVL rather than leaving it to the
      viewer, and the two stock tracks differ sharply - BAJBEACH's tropical 0,200,235 against
      ASPEN's near-white 250,250,250 - so drawing both in one hardcoded blue would misreport
      the level. Tracks that carry no such record keep the viewer's default.
    */
    const evoWater = trackData.water?.color;
    const mat = new THREE.MeshLambertMaterial({
      color: evoWater
        ? new THREE.Color(evoWater[0] / 255, evoWater[1] / 255, evoWater[2] / 255)
        : WATER_COLOR,
      transparent: true,
      opacity: evoWater ? Math.min(1, Math.max(0, evoWater[3] / 255)) : 0.6,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    // Center is at worldSize/2 in both X and Z after the flip
    mesh.position.set(worldSize / 2, y, worldSize / 2);
    this._groups.water.add(mesh);
  }

  _worldSize(trackData) {
    const gs = trackData.terrain?.gridSize ?? 256;
    const cs = trackData.terrain?.cellSize ?? 64;
    return gs * cs;
  }

  _buildCourses(trackData) {
    const hs = this._heightScale;
    const ws = this._worldSize(trackData);
    const evo = trackData.origin === "EVO1" || trackData.origin === "EVO2";
    const toScene = (p) => new THREE.Vector3(p[0], p[2] * hs + 8, ws - p[1]);
    const addCourse = (course, color, { loop = true, label = null, labelLift = 0 } = {}) => {
      if (!course?.segments?.length) return;
      const segments = course.segments.filter((seg) => seg.start && seg.end)
        .map((seg) => [toScene(seg.start), toScene(seg.end)]);
      if (!segments.length) return;
      const mat = new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false, depthWrite: false });
      const lineOf = (points, Kind = THREE.Line) => {
        const line = new Kind(new THREE.BufferGeometry().setFromPoints(points), mat);
        line.renderOrder = 1000;
        return line;
      };

      /*
        Each course is built in all three Course styles and the style shows one of them:

          smooth   the path a truck drives: the corners a stored course leaves out put back
                   (see smoothCoursePath) and every join rounded off
          joined   the runs as stored, each joined straight to the next
          traxx    as Traxx and JTraxx draw it: every segment on its own, nothing joining
                   them, and each numbered in white at its start (TraxxViewDisplay.cpp
                   OverlayCourse: `sprintf(label, "%d", s)`, drawn at the segment's cstart)

        A recorded AI line (Evo) is already the path driven, one point to the next, so it is
        the same line in every style and carries no segment numbers.
      */
      const joinedPoints = segments.flat();
      if (loop && !course.recorded) joinedPoints.push(joinedPoints[0]);
      const joined = lineOf(joinedPoints);
      const smooth = course.recorded ? joined : lineOf(smoothCoursePath(segments, loop));
      const traxx = course.recorded ? joined : new THREE.Group();
      if (!course.recorded) {
        traxx.add(lineOf(segments.flat(), THREE.LineSegments));
        segments.forEach(([start], s) => {
          const number = this._makeLabelSprite(String(s), 0xffffff, SEGMENT_LABEL_SCREEN_HEIGHT);
          number.position.copy(start);
          traxx.add(number);
        });
      }
      const styles = { smooth, joined, traxx };

      // One group per course, behind its own checkbox; see courseList.
      const group = new THREE.Group();
      group.visible = false;
      for (const shape of new Set(Object.values(styles))) group.add(shape);
      if (label) {
        // Named at its first point, so each course says what it is for.
        const sprite = this._makeLabelSprite(label, color);
        const first = segments[0][0];
        sprite.position.copy(first).setY(first.y + MARKER_LABEL_HEIGHT + labelLift);
        group.add(sprite);
      }
      this._groups.courses.add(group);
      this._courses.push({ label: label ?? "Course", color, group, styles });
    };

    /*
      Every course is drawn, each in its own colour and named at its start.

      CPR has five and each has its own job: three AI racing lines, the pit road lap and pit
      row (CPR_COURSE_PURPOSES); pit row is not a lap, so it is left open. The SIT games
      (MTM1, MTM2, Evo) have a main course followed by up to four extended ones, which are the
      lines the computer trucks follow: Traxx's notes put trucks not locking onto the course
      down to a track having no extended courses. Evo keeps its computer drivers' lines as
      recorded laps instead (see evo-ai-lines.js), which arrive named.
    */
    const courses = [trackData.primaryCourse, ...(trackData.extendedCourses ?? [])];
    const isCpr = trackData.origin === "CPR";
    /*
      An Evo rally is one way: a single run from a start to a finish somewhere else (PEAK
      climbs from the foot of the mountain to its summit, 4,000 units away). Its course ends
      at the finish rather than turning back to where it began.
    */
    const oneWay = evo && trackData.trackType === "RALLY";
    courses.forEach((course, i) => {
      const purpose = isCpr ? CPR_COURSE_PURPOSES[i] : null;
      const name = isCpr ? purpose?.name : (course?.name ?? (i === 0 ? "Main course" : `AI line ${i}`));
      addCourse(course, (isCpr ? CPR_COURSE_COLORS : SIT_COURSE_COLORS)[i] ?? COURSE_COLOR, {
        loop: oneWay ? false : purpose?.lap ?? true,
        label: name ? `C${i} ${name}` : `C${i}`,
        // The AI lines are usually copies of each other and share a first point, so each
        // label sits at its own height instead of printing over the others.
        labelLift: i * 45,
      });
    });
    this.setCourseStyle(this._courseStyle);
  }

  /**
   * The loaded track's courses, in course order, for the sidebar to give each its own
   * checkbox. What they are depends on the game: CPR's five named purposes, or a SIT track's
   * main course and AI lines.
   */
  courseList() {
    return this._courses.map(({ label, color, group }, index) => ({ index, label, color, visible: group.visible }));
  }

  setCourseVisible(index, visible) {
    const course = this._courses[index];
    if (course) course.group.visible = visible;
  }

  /** "smooth", "joined" or "traxx"; see _buildCourses. */
  setCourseStyle(style) {
    this._courseStyle = COURSE_STYLES.has(style) ? style : "smooth";
    for (const { styles } of this._courses) {
      for (const shape of new Set(Object.values(styles))) shape.visible = false;
      styles[this._courseStyle].visible = true;
    }
  }

  /*
    Converts an editor-space position ([x, y, altitude], as .DEF placements use) into scene
    space. Same transform the object and course builders apply: Z is flipped so editor Y=0
    (south) lands at the far end of the world, and altitude is scaled by the height scale.
  */
  _editorToScene(position, trackData) {
    const ws = this._worldSize(trackData);
    return new THREE.Vector3(position[0], position[2] * this._heightScale, ws - position[1]);
  }

  /*
    Terrain height, in scene units, under an editor-space position.

    Markers sit on the ground rather than at the height stored in their own record. The stored
    height is ground level anyway for everything the .DEF places, but .NAV and .PUP records
    are not all flush with it, and a marker floating over the terrain reads as a position
    error rather than as a deliberate altitude. Sampling the heightfield makes every marker
    agree with the surface under it.

    The height is bilinear between the four vertices around the point. For a marker on a cell
    centre that is the average of the cell's corners; TV-family markers keep their exact
    sub-cell position (tv-coords.js), and bilinear is what lands them on the surface there.

    A 16-bit heightfield is read two ways, because two games write one: CPR is 10.6 fixed
    point (divisor 64) and Evo is 11.5 (divisor 32), and each loader states its divisor on the
    terrain record. The decode is shared with the mesh builder (shared/terrain-height.js), so
    a marker cannot land on a different surface than the one drawn. Reading Evo with the old
    undeclared-grid rule returned half the real height and, below 8 world units, the raw
    sample unscaled, which is what once buried every Evo checkpoint marker.
  */
  _terrainHeightAt(editorX, editorY, trackData) {
    const terrain = trackData.terrain;
    const raw = this._terrainRaw;
    if (!raw || !terrain) return 0;
    const gridSize = terrain.gridSize ?? 256;
    const cellSize = terrain.cellSize ?? 64;
    const fx = Math.min(gridSize - 1, Math.max(0, editorX / cellSize));
    const fz = Math.min(gridSize - 1, Math.max(0, editorY / cellSize));
    const cx = Math.min(gridSize - 2, Math.floor(fx));
    const cz = Math.min(gridSize - 2, Math.floor(fz));
    const tx = fx - cx, tz = fz - cz;

    const h00 = heightAtCell(terrain, raw, cx, cz);
    const h10 = heightAtCell(terrain, raw, cx + 1, cz);
    const h01 = heightAtCell(terrain, raw, cx, cz + 1);
    const h11 = heightAtCell(terrain, raw, cx + 1, cz + 1);
    const h = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
    return h * this._heightScale;
  }

  /*
    An editor-space position dropped onto the terrain surface.

    Falls back to the height stored in the record when the track carries no heightfield, so a
    marker layer never collapses to y=0 on a track this viewer cannot sample.
  */
  _markerGroundPosition(position, trackData, snapToGround = true) {
    const point = this._editorToScene(position, trackData);
    if (snapToGround && this._terrainRaw) {
      point.y = this._terrainHeightAt(position[0], position[1], trackData);
    }
    return point;
  }

  /*
    A text label that keeps a constant size on screen.

    `sizeAttenuation: false` is the point: these are map legends, so a marker on the far side
    of the world has to stay readable rather than shrink to a pixel. It only works because
    there are few of them, a handful of navigation points and tunnels per level and 40
    powerups across every shipped surface level put together.

    The text is drawn to a canvas with a dark outline so it survives over both bright terrain
    and dark terrain without a backing plate.
  */
  _makeLabelSprite(text, color, screenHeight = LABEL_SCREEN_HEIGHT) {
    const scale = 2;                 // supersample, so the label stays crisp when magnified
    const fontSize = 26 * scale;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
    const padding = 8 * scale;
    canvas.width = Math.ceil(ctx.measureText(text).width) + padding * 2;
    canvas.height = fontSize + padding * 2;

    // Resizing the canvas resets the context, so the font has to be set again.
    ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.lineWidth = 5 * scale;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
    ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;

    /*
      Each label owns its canvas texture, so clearTrack has to release them. The generic
      teardown there disposes geometry and materials but deliberately not maps, since model
      textures are shared between meshes; these are not shared, so they are tracked here and
      disposed by name.
    */
    this._labelTextures.push(texture);

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true,
    }));
    sprite.scale.set(screenHeight * (canvas.width / canvas.height), screenHeight, 1);
    sprite.renderOrder = 1003;
    return sprite;
  }

  /*
    One labelled map marker: a small solid on the ground plus its legend above it.

    Markers are not linked to each other. An entrance and its exit, or two consecutive
    navigation points, are routinely on opposite sides of the map, and because the viewer
    draws a single unwrapped copy of the world a line between them would cut straight across
    terrain the route never crosses. The label carries the association instead.

    Depth testing stays off so a marker inside a hill is still findable, which is the whole
    reason these layers exist.
  */
  _addMapMarker(group, base, color, label) {
    const geo = new THREE.OctahedronGeometry(MARKER_HEAD_RADIUS, 0);
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false });
    const head = new THREE.Mesh(geo, mat);
    head.position.copy(base).setY(base.y + MARKER_HEAD_RADIUS);
    head.renderOrder = 1002;
    group.add(head);

    if (label) {
      const sprite = this._makeLabelSprite(label, color);
      sprite.position.copy(base).setY(base.y + MARKER_LABEL_HEIGHT);
      group.add(sprite);
    }
    return head;
  }

  /*
    Navigation points from the level's .NAV.

    Numbered NAV1..NAVn in list order, which is the order the level plays, so the sequence is
    legible from the labels without drawing a route line across a map that does not wrap. The
    type is appended because it is what distinguishes an objective from a checkpoint, and the
    start point additionally gets a heading arrow, heading being the one part of its
    pitch/bank/heading triple that the game uses.
  */
  _buildNavPoints(trackData) {
    const group = this._groups.navPoints;
    trackData.navPoints.forEach((point, i) => {
      /*
        Two Hellbender-only cases the TV form never produces.

        A sync point or terminator has no place on the map, and an escort objective's stored
        coordinates are an uninitialised editor field rather than a position (see
        hb-nav-parser.js). Neither gets a marker; both stay in the list panel.
      */
      if (NAV_TYPES_WITHOUT_A_PLACE.has(point.type) || point.positionIsPlaceholder) return;

      /*
        Hellbender authors whole sections of a level below zero, and the viewer draws only the
        surface heightfield. Snapping one of those onto the surface would move it somewhere it
        is not, so an underground point keeps the altitude its own record states. Markers draw
        with depth testing off, so it is still visible through the hill above it.
      */
      const base = this._markerGroundPosition(point.position, trackData, !point.underground);
      const color = NAV_COLORS[point.type] ?? NAV_DEFAULT_COLOR;
      const suffix = navLabelSuffix(point) + (point.underground ? " (below)" : "");
      this._addMapMarker(group, base, color, `NAV${i + 1} ${suffix}`);
      if (point.type === NAV_START_POINT) this._addHeadingArrow(group, base, point.heading, color);
    });
  }

  /*
    Checkpoint markers, for the games whose route is in the .SIT rather than in a .NAV.

    Numbered CP1..CPn in pass order, which is what a viewer of an MTM, CPR or Evo track wants
    from a map: not where the gates are - the gate models are already drawn - but which one
    comes first. That is the same argument the .NAV layer makes, so it is the same marker: a
    head on the ground and a legend that stays readable from across the world.

    Gate models are drawn in MTM and CPR but not in Evo, whose checkpoint records carry no
    model at all (its gate posts are separate props), so on an Evo track this layer is the
    only thing that says where a checkpoint is.
  */
  _buildCheckpointMarkers(trackData) {
    const group = this._groups.checkpointMarkers;
    /*
      CPR checkpoints are labelled by what they are for (see cprCheckpointRole): the pit lane
      gates by name and in blue, since a lap does not count them, the start/finish as S/F,
      and the ordinary gates numbered in lap order after it. Every other game numbers all of
      its checkpoints in pass order.
    */
    let gateNumber = 0;
    trackData.checkpoints.forEach((checkpoint, i) => {
      const base = this._markerGroundPosition(checkpoint.position, trackData);
      const role = checkpoint.role;
      if (!role) {
        this._addMapMarker(group, base, CHECKPOINT_MARKER_COLOR, `CP${i + 1}`);
      } else if (isCprPitCheckpoint(role)) {
        this._addMapMarker(group, base, PIT_CHECKPOINT_MARKER_COLOR, CPR_CHECKPOINT_LABELS[role]);
      } else if (role === "startFinish") {
        this._addMapMarker(group, base, START_FINISH_MARKER_COLOR, CPR_CHECKPOINT_LABELS[role]);
      } else {
        this._addMapMarker(group, base, CHECKPOINT_MARKER_COLOR, `CP${++gateNumber}`);
      }
    });
  }

  /*
    The start heading, as an arrow lying on the ground.

    Game headings run clockwise from north over 65536 units, and the scene's north is -Z, so
    the direction is (sin a, -cos a). That is the same convention TrackCamera.yaw uses, which
    is why the camera can take the heading unconverted.
  */
  _addHeadingArrow(group, base, heading, color) {
    const a = (heading / 65536) * Math.PI * 2;
    const dir = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
    const from = base.clone().setY(base.y + MARKER_HEAD_RADIUS);
    const tip = from.clone().addScaledVector(dir, HEADING_ARROW_LENGTH);
    const geo = new THREE.BufferGeometry().setFromPoints([from, tip]);
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 1001;
    group.add(line);

    const headGeo = new THREE.ConeGeometry(24, 64, 8);
    const head = new THREE.Mesh(headGeo, new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }));
    head.position.copy(tip);
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    head.renderOrder = 1002;
    group.add(head);
  }

  /*
    Tunnel mouths from the level's .TDF.

    Each tunnel contributes two independent markers, "T<n> start" and "T<n> exit", numbered in
    .TDF order. They are deliberately not joined: a tunnel's two ends are often far apart, and
    a line between them would imply a path across terrain the tunnel does not follow. Tunnel
    interiors are separate levels and are not rendered; the mouths are what a map view can
    honestly show.
  */
  _buildTunnelMarkers(trackData) {
    const group = this._groups.tunnels;
    trackData.tunnels.forEach((tunnel, i) => {
      const n = i + 1;
      const entrance = this._markerGroundPosition(tunnel.entrancePosition, trackData);
      const exit = this._markerGroundPosition(tunnel.exitPosition, trackData);
      this._addMapMarker(group, entrance, TUNNEL_ENTRANCE_COLOR, `T${n} start`);
      this._addMapMarker(group, exit, TUNNEL_EXIT_COLOR, `T${n} exit${tunnel.exitsIntoChamber ? " (chamber)" : ""}`);
    });
  }

  /*
    Loose powerup pickups from the level's .PUP.

    Labelled PUP1..PUPn with the pickup's name ("PUP3 Shield Restore"). The type index is named
    from the table both period editors carry (tv-tables.js); a type outside it, or any
    Hellbender pickup, keeps the bare index as "t<n>".

    The pickup model is drawn at the record's own position when the open archive carries it.
    The stock POWER*.BIN models live in STARTUP.POD, so on a stock level archive the marker is
    all there is.

    Loose pickups are the exception, though. Most powerups in a TV/F3 level are hidden inside
    objects: a .DEF definition names a drop type and a drop chance, and authors put the real
    supply in bunkers that always drop. ARTIC has an empty .PUP but 52 such bunkers. Those are
    places on the map where a powerup is, so objects with a guaranteed (100%) drop are marked
    too, labelled with what they hold and what holds it ("Shield Restore in BUNKER"). Chance
    drops from enemies (4-20% in ARTIC) are not a place on the map and are left out.
  */
  _buildPowerups(trackData) {
    const group = this._groups.powerups;
    for (const box of trackData.boxes ?? []) {
      if (!(box.dropChance >= 100) || !box.dropName) continue;
      const base = this._markerGroundPosition(box.position, trackData);
      const holder = (box.modelName ?? "").replace(/\.BIN$/i, "");
      this._addMapMarker(group, base, POWERUP_COLOR, holder ? `${box.dropName} in ${holder}` : box.dropName);
    }
    (trackData.powerups ?? []).forEach((powerup, i) => {
      const base = this._markerGroundPosition(powerup.position, trackData);
      this._addMapMarker(group, base, POWERUP_COLOR, `PUP${i + 1} ${powerup.name || `t${powerup.type}`}`);
      const model = powerup.modelName ? trackData.models?.[powerup.modelName] : null;
      if (model?.meshes?.length) {
        const box = { position: powerup.position, psi: 0, theta: 0, phi: 0 };
        this._buildBinModel(model, box, this._heightScale, this._worldSize(trackData), trackData,
          { targetGroup: group });
      }
    });
  }

  /*
    Texture animations from the level's .ANI.

    Two kinds, both reduced by the worker to "write these bytes over this image":

      - model textures, where the frames replace the pixels of one shared DataTexture, so
        every mesh using that texture animates at once;
      - terrain slots, where the frames are tile-sized blits into the terrain atlas.

    Nothing here rebuilds geometry or swaps materials, so the cost per frame is one array copy
    and a needsUpdate flag.
  */
  _installTextureAnimations(trackData) {
    this._textureAnimations = [];
    this._animationClock = 0;

    for (const animation of trackData.modelTextureAnimations ?? []) {
      const texture = this._modelTexCache[animation.name];
      if (!texture) continue;
      const frames = animation.frames.map((buffer) => new Uint8ClampedArray(buffer));
      if (frames.length < 2) continue;
      this._textureAnimations.push({
        kind: "model", texture, frames, fps: animation.fps, current: -1,
        target: texture.image.data,
      });
    }

    const atlasAnimations = trackData.terrain?.atlas?.animations ?? [];
    if (atlasAnimations.length && this._terrainAtlasTex) {
      const atlasData = this._terrainAtlasTex.image.data;
      const atlasWidth = this._terrainAtlasWidth;
      for (const animation of atlasAnimations) {
        const frames = animation.frames.map((buffer) => new Uint8ClampedArray(buffer));
        if (frames.length < 2) continue;
        this._textureAnimations.push({
          kind: "atlas", texture: this._terrainAtlasTex, frames, fps: animation.fps, current: -1,
          target: atlasData, atlasWidth, x: animation.x, y: animation.y, size: animation.size,
        });
      }
    }
  }

  _updateTextureAnimations(dt) {
    const animations = this._textureAnimations;
    if (!animations?.length) return;
    if (this._renderFlags.animate === false) return;
    this._animationClock += dt;

    for (const animation of animations) {
      const frame = Math.floor(this._animationClock * animation.fps) % animation.frames.length;
      if (frame === animation.current) continue;
      animation.current = frame;
      const source = animation.frames[frame];
      if (animation.kind === "model") {
        animation.target.set(source);
        // An animated cutout can change its shadow silhouette with the frame.
        this._shadows.invalidateDynamic();
      } else {
        // Blit one square tile into the atlas, row by row.
        const { atlasWidth, x, y, size } = animation;
        for (let row = 0; row < size; row++) {
          const dst = ((y + row) * atlasWidth + x) * 4;
          animation.target.set(source.subarray(row * size * 4, (row + 1) * size * 4), dst);
        }
      }
      animation.texture.needsUpdate = true;
    }
  }

  _buildRaceTrackLayer(trackData) {
    const surfaces = trackData.raceTrackSurfaces ?? [];
    if (surfaces.length < 2) return;

    const textures = trackData.raceTrackTextures ?? [];
    const materials = textures.map((tex, i) => this._makeRaceTrackMaterial(tex, i));
    if (!materials.length) materials.push(new THREE.MeshLambertMaterial({ color: 0x717178, ...CPR_DEPTH_NUDGE }));
    /*
      Catch fencing is not one of the track's own textures, so its material is appended past
      the end of the list. Buckets can then key on it like any other material index, while
      normalizeRaceTextureIndex keeps clamping into the real textures only.

      Built on first use: most tracks have no fenced walls at all, and an unused material
      holding a 256x256 DataTexture never reaches a mesh, so clearTrack would never dispose
      it.
    */
    const textureCount = materials.length;
    let fenceMaterialIndex = -1;
    const fenceMaterial = () => {
      if (fenceMaterialIndex < 0) {
        fenceMaterialIndex = materials.length;
        materials.push(this._makeFenceMaterial(trackData.raceTrackFence));
      }
      return fenceMaterialIndex;
    };

    const hs = this._heightScale;
    const ws = this._worldSize(trackData);
    // TRK altitude is feet; / 2 gives the 2 ft legacy steps the terrain and models use. CPR's
    // own `/ 4` is its 4 ft step, and using it here drew the road at half height.
    const zDivisor = LEGACY_ALTITUDE_DIVISOR;
    // Wall heights go through the same transform as track altitude so they stay consistent
    // with the surface when the height scale slider moves.
    const partHeight = cprFeetToWorldY(CPR_WALL_PART_HEIGHT_FT, hs, zDivisor);
    const roadBuckets = new Map();
    const wallBuckets = new Map();

    /*
      No vertical bias.

      A CPR track altitude is in feet and the terrain RAW stores the same quantity scaled, so
      point[1] / zDivisor lands on the terrain height under the track directly. Checked
      against Laguna with the terrain decoded at full 10.6 precision: across all 6620 track
      points the road sits a median of 2.0 ft above the ground, 5th to 95th percentile +0.5
      to +5.4 ft, which is what "Match ground alt" produces (it levels the ground to the
      minimum altitude under the track, and banking drops one side below that).

      The layer used to be lifted an extra 8 world units on top of that, roughly 11 feet,
      which is what made the track look like it hovered and the surrounding objects look
      buried. Coplanar z-fighting is a depth buffer problem, so it is solved with
      polygonOffset on the material instead of by moving the geometry.
    */
    const pointToWorld = (point) => cprPointToScene(point, hs, ws, zDivisor);

    const bucketFor = (buckets, materialIndex) => {
      const key = Math.max(0, Math.min(materials.length - 1, materialIndex | 0));
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { positions: [], uvs: [], indices: [] };
        buckets.set(key, bucket);
      }
      return bucket;
    };

    const addQuad = (buckets, materialIndex, p0, p1, p2, p3, uvs) => {
      const bucket = bucketFor(buckets, materialIndex);
      const base = bucket.positions.length / 3;
      bucket.positions.push(...p0, ...p1, ...p2, ...p3);
      bucket.uvs.push(...uvs);
      bucket.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    /*
      Each record owns the stretch to the next one. On a closed circuit the last record's
      stretch runs back to record 0; without it the start/finish line was a one-segment hole.
      See cprSegmentPairs.
    */
    for (const [from, to] of cprSegmentPairs(surfaces)) {
      const a = surfaces[from];
      const b = surfaces[to];
      const aPts = a.points ?? [];
      const bPts = b.points ?? [];
      const laneCount = Math.min(aPts.length, bPts.length) - 1;
      if (laneCount < 1) continue;
      // The game draws nothing of the layer beyond its walls; see cprVisibleSlots.
      const visible = cprVisibleSlots(a);

      for (let lane = Math.max(0, visible.first); lane <= Math.min(laneCount - 1, visible.last); lane++) {
        /*
          A cross section slot collapsed on both segments has no area. Skipping those is what
          drops the unused slots and the pit lane band on tracks that have no pit lane there,
          and it reads that from the geometry rather than inferring it from where walls are.
        */
        if (isDegenerateSlot(a, lane) && isDegenerateSlot(b, lane)) continue;
        const coords = a.textureCoordinates?.[lane];
        const texIdx = normalizeRaceTextureIndex(
          cprTextureIndex(coords?.[0] ?? a.textureIndexes?.[lane] ?? 0), textureCount);
        const p0 = pointToWorld(aPts[lane]);
        const p1 = pointToWorld(bPts[lane]);
        const p2 = pointToWorld(bPts[lane + 1]);
        const p3 = pointToWorld(aPts[lane + 1]);
        const len = Math.max(1, Math.hypot(p1[0] - p0[0], p1[2] - p0[2]));
        const vRepeat = Math.max(1, len / 256);
        /*
          U comes from the file, not from the section width.

          Road textures are half-carriageway tiles with the white edge line baked into one
          side (RD4A left, RD4B right), so tiling U across the width repeats that line over
          the road surface. The stored u1..u4 map the tile across the section exactly once.
          Order follows the quad: u1 at p0, u2 at p3, u3 at p1, u4 at p2.
        */
        const uP0 = cprTextureU(coords?.[1] ?? CPR_DEFAULT_SECTION_U_INNER);
        const uP3 = cprTextureU(coords?.[2] ?? CPR_DEFAULT_SECTION_U_OUTER);
        const uP1 = cprTextureU(coords?.[3] ?? CPR_DEFAULT_SECTION_U_INNER);
        const uP2 = cprTextureU(coords?.[4] ?? CPR_DEFAULT_SECTION_U_OUTER);
        addQuad(roadBuckets, texIdx, p0, p1, p2, p3, [
          uP0, 1,
          uP1, 1 - vRepeat,
          uP2, 1 - vRepeat,
          uP3, 1,
        ]);
      }

      /*
        Direction across the cross section on this segment, first point to last, which runs
        toward increasing pointOffset. Used below to work out which face of a wall is the one
        anybody ever sees.
      */
      const acrossFrom = pointToWorld(aPts[0]);
      const acrossTo = pointToWorld(aPts[aPts.length - 1]);
      const acrossX = acrossTo[0] - acrossFrom[0];
      const acrossZ = acrossTo[2] - acrossFrom[2];

      const pointCount = Math.min(aPts.length, bPts.length);
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        // A wall belongs to the segment its record is stored on and spans forward to the
        // next one, so the owning segment decides whether a panel exists at all.
        const layers = CPR_WALL_LAYERS[a.wallTypes?.[pointIndex] ?? 0];
        if (!layers) continue;
        /*
          wallTexture is four parts per point, one per stacked panel, and how many of them
          are real depends on the wall type. Note the array stays populated after a wall is
          deleted: the guide says so outright ("it doesn't remove the texture at all"), which
          is why the parts are only read once the wall type says there is a wall here.
        */
        const parts = a.wallTextures?.[pointIndex] ?? [];
        const p0 = pointToWorld(aPts[pointIndex]);
        const p1 = pointToWorld(bPts[pointIndex]);
        const len = Math.max(1, Math.hypot(p1[0] - p0[0], p1[2] - p0[2]));
        const uRepeat = Math.max(1, len / 256);

        /*
          Which face of this wall looks at the track.

          The quad runs along the track and is extruded straight up, so its front face normal
          is horizontal and perpendicular to the run: T x up, which is (-Tz, 0, Tx). A wall
          below the cross section midpoint should face increasing pointOffset and one at or
          above it should face the other way. When the front face points away, the only face
          anyone can see is the back one, and a back face draws its texture mirrored.

          This cannot be decided from the point index alone. pointToWorld mirrors Z
          (ws - wy), which reverses the handedness of the whole layer, so what the file calls
          the left of the track lands on the driver's right. Testing the geometry as it
          actually reaches world space keeps this correct whatever that transform does.
        */
        const normalX = -(p1[2] - p0[2]);
        const normalZ = p1[0] - p0[0];
        const facing = pointIndex < CPR_CROSS_SECTION_MIDPOINT ? 1 : -1;
        const seenFromBehind = (normalX * acrossX + normalZ * acrossZ) * facing < 0;
        const uLo = seenFromBehind ? uRepeat : 0;
        const uHi = seenFromBehind ? 0 : uRepeat;

        let base = 0;
        for (const layer of layers) {
          const top = base + layer.units * partHeight;
          const q0 = [p0[0], p0[1] + base, p0[2]];
          const q1 = [p1[0], p1[1] + base, p1[2]];
          const q2 = [p1[0], p1[1] + top,  p1[2]];
          const q3 = [p0[0], p0[1] + top,  p0[2]];
          if (layer.fence) {
            addQuad(wallBuckets, fenceMaterial(), q0, q1, q2, q3, [
              uLo, 1, uHi, 1, uHi, 0, uLo, 0,
            ]);
          } else {
            const value = parts[layer.part] ?? parts[0] ?? 0;
            const texIdx = normalizeRaceTextureIndex(cprTextureIndex(value), textureCount);
            /*
              The four sub textures in a wall RAW are stacked vertically as 256x64 strips,
              one advertising panel each, so the slice picks a V band and U stays free to run
              along the wall. THREE.DataTexture does not flip Y, so image row 0 is v = 0 and
              strip s covers v in [s/4, (s+1)/4].
            */
            const vTop = cprTextureSlice(value) / CPR_TEXTURE_SLICE_COUNT;
            const vBottom = vTop + 1 / CPR_TEXTURE_SLICE_COUNT;
            addQuad(wallBuckets, texIdx, q0, q1, q2, q3, [
              uLo, vBottom, uHi, vBottom, uHi, vTop, uLo, vTop,
            ]);
          }
          base = top;
        }
      }
    }

    const wireMat = new THREE.LineBasicMaterial({ color: 0xF5E287 });
    const addMeshes = (buckets) => {
      for (const [materialIndex, bucket] of buckets) {
        if (!bucket.positions.length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(bucket.positions, 3));
        geo.setAttribute("uv", new THREE.Float32BufferAttribute(bucket.uvs, 2));
        geo.setIndex(bucket.indices);
        geo.computeVertexNormals();
        const surface = new THREE.Mesh(geo, materials[materialIndex]);
        surface.receiveShadow = true;
        this._groups.racetrack.add(surface);
        this._groups.racetrackWire.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), wireMat));
      }
    };

    addMeshes(roadBuckets);
    addMeshes(wallBuckets);
    this._buildRoadMask(roadBuckets);
  }

  /*
    CPR draws its road over the terrain, never the other way round.

    The terrain is a 32 ft grid and the road is not, so on a banked turn or a road cut into a
    slope the interpolated ground rises through the road surface between grid points, and a
    depth tested draw lets it cover the tarmac. The game gives the road layer precedence.

    A heightfield cannot pass over the road it is under, so any terrain inside the road's
    footprint is either below the road (hidden by it anyway) or poking through it. The road
    quads are rendered once from straight above into a coverage mask, and the terrain
    material pushes its fragments inside it to the back of the depth range. The road then
    always wins, whichever is drawn first. Pushing rather than discarding matters at the
    mask's soft edge: a discarded fragment there leaves a hole to the sky, where a pushed one
    still fills the pixel when nothing else does. Objects, trucks and walls are untouched and
    still depth test normally, so a hill in front of the road keeps hiding it.

    The mask covers only the road's bounding box, at about a foot per texel.
  */
  _buildRoadMask(roadBuckets) {
    const positions = [];
    const indices = [];
    for (const bucket of roadBuckets.values()) {
      const base = positions.length / 3;
      positions.push(...bucket.positions);
      for (const index of bucket.indices) indices.push(base + index);
    }
    if (!indices.length) return;

    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
      minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
    }
    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    const maxSize = Math.min(ROAD_MASK_MAX_SIZE, this._renderer.capabilities.maxTextureSize);
    const width = Math.max(1, Math.min(maxSize, Math.ceil(spanX / ROAD_MASK_UNITS_PER_TEXEL)));
    const height = Math.max(1, Math.min(maxSize, Math.ceil(spanZ / ROAD_MASK_UNITS_PER_TEXEL)));

    const target = new THREE.WebGLRenderTarget(width, height, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });

    // Placed straight into the mask's own [minX, maxX] x [minZ, maxZ] square, so the terrain
    // shader reads it back with the same bounds and no camera is involved.
    const bounds = new THREE.Vector4(minX, minZ, spanX, spanZ);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    const mat = new THREE.ShaderMaterial({
      uniforms: { bounds: { value: bounds } },
      vertexShader: `
        uniform vec4 bounds;
        void main() {
          vec2 uv = (position.xz - bounds.xy) / bounds.zw;
          gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
        }`,
      fragmentShader: "void main() { gl_FragColor = vec4(1.0); }",
      side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    });
    const maskScene = new THREE.Scene();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    maskScene.add(mesh);

    const previousTarget = this._renderer.getRenderTarget();
    const previousClear = this._renderer.getClearColor(new THREE.Color());
    const previousAlpha = this._renderer.getClearAlpha();
    this._renderer.setRenderTarget(target);
    this._renderer.setClearColor(0x000000, 0);
    this._renderer.clear(true, false, false);
    this._renderer.render(maskScene, this._camera);
    this._renderer.setRenderTarget(previousTarget);
    this._renderer.setClearColor(previousClear, previousAlpha);
    geo.dispose();
    mat.dispose();

    this._roadMaskTarget = target;
    this._roadMaskUniforms.roadMask.value = target.texture;
    this._roadMaskUniforms.roadMaskBounds.value.copy(bounds);
  }

  /** Lets a terrain material drop the fragments the road covers; see _buildRoadMask. */
  /*
    The terrain's two shader additions.

    The CPR road mask, see _buildRoadMask.

    And the MTM family's baked light (USE_LTE, when the terrain carries an lteLight attribute;
    see terrain-builder.js). The ground is drawn at the brightness the LTE bakes in, the way
    MTM2 draws it, instead of being shaded again by the scene's sun, which would darken every
    slope twice. The scene's lights still decide two things: shadows, and how much darker the
    weather makes everything. So the lighting runs with the normal pointing straight up (no
    slope term) and its result is scaled by lteGain, which maps an unshadowed clear-day
    ground to exactly its LTE brightness.
  */
  _installTerrainShader(material, baked) {
    const uniforms = this._roadMaskUniforms;
    if (baked) material.defines = { ...(material.defines ?? {}), USE_LTE: "" };
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
          varying vec2 vRoadMaskXZ;
          #ifdef USE_LTE
            attribute float lteLight;
            varying float vLteLight;
          #endif`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          vRoadMaskXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
          #ifdef USE_LTE
            vLteLight = lteLight;
          #endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying vec2 vRoadMaskXZ;
          uniform sampler2D roadMask;
          uniform vec4 roadMaskBounds;
          uniform float roadMaskEnabled;
          #ifdef USE_LTE
            varying float vLteLight;
            uniform float lteGain;
          #endif`)
        .replace("#include <lights_fragment_begin>", `
          #ifdef USE_LTE
            normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          #endif
          #include <lights_fragment_begin>`)
        .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
          #ifdef USE_LTE
            // The LTE byte is a display brightness; the lighting runs in linear space.
            float lteLinear = lteGain * pow(vLteLight, 2.2);
            reflectedLight.directDiffuse *= lteLinear;
            reflectedLight.indirectDiffuse *= lteLinear;
          #endif`)
        .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
          gl_FragDepth = gl_FragCoord.z;
          if (roadMaskEnabled > 0.5) {
            vec2 roadUv = (vRoadMaskXZ - roadMaskBounds.xy) / roadMaskBounds.zw;
            if (all(greaterThanEqual(roadUv, vec2(0.0))) && all(lessThanEqual(roadUv, vec2(1.0)))
                && texture2D(roadMask, roadUv).r > 0.5) gl_FragDepth = ROAD_MASK_DEPTH;
          }`)
        .replace("#include <common>", "#include <common>\n#define ROAD_MASK_DEPTH 0.999999");
    };
  }

  _makeRaceTrackMaterial(texture, index) {
    if (texture?.rgba && texture.width > 0 && texture.height > 0) {
      const tex = new THREE.DataTexture(new Uint8ClampedArray(texture.rgba), texture.width, texture.height, THREE.RGBAFormat);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = tex.minFilter = this._textureSmoothingEnabled ? THREE.LinearFilter : THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, ...CPR_DEPTH_NUDGE });
    }
    const fallback = [0x717178, 0x5c5c62, 0x8b8b91, 0x6b6048, 0x7a785f][index % 5];
    return new THREE.MeshLambertMaterial({ color: fallback, side: THREE.DoubleSide, ...CPR_DEPTH_NUDGE });
  }

  /*
    Catch fencing for CPR wall types 3 and 5.

    ART\CATCH3D.RAW is a colour-keyed cutout, already decoded that way in the worker, so
    alphaTest is the right tool here rather than blending: a transparent material would need
    per-fragment sorting against the walls and terrain behind it, and the fence is a hard
    on/off mask with no partial coverage to preserve.
  */
  _makeFenceMaterial(fence) {
    if (fence?.rgba && fence.width > 0 && fence.height > 0) {
      const tex = new THREE.DataTexture(new Uint8ClampedArray(fence.rgba), fence.width, fence.height, THREE.RGBAFormat);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = tex.minFilter = this._textureSmoothingEnabled ? THREE.LinearFilter : THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, alphaTest: 0.5, ...CPR_DEPTH_NUDGE });
    }
    return new THREE.MeshLambertMaterial({
      color: 0x9a9a9a, side: THREE.DoubleSide, transparent: true, opacity: 0.3,
    });
  }

  _buildObjects(trackData) {
    const hs = this._heightScale;
    const ws = this._worldSize(trackData);

    // Shared cbox materials (top/sides/bottom like JTraxx)
    const cboxMatSide   = new THREE.MeshBasicMaterial({ color: CBOX_SIDE,   transparent: true, opacity: 0.75 });
    const cboxMatTop    = new THREE.MeshBasicMaterial({ color: CBOX_TOP,    transparent: true, opacity: 0.75 });
    const cboxMatBottom = new THREE.MeshBasicMaterial({ color: CBOX_BOTTOM, transparent: true, opacity: 0.75 });
    const cboxWireMat   = new THREE.LineBasicMaterial({ color: CBOX_WIRE });
    const rampMatSide   = new THREE.MeshBasicMaterial({ color: RAMP_SIDE,   transparent: true, opacity: 0.75 });
    const rampMatTop    = new THREE.MeshBasicMaterial({ color: RAMP_TOP,    transparent: true, opacity: 0.75 });
    const rampMatBottom = new THREE.MeshBasicMaterial({ color: RAMP_BOTTOM, transparent: true, opacity: 0.75 });
    const rampWireMat   = new THREE.LineBasicMaterial({ color: RAMP_WIRE });

    for (const box of trackData.boxes ?? []) {
      const underground = trackData.origin === "HB" && box.hellbenderUnderground === true;
      const [wx, wy, wz] = box.position ?? [0, 0, 0];
      const modelName = box.modelName;
      const model = modelName ? trackData.models?.[modelName] : null;
      const renderModel = model?.meshes?.length;
      /*
        Evo 2 names the camera-facing class outright (CNonCollideFacing); MTM uses a type id,
        and both of MTM2's facing types turn: TrackPOD.cpp treats 8 and 9 alike ("Facing
        object? Allow all directions."). They differ only in whether the trunk is solid.
      */
      const isBillboard = box.type === BOXTYPE_NO_COLLIDE_FACING || box.type === BOXTYPE_COLLIDE_FACING
        || box.billboard === true;
      /*
        MTM1 draws its checkpoint banners (CKBAN1.BIN and on) as ordinary scenery; only the
        closing checkpoint, a CKBOX.BIN, is the invisible trigger box MTM2 uses for every
        checkpoint. So on MTM1 the banners stay visible with the objects and only a CKBOX
        waits behind the Checkpoints toggle.
      */
      const isCheckpoint = box.type === BOXTYPE_CHECKPOINT
        && !(trackData.origin === "MTM1" && modelName && !/^CKBOX\.BIN$/i.test(modelName));
      const isRamp = box.type === BOXTYPE_RAMP;

      if (renderModel) {
        this._buildBinModel(model, box, hs, ws, trackData,
          { checkpoint: isCheckpoint, billboard: isBillboard, underground });
      }

      /*
        An Evo box with no model draws nothing.

        Its collision classes carry a `size` rather than the Traxx half-extents, and a third
        of a stock track's placements are model-less CCollisionBox / CCheckpoint records.
        Falling through to the prism path would default them all to 32 and bury the track
        under hundreds of grey cubes that stand for nothing the game draws.
      */
      if (!renderModel && isEvoOrigin(trackData.origin)) continue;

      if (!renderModel) {
        // Traxx half-extents are width/length/height as authored; THREE.BoxGeometry takes
        // full sizes, hence the doubling.
        const hw = (box.width  ?? 32) * 2;
        const hh = (box.height ?? 32) * 2;
        const hl = (box.length ?? 32) * 2;
        const posY = wz * hs;

        // A ramp with no model is the procedural wedge, not a prism.
        const geo = isRamp
          ? this._buildRampGeometry(box.width ?? 32, box.length ?? 32, box.height ?? 32)
          : this._buildCboxGeometry(hw, hh, hl);
        const mats = isRamp
          ? [rampMatSide, rampMatTop, rampMatBottom]
          : [cboxMatSide, cboxMatTop, cboxMatBottom];

        const cMesh = new THREE.Mesh(geo, mats);
        this._applyBoxMatrix(cMesh, box, posY, wx, ws - wy);
        (isRamp ? this._groups.ramps : this._groups.cboxes).add(cMesh);

        const wEdges = new THREE.EdgesGeometry(
          isRamp ? geo : new THREE.BoxGeometry(hw, hh, hl)
        );
        const wBox = new THREE.LineSegments(wEdges, isRamp ? rampWireMat : cboxWireMat);
        this._applyBoxMatrix(wBox, box, posY, wx, ws - wy);
        (isRamp ? this._groups.rampsWire : this._groups.cboxesWire).add(wBox);
      }
    }
  }

  /**
   * Ramp wedge, transcribed from Traxx's `ramppoly` (Traxx/TraxxView.cpp:876-995).
   *
   * Traxx builds the ramp from the SAME eight corners as a collision prism and only varies
   * the polygon list, so the wedge is a box with corners 4 and 7 (the top of the low edge)
   * simply not used. In Traxx local space the corners are
   *   v0..v3 = z=-h, (-w,-l) (-w,+l) (+w,+l) (+w,-l)
   *   v4..v7 = z=+h, same order
   * and the slope climbs from the -y edge to the +y edge.
   *
   * Faces, straight from the AddPolygon calls:
   *   bottom  (0,2,1) (2,0,3)
   *   slope   (0,5,3) (3,5,6)
   *   sides   (2,3,6) (1,5,0) (5,1,6) (6,1,2)
   *
   * Every triangle is emitted with its winding reversed, because Traxx's winding produces
   * inward normals under the right-hand rule (the same reason BIN meshes render BackSide).
   *
   * Authored in Three.js axes so it can share `traxxPrismMatrix` with the collision prisms:
   * three.x = traxx.x, three.y = traxx.z, three.z = -traxx.y.
   */
  _buildRampGeometry(w, l, h) {
    const v = [
      [-w, -h,  l],  // 0
      [-w, -h, -l],  // 1
      [ w, -h, -l],  // 2
      [ w, -h,  l],  // 3
      [-w,  h,  l],  // 4 (unused by the ramp)
      [-w,  h, -l],  // 5
      [ w,  h, -l],  // 6
      [ w,  h,  l],  // 7 (unused by the ramp)
    ];

    // [tri, materialGroup] with group 0 = sides, 1 = top, 2 = bottom, matching _buildCboxGeometry.
    const faces = [
      [[0, 1, 2], 2], [[2, 3, 0], 2],
      [[0, 3, 5], 1], [[3, 6, 5], 1],
      [[2, 6, 3], 0], [[1, 0, 5], 0], [[5, 6, 1], 0], [[6, 2, 1], 0],
    ];

    const positions = new Float32Array(faces.length * 9);
    const geo = new THREE.BufferGeometry();
    let o = 0;
    for (const [tri] of faces) {
      for (const idx of tri) {
        positions[o++] = v[idx][0];
        positions[o++] = v[idx][1];
        positions[o++] = v[idx][2];
      }
    }
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();

    geo.clearGroups();
    for (let i = 0; i < faces.length; i++) geo.addGroup(i * 3, 3, faces[i][1]);
    return geo;
  }

  // Box geometry with 3 material groups: sides (0), top (1), bottom (2)
  _buildCboxGeometry(w, h, d) {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.clearGroups();
    // BoxGeometry index order: +X(0-5), -X(6-11), +Y(12-17), -Y(18-23), +Z(24-29), -Z(30-35)
    geo.addGroup(0,  6,  0);  // +X side
    geo.addGroup(6,  6,  0);  // -X side
    geo.addGroup(12, 6,  1);  // +Y top
    geo.addGroup(18, 6,  2);  // -Y bottom
    geo.addGroup(24, 6,  0);  // +Z side
    geo.addGroup(30, 6,  0);  // -Z side
    return geo;
  }

  // Collision prism / ramp wedge orientation. Geometry is authored in Three.js axes, so this
  // uses the conjugated form; the rotation itself is the same one models get.
  _applyBoxMatrix(obj, box, posY, posX, posZ) {
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(traxxPrismMatrix(box.psi ?? 0, box.theta ?? 0, box.phi ?? 0, posX, posY, posZ));
    obj.matrixWorldNeedsUpdate = true;
  }

  /**
   * Build the Three.js material for one BIN mesh.
   *
   * Ported from JSPod's BIN viewer (src/preview/bin-preview.js createPreviewMaterial). A mesh
   * that came from an MRGL_MATERIAL states its own shading; one that did not falls back to
   * the legacy rule that face types 0x11 / 0x33 are cutouts.
   *
   * Legacy BIN meshes are wound opposite to Three.js' default front-face expectation, so
   * BackSide is the norm and the material's own TWOSIDED flag is what turns that off.
   */
  _createModelMaterial(mesh) {
    const F = MATERIAL_FLAGS;
    const material = mesh.material;
    const flags = material?.flags ?? 0;
    const map = mesh.textureName ? this._modelTexCache[mesh.textureName] : null;

    // Alpha cutouts belong in the opaque queue and must write depth, so ALPHATEST takes
    // precedence over BLEND when a material carries both.
    // `textureHasAlpha` is the .SMF case: an .OPA plane or a two-sample .TIF is an opacity
    // channel whatever the material flag says. See evo-track-loader.js for why it has to win.
    const alphaTested = material
      ? !!(flags & F.ALPHATEST)
      : !!mesh.transparent || mesh.textureHasAlpha === true;
    const blended = material
      ? !!(flags & F.BLEND) && !alphaTested
      : false;

    const tint = material && (flags & F.TINT) ? material.tint : [1, 1, 1];
    const channel = (v) => Math.round(Math.min(1, Math.max(0, v ?? 1)) * 255);
    const color = map
      ? new THREE.Color((channel(tint[0]) << 16) | (channel(tint[1]) << 8) | channel(tint[2]))
      : new THREE.Color(mesh.color ?? 0xaaaaaa);

    const props = {
      color,
      map: map ?? null,
      /*
        A .SMF mesh states its sidedness by convention rather than by a flag, and its foliage,
        fences and banners are all single-sided sheets meant to be seen from behind. They are
        drawn double-sided; only the legacy .BIN path has a winding to compensate for.
      */
      side: mesh.doubleSided || (material && (flags & F.TWOSIDED)) ? THREE.DoubleSide : THREE.BackSide,
      transparent: blended,
      opacity: blended ? Math.min(1, Math.max(0, material?.baseAlpha ?? 1)) : 1,
      alphaTest: alphaTested
        ? (flags & F.ALPHAREF ? Math.min(1, Math.max(0, (material?.alphaRef ?? 128) / 255)) : 0.5)
        : 0,
      depthWrite: alphaTested || !(flags & F.NOZWRITE),
      blending: flags & F.ADDITIVE ? THREE.AdditiveBlending : THREE.NormalBlending,
    };

    // A material that is not marked LIT is drawn unshaded, as the engine does.
    if (material && !(flags & F.LIT)) return new THREE.MeshBasicMaterial(props);

    // Legacy meshes keep the Lambert shading the rest of the scene uses. A mesh that carries
    // a real material gets Phong, because specPower and emissive have nowhere to go on a
    // Lambert material and they are half of what the material is for.
    if (!material) return new THREE.MeshLambertMaterial(props);

    return new THREE.MeshPhongMaterial({
      ...props,
      shininess: Math.max(0, material.specPower ?? 0),
      emissive: flags & F.EMISSIVE ? new THREE.Color(0xffffff) : new THREE.Color(0x000000),
      emissiveIntensity: flags & F.EMISSIVE ? Math.min(1, Math.max(0, material.emissive ?? 0)) : 0,
    });
  }

  _buildBinModel(model, box, hs, ws, trackData, options = {}) {
    const checkpoint = options.checkpoint === true;
    const billboard = options.billboard === true;
    const underground = options.underground === true;
    const [wx, wy, wz] = box.position ?? [0, 0, 0];
    const evo = isEvoOrigin(trackData.origin);

    // World position in Three.js space
    const posX = wx;
    const anchored = traxxTrueOrigin(trackData.origin) && !billboard;
    const posY = evo ? wz * hs
      : trackData.origin === "HB" ? wz * 3
      : anchored ? wz * hs
      : wz * hs + (model.baseZ ?? 0) * 0.75;
    const posZ = ws - wy;

    // SIT angles are in RADIANS: psi=yaw (around Traxx Z height), theta=pitch (X), phi=roll (Y depth).
    // Model vertices are in raw Traxx local space; the 0.75 height stretch lives in the matrix,
    // because Traxx applies it after the rotation and it does not commute with one.
    /*
      TV/F3 models turn about their own origin too, which is the attach point the placement
      names: on 113 of 193 shipped models the origin is the model's base, and the rest are
      flyers centred on it. The bounding-box centre the decoder recentres on is off that
      origin by more than 10% of the model's size on 30 of them (CANN.BIN by 30%).
    */
    const zStretch = modelZStretch(trackData.origin);
    const modelMatrix = evo
      ? evoModelMatrix(box.psi ?? 0, box.theta ?? 0, box.phi ?? 0, posX, posY, posZ)
      : traxxModelMatrix(box.psi ?? 0, box.theta ?? 0, box.phi ?? 0, posX, posY, posZ, zStretch);
    // Put the decoder's recentred mesh back on the model's own origin before it is turned.
    if (anchored) modelMatrix.multiply(new THREE.Matrix4().makeTranslation(model.anchor?.x ?? 0, model.anchor?.y ?? 0, model.anchor?.z ?? 0));

    const group = new THREE.Group();
    const meshRoot = billboard ? new THREE.Group() : group;

    const wireGroup = new THREE.Group();
    const wireRoot = billboard ? new THREE.Group() : wireGroup;
    const wireMat = new THREE.LineBasicMaterial({ color: 0xF5E287 });

    /*
      An animated BIN carries every keyframe as vertex positions in its first frame's space
      (see keyframeMorphs in the worker). Frames 1..n are morph targets on frame 0, so the
      scene can blend any two neighbours and play the keyframes as a smooth motion.
    */
    const keyframes = model.keyframes?.length >= 2 ? model.keyframes : null;
    const morphMeshes = [];

    for (let meshIndex = 0; meshIndex < (model.meshes ?? []).length; meshIndex++) {
      const mesh = model.meshes[meshIndex];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
      geo.setAttribute("normal",   new THREE.BufferAttribute(new Float32Array(mesh.normals), 3));
      geo.setAttribute("uv",       new THREE.BufferAttribute(new Float32Array(mesh.uvs), 2));
      // .SMF geometry is indexed; .BIN meshes arrive already expanded to triangle soup.
      if (mesh.indices) geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
      if (keyframes) {
        geo.morphAttributes.position = keyframes.slice(1).map((frame) =>
          new THREE.BufferAttribute(new Float32Array(frame.meshes[meshIndex].positions), 3));
        geo.morphAttributes.normal = keyframes.slice(1).map((frame) =>
          new THREE.BufferAttribute(new Float32Array(frame.meshes[meshIndex].normals), 3));
      }
      geo.computeBoundingSphere();

      const material = this._createModelMaterial(mesh);
      const solid = new THREE.Mesh(geo, material);
      if (keyframes) morphMeshes.push(solid);
      // BIN faces are reverse-wound: their visible outside is BackSide. Match that in the
      // shadow pass, including alpha-tested cutouts, instead of casting from their inside.
      if (!material.transparent && material.depthWrite && material.blending === THREE.NormalBlending) {
        solid.castShadow = true;
        material.shadowSide = material.side;
      }
      meshRoot.add(solid);
      wireRoot.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), wireMat));
    }

    if (billboard) {
      group.position.set(posX, posY, posZ);
      wireGroup.position.copy(group.position);

      // Facing props are yawed toward the camera each frame, but the 0.75 vertical world
      // stretch still applies. Three composes local matrices as T*R*S, and a scale of
      // (1, 0.75, 1) commutes with the pure Y-axis rotation `lookAt` produces, so putting it
      // on the group's scale is equivalent to Traxx applying it after the rotation.
      // Evo has no vertical world stretch to preserve while the prop yaws to face the camera.
      group.scale.set(1, evo ? 1 : zStretch, 1);
      wireGroup.scale.copy(group.scale);

      // The authored orientation, kept so that turning the billboard toggle off restores what
      // the .SIT actually says rather than snapping the prop to yaw 0. Traxx never billboards
      // type-8 objects at all: it draws every box with its authored psi/theta/phi, so the
      // toggle-off state has to equal the ordinary object path exactly.
      //
      // This is stored as a full matrix rather than a quaternion on purpose: it carries the
      // non-uniform 0.75, so it is not a pure rotation and a quaternion cannot represent it.
      group.userData.staticMatrix = modelMatrix.clone();
      wireGroup.userData.staticMatrix = modelMatrix.clone();

      // Traxx model space is Z-up and needs the swap into scene axes; Evo geometry is already
      // on them, so its billboard root is the identity.
      const localAxisMatrix = evo
        ? new THREE.Matrix4()
        : new THREE.Matrix4().set(
           1,  0, 0, 0,
           0,  0, 1, 0,
           0, -1, 0, 0,
           0,  0, 0, 1
        );
      meshRoot.matrixAutoUpdate = false;
      meshRoot.matrix.copy(localAxisMatrix);
      meshRoot.matrixWorldNeedsUpdate = true;
      wireRoot.matrixAutoUpdate = false;
      wireRoot.matrix.copy(localAxisMatrix);
      wireRoot.matrixWorldNeedsUpdate = true;
      group.add(meshRoot);
      wireGroup.add(wireRoot);
    } else {
      group.matrixAutoUpdate = false;
      group.matrix.copy(modelMatrix);
      group.matrixWorldNeedsUpdate = true;
      wireGroup.matrixAutoUpdate = false;
      wireGroup.matrix.copy(modelMatrix);
      wireGroup.matrixWorldNeedsUpdate = true;
    }

    // A Hellbender object in the cavern belongs to the cavern layer, so it appears and hides
    // with the room it is in rather than with the objects on the surface above it.
    // A caller-owned layer (the powerup pickups) takes the solid model and has no wireframe.
    const targetGroup = options.targetGroup ?? (underground ? this._groups.underground
      : billboard ? this._groups.billboards
      : (checkpoint ? this._groups.checkpoints : this._groups.objects));
    const targetWireGroup = options.targetGroup ? null : underground ? this._groups.undergroundWire
      : billboard ? this._groups.billboardsWire
      : (checkpoint ? this._groups.checkpointsWire : this._groups.objectsWire);
    /*
      Remember which drawn object came from which box.

      Drive mode can shove a movable object around the simulation, and without this link the
      collider moves while its model stands exactly where the track put it. Keyed by the box's
      index in trackData.boxes, which is what the colliders record as `sourceIndex`.

      Both the solid group and its wireframe are kept, because they are placed independently
      and would otherwise drift apart the moment anything moved.
    */
    const boxIndex = (trackData.boxes ?? []).indexOf(box);
    if (boxIndex >= 0) {
      this._objectsByBox = this._objectsByBox ?? new Map();
      this._objectsByBox.set(boxIndex, { group, wireGroup, billboard });
    }

    /*
      A top-crush cab holds its first frame until a truck flattens it; drive mode sets its
      pose (applyCrush). Every other animated BIN loops through its keyframes on its own.
    */
    if (morphMeshes.length) {
      const animation = { meshes: morphMeshes, frameCount: keyframes.length, boxIndex };
      if (box.crushRole === "cab") this._crushCabs.set(boxIndex, animation);
      else this._keyframeAnimations.push(animation);
    }

    if (billboard || underground) group.traverse((child) => { if (child.isMesh) child.castShadow = false; });
    targetGroup.add(group);
    targetWireGroup?.add(wireGroup);
  }

  /*
    Evo 2 vegetation, drawn with instancing.

    A .VEG places 6,169 trees in BAJBEACH and 11,342 in PEAK out of four models. One mesh per
    model per draw call is the only way that stays interactive, and it is what the game does
    too - `maxTrees` is 20,000-25,000 in the stock tracks.

    A tree record carries position, the model slot and a size, but no orientation: the .VEG
    has no rotation field at all. Leaving every instance at yaw 0 makes a forest of identical
    cardboard cutouts all facing the same way, so each is turned by a yaw derived from its own
    record byte. That is a viewer convention, stated here rather than hidden, and it is
    deterministic so a track looks the same on every load.
  */
  _buildVegetation(trackData) {
    const hs = this._heightScale;
    const ws = this._worldSize(trackData);

    const byModel = new Map();
    for (const tree of trackData.vegetation.trees) {
      if (!byModel.has(tree.modelName)) byModel.set(tree.modelName, []);
      byModel.get(tree.modelName).push(tree);
    }

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();

    for (const [modelName, trees] of byModel) {
      const model = trackData.models?.[modelName];
      if (!model?.meshes?.length) continue;

      for (const mesh of model.meshes) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
        geo.setAttribute("normal",   new THREE.BufferAttribute(new Float32Array(mesh.normals), 3));
        geo.setAttribute("uv",       new THREE.BufferAttribute(new Float32Array(mesh.uvs), 2));
        if (mesh.indices) geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
        geo.computeBoundingSphere();

        const instanced = new THREE.InstancedMesh(geo, this._createModelMaterial(mesh), trees.length);
        const wire = new THREE.InstancedMesh(
          geo.clone(),
          new THREE.MeshBasicMaterial({ color: 0xf5e287, wireframe: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
          trees.length,
        );
        for (let i = 0; i < trees.length; i++) {
          const tree = trees[i];
          const [wx, wy, wz] = tree.position;
          position.set(wx, wz * hs, ws - wy);
          quaternion.setFromAxisAngle(UP_AXIS, tree.yaw ?? 0);
          // A slot is scaled to the footprint and height its .VEG declares, which is not the
          // same ratio on both axes for any stock slot.
          const [sx, sy, sz] = tree.scale ?? [1, 1, 1];
          scale.set(sx, sy, sz);
          matrix.compose(position, quaternion, scale);
          instanced.setMatrixAt(i, matrix);
          wire.setMatrixAt(i, matrix);
        }
        instanced.instanceMatrix.needsUpdate = true;
        wire.instanceMatrix.needsUpdate = true;
        // Trees are scattered across the whole world, so a per-instance frustum test is what
        // culling has to work from; the merged bounds would span the map and never cull.
        instanced.computeBoundingSphere();
        wire.computeBoundingSphere();
        // Trees cast like any other scenery, alpha-tested leaves included; the shadow pass
        // uses the same face as the draw, as for the BIN objects.
        const treeMaterial = instanced.material;
        if (!treeMaterial.transparent && treeMaterial.depthWrite && treeMaterial.blending === THREE.NormalBlending) {
          instanced.castShadow = true;
          treeMaterial.shadowSide = treeMaterial.side;
        }
        this._groups.vegetation.add(instanced);
        this._groups.vegetationWire.add(wire);
      }
    }
  }

  _updateBillboards() {
    const target = new THREE.Vector3();
    if (this._renderFlags.billboards === false) {
      resetBillboardGroup(this._groups.billboards);
      resetBillboardGroup(this._groups.billboardsWire);
      return;
    }
    const orient = (group) => {
      for (const obj of group.children) {
        // May have been pinned to its authored matrix while the toggle was off.
        obj.matrixAutoUpdate = true;
        target.set(this._camera.position.x, obj.position.y, this._camera.position.z);
        obj.lookAt(target);
      }
    };
    orient(this._groups.billboards);
    orient(this._groups.billboardsWire);
  }

  /**
   * Report any mesh whose texture never made it into the cache. Such a mesh silently falls
   * back to a colour derived from its texture NAME, which looks like a deliberate flat colour
   * rather than a missing texture, so it needs saying out loud.
   */
  _reportMissingModelTextures(trackData) {
    const missing = new Map();
    for (const [modelName, model] of Object.entries(trackData.models ?? {})) {
      for (const mesh of model.meshes ?? []) {
        if (!mesh.textureName || this._modelTexCache[mesh.textureName]) continue;
        if (!missing.has(mesh.textureName)) missing.set(mesh.textureName, []);
        missing.get(mesh.textureName).push(modelName);
      }
    }
    if (!missing.size) return;
    const lines = [...missing].map(([tex, models]) => `${tex} (used by ${models.join(", ")})`);
    console.warn(`[JSTrackViewer] ${missing.size} model texture(s) not in cache, meshes will `
      + `render in a placeholder colour:\n  ` + lines.join("\n  ")
      + `\n  cache has: ${Object.keys(this._modelTexCache).join(", ") || "(empty)"}`);
  }

  /*
    Put a drivable truck in the scene, or take it out again with null.

    The truck's art goes into the same cache the track's models use, so its meshes resolve
    their textures by the rules already in _createModelMaterial: the MRGL flags, the BackSide
    winding legacy BIN geometry needs, and the alpha handling. That is the reason
    buildTruckObject asks for a material factory rather than making its own materials.

    The cache is keyed by texture name, and a truck arrives from a different archive than the
    track, so a name collision would have one overwrite the other. In practice truck art is
    named for the truck, and the cost of a collision is a wrong texture rather than a failure.
  */
  setDriveTruck(assembly) {
    this._shadowMaterialsDirty = true;
    this.stopDrive();
    this._truckLights?.dispose();
    this._truckLights = null;
    this._driveTruck?.dispose();
    this._driveTruck = null;
    const group = this._groups.driveTruck;
    while (group.children.length) group.remove(group.children[0]);
    if (!assembly) {
      this._shadows.invalidate();
      return null;
    }

    this._modelTexCache = this._modelTexCache ?? {};
    this._loadModelTextures(assembly.textures ?? []);

    this._driveTruck = buildTruckObject(
      assembly,
      (mesh) => this._createModelMaterial(mesh),
      // Links name their art the way a manifest writes it ("Silver.raw"), so match on the
      // stem rather than on the exact key the archive happened to use.
      (name) => this._modelTextureByStem(name)
    );
    this._driveTruck.root.traverse((child) => {
      if (!child.isMesh) return;
      // The truck drives through the shade of trees and buildings, so it takes shadows too.
      child.receiveShadow = true;
      const material = child.material;
      if (!material?.transparent && material?.depthWrite && material.blending === THREE.NormalBlending) {
        child.castShadow = true;
        material.shadowSide = material.side;
      }
    });
    group.add(this._driveTruck.root);
    // Lamps ride on the chassis, so they tilt and bounce with the body. See truck-lights.js.
    if (assembly.lights?.length) {
      this._truckLights = new TruckLightRig(assembly.lights, assembly.lightTextures);
      this._driveTruck.chassis.add(this._truckLights.group);
    }
    this._shadows.invalidate();
    return this._driveTruck;
  }

  get driveTruck() { return this._driveTruck ?? null; }

  /*
    Show what the simulation collides with.

    Built from the colliders rather than from the track data on purpose: the complaint this
    answers is driving into invisible walls, and an invisible wall is precisely a case where
    the collision geometry and the drawn scenery disagree. A marker layer derived from the
    track data would agree with the scenery and show nothing.
  */
  async setColliderMarkers(colliders) {
    const group = this._groups.hitboxes;
    group.userData.dispose?.();
    group.userData.dispose = null;
    while (group.children.length) group.remove(group.children[0]);
    if (!colliders) return;

    const generation = this._driveGeneration;
    const { buildColliderMarkers } = await import("./drive/collider-markers.js");
    if (generation !== this._driveGeneration) return;
    const markers = buildColliderMarkers(colliders);
    group.userData.dispose = markers.userData.dispose;
    while (markers.children.length) group.add(markers.children[0]);
    this._applyVisibility();
  }

  /*
    Start driving the truck that is already in the scene.

    The spawn callback is handed to drive mode rather than a fixed point, so that R re-spawns
    against the track's own start grid every time instead of against wherever the truck
    happened to be when driving began.
  */
  async startDrive(trackData, assembly, onStatus, onPose) {
    if (!this._driveTruck || !trackData || trackData !== this._trackData) return null;
    const generation = ++this._driveGeneration;
    const { createDriveMode } = await import("./drive/drive-mode.js");
    if (generation !== this._driveGeneration || trackData !== this._trackData) return null;
    const frame = createWorldFrame(trackData);
    // Fly! has no start grid: the truck starts where the camera is, and R brings it back there.
    const flyStart = trackData.origin === "FLY"
      ? { x: this._nav.position.x / UNITS_PER_FOOT_H, z: this._nav.position.z / UNITS_PER_FOOT_H, psi: this._nav.yaw * Math.PI / 180 }
      : null;

    this._drive?.stop();
    this._drive?.dispose();
    this._drive = createDriveMode({
      camera: this._camera,
      element: this._container,
      frame,
      assembly,
      truckObject: this._driveTruck,
      // Drive mode builds the track's solid objects from this; without it the truck would
      // drive through every box and ramp on the map.
      trackData,
      // Shoved objects have to move on screen as well as in the simulation.
      onObjectsMoved: (colliders) => {
        this.applyColliderOffsets(colliders);
        this._applyCrush(colliders);
        this._moveColliderMarkers(colliders);
      },
      spawn: () => flyStart
        ? spawnAt(frame, assembly, this._drive?.colliders, flyStart.x, flyStart.z, flyStart.psi)
        : trackSpawnPoint(trackData, frame, assembly, this._drive?.colliders),
      onStatus,
      onPose,
      lights: this._truckLights,
      movers: this._movers,
    });
    this._resetCrush();
    // Dusk and night start with the lights on, as a driver would; L switches them.
    const dark = this.weatherApplies() && (this._weather === "dusk" || this._weather === "night");
    this._truckLights?.setOn(dark);

    // Keep collider markers ready for the Test Drive checkbox, but hidden until requested.
    this._renderFlags.hitboxes = false;
    await this.setColliderMarkers(this._drive.colliders);
    if (generation !== this._driveGeneration || trackData !== this._trackData) return null;

    this._nav.enabled = false;
    this._drive.start();
    return this._drive;
  }

  /*
    Move the drawn objects that the simulation has shoved.

    These groups are placed with a baked matrix and matrixAutoUpdate off, which is what keeps
    hundreds of static props cheap. So an offset cannot be written to `position`: nothing would
    read it. It is composed onto the stored matrix instead, which is also why the original is
    kept the first time an object moves rather than recomputed from the box each frame.

    Only objects that have actually been displaced are touched, so a track full of static
    scenery costs one comparison per movable object per frame and nothing else.
  */
  applyColliderOffsets(colliders) {
    if (!colliders || !this._objectsByBox) return;
    let moved = false;
    for (const solid of colliders.movables) {
      // Trains are drawn from their mover, which also carries whatever rides on them.
      if (solid.moving) continue;
      const drawn = this._objectsByBox.get(solid.sourceIndex);
      if (!drawn) continue;
      const { x, y, z } = solid.offset;
      const tilted = solid.tilt && (solid.tilt.x !== 0 || solid.tilt.y !== 0 || solid.tilt.z !== 0);
      if (x === 0 && y === 0 && z === 0 && !tilted) continue;
      moved = true;

      const move = this._colliderMatrix(solid);
      for (const node of [drawn.group, drawn.wireGroup]) {
        if (!node) continue;
        if (!node.userData.placedMatrix) node.userData.placedMatrix = node.matrix.clone();
        node.matrix.copy(node.userData.placedMatrix);
        node.matrix.premultiply(move);
        node.matrixWorldNeedsUpdate = true;
      }
    }
    if (moved) this._shadows.invalidateDynamic();
  }

  /*
    Where a shoved or fallen object has got to, as a scene matrix.

    Two conversions live here, and both matter. The simulation works in feet and the scene is
    anisotropic (2 units per foot across, 1.5 up), so a displacement scales per axis. A
    ROTATION cannot simply be copied across: a rotation R in feet becomes S R S^-1 in scene
    units, because the scene is a stretched view of the world. Copying R unchanged would leave
    a toppled lamp post the wrong length as it swung, which is the same mistake that squashed
    the truck early on.

    The tilt is about the object's base, so the matrix moves the pivot to the origin, turns,
    and puts it back.
  */
  _colliderMatrix(solid) {
    const H = UNITS_PER_FOOT_H;
    const V = UNITS_PER_FOOT_V;
    const move = new THREE.Matrix4().makeTranslation(
      solid.offset.x * H, solid.offset.y * V, solid.offset.z * H
    );
    const tilt = solid.tilt;
    if (!tilt || (tilt.x === 0 && tilt.y === 0 && tilt.z === 0)) return move;

    const pivot = new THREE.Vector3(
      (solid.centre.x + solid.pivot.x) * H,
      (solid.centre.y + solid.pivot.y) * V,
      (solid.centre.z + solid.pivot.z) * H
    );
    const stretch = new THREE.Matrix4().makeScale(H, V, H);
    const shrink = new THREE.Matrix4().makeScale(1 / H, 1 / V, 1 / H);
    const rotation = new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion(tilt.x, tilt.y, tilt.z, tilt.w)
    );
    const turn = stretch.multiply(rotation).multiply(shrink);

    return move
      .multiply(new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z))
      .multiply(turn)
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  }

  /*
    Keep the hitbox wireframes on their objects.

    A marker that stayed behind when its object was knocked aside would be worse than no
    marker: the layer exists to say where the truck will actually hit something.
  */
  _moveColliderMarkers(colliders) {
    if (!colliders || !this._groups.hitboxes.visible) return;
    for (const marker of this._groups.hitboxes.children) {
      const solid = marker.userData.collider;
      if (!solid?.movable && !solid?.moving) continue;
      marker.position.set(
        (solid.centre.x + solid.offset.x) * UNITS_PER_FOOT_H,
        (solid.centre.y + solid.offset.y) * UNITS_PER_FOOT_V,
        (solid.centre.z + solid.offset.z) * UNITS_PER_FOOT_H
      );
      /*
        A marker follows its object over as well as along. This composes the tilt as a plain
        rotation rather than through the scene's stretch, unlike the drawn object: the wireframe
        is a diagnostic, and a degree or so of lean on a toppled box is not worth a matrix.
      */
      const tilt = solid.tilt;
      if (tilt && (tilt.x !== 0 || tilt.y !== 0 || tilt.z !== 0)) {
        if (!marker.userData.basis) marker.userData.basis = marker.quaternion.clone();
        marker.quaternion.copy(new THREE.Quaternion(tilt.x, tilt.y, tilt.z, tilt.w))
          .multiply(marker.userData.basis);
      }
    }
  }

  /** Stop driving and hand the camera back to the fly camera. */
  stopDrive() {
    this._driveGeneration++;
    this._drive?.stop();
    this._drive?.dispose();
    this._drive = null;
    this._nav.enabled = true;
    // Drive cameras set their own field of view; flying goes back to the game's.
    if (this._camera.fov !== NAV_FOV) {
      this._camera.fov = NAV_FOV;
      this._camera.updateProjectionMatrix();
      this._shadows.refit();
    }
    // The markers are drive mode's, so they go when it does.
    this._renderFlags.hitboxes = false;
    this.setColliderMarkers(null);
    this._applyVisibility();
  }

  get drive() { return this._drive ?? null; }

  /** A cached model texture by file stem, ignoring directory and extension. */
  _modelTextureByStem(name) {
    if (!name) return null;
    const stem = (s) => {
      const upper = String(s).replace(/\\/g, "/").toUpperCase();
      const title = upper.includes("/") ? upper.slice(upper.lastIndexOf("/") + 1) : upper;
      return title.replace(/\.[^.]+$/, "");
    };
    const want = stem(name);
    const direct = this._modelTexCache?.[name];
    if (direct) return direct;
    for (const key of Object.keys(this._modelTexCache ?? {})) {
      if (stem(key) === want) return this._modelTexCache[key];
    }
    return null;
  }

  /*
    Put the truck on the track's start grid.

    The altitude stored with a grid slot is not used. Phase 0 measured what those altitudes
    actually are: SUMMIT1 parks its trucks 6.00 ft up, ALASKA 9 ft and CRAZY98 10 ft, against
    a 6.80 ft wheels-just-touching height for BIGFOOT. They are authored drop heights rather
    than settled poses, so the truck is put on the terrain instead, at the height its own
    geometry says it rests at.

    Heading: the grid's convention is forward = (sin psi, 0, -cos psi), and a truck model faces
    -Z at rest, so the chassis turns by -psi. That is the same sign evoModelMatrix uses, and
    for the same reason: the scene's Z is flipped relative to the editor's.

    @returns the spawn position in feet, or null when there is nothing to spawn on.
  */
  spawnDriveTruck(trackData, assembly) {
    this._shadowMaterialsDirty = true;
    const truck = this._driveTruck;
    if (!truck || !trackData) return null;

    const frame = createWorldFrame(trackData);
    // On CPR the grid is on the road layer, a couple of feet above the terrain under it.
    const road = trackData.raceTrackSurfaces?.length ? createRaceTrackSupport(trackData) : null;
    const { psi, ...position } = trackData.origin === "FLY"
      ? spawnAt(frame, assembly, road, this._nav.position.x / UNITS_PER_FOOT_H, this._nav.position.z / UNITS_PER_FOOT_H, this._nav.yaw * Math.PI / 180)
      : trackSpawnPoint(trackData, frame, assembly, road);
    const ground = groundForSpawn(frame, road, position.x, position.z);

    truck.reset();
    // Scene units, not feet: the truck is drawn true while the terrain is not, so its height
    // is measured from the ground under it. See world-frame's toSceneTruckPosition.
    truck.setPose(
      frame.toSceneTruckPosition(position, ground),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -psi)
    );
    this._shadows.invalidate();
    return position;
  }

  _loadModelTextures(modelTextures) {
    for (const { name, rgba, width, height } of modelTextures) {
      const tex = new THREE.DataTexture(new Uint8ClampedArray(rgba), width, height, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = tex.minFilter = this._textureSmoothingEnabled ? THREE.LinearFilter : THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      this._modelTexCache[name] = tex;
    }
  }

  _buildGroundBoxes(groundBoxes, hs, trackData, solidGroup = this._groups.gboxes, wireGroup = this._groups.gboxesWire) {
    const atlasTex = this._terrainAtlasTex;
    const cols = this._terrainAtlasCols || this._terrainAtlasN || 1;
    const rows = this._terrainAtlasRows || 1;
    const atlasWidth = this._terrainAtlasWidth || cols;
    const atlasHeight = this._terrainAtlasHeight || rows;
    const atlasTileSize = this._terrainAtlasTileSize || (atlasWidth / cols);
    const atlasPadding = this._terrainAtlasPadding || 0;
    const atlasSourceTileSize = this._terrainAtlasSourceTileSize || atlasTileSize;
    const CELL = 64;
    const ws = this._worldSize(trackData) || 16384;

    // Three.js BoxGeometry face order → CL0 face index
    // BoxGeo: 0=+X(E), 1=-X(W), 2=+Y(top), 3=-Y(bot), 4=+Z(S), 5=-Z(N)
    // CL0:    0=S,     1=N,     2=E,        3=W,       4=top,   5=bottom
    const FACE_MAP = [2, 3, 4, 5, 0, 1];

    const wireMat  = new THREE.LineBasicMaterial({ color: GBOX_COLOR });
    const fallback = new THREE.MeshLambertMaterial({ color: GBOX_COLOR, transparent: true, opacity: 0.35 });

    for (const gb of groundBoxes) {
      const upper = gb.upper ?? 0;
      const lower = gb.lower ?? 0;
      if (upper < 1) continue;
      const midX    = gb.midX ?? (gb.x * CELL + CELL / 2);
      const midYW   = gb.midY ?? (gb.y * CELL + CELL / 2);
      const midZ    = ws - midYW;
      const yLow    = lower * hs;
      const yHigh   = upper * hs;
      const h3d     = Math.max(1, yHigh - yLow);
      const cy      = (yLow + yHigh) / 2;

      const boxGeo = this._buildGroundBoxGeometry(CELL, h3d);

      let solidMat;
      if (atlasTex && gb.faceTexture) {
        const uvAttr = boxGeo.attributes.uv;
        const uvArr  = uvAttr.array;
        /*
          The 2px overlap crops a ground box's faces exactly as it crops the terrain: two pixels
          of the slot's LEGACY tile off each side (see terrain-builder.js). MTM2's ground box art
          carries the same baked border ring as its terrain tiles, so without this the edges of
          every box drew a dark frame that the terrain beside it did not.
        */
        const overlapArr = new Float32Array(uvArr.length);
        // Geometry face vertices are ordered TL, TR, BL, BR for side walls.
        const flatFaceCorners = [0, 1, 3, 2];
        const sideFaceCorners = [3, 2, 0, 1];
        // Top faces use the flat basis with north/south flipped so the texture
        // bottom edge maps to the southern edge of the ground box.
        const topFaceCorners = [3, 2, 0, 1];
        for (let face = 0; face < 6; face++) {
          const cl0Face = FACE_MAP[face];
          const texIdx = gb.faceTexture[cl0Face]  ?? -1;
          if (texIdx < 0) continue;
          const rot    = gb.faceRotation?.[cl0Face] ?? 0;
          const mirror = gb.faceMirror?.[cl0Face]   ?? 0;
          const baseCorners = face === 2
            ? topFaceCorners
            : (face === 0 || face === 1 || face === 4 || face === 5)
              ? sideFaceCorners
              : flatFaceCorners;
          const atlasCol = texIdx % cols;
          const atlasRow = Math.floor(texIdx / cols);
          const slotX = atlasCol * atlasTileSize + atlasPadding;
          const slotY = atlasRow * atlasTileSize + atlasPadding;
          const u0 = slotX / atlasWidth;
          const u1 = (slotX + atlasSourceTileSize) / atlasWidth;
          const v0 = slotY / atlasHeight;
          const v1 = (slotY + atlasSourceTileSize) / atlasHeight;
          const cU = [u0, u1, u1, u0];
          const cV = [v1, v1, v0, v0];
          const legacySide = this._terrainAtlasLegacySides?.[texIdx] ?? atlasSourceTileSize;
          const inset = TERRAIN_OVERLAP_PIXELS * atlasSourceTileSize / legacySide;
          const iu = inset / atlasWidth, iv = inset / atlasHeight;
          const oU = [u0 + iu, u1 - iu, u1 - iu, u0 + iu];
          const oV = [v1 - iv, v1 - iv, v0 + iv, v0 + iv];
          const base = face * 8;
          for (let v = 0; v < 4; v++) {
            let result = baseCorners[v];
            if (mirror & 1) result = (3 - result) & 3;
            if (mirror & 2) result = (1 - result) & 3;
            const ci = (face === 2 || face === 3)
              ? (result + rot) & 3
              : (result - rot + 4) & 3;
            uvArr[base + v * 2]     = cU[ci];
            uvArr[base + v * 2 + 1] = cV[ci];
            overlapArr[base + v * 2]     = oU[ci];
            overlapArr[base + v * 2 + 1] = oV[ci];
          }
        }
        // Registered with the terrain's, so the 2px overlap toggle swaps both together.
        const full = new Float32Array(uvArr);
        if (this._renderFlags.terrainOverlap === true) uvArr.set(overlapArr);
        this._terrainUvTargets.push({ geometry: boxGeo, full, overlap: overlapArr });
        uvAttr.needsUpdate = true;
        solidMat = new THREE.MeshLambertMaterial({ map: atlasTex });
      } else {
        solidMat = fallback;
      }

      const solidMesh = new THREE.Mesh(boxGeo, solidMat);
      solidMesh.castShadow = true;
      solidMesh.receiveShadow = true;
      solidMesh.position.set(midX, cy, midZ);
      solidGroup.add(solidMesh);

      const lineBox = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo), wireMat);
      lineBox.position.set(midX, cy, midZ);
      wireGroup.add(lineBox);
    }
  }

  _buildGroundBoxGeometry(size, height) {
    const x0 = -size / 2, x1 = size / 2;
    const z0 = -size / 2, z1 = size / 2;
    const y0 = -height / 2, y1 = height / 2;
    const positions = [];
    const uvs = [];
    const indices = [];

    const addFace = (verts) => {
      const base = positions.length / 3;
      for (const [x, y, z] of verts) {
        positions.push(x, y, z);
        uvs.push(0, 0);
      }
      indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
    };

    // Face order matches THREE.BoxGeometry: +X, -X, +Y, -Y, +Z, -Z.
    // Side vertices are TL, TR, BL, BR as viewed from outside the box.
    addFace([[x1, y1, z1], [x1, y1, z0], [x1, y0, z1], [x1, y0, z0]]);
    addFace([[x0, y1, z0], [x0, y1, z1], [x0, y0, z0], [x0, y0, z1]]);
    addFace([[x0, y1, z0], [x1, y1, z0], [x0, y1, z1], [x1, y1, z1]]);
    addFace([[x0, y0, z1], [x1, y0, z1], [x0, y0, z0], [x1, y0, z0]]);
    addFace([[x0, y1, z1], [x1, y1, z1], [x0, y0, z1], [x1, y0, z1]]);
    addFace([[x1, y1, z0], [x0, y1, z0], [x1, y0, z0], [x0, y0, z0]]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  _buildTrucks(trackData) {
    const hs = this._heightScale;
    const ws = this._worldSize(trackData);
    /*
      The arrow is sized in world units, so it has to scale with the cell.

      MTM and the TV family are 64 units to a cell and Evo is 32, which makes a fixed-size
      marker twice as large on an Evo track. It shows: ASPEN's eight grid slots are about 16
      units apart, so full-size arrows overlap into one blob instead of reading as a grid.
    */
    const markerScale = (trackData.terrain?.cellSize ?? 64) / 64;
    // Triangle arrow matching Java SoftwareOverlayRenderer perspective markers
    // Colors: truck 1 = orange-yellow, others = lighter shades
    const TRUCK_COLORS = [0xFFCC00, 0xFF9900, 0xFF6600, 0xFFDD44];

    for (let i = 0; i < trackData.trucks.length; i++) {
      const truck = trackData.trucks[i];
      // The MTM family's slot 0 is the saved player truck rather than a vehicle on the grid;
      // see sit-parser.js. Evo has no such slot, so this keys on the record, not the index.
      if (truck.playerSlot === true) continue;

      const [wx, wy, wz] = truck.position ?? [0, 0, 0];
      const baseX = wx;
      const baseY = wz * hs + 4;
      const baseZ = ws - wy;

      const heading = truck.psi ?? 0;
      const fwdX = Math.sin(heading);
      const fwdZ = -Math.cos(heading);
      const rightX = Math.cos(heading);
      const rightZ = Math.sin(heading);

      const nose = 40 * markerScale;
      const tail = 14 * markerScale;
      const halfWidth = 18 * markerScale;
      const tipX2   = baseX + fwdX * nose;
      const tipZ2   = baseZ + fwdZ * nose;
      const leftX2  = baseX - fwdX * tail - rightX * halfWidth;
      const leftZ2  = baseZ - fwdZ * tail - rightZ * halfWidth;
      const rightX2 = baseX - fwdX * tail + rightX * halfWidth;
      const rightZ2 = baseZ - fwdZ * tail + rightZ * halfWidth;

      const color = TRUCK_COLORS[Math.min(i, TRUCK_COLORS.length - 1)];
      const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, depthWrite: false });

      const positions = new Float32Array([
        tipX2,   baseY, tipZ2,
        leftX2,  baseY, leftZ2,
        rightX2, baseY, rightZ2,
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

      const arrow = new THREE.Mesh(geo, mat);
      arrow.renderOrder = 1001;
      this._groups.trucks.add(arrow);
    }
  }

  /*
    Where the sun is, from the level's own light vector.

    Every game here stores one, in the same shape: the direction the light TRAVELS, as
    (east, up, north). Traxx writes it as a 16.16 fixed point triple on .LVL line 17 and its
    editor round-trips it through a five-way compass - Noon, N, E, S, W - which is what
    identifies the axes:

      Noon (0, -64000, 0)        N (0, -46333, -46333)      E (-46333, -46333, 0)
      S    (0, -46333, +46333)   W (+46333, -46333, 0)

    (TrackPOD/TrackPOD.cpp:918-957 sets them, Traxx/TraxxViewEdit.cpp:3293-3306 reads them
    back, and the `// z` comment on index 1 is what says the second component is the vertical.)
    Evo writes the same vector as a unit float triple, `lightSourceVector` in its .LVL.

    The north component needs the scene's Z flip and used to not get it. The terrain builder
    lays cell row `cz` at `z = (gridSize - cz) * cellSize`, so the world's north is scene -Z,
    and a light travelling north travels scene -Z. Reading it straight put the sun on the wrong
    side of the map along that axis. It goes unnoticed on most of the shipped content because
    the third component is zero - the E, W and Noon presets - but 13 of the 17 CART Precision
    Racing tracks are on the S preset, and five Terminal Velocity levels, and those were all
    lit from the north.
  */
  _updateSunFromTrackData(trackData) {
    const vector = trackData.sunVector;
    if (!vector) return;
    const [east, up, north] = vector;
    if (!east && !up && !north) return;   // two Hellbender levels store all zeros
    this._trackSunDirection = new THREE.Vector3(east, up, -north).normalize();
    this._sunDirection = this._trackSunDirection.clone();
    this._applySunDirection();
  }

  /** Places the directional light opposite the direction its light travels. */
  _applySunDirection(notify = true) {
    const d = this._sunDirection;
    if (!d || !this._sun) return;
    this._sun.position.copy(this._sun.target.position).addScaledVector(d, -SUN_DISTANCE);
    this._shadows.setDirection(d);
    // The baked terrain light is normalised against the sun's height; see _applyLighting.
    this._applyLighting();
    this._shadows.invalidate();
    if (notify) this._onSunChange?.(this.sunAngles());
  }

  setSunChangeCallback(fn) { this._onSunChange = fn; }

  /*
    The sun as a compass bearing and a height above the horizon.

    Bearing is where the sun IS, not where its light goes, because that is what "the sun is in
    the east" means: it is the direction the light arrives from, measured clockwise from north
    the same way every other heading in this viewer is.
  */
  sunAngles() {
    const d = this._sunDirection;
    if (!d) return null;
    const horizontal = Math.hypot(d.x, d.z);
    const elevation = Math.atan2(-d.y, horizontal) * 180 / Math.PI;
    // -d is the direction toward the sun; scene north is -Z, so bearing = atan2(-dx, dz).
    const azimuth = ((Math.atan2(-d.x, d.z) * 180 / Math.PI) % 360 + 360) % 360;
    return { azimuth, elevation, fromTrack: !!this._trackSunDirection && d.equals(this._trackSunDirection) };
  }

  /** Points the sun from a compass bearing and a height above the horizon, both in degrees. */
  setSunAngles(azimuthDeg, elevationDeg) {
    const a = azimuthDeg * Math.PI / 180;
    const e = Math.max(0.5, Math.min(90, elevationDeg)) * Math.PI / 180;
    const horizontal = Math.cos(e);
    /*
      The exact inverse of sunAngles. The sun sits at bearing `a`, which is the scene direction
      (sin a, ., -cos a) since north is -Z, and its light travels the opposite way - so both
      horizontal terms are negated. Getting that backwards puts the sun 180 degrees out, which
      looks plausible on a symmetric hill and wrong everywhere else.
    */
    this._sunDirection = new THREE.Vector3(
      -Math.sin(a) * horizontal, -Math.sin(e), Math.cos(a) * horizontal).normalize();
    this._applySunDirection();
  }

  /** Returns the sun to the direction the loaded level states. */
  restoreTrackSun() {
    if (!this._trackSunDirection) return;
    this._sunDirection = this._trackSunDirection.clone();
    this._applySunDirection();
  }
}

// With billboarding off, a facing prop falls back to the orientation the .SIT authored, which
// is what Traxx itself always draws. The stored matrix includes the non-uniform height
// stretch, so it is applied whole rather than decomposed.
/*
  Morph influences that show keyframe `from` blended `t` of the way to keyframe `to`. Frame 0 is
  the geometry itself and frames 1..n are the morph targets, so frame k is influence k - 1.
*/
function setKeyframeBlend(influences, from, to, t) {
  if (!influences) return;
  influences.fill(0);
  if (from > 0) influences[from - 1] += 1 - t;
  if (to > 0) influences[to - 1] += t;
}

function resetBillboardGroup(group) {
  for (const obj of group.children) {
    const staticMatrix = obj.userData.staticMatrix;
    if (!staticMatrix) continue;
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(staticMatrix);
    obj.matrixWorldNeedsUpdate = true;
  }
}

function normalizeRaceTextureIndex(index, textureCount) {
  if (textureCount <= 0) return 0;
  return index >= 0 && index < textureCount ? index : 0;
}

/*
  The path a course's runs describe, with the joins between them rounded off the way a truck
  turns: the Smooth course style.

  A course is a list of straight runs. MTM's usually meet end to start; an Evo course leaves
  the corners out, so each run ends before its corner and the next starts after it, and a
  hairpin loses its whole far leg (DEJAVUD0 climbs one dirt road to CP8 and comes down the
  parallel one, and the course holds only the two straights). Each join gets the curve the
  road takes:

    runs that turn        a curve with its control point where the two runs' lines meet
    runs that double back a U turn from the end of one to the start of the other, carried
                          past whichever of them stops short
    anything else         an S curve leaving and arriving along each run (a lane change, a
                          slight bend)

  A turn is not limited to the gap between the runs. It reaches back along both runs, as far
  as COURSE_CORNER_RADIUS from the corner and never more than half of either run, so a road
  corner draws as a wide sweep rather than a kink at the run ends. That half-run limit is
  also what keeps two neighbouring curves on one run from overlapping.
*/
const COURSE_CORNER_RADIUS = 240;
const COURSE_CURVE_STEPS = 16;

function smoothCoursePath(segments, loop) {
  const n = segments.length;
  const starts = segments.map(([start]) => start);
  const ends = segments.map(([, end]) => end);
  const curves = [];
  for (let i = 0; i < (loop ? n : n - 1); i++) {
    const j = (i + 1) % n;
    const join = courseJoin(segments[i], segments[j]);
    ends[i] = join.from;
    starts[j] = join.to;
    curves[i] = join.points;
  }
  const out = [];
  for (let i = 0; i < n; i++) out.push(starts[i], ends[i], ...(curves[i] ?? []));
  if (loop) out.push(starts[0]);
  return out;
}

/** The curve from run a to run b: where it leaves a, where it joins b, and the points between. */
function courseJoin([aStart, aEnd], [bStart, bEnd]) {
  const R = COURSE_CORNER_RADIUS;
  const d0 = new THREE.Vector2(aEnd.x - aStart.x, aEnd.z - aStart.z);
  const d1 = new THREE.Vector2(bEnd.x - bStart.x, bEnd.z - bStart.z);
  const lenA = d0.length(), lenB = d1.length();
  const straight = { from: aEnd, to: bStart, points: [] };
  if (lenA < 1e-3 || lenB < 1e-3) return straight;
  d0.divideScalar(lenA); d1.divideScalar(lenB);
  const gap = new THREE.Vector2(bStart.x - aEnd.x, bStart.z - aEnd.z);
  const cross = d0.x * d1.y - d0.y * d1.x;
  // A point `along` a run measured from its start, height included (and extrapolated past it).
  const onA = (along) => aStart.clone().lerp(aEnd, along / lenA);
  const onB = (along) => bStart.clone().lerp(bEnd, along / lenB);
  const inner = (curve) => curve.getPoints(COURSE_CURVE_STEPS).slice(1, -1);

  if (Math.abs(cross) > 0.05) {
    // Where the two runs' lines meet: s ahead of a's end, t behind b's start.
    const s = (gap.x * d1.y - gap.y * d1.x) / cross;
    const t = (d0.x * gap.y - d0.y * gap.x) / cross;
    if (s > -lenA / 2 && t > -lenB / 2 && s < 4 * R && t < 4 * R) {
      // The same distance back along both runs where it can be, so the curve is even.
      const lo = Math.max(s, t, 0);
      const hi = Math.min(s + lenA / 2, t + lenB / 2);
      const r = lo <= hi ? Math.min(Math.max(R, lo), hi) : null;
      const rA = r ?? Math.min(Math.max(R, s, 0), s + lenA / 2);
      const rB = r ?? Math.min(Math.max(R, t, 0), t + lenB / 2);
      const from = onA(lenA + s - rA);
      const to = onB(rB - t);
      const corner = onA(lenA + s);
      corner.y = (from.y + to.y) / 2;
      return { from, to, points: inner(new THREE.QuadraticBezierCurve3(from, corner, to)) };
    }
  }

  const g = gap.length();
  if (g < 1) return straight;
  const dir0 = new THREE.Vector3(d0.x, 0, d0.y), dir1 = new THREE.Vector3(d1.x, 0, d1.y);
  if (d0.dot(d1) < 0) {
    // Doubling back: carry on past whichever run stops short, then come round.
    const ahead = gap.dot(d0);
    const width = Math.abs(gap.x * d0.y - gap.y * d0.x);
    const k0 = Math.max(ahead, 0) + width * 0.66;
    const k1 = Math.max(-ahead, 0) + width * 0.66;
    return { from: aEnd, to: bStart, points: inner(new THREE.CubicBezierCurve3(
      aEnd, aEnd.clone().addScaledVector(dir0, k0), bStart.clone().addScaledVector(dir1, -k1), bStart)) };
  }
  return { from: aEnd, to: bStart, points: inner(new THREE.CubicBezierCurve3(
    aEnd, aEnd.clone().addScaledVector(dir0, g / 3), bStart.clone().addScaledVector(dir1, -g / 3), bStart)) };
}
