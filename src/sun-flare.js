/*
  The sun, the moon and MTM2's lens flare.

  All of it comes from MTM2's STARTUP.POD. The textures are its SUN*.RAW, SUNCRAM.RAW and
  MOON.RAW with their palettes, exported to resources/flare. The layout is its SUN.TXT,
  transcribed below:

    master radius 916   "a radius of this size is full screen size"
    layers              texture, axis position, radius, texture rectangle
    vischecking rays    nine points around the camera, 8 ft apart, cast at the sun

  Sizes. The TRI engine projects with a fixed 512 pixel focal length, and a layer of radius
  r measures r / 916 of that on screen. That puts the glare and the largest ring at the
  sizes MTM2 draws them at 1280x720. Here the focal length comes from the camera instead,
  so the flare keeps its proportions at any window size and field of view.

  Placement. A layer's axis position runs along the line from the screen centre (0) through
  the sun (1) and on past the centre (negative), which is where the ghost rings sit.

  The sun disc itself (SUN02, the file's "this is now drawn with the sky") and the moon that
  replaces it at night are not part of the flare. They go in the sky, before everything
  else, so the terrain and the backdrop cover them the way they cover the sky. The flare is
  drawn over the finished frame and fades with the share of the nine rays that reach the sun.
*/

import * as THREE from "three";

const MASTER_RADIUS = 916;
/** SUN.TXT texture rectangles are in 256ths, whatever the texture's real size. */
const TEXTURE_UNITS = 256;
const SUN_DISC = { file: "SUN02.png", radius: 458 };
/** Not in SUN.TXT; measured off MTM2's night sky at 1280x720, about 42 px across the radius. */
const MOON_DISC = { file: "MOON.png", radius: 75 };
const LAYERS = [
  ["SUN06.png", 0.2, 43, 8, 8, 248, 248],
  ["SUN07.png", 0.0, 11, 8, 8, 248, 248],
  ["SUN07.png", -0.271, 27, 8, 8, 248, 248],
  ["SUN09.png", -0.416, 80, 8, 8, 248, 248],
  ["SUNCRAM.png", -0.447, 143, 130, 130, 254, 254],
  ["SUN11.png", -0.475, 41, 8, 8, 248, 248],
  ["SUN12.png", -0.643, 61, 8, 8, 248, 248],
  ["SUN13.png", -0.674, 60, 8, 8, 248, 248],
  ["SUNCRAM.png", -1.0, 213, 130, 2, 254, 126],
  ["SUNCRAM.png", -1.333, 410, 2, 130, 126, 254],
];
/** The vischecking rays' offsets from the camera, in feet across (x) and up (y) the view. */
const VIS_RAYS = [[0, 0], [0, 8], [0, -8], [8, 0], [-8, 0], [4, 4], [4, -4], [-4, 4], [-4, -4]];
/** How far past the screen edge, in half-screens, the sun can be before the flare is gone. */
const EDGE_FADE = 0.35;

export class SunFlare {
  /**
   * @param {THREE.Object3D} skyParent  where the sun and moon discs go: the sky's group
   */
  constructor(skyParent) {
    this._loader = new THREE.TextureLoader();
    this._textures = new Map();
    this._mode = "none";
    this._visibility = 0;

    this._overlay = new THREE.Scene();
    this._overlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    this._layers = LAYERS.map(([file, axis, radius, x1, y1, x2, y2]) => {
      const geo = new THREE.PlaneGeometry(1, 1);
      const uv = geo.attributes.uv;
      // PlaneGeometry corners: (0,1) (1,1) (0,0) (1,0) in UV, top-left first.
      const u1 = x1 / TEXTURE_UNITS, u2 = x2 / TEXTURE_UNITS;
      const v1 = 1 - y1 / TEXTURE_UNITS, v2 = 1 - y2 / TEXTURE_UNITS;
      uv.setXY(0, u1, v1); uv.setXY(1, u2, v1); uv.setXY(2, u1, v2); uv.setXY(3, u2, v2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map: this._texture(file), blending: THREE.AdditiveBlending, transparent: true,
        depthTest: false, depthWrite: false, toneMapped: false,
      }));
      mesh.frustumCulled = false;
      this._overlay.add(mesh);
      return { mesh, axis, radius };
    });

    /*
      The discs are opaque-pass objects in the sky's group, so they draw with the sky and
      before the rest of the scene. Blending still applies to an opaque material as long as
      it is not NormalBlending, which is why the moon uses an explicit alpha blend.
    */
    this._sunDisc = this._disc(SUN_DISC.file, { blending: THREE.AdditiveBlending });
    this._moonDisc = this._disc(MOON_DISC.file, {
      blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    skyParent.add(this._sunDisc, this._moonDisc);
  }

  _texture(file) {
    if (!this._textures.has(file)) {
      const tex = this._loader.load(new URL(`./resources/flare/${file}`, import.meta.url).href);
      tex.colorSpace = THREE.SRGBColorSpace;
      this._textures.set(file, tex);
    }
    return this._textures.get(file);
  }

  _disc(file, blend) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._texture(file), depthTest: false, depthWrite: false, fog: false, toneMapped: false, ...blend,
    }));
    sprite.frustumCulled = false;
    sprite.renderOrder = 1;   // after the sky dome, which is 0 in the same group
    sprite.visible = false;
    return sprite;
  }

  /** "sun" (disc and flare), "moon" (disc only) or "none". */
  setMode(mode) {
    this._mode = mode;
    if (mode === "none") this._visibility = 0;
  }

  /**
   * Places everything for this frame.
   *
   * @param {THREE.PerspectiveCamera} camera
   * @param {THREE.Vector3} lightDirection  the way the sunlight travels (unit)
   * @param {boolean} showDiscs             whether the sky, and so the discs, are drawn
   * @param {boolean} showFlare
   * @param {(origin: THREE.Vector3, direction: THREE.Vector3) => boolean} blocked
   */
  update(camera, lightDirection, showDiscs, showFlare, blocked) {
    const toSun = _toSun.copy(lightDirection).negate().normalize();
    const distance = camera.far * 0.85;
    const disc = this._mode === "moon" ? this._moonDisc : this._sunDisc;
    const discRadius = this._mode === "moon" ? MOON_DISC.radius : SUN_DISC.radius;
    this._sunDisc.visible = false;
    this._moonDisc.visible = false;
    if (this._mode !== "none" && showDiscs) {
      disc.visible = true;
      disc.position.copy(camera.position).addScaledVector(toSun, distance);
      // A camera-facing quad whose half-size subtends atan(r / 916), as the layers do.
      disc.scale.setScalar(2 * distance * discRadius / MASTER_RADIUS);
    }

    this._flareOn = false;
    if (this._mode !== "sun" || !showFlare) return;
    camera.getWorldDirection(_forward);
    if (_forward.dot(toSun) <= 0) return;
    _screen.copy(camera.position).addScaledVector(toSun, distance).project(camera);
    const outside = Math.max(Math.abs(_screen.x), Math.abs(_screen.y)) - 1;
    const edge = outside <= 0 ? 1 : Math.max(0, 1 - outside / EDGE_FADE);
    if (edge <= 0) return;

    // The share of the nine rays that reach the sun.
    _right.setFromMatrixColumn(camera.matrixWorld, 0);
    _up.setFromMatrixColumn(camera.matrixWorld, 1);
    let clear = 0;
    for (const [x, y] of VIS_RAYS) {
      // Offsets are feet; the scene has 2 units to a foot across and 1.5 up.
      _origin.copy(camera.position).addScaledVector(_right, x * 2).addScaledVector(_up, y * 1.5);
      if (!blocked(_origin, toSun)) clear++;
    }
    this._visibility = (clear / VIS_RAYS.length) * edge;
    if (this._visibility <= 0) return;

    this._sunScreen = [_screen.x, _screen.y];
    this._flareOn = true;
  }

  /** Draws the flare over the frame just rendered. */
  render(renderer, camera) {
    if (!this._flareOn) return;
    const size = renderer.getSize(_size);
    const halfW = size.x / 2, halfH = size.y / 2;
    const cam = this._overlayCamera;
    cam.left = -halfW; cam.right = halfW; cam.top = halfH; cam.bottom = -halfH;
    cam.updateProjectionMatrix();
    const focal = halfH / Math.tan((camera.fov * Math.PI / 180) / 2);
    const [sx, sy] = this._sunScreen;
    for (const { mesh, axis, radius } of this._layers) {
      mesh.position.set(sx * halfW * axis, sy * halfH * axis, 0);
      mesh.scale.setScalar(2 * focal * radius / MASTER_RADIUS);
      mesh.material.opacity = this._visibility;
    }
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this._overlay, cam);
    renderer.autoClear = autoClear;
  }
}

const _toSun = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _screen = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _size = new THREE.Vector2();
