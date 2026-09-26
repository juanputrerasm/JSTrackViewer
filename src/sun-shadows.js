/*
  Sun shadows across the whole view distance, as cascaded shadow maps.

  A single shadow map has one texel size everywhere it covers. Stretched over the view
  distance that texel grows until trees cast smudges, so the viewer used to shadow only a
  32 cell square around the camera, and shadows stopped a short way in front of it. Cascades
  split the view frustum by distance and give each slice its own map: fine texels close to
  the camera, where detail shows, and coarse ones far away, where it does not.

  three.js's CSM add-on does the splitting and fitting. It lights with one directional light
  per cascade and selects one of them per fragment, which has two consequences handled here:

    - Every lit material has to be set up for it. A material that is not would add all the
      cascade lights together and render several times too bright. setupMaterials walks the
      scene and sets up whatever it has not seen, so materials created later (a texture
      toggle swapping the terrain's, a truck being loaded) are picked up on the next pass.

    - CSM takes a material's onBeforeCompile for itself. The terrain already has one (the
      CPR road mask, see scene.js), so an existing hook is kept and run first, and the
      program cache key is made to tell the combined hook apart from CSM's alone.

  With shadows off the cascades are hidden and the scene's ordinary sun lights instead: a
  set up material with no shadowed lights falls through to CSM's plain lighting loop, so it
  is lit exactly once either way.

  Keeping it cheap. A shadow map redraw draws every caster in the cascade again, and on a
  track with thousands of objects that is most of a frame's work. CSM fits each cascade to
  the view frustum, so every turn of the camera, not only every move, redraws all four. Here
  the fitting is CSM's replaced (see _fit) so that the maps depend as little as possible on
  the camera:

    - Each cascade covers a circle around the camera rather than its slice of the frustum:
      the circle that holds the slice however the camera is turned. Looking around then
      never redraws anything.
    - Each covers a little more than it needs (SLACK) and is redrawn only once the camera
      has moved further than that from where it was last fitted. Moving slowly redraws the
      near cascade now and then and the far one hardly ever.
    - When things in the scene move (a truck being driven, objects knocked about), the near
      cascade redraws every frame and each further one half as often.
    - The fit is snapped to whole texels, so a refit does not make shadow edges crawl.
*/

import * as THREE from "three";
import { CSM } from "three/addons/csm/CSM.js";

const CASCADES = 4;
const MAP_SIZE = 2048;
/** Where the first three cascades end, in world units (64 to a cell); the last runs on to maxFar. */
const CASCADE_ENDS = [1200, 4000, 10000];
const LIGHT_MARGIN = 3000;
const LIGHT_FAR = 80000;
/** How much further than its slice each cascade reaches, as a fraction: the camera's free travel. */
const SLACK = 0.12;
/** Depth room behind a cascade's circle toward the sun, in world units, for tall casters. */
const DEPTH_MARGIN = 6000;
/** Normal offset per cascade, as a fraction of that cascade's texel: enough to stop acne on the terrain. */
const NORMAL_BIAS_PER_TEXEL = 0.5;
const DEPTH_BIAS = -0.00002;
/** Materials whose shader uses the scene lights, and so the cascade lights. */
const isLit = (material) => material && (material.isMeshLambertMaterial || material.isMeshPhongMaterial
  || material.isMeshStandardMaterial || material.isMeshToonMaterial);

export class SunShadows {
  constructor({ scene, camera, color, intensity = 1, maxFar = 24576 }) {
    this._scene = scene;
    this._camera = camera;
    this._seen = new WeakSet();
    this._csm = new CSM({
      camera,
      parent: scene,
      cascades: CASCADES,
      maxFar,
      mode: "custom",
      customSplitsCallback: (amount, near, far, target) => {
        for (let i = 1; i < amount; i++) {
          // Fixed distances, squeezed evenly if the view distance is shorter than they are.
          const end = CASCADE_ENDS[i - 1] ?? far;
          target.push(Math.min(end / far, i / amount));
        }
        target.push(1);
      },
      shadowMapSize: MAP_SIZE,
      lightIntensity: intensity,
      lightNear: 1,
      lightFar: LIGHT_FAR,
      lightMargin: LIGHT_MARGIN,
    });
    for (const light of this._csm.lights) {
      light.color.set(color);
      light.shadow.bias = DEPTH_BIAS;
      // Redrawn per cascade, only when _fit or invalidate says so.
      light.shadow.autoUpdate = false;
    }
    this._fits = this._csm.lights.map(() => ({ center: null, radius: 0 }));
    this._frame = 0;
    this._dynamic = false;
    this.setEnabled(false);
  }

  get enabled() { return this._enabled; }

  /** Shows the cascade lights and lets them cast, or hides them all. */
  setEnabled(enabled) {
    this._enabled = enabled;
    for (const light of this._csm.lights) {
      light.visible = enabled;
      light.castShadow = enabled;
    }
    this.invalidate();
  }

  /** Something that affects every shadow changed (the sun, the track, visibility): redraw all. */
  invalidate() {
    for (const fit of this._fits ?? []) fit.center = null;
  }

  /** Something in the scene moved this frame: redraw near cascades now, far ones in turn. */
  invalidateDynamic() {
    this._dynamic = true;
  }

  setIntensity(value) {
    for (const light of this._csm.lights) light.intensity = value;
  }

  setColor(color) {
    for (const light of this._csm.lights) light.color.set(color);
  }

  /** The direction the sunlight travels, as the scene's own sun uses it. */
  setDirection(direction) {
    this._csm.lightDirection.copy(direction).normalize();
    this.invalidate();
  }

  /** After the camera's aspect or far plane changes: the cascades are cut from its frustum. */
  setMaxFar(maxFar) {
    this._csm.maxFar = maxFar;
    this.refit();
  }

  refit() {
    // Recomputes the cascade breaks and the shaders' copies of them; the circles follow.
    this._csm.updateFrustums();
    this.invalidate();
  }

  /**
   * Sets up every lit material under `root` that has not been seen yet.
   * Cheap on a scene that has not changed: one traversal and a WeakSet lookup per material.
   */
  setupMaterials(root = this._scene) {
    root.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!isLit(material) || this._seen.has(material)) continue;
        this._seen.add(material);
        this._setup(material);
      }
    });
  }

  _setup(material) {
    const own = Object.prototype.hasOwnProperty.call(material, "onBeforeCompile") ? material.onBeforeCompile : null;
    this._csm.setupMaterial(material);
    if (!own) return;
    const csmHook = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      own.call(material, shader, renderer);
      csmHook.call(material, shader, renderer);
    };
    const key = `${own.toString()}|${csmHook.toString()}`;
    material.customProgramCacheKey = () => key;
    material.needsUpdate = true;
  }

  /** Drops the materials of a track that has been cleared, which the CSM would otherwise keep. */
  forgetMaterials() {
    this._csm.shaders.clear();
    this._seen = new WeakSet();
  }

  /**
   * Once a frame: refits and marks for redrawing the cascades that need it. Returns true when
   * any does, for the renderer's shadow pass to run.
   */
  update() {
    if (!this._enabled) return false;
    this._frame++;
    const camera = this._camera;
    camera.updateMatrixWorld();
    const far = Math.min(camera.far, this._csm.maxFar);
    // The farthest a point at view depth d can be from the camera is d times this.
    const ty = Math.tan((camera.fov * Math.PI / 180) / 2);
    const tx = ty * camera.aspect;
    const spread = Math.sqrt(1 + tx * tx + ty * ty);

    let any = false;
    this._csm.lights.forEach((light, i) => {
      const fit = this._fits[i];
      const reach = this._csm.breaks[i] * far * spread;
      const radius = reach * (1 + SLACK);
      const stale = !fit.center || Math.abs(fit.radius - radius) > radius * 1e-3
        || fit.center.distanceTo(camera.position) > reach * SLACK;
      const due = this._dynamic && this._frame % (1 << i) === 0;
      if (!stale && !due) return;
      if (stale) this._fit(light, fit, radius);
      light.shadow.needsUpdate = true;
      any = true;
    });
    this._dynamic = false;
    return any;
  }

  /*
    Points a cascade's light at a circle of `radius` around the camera, snapped to texels in
    the light's own frame so that successive fits line up with each other.
  */
  _fit(light, fit, radius) {
    const direction = this._csm.lightDirection;
    _orientation.lookAt(_zero, direction, _worldUp);
    _inverse.copy(_orientation).invert();
    const texel = (2 * radius) / MAP_SIZE;
    _center.copy(this._camera.position).applyMatrix4(_inverse);
    _center.x = Math.round(_center.x / texel) * texel;
    _center.y = Math.round(_center.y / texel) * texel;
    _center.applyMatrix4(_orientation);

    const cam = light.shadow.camera;
    cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
    cam.near = 1;
    cam.far = 2 * radius + 2 * DEPTH_MARGIN;
    cam.updateProjectionMatrix();
    light.position.copy(_center).addScaledVector(direction, -(radius + DEPTH_MARGIN));
    light.target.position.copy(_center);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
    light.shadow.normalBias = texel * NORMAL_BIAS_PER_TEXEL;

    fit.center = this._camera.position.clone();
    fit.radius = radius;
  }
}

const _orientation = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const _center = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
