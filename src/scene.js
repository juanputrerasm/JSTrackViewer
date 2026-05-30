import * as THREE from "three";
import { TrackCamera } from "./nav.js";

const WATER_COLOR = 0x1a6090;
const COURSE_COLOR = 0xffdd00;
const GBOX_COLOR = 0x00ff88;
// Collision box colors matching JTraxx Java constants
const CBOX_TOP    = 0x8D42FF;
const CBOX_SIDE   = 0x6A20C8;
const CBOX_BOTTOM = 0x3F0A80;
const CBOX_WIRE   = 0x9A4DFF;
const GRID_COLOR = 0x444466;
const AMBIENT_COLOR = 0x888888;
const SUN_COLOR = 0xfff4e0;
const BACKGROUND_COLOR = 0xbcd6e7;
const EMPTY_BACKGROUND_COLOR = 0x151417;

export class TrackScene {
  constructor(container) {
    this._container = container;
    this._trackData = null;
    this._renderFlags = {
      terrain: true, textures: true, grid: false,
      courses: false, objects: true, gboxes: true,
      cboxes: false, water: true, backdrop: true, shadows: true,
      wireframe: false, trucks: true, billboards: true, checkpoints: true,
    };
    this._heightScale = 4;
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
    // Backdrop: prefer BIN model (MTM2), fall back to RAW sky texture (TV/F3/HB)
    if (trackData.backdropModelName && trackData.models?.[trackData.backdropModelName]) {
      this._buildBackdropModel(trackData.backdropModelName, trackData);
    } else if (trackData.skyTexture) {
      this._buildBackdropFromTexture(trackData.skyTexture);
    }
    if (trackData.waterLevel > 0) this._buildWater(trackData);
    if (trackData.raceTrackSurfaces?.length) this._buildRaceTrackLayer(trackData);
    this._buildCourses(trackData);
    if (trackData.boxes?.length) this._buildObjects(trackData);
    if (trackData.groundBoxes?.length) this._buildGroundBoxes(trackData.groundBoxes, this._heightScale, trackData);
    if (trackData.trucks?.length) this._buildTrucks(trackData);

    this._nav.resetToCourseStart(trackData, this._heightScale);

    this._applyVisibility();
    this._updateSunFromTrackData(trackData);
  }

  _buildTerrain(terrainData) {
    const { gridSize, cellSize, positions, normals, uvs, indices, atlas } = terrainData;

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

      // Stored positions are in JTraxx-local space: (v - anchor) * [1, 1, 0.75]
      // Backdrop needs raw scaled positions relative to camera in Three.js axes:
      //   three.x = local.x + anchor.x   (JTraxx X → Three.js X)
      //   three.y = local.z / 0.75 + anchor.z  (JTraxx Z → Three.js Y, undo 0.75)
      //   three.z = -(local.y + anchor.y) (JTraxx Y depth → Three.js -Z)
      for (let i = 0; i < srcPos.length; i += 3) {
        backdropPos[i]     = srcPos[i]     + anchor.x;
        backdropPos[i + 1] = srcPos[i + 2] / 0.75 + anchor.z;
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

  _buildRaceTrackLayer(trackData) {
    const surfaces = trackData.raceTrackSurfaces ?? [];
    if (surfaces.length < 2) return;

    const textures = trackData.raceTrackTextures ?? [];
    const materials = textures.map((tex, i) => this._makeRaceTrackMaterial(tex, i));
    if (!materials.length) materials.push(new THREE.MeshLambertMaterial({ color: 0x717178 }));

    const hs = this._heightScale;
    const ws = this._worldSize(trackData);
    const rawBytesPerCell = trackData.terrain?.rawBytesPerCell ?? 1;
    const roadBuckets = new Map();
    const wallBuckets = new Map();

    const pointToWorld = (point, yBias = 8) => {
      if (!point || point.length < 3) return [0, yBias, 0];
      const wx = 2 * Math.trunc(point[0]);
      const wy = 2 * Math.trunc(point[2]);
      const zDivisor = rawBytesPerCell === 2 ? 4 : 2;
      const wz = point[1] / zDivisor;
      return [wx, wz * hs + yBias, ws - wy];
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
        if (!isRaceLaneInsideWalls(a, b, lane)) continue;
        const texIdx = normalizeRaceTextureIndex(a.textureIndexes?.[lane] ?? 0, materials.length);
        const p0 = pointToWorld(aPts[lane]);
        const p1 = pointToWorld(bPts[lane]);
        const p2 = pointToWorld(bPts[lane + 1]);
        const p3 = pointToWorld(aPts[lane + 1]);
        const len = Math.max(1, Math.hypot(p1[0] - p0[0], p1[2] - p0[2]));
        const width = Math.max(1, Math.hypot(p3[0] - p0[0], p3[2] - p0[2]));
        const uRepeat = Math.max(1, width / 256);
        const vRepeat = Math.max(1, len / 256);
        addQuad(roadBuckets, texIdx, p0, p1, p2, p3, [
          0, 1,
          0, 1 - vRepeat,
          uRepeat, 1 - vRepeat,
          uRepeat, 1,
        ]);
      }

      const pointCount = Math.min(aPts.length, bPts.length);
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        const wallType = Math.max(a.wallTypes?.[pointIndex] ?? 0, b.wallTypes?.[pointIndex] ?? 0);
        if (wallType <= 0) continue;
        const p0 = pointToWorld(aPts[pointIndex], 10);
        const p1 = pointToWorld(bPts[pointIndex], 10);
        const wallHeight = Math.min(18, 6 + wallType * 2);
        const p2 = [p1[0], p1[1] + wallHeight, p1[2]];
        const p3 = [p0[0], p0[1] + wallHeight, p0[2]];
        const wallValue = selectRaceWallTexture(a.wallTextures?.[pointIndex], b.wallTextures?.[pointIndex]);
        const texIdx = normalizeRaceTextureIndex(wallValue, materials.length);
        const len = Math.max(1, Math.hypot(p1[0] - p0[0], p1[2] - p0[2]));
        const uRepeat = Math.max(1, len / 256);
        const vRepeat = Math.max(1, wallHeight / 64);
        addQuad(wallBuckets, texIdx, p0, p1, p2, p3, raceWallUvs(wallValue, uRepeat, vRepeat));
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
      return new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
    }
    const fallback = [0x717178, 0x5c5c62, 0x8b8b91, 0x6b6048, 0x7a785f][index % 5];
    return new THREE.MeshLambertMaterial({ color: fallback, side: THREE.DoubleSide });
  }

  _buildObjects(trackData) {
    const hs = this._heightScale;
    const ws = this._worldSize(trackData);

    // Shared cbox materials (top/sides/bottom like JTraxx)
    const cboxMatSide   = new THREE.MeshBasicMaterial({ color: CBOX_SIDE,   transparent: true, opacity: 0.75 });
    const cboxMatTop    = new THREE.MeshBasicMaterial({ color: CBOX_TOP,    transparent: true, opacity: 0.75 });
    const cboxMatBottom = new THREE.MeshBasicMaterial({ color: CBOX_BOTTOM, transparent: true, opacity: 0.75 });
    const cboxWireMat   = new THREE.LineBasicMaterial({ color: CBOX_WIRE });

    for (const box of trackData.boxes ?? []) {
      if (trackData.origin === "HB" && box.hellbenderUndergroundHidden) continue;
      const [wx, wy, wz] = box.position ?? [0, 0, 0];
      const modelName = box.modelName;
      const model = modelName ? trackData.models?.[modelName] : null;
      const renderModel = model?.meshes?.length;
      const isBillboard = box.type === 8;
      const isCheckpoint = box.type === 6;

      if (renderModel) {
        this._buildBinModel(model, box, hs, ws, trackData, { checkpoint: isCheckpoint, billboard: isBillboard });
      }

      if (!renderModel) {
        const hw = (box.width  ?? 32) * 2;
        const hh = (box.height ?? 32) * 2;
        const hl = (box.length ?? 32) * 2;
        const cGeo = this._buildCboxGeometry(hw, hh, hl);
        const cMesh = new THREE.Mesh(cGeo, [cboxMatSide, cboxMatTop, cboxMatBottom]);
        this._applyBoxMatrix(cMesh, box, wz * hs, wx, ws - wy);
        this._groups.cboxes.add(cMesh);

        const wGeo = new THREE.BoxGeometry(hw, hh, hl);
        const wEdges = new THREE.EdgesGeometry(wGeo);
        const wBox = new THREE.LineSegments(wEdges, cboxWireMat);
        this._applyBoxMatrix(wBox, box, wz * hs, wx, ws - wy);
        this._groups.cboxesWire.add(wBox);
      }
    }
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

  // Apply box rotation matrix (using SIT radians directly, cbox uses +psi per Java buildBoxPrism)
  _applyBoxMatrix(obj, box, posY, posX, posZ) {
    const psi   = box.psi   ?? 0;
    const theta = box.theta ?? 0;
    const phi   = box.phi   ?? 0;
    const Cp = Math.cos(psi),   Sp = Math.sin(psi);
    const Ct = Math.cos(theta), St = Math.sin(theta);
    const Cf = Math.cos(phi),   Sf = Math.sin(phi);
    // Cbox uses +psi (matches Java buildBoxPrism: rotateZ(v, +psi))
    const Rx0 = Cf*Cp - Sf*St*Sp,  Rx1 = -Cf*Sp - Sf*St*Cp,  Rx2 = -Sf*Ct;
    const Ry0 = Sp*Ct,              Ry1 =  Cp*Ct,              Ry2 = -St;
    const Rz0 = Sf*Cp + Cf*St*Sp,  Rz1 = -Sf*Sp + Cf*St*Cp,  Rz2 =  Cf*Ct;
    // The box geometry is in Three.js space, so apply T*R_cbox*T^{-1}:
    // Row 0: [Rx0, Rx2, -Rx1, posX]
    // Row 1: [Rz0, Rz2, -Rz1, posY]
    // Row 2: [-Ry0, -Ry2, Ry1, posZ]
    obj.matrixAutoUpdate = false;
    obj.matrix.set(
       Rx0,  Rx2, -Rx1,  posX,
       Rz0,  Rz2, -Rz1,  posY,
      -Ry0, -Ry2,  Ry1,  posZ,
       0,    0,    0,     1
    );
    obj.matrixWorldNeedsUpdate = true;
  }

  _buildBinModel(model, box, hs, ws, trackData, options = {}) {
    const checkpoint = options.checkpoint === true;
    const billboard = options.billboard === true;
    const [wx, wy, wz] = box.position ?? [0, 0, 0];

    // World position in Three.js space
    const posX = wx;
    const posY = trackData.origin === "HB" ? wz * 3 : wz * hs + (model.baseZ ?? 0) * 0.75;
    const posZ = ws - wy;

    // SIT angles are in RADIANS: psi=yaw (around JTraxx Z height), theta=pitch (X), phi=roll (Y depth)
    // Java applies: rotateZ(-psi) → rotateX(theta) → rotateY(-phi) in JTraxx local space
    // Vertices are stored in JTraxx local space with 0.75 on Z, so the matrix is T*R
    // where T maps (jx,jy,jz) → (jx, jz, -jy) (Three.js axes)
    const psi   = box.psi   ?? 0;
    const theta = box.theta ?? 0;
    const phi   = box.phi   ?? 0;

    const Cp = Math.cos(psi),   Sp = Math.sin(psi);
    const Ct = Math.cos(theta), St = Math.sin(theta);
    const Cf = Math.cos(phi),   Sf = Math.sin(phi);

    // Java rotation matrix rows in JTraxx space (R = R_Y(-phi) * R_X(theta) * R_Z(-psi)):
    const Rx0 = Cf*Cp + Sf*St*Sp,  Rx1 = Cf*Sp - Sf*St*Cp,  Rx2 = -Sf*Ct;
    const Ry0 = -Ct*Sp,             Ry1 =  Ct*Cp,            Ry2 = -St;
    const Rz0 = Sf*Cp - Cf*St*Sp,  Rz1 = Sf*Sp + Cf*St*Cp,  Rz2 =  Cf*Ct;

    // Combined T*R matrix: Three.js X←JTraxx X (Rx), Y←JTraxx Z (Rz), Z←(-JTraxx Y) (-Ry)
    const modelMatrix = new THREE.Matrix4().set(
       Rx0,  Rx1,  Rx2,  posX,
       Rz0,  Rz1,  Rz2,  posY,
      -Ry0, -Ry1, -Ry2,  posZ,
       0,    0,    0,     1
    );

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

      let mat;
      const texName = mesh.textureName;
      const alphaOpts = mesh.transparent ? { alphaTest: 0.5 } : {};
      // Legacy BIN meshes are wound opposite to Three.js' default front-face expectation.
      // Using BackSide matches the original renderer path, which culls front faces.
      if (texName && this._modelTexCache[texName]) {
        mat = new THREE.MeshLambertMaterial({ map: this._modelTexCache[texName], side: THREE.BackSide, ...alphaOpts });
      } else {
        const c = mesh.color ?? 0xaaaaaa;
        const r = ((c >> 16) & 0xff) / 255;
        const g = ((c >> 8)  & 0xff) / 255;
        const b = (c & 0xff) / 255;
        mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(r, g, b), side: THREE.BackSide });
      }
      meshRoot.add(new THREE.Mesh(geo, mat));
      wireRoot.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), wireMat));
    }

    if (billboard) {
      group.position.set(posX, posY, posZ);
      wireGroup.position.copy(group.position);
      group.userData.staticQuaternion = group.quaternion.clone();
      wireGroup.userData.staticQuaternion = wireGroup.quaternion.clone();

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
        target.set(this._camera.position.x, obj.position.y, this._camera.position.z);
        obj.lookAt(target);
      }
    };
    orient(this._groups.billboards);
    orient(this._groups.billboardsWire);
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

function resetBillboardGroup(group) {
  for (const obj of group.children) {
    if (obj.userData.staticQuaternion) {
      obj.quaternion.copy(obj.userData.staticQuaternion);
    }
  }
}

function isRaceLaneInsideWalls(surfaceA, surfaceB, lane) {
  const wallIndexes = [];
  const collect = (wallTypes) => {
    for (let i = 0; i < (wallTypes?.length ?? 0); i++) {
      if ((wallTypes[i] ?? 0) > 0) wallIndexes.push(i);
    }
  };
  collect(surfaceA.wallTypes);
  collect(surfaceB.wallTypes);
  if (wallIndexes.length < 2) return true;
  const leftWall = Math.min(...wallIndexes);
  const rightWall = Math.max(...wallIndexes);
  return lane >= leftWall && lane < rightWall;
}

function normalizeRaceTextureIndex(value, textureCount) {
  if (textureCount <= 0) return 0;
  const idx = (value ?? 0) & 0x0FFF;
  return idx >= 0 && idx < textureCount ? idx : 0;
}

function selectRaceWallTexture(aValues, bValues) {
  const first = (aValues ?? [])[0] ?? (bValues ?? [])[0];
  return Number.isFinite(first) ? first : 0;
}

function raceWallUvs(value, uRepeat, vRepeat) {
  const tile = (((value ?? 0) >> 12) & 3) / 4;
  const u0 = tile;
  const u1 = tile + 0.25 * uRepeat;
  return [
    u0, 1,
    u1, 1,
    u1, 1 - vRepeat,
    u0, 1 - vRepeat,
  ];
}
