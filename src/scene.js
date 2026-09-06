import * as THREE from "three";
import { MATERIAL_FLAGS } from "./shared/mrgl-material.js";
import { TrackCamera } from "./nav.js";
import {
  CPR_WALL_LAYERS,
  CPR_WALL_PART_HEIGHT_FT,
  CPR_TEXTURE_SLICE_COUNT,
  CPR_CROSS_SECTION_MIDPOINT,
  cprTextureIndex,
  cprTextureSlice,
  cprTextureU,
  cprFeetToWorldY,
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

const WATER_COLOR = 0x1a6090;
const COURSE_COLOR = 0xffdd00;
const GBOX_COLOR = 0x00ff88;
// Traxx box types (Include/TrackPODBox.h and cursh2\core\sim.h's enum BoxType).
const BOXTYPE_CHECKPOINT        = 6;
const BOXTYPE_NO_COLLIDE_FACING = 8;
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
};
const NAV_DEFAULT_COLOR = 0xaaaaaa;
const NAV_START_POINT = 6;
const TUNNEL_ENTRANCE_COLOR = 0x00ccff;
const TUNNEL_EXIT_COLOR = 0x0066aa;
const POWERUP_COLOR = 0x66ff99;
const MARKER_HEAD_RADIUS = 22;
/** Where the label floats above the ground, in world units. */
const MARKER_LABEL_HEIGHT = 90;
/** Label height as a fraction of the viewport, since labels do not scale with distance. */
const LABEL_SCREEN_HEIGHT = 0.035;
const HEADING_ARROW_LENGTH = 220;

/*
  The short type tag on a navigation marker.

  Enough to tell an objective from a checkpoint at a glance, and to say which tunnel a tunnel
  point leads to, without turning the label into a sentence. The full detail is in the
  Navigation Points panel.
*/
function navLabelSuffix(point) {
  switch (point.type) {
    case 0: return `target x${point.targets?.length ?? 0}`;
    case 1: return `enter ${(point.tunnelLevel ?? "").replace(/\.LVL$/, "")}`;
    case 2: return "checkpoint";
    case 3: return "jump zone";
    case 4: return "tunnel exit";
    case 5: return "boss";
    case 6: return "start";
    default: return point.typeName ?? "";
  }
}
const GRID_COLOR = 0x444466;
const AMBIENT_COLOR = 0x888888;
const SUN_COLOR = 0xfff4e0;
const BACKGROUND_COLOR = 0xbcd6e7;
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

/**
 * Object matrix for geometry authored in Traxx local space (BIN models): T * S * R,
 * where T maps Traxx (jx,jy,jz) -> Three.js (jx, jz, -jy).
 */
function traxxModelMatrix(psi, theta, phi, posX, posY, posZ) {
  const [r0, r1, r2] = traxxRotationRows(psi, theta, phi);
  const z = TRAXX_Z_STRETCH;
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

export class TrackScene {
  constructor(container) {
    this._container = container;
    this._trackData = null;
    this._renderFlags = {
      terrain: true, textures: true, grid: false,
      courses: false, objects: true, gboxes: true,
      cboxes: false, water: true, backdrop: true, shadows: true,
      wireframe: false, trucks: true, billboards: true, checkpoints: true,
      navpoints: true, tunnels: true, powerups: true, animate: true,
    };
    this._heightScale = 4;
    this._labelTextures = [];
    this._lastTime = 0;
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
    this._renderer.shadowMap.enabled = false;
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
      cboxes:     new THREE.Group(),
      cboxesWire: new THREE.Group(),
      ramps:      new THREE.Group(),
      rampsWire:  new THREE.Group(),
      navPoints:  new THREE.Group(),
      tunnels:    new THREE.Group(),
      powerups:   new THREE.Group(),
      water:      new THREE.Group(),
      trucks:     new THREE.Group(),
      backdrop:   new THREE.Group(),
    };
    for (const g of Object.values(this._groups)) this._scene.add(g);
  }

  _initCamera() {
    const { width, height } = this._container.getBoundingClientRect();
    this._camera = new THREE.PerspectiveCamera(60, (width || 800) / (height || 600), 1, 120000);
    this._nav = new TrackCamera(this._camera);
    this._nav.bindElement(this._container);
    this._nav.setGridSpanChangeCallback((gs) => { this._onGridSpanChange?.(gs); });
  }

  setGridSpanChangeCallback(fn) { this._onGridSpanChange = fn; }
  setNavigationChangeCallback(fn) { this._nav?.setChangeCallback(fn); }

  _initLights() {
    this._ambient = new THREE.AmbientLight(AMBIENT_COLOR, 1.4);
    this._scene.add(this._ambient);
    this._sun = new THREE.DirectionalLight(SUN_COLOR, 1.0);
    this._sun.position.set(1, 2, 0.5);
    this._scene.add(this._sun);
  }

  setSunIntensity(v) {
    if (this._sun) this._sun.intensity = v;
  }

  setGamma(v) {
    this._renderer.toneMappingExposure = v;
  }

  // Set view distance in grid-cell units (1 cell = 64 world units)
  setViewDistance(cells) {
    const dist = cells * 64;
    this._camera.far = dist * 3;
    this._camera.updateProjectionMatrix();
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
    this._renderer.setSize(width, height);
  }

  _startLoop() {
    const loop = (time) => {
      requestAnimationFrame(loop);
      const dt = Math.min((time - this._lastTime) / 1000, 0.1);
      this._lastTime = time;
      this._nav.update(dt);
      // Keep backdrop centered on camera so it never appears to move
      if (this._backdropMesh) this._backdropMesh.position.copy(this._camera.position);
      this._updateBillboards();
      this._updateTextureAnimations(dt);
      this._renderer.render(this._scene, this._camera);
    };
    requestAnimationFrame((t) => { this._lastTime = t; requestAnimationFrame(loop); });
  }

  get nav() { return this._nav; }

  setRenderFlags(flags) {
    Object.assign(this._renderFlags, flags);
    this._applyVisibility();
  }

  _applyVisibility() {
    const f = this._renderFlags;
    this._groups.terrain.visible = f.terrain;
    this._groups.racetrack.visible = f.objects;
    this._groups.terrainGrid.visible = f.grid;
    this._groups.courses.visible = f.courses;
    this._groups.objects.visible = f.objects;
    this._groups.objectsWire.visible = f.objects && (f.wireframe === true);
    this._groups.billboards.visible = f.objects;
    this._groups.billboardsWire.visible = f.objects && (f.wireframe === true);
    this._groups.checkpoints.visible = f.objects && f.checkpoints !== false;
    this._groups.checkpointsWire.visible = f.objects && f.checkpoints !== false && (f.wireframe === true);
    this._groups.racetrackWire.visible = f.objects && (f.wireframe === true);
    this._groups.gboxes.visible = f.gboxes;
    this._groups.gboxesWire.visible = f.gboxes && (f.wireframe === true);
    this._groups.cboxes.visible = f.cboxes;
    this._groups.cboxesWire.visible = f.cboxes && (f.wireframe === true);
    // A ramp is track the player drives on, not an invisible collision helper, so it follows
    // the objects toggle rather than the collision-box overlay.
    this._groups.ramps.visible = f.objects && f.ramps !== false;
    this._groups.rampsWire.visible = f.objects && f.ramps !== false && (f.wireframe === true);
    this._groups.navPoints.visible = f.navpoints !== false;
    this._groups.tunnels.visible = f.tunnels !== false;
    this._groups.powerups.visible = f.powerups !== false;
    this._groups.water.visible = f.water;
    this._groups.trucks.visible = f.trucks !== false;
    this._groups.backdrop.visible = f.backdrop;
    if (this._sun) this._sun.visible = f.shadows !== false;

    // texture toggle: swap between textured and flat terrain material
    if (this._terrainMesh) {
      this._terrainMesh.material = f.textures ? this._terrainMatTextured : this._terrainMatFlat;
    }
  }

  setHeightScale(hs) {
    this._heightScale = hs;
  }

  clearTrack() {
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
    this._terrainMatTextured = null;
    this._terrainMatFlat = null;
    this._terrainAtlasTex?.dispose();
    this._terrainAtlasTex = null;
    this._terrainAtlasN = 1;
    this._terrainAtlasCols = 1;
    this._terrainAtlasRows = 1;
    this._terrainAtlasWidth = 1;
    this._terrainAtlasHeight = 1;
    this._terrainAtlasTileSize = 64;
    this._terrainAtlasPadding = 0;
    this._terrainAtlasSourceTileSize = 64;
    this._backdropMesh = null;
    this._arenaMesh = null;
    this._terrainRaw = null;
    for (const texture of this._labelTextures ?? []) texture.dispose();
    this._labelTextures = [];
    this._textureAnimations = [];
    this._animationClock = 0;
    this._modelTexCache = {};
    this._trackData = null;
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
    if (trackData.terrain) this._buildTerrain(trackData.terrain);
    // An arena REPLACES the backdrop rather than joining it: Traxx suppresses the backdrop
    // model at load (TrackPODFile.cpp:2758-2759) and again at draw
    // (TraxxViewDisplay.cpp:307-311, `openglbackdrop = arena.arena == FALSE && ...`).
    // The stadium is a closed shell, so there is no sky left to show behind it.
    // Otherwise: prefer BIN model (MTM2), fall back to RAW sky texture (TV/F3/HB).
    if (trackData.arena && trackData.models?.[trackData.arena.modelName]) {
      this._buildArena(trackData);
    } else if (trackData.backdropModelName && trackData.models?.[trackData.backdropModelName]) {
      this._buildBackdropModel(trackData.backdropModelName, trackData);
    } else if (trackData.skyTexture) {
      this._buildBackdropFromTexture(trackData.skyTexture);
    }
    if (trackData.waterLevel > 0) this._buildWater(trackData);
    if (trackData.raceTrackSurfaces?.length) this._buildRaceTrackLayer(trackData);
    this._buildCourses(trackData);
    if (trackData.boxes?.length) this._buildObjects(trackData);
    this._reportMissingModelTextures(trackData);
    if (trackData.groundBoxes?.length) this._buildGroundBoxes(trackData.groundBoxes, this._heightScale, trackData);
    if (trackData.trucks?.length) this._buildTrucks(trackData);
    if (trackData.navPoints?.length) this._buildNavPoints(trackData);
    if (trackData.tunnels?.length) this._buildTunnelMarkers(trackData);
    if (trackData.powerups?.length) this._buildPowerups(trackData);
    this._installTextureAnimations(trackData);

    this._nav.resetToCourseStart(trackData, this._heightScale);

    this._applyVisibility();
    this._updateSunFromTrackData(trackData);
  }

  _buildTerrain(terrainData) {
    const { gridSize, cellSize, positions, normals, uvs, indices, atlas } = terrainData;

    // Kept for marker placement: the raw heightfield is what puts a marker on the ground.
    this._terrainRaw = terrainData.rawData ? new Uint8Array(terrainData.rawData) : null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("normal",   new THREE.BufferAttribute(new Float32Array(normals), 3));
    geo.setAttribute("uv",       new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));

    // Atlas texture
    const atlasImg = new ImageData(new Uint8ClampedArray(atlas.rgba), atlas.width, atlas.height);
    const atlasTex = new THREE.DataTexture(atlasImg.data, atlas.width, atlas.height, THREE.RGBAFormat);
    atlasTex.wrapS = atlasTex.wrapT = THREE.ClampToEdgeWrapping;
    atlasTex.magFilter = THREE.NearestFilter;
    atlasTex.minFilter = THREE.NearestFilter;
    atlasTex.generateMipmaps = false;
    atlasTex.colorSpace = THREE.SRGBColorSpace;
    atlasTex.needsUpdate = true;

    this._terrainMatTextured = new THREE.MeshLambertMaterial({ map: atlasTex, side: THREE.FrontSide });
    this._terrainMatFlat = new THREE.MeshLambertMaterial({ color: 0x4a7a4a, side: THREE.FrontSide });
    this._terrainAtlasTex = atlasTex;
    this._terrainAtlasN = atlas.textureCount;
    this._terrainAtlasCols = atlas.atlasCols ?? atlas.textureCount ?? 1;
    this._terrainAtlasRows = atlas.atlasRows ?? 1;
    this._terrainAtlasWidth = atlas.width ?? 1;
    this._terrainAtlasHeight = atlas.height ?? 1;
    this._terrainAtlasTileSize = atlas.atlasTileSize ?? 64;
    this._terrainAtlasPadding = atlas.atlasPadding ?? 0;
    this._terrainAtlasSourceTileSize = atlas.sourceTileSize ?? 64;

    this._terrainMesh = new THREE.Mesh(geo, this._terrainMatTextured);
    this._terrainMesh.receiveShadow = false;
    this._groups.terrain.add(this._terrainMesh);

    // Grid overlay — quad edges only (no triangle diagonals)
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
    this._groups.backdrop.add(this._backdropMesh);
  }

  _buildBackdropModel(modelName, trackData) {
    const model = trackData.models?.[modelName];
    if (!model?.meshes?.length) return;
    const anchor = model.anchor ?? { x: 0, y: 0, z: 0 };

    const group = new THREE.Group();

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

      group.add(new THREE.Mesh(geo, mat));
    }

    group.renderOrder = -1;
    this._backdropMesh = group;
    this._groups.backdrop.add(group);
  }

  _buildWater(trackData) {
    const { terrain, waterLevel } = trackData;
    if (!terrain || !waterLevel) return;
    const gs = terrain.gridSize ?? 256;
    const cs = terrain.cellSize ?? 64;
    const worldSize = gs * cs;
    const y = waterLevel * (this._heightScale);
    const geo = new THREE.PlaneGeometry(worldSize, worldSize);
    const mat = new THREE.MeshLambertMaterial({
      color: WATER_COLOR, transparent: true, opacity: 0.6, side: THREE.DoubleSide
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
    const addCourse = (course, color) => {
      if (!course?.segments?.length) return;
      const pts = [];
      for (const seg of course.segments) {
        // pos[0]=JTraxx X, pos[1]=JTraxx Y(depth→flip), pos[2]=JTraxx Z(height)
        if (seg.start) pts.push(new THREE.Vector3(seg.start[0], seg.start[2] * hs + 8, ws - seg.start[1]));
        if (seg.end)   pts.push(new THREE.Vector3(seg.end[0],   seg.end[2]   * hs + 8, ws - seg.end[1]));
      }
      if (pts.length < 2) return;
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false, depthWrite: false });
      const line = new THREE.LineLoop(geo, mat);
      line.renderOrder = 1000;
      this._groups.courses.add(line);
    };
    addCourse(trackData.primaryCourse, COURSE_COLOR);
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

    Markers land on cell centres, so averaging the cell's four corners is the bilinear height
    at the point the marker actually occupies rather than the height of one of its corners.
  */
  _terrainHeightAt(editorX, editorY, trackData) {
    const terrain = trackData.terrain;
    const raw = this._terrainRaw;
    if (!raw || !terrain) return 0;
    const gridSize = terrain.gridSize ?? 256;
    const bytesPerCell = terrain.rawBytesPerCell ?? 1;
    const cx = Math.min(gridSize - 1, Math.max(0, Math.floor(editorX / (terrain.cellSize ?? 64))));
    const cz = Math.min(gridSize - 1, Math.max(0, Math.floor(editorY / (terrain.cellSize ?? 64))));

    let total = 0;
    for (const [ox, oz] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const x = Math.min(gridSize - 1, cx + ox);
      const z = Math.min(gridSize - 1, cz + oz);
      const off = (x + z * gridSize) * bytesPerCell;
      if (bytesPerCell === 1) {
        total += raw[off] ?? 0;
      } else {
        const lo = raw[off] ?? 0;
        const hi = raw[off + 1] ?? 0;
        total += hi === 0 ? lo : (lo | (hi << 8)) >>> 6;
      }
    }
    return (total / 4) * this._heightScale;
  }

  /*
    An editor-space position dropped onto the terrain surface.

    Falls back to the height stored in the record when the track carries no heightfield, so a
    marker layer never collapses to y=0 on a track this viewer cannot sample.
  */
  _markerGroundPosition(position, trackData) {
    const point = this._editorToScene(position, trackData);
    if (this._terrainRaw) point.y = this._terrainHeightAt(position[0], position[1], trackData);
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
  _makeLabelSprite(text, color) {
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
    sprite.scale.set(LABEL_SCREEN_HEIGHT * (canvas.width / canvas.height), LABEL_SCREEN_HEIGHT, 1);
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
      const base = this._markerGroundPosition(point.position, trackData);
      const color = NAV_COLORS[point.type] ?? NAV_DEFAULT_COLOR;
      this._addMapMarker(group, base, color, `NAV${i + 1} ${navLabelSuffix(point)}`);
      if (point.type === NAV_START_POINT) this._addHeadingArrow(group, base, point.heading, color);
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

    Labelled PUP1..PUPn with the record's type index appended as "t<n>". The index is not
    expanded into a name: STARTUP.POD carries thirteen POWER*.BIN pickup models, but nothing
    in any level file maps a .PUP type index onto one of them, and the F!Zone manual describes
    the powerup list only as an editor enumeration. Reporting the number the level stores is
    the honest option; inventing a name for it is not.
  */
  _buildPowerups(trackData) {
    const group = this._groups.powerups;
    trackData.powerups.forEach((powerup, i) => {
      const base = this._markerGroundPosition(powerup.position, trackData);
      this._addMapMarker(group, base, POWERUP_COLOR, `PUP${i + 1} t${powerup.type}`);
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
    const rawBytesPerCell = trackData.terrain?.rawBytesPerCell ?? 1;
    const zDivisor = rawBytesPerCell === 2 ? 4 : 2;
    // Wall heights go through the same transform as track altitude so they stay consistent
    // with the surface when the height scale slider moves.
    const partHeight = cprFeetToWorldY(CPR_WALL_PART_HEIGHT_FT, hs, zDivisor);
    const roadBuckets = new Map();
    const wallBuckets = new Map();

    /*
      No vertical bias.

      A CPR track altitude is in feet and the terrain RAW stores the same quantity scaled, so
      point[1] / zDivisor lands on the terrain height under the track directly. Checked
      against Laguna: sampling the terrain beneath the centreline of every segment gives the
      track sitting a median of 1.07 terrain units above it, with 95% of points between
      +0.08 and +1.84, which is exactly what "Match ground alt" produces (it levels the
      ground to the minimum altitude under the track, and banking drops one side below that).

      The layer used to be lifted an extra 8 world units on top of that, roughly 11 feet,
      which is what made the track look like it hovered and the surrounding objects look
      buried. Coplanar z-fighting is a depth buffer problem, so it is solved with
      polygonOffset on the material instead of by moving the geometry.
    */
    const pointToWorld = (point) => {
      if (!point || point.length < 3) return [0, 0, 0];
      const wx = 2 * Math.trunc(point[0]);
      const wy = 2 * Math.trunc(point[2]);
      const wz = point[1] / zDivisor;
      return [wx, wz * hs, ws - wy];
    };

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

    for (let i = 0; i + 1 < surfaces.length; i++) {
      const a = surfaces[i];
      const b = surfaces[i + 1];
      const aPts = a.points ?? [];
      const bPts = b.points ?? [];
      const laneCount = Math.min(aPts.length, bPts.length) - 1;
      if (laneCount < 1) continue;

      for (let lane = 0; lane < laneCount; lane++) {
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
        this._groups.racetrack.add(new THREE.Mesh(geo, materials[materialIndex]));
        this._groups.racetrackWire.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), wireMat));
      }
    };

    addMeshes(roadBuckets);
    addMeshes(wallBuckets);
  }

  _makeRaceTrackMaterial(texture, index) {
    if (texture?.rgba && texture.width > 0 && texture.height > 0) {
      const tex = new THREE.DataTexture(new Uint8ClampedArray(texture.rgba), texture.width, texture.height, THREE.RGBAFormat);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
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
      if (trackData.origin === "HB" && box.hellbenderUndergroundHidden) continue;
      const [wx, wy, wz] = box.position ?? [0, 0, 0];
      const modelName = box.modelName;
      const model = modelName ? trackData.models?.[modelName] : null;
      const renderModel = model?.meshes?.length;
      const isBillboard = box.type === BOXTYPE_NO_COLLIDE_FACING;
      const isCheckpoint = box.type === BOXTYPE_CHECKPOINT;
      const isRamp = box.type === BOXTYPE_RAMP;

      if (renderModel) {
        this._buildBinModel(model, box, hs, ws, trackData, { checkpoint: isCheckpoint, billboard: isBillboard });
      }

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
    const alphaTested = material ? !!(flags & F.ALPHATEST) : !!mesh.transparent;
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
      side: material && (flags & F.TWOSIDED) ? THREE.DoubleSide : THREE.BackSide,
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
    const [wx, wy, wz] = box.position ?? [0, 0, 0];

    // World position in Three.js space
    const posX = wx;
    const posY = trackData.origin === "HB" ? wz * 3 : wz * hs + (model.baseZ ?? 0) * 0.75;
    const posZ = ws - wy;

    // SIT angles are in RADIANS: psi=yaw (around Traxx Z height), theta=pitch (X), phi=roll (Y depth).
    // Model vertices are in raw Traxx local space; the 0.75 height stretch lives in the matrix,
    // because Traxx applies it after the rotation and it does not commute with one.
    const modelMatrix = traxxModelMatrix(box.psi ?? 0, box.theta ?? 0, box.phi ?? 0, posX, posY, posZ);

    const group = new THREE.Group();
    const meshRoot = billboard ? new THREE.Group() : group;

    const wireGroup = new THREE.Group();
    const wireRoot = billboard ? new THREE.Group() : wireGroup;
    const wireMat = new THREE.LineBasicMaterial({ color: 0xF5E287 });

    for (const mesh of model.meshes ?? []) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
      geo.setAttribute("normal",   new THREE.BufferAttribute(new Float32Array(mesh.normals), 3));
      geo.setAttribute("uv",       new THREE.BufferAttribute(new Float32Array(mesh.uvs), 2));
      geo.computeBoundingSphere();

      meshRoot.add(new THREE.Mesh(geo, this._createModelMaterial(mesh)));
      wireRoot.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), wireMat));
    }

    if (billboard) {
      group.position.set(posX, posY, posZ);
      wireGroup.position.copy(group.position);

      // Facing props are yawed toward the camera each frame, but the 0.75 vertical world
      // stretch still applies. Three composes local matrices as T*R*S, and a scale of
      // (1, 0.75, 1) commutes with the pure Y-axis rotation `lookAt` produces, so putting it
      // on the group's scale is equivalent to Traxx applying it after the rotation.
      group.scale.set(1, TRAXX_Z_STRETCH, 1);
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

      const localAxisMatrix = new THREE.Matrix4().set(
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

    const targetGroup = billboard ? this._groups.billboards : (checkpoint ? this._groups.checkpoints : this._groups.objects);
    const targetWireGroup = billboard ? this._groups.billboardsWire : (checkpoint ? this._groups.checkpointsWire : this._groups.objectsWire);
    targetGroup.add(group);
    targetWireGroup.add(wireGroup);
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

  _loadModelTextures(modelTextures) {
    for (const { name, rgba, width, height } of modelTextures) {
      const tex = new THREE.DataTexture(new Uint8ClampedArray(rgba), width, height, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.needsUpdate = true;
      this._modelTexCache[name] = tex;
    }
  }

  _buildGroundBoxes(groundBoxes, hs, trackData) {
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
          }
        }
        uvAttr.needsUpdate = true;
        solidMat = new THREE.MeshLambertMaterial({ map: atlasTex });
      } else {
        solidMat = fallback;
      }

      const solidMesh = new THREE.Mesh(boxGeo, solidMat);
      solidMesh.position.set(midX, cy, midZ);
      this._groups.gboxes.add(solidMesh);

      const lineBox = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo), wireMat);
      lineBox.position.set(midX, cy, midZ);
      this._groups.gboxesWire.add(lineBox);
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
    // Triangle arrow matching Java SoftwareOverlayRenderer perspective markers
    // Colors: truck 1 = orange-yellow, others = lighter shades
    const TRUCK_COLORS = [0xFFCC00, 0xFF9900, 0xFF6600, 0xFFDD44];

    for (let i = 0; i < trackData.trucks.length; i++) {
      const truck = trackData.trucks[i];
      if (i === 0) continue;  // slot 0 is player starting position, not an NPC truck

      const [wx, wy, wz] = truck.position ?? [0, 0, 0];
      const baseX = wx;
      const baseY = wz * hs + 4;
      const baseZ = ws - wy;

      const heading = truck.psi ?? 0;
      const fwdX = Math.sin(heading);
      const fwdZ = -Math.cos(heading);
      const rightX = Math.cos(heading);
      const rightZ = Math.sin(heading);

      const tipX2   = baseX + fwdX * 40;
      const tipZ2   = baseZ + fwdZ * 40;
      const leftX2  = baseX - fwdX * 14 - rightX * 18;
      const leftZ2  = baseZ - fwdZ * 14 - rightZ * 18;
      const rightX2 = baseX - fwdX * 14 + rightX * 18;
      const rightZ2 = baseZ - fwdZ * 14 + rightZ * 18;

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

  _updateSunFromTrackData(trackData) {
    if (!trackData.sunVector) return;
    const [sx, sy, sz] = trackData.sunVector;
    const len = Math.hypot(sx, sy, sz) || 1;
    this._sun.position.set(-sx / len * 5000, -sy / len * 5000, -sz / len * 5000);
    // Do not override sun intensity from track data — user controls it via slider
  }
}

// With billboarding off, a facing prop falls back to the orientation the .SIT authored, which
// is what Traxx itself always draws. The stored matrix includes the non-uniform height
// stretch, so it is applied whole rather than decomposed.
function resetBillboardGroup(group) {
  for (const obj of group.children) {
    const staticMatrix = obj.userData.staticMatrix;
    if (!staticMatrix) continue;
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(staticMatrix);
    obj.matrixWorldNeedsUpdate = true;
  }
}

/*
  Whether a cross section slot is collapsed to zero width on this segment.

  pointOffset is the lateral offset of each point from the centreline, in feet, and is the
  direct answer. At Laguna segment 0 it runs -48, -48, -48, -36, -24, -24, 0, 24 ... so the
  two Left unused slots and every pit slot are flat against their neighbour.

  Falling back to comparing the world positions covers a track whose pointOffset block failed
  to parse, since a collapsed slot repeats its coordinates in plist as well.
*/
function isDegenerateSlot(surface, lane) {
  const offsets = surface.pointOffsets;
  if (offsets && offsets.length > lane + 1) return offsets[lane] === offsets[lane + 1];
  const points = surface.points ?? [];
  const a = points[lane];
  const b = points[lane + 1];
  if (!a || !b) return true;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function normalizeRaceTextureIndex(index, textureCount) {
  if (textureCount <= 0) return 0;
  return index >= 0 && index < textureCount ? index : 0;
}
