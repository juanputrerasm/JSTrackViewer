/*
  The Test Drive truck's lights.

  The drawing half is JSTruckViewer's TruckLightRig (src/truck-lights.js there), ported: a
  flare sprite at each lamp and, for lamps that have one, a translucent beam cone along the
  lamp's heading and pitch, both from the TRK's own light records and bitmaps. Every light
  carries a type (BinEdit's Truck.h, and the stock trucks agree):

    0  headlights       front, pitched 10 degrees down, 75 ft HEADLITE/LITEFUZZ beam
    1  brake and tail   rear, BRLT*.RAW shaped like each tail lamp
    3  roof light bar   HEADLITE lamps fanned across the cab roof, 40 ft beams
    4  special          Monster Patrol's spinning beacons, Snakebite's blinkers
    5  reverse          rear, BRLTRV.RAW, white

  What the truck viewer does not need and this does is light: at dusk or at night a beam
  has to fall on the ground and the scenery. So the headlights and the light bar each get
  one real spotlight, aimed and spread like their lamps' beams. One per group rather than
  one per lamp, because every light in a scene is paid for by every lit pixel, and a pair of
  headlights a few feet apart lights the track the same as one lamp between them.

  Which lamps are lit is the driver's and the truck's business:
    L                       headlights, light bar and specials, with their spotlights
    braking                 brake lights
    in reverse              reverse lights

  Units: the rig lives in the truck's chassis, which is drawn true at 2 scene units to a
  foot on every axis (see truck-object.js), so every TRK length is doubled here.
*/

import * as THREE from "three";

const INNER_PER_FOOT = 2;

export const LIGHT_GROUPS = ["headlights", "lightBar", "brake", "reverse", "special"];
const GROUP_BY_TYPE = { 0: "headlights", 1: "brake", 3: "lightBar", 4: "special", 5: "reverse" };
export function lightGroupOf(type) {
  return GROUP_BY_TYPE[type] ?? "special";
}
/** The groups L switches; brake and reverse follow the driving. */
const SWITCHED = new Set(["headlights", "lightBar", "special"]);

const BEAM_INTENSITY = 0.14;
const BEAM_RADIAL_SEGMENTS = 24;
const BEAM_TEXTURE_FEET = 12;
const BEAM_TEXTURE_AROUND = 2;

/*
  The spotlights. A beam cone is drawn short, but the light it throws carries further, so the
  reach is a multiple of the cone's length, and it is spread wider than the drawn cone, with
  a soft edge. No decay with distance, only a soft cutoff at the reach: a headlight pool that
  fades as 1/d is a bright blob at the bumper and nothing beyond, which is not how the game's
  lights read. Intensity is then plain irradiance, in the scene's light units (see
  LIGHT_SCALE in scene.js): about daylight on ground the beam meets squarely.
*/
const SPOT_REACH = 4;
const SPOT_MIN_REACH_FEET = 220;
const SPOT_SPREAD = 1.8;
const SPOT_MIN_ANGLE = 0.55;
const SPOT_MAX_ANGLE = Math.PI / 3.2;
const SPOT_PENUMBRA = 0.65;
const SPOT_DECAY = 0;
/*
  The lamps' own pitch, 10 degrees down on the stock headlights, puts the beam on the ground
  about 35 ft ahead. The visible cone should, but the light it throws is aimed flatter, so
  the pool reaches down the track the way a real headlight's does.
*/
const SPOT_PITCH_SHARE = 0.35;
const SPOT_INTENSITY = { headlights: 12, lightBar: 7 };

const BEAM_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    vUv = uv;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vec3 viewNormal = normalize(normalMatrix * normal);
    vFacing = abs(dot(viewNormal, normalize(-viewPosition.xyz)));
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const BEAM_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D map;
  uniform vec2 repeat;
  uniform float intensity;
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    vec3 fuzz = texture2D(map, vUv * repeat).rgb;
    float along = pow(1.0 - vUv.y, 2.2);
    float edge = pow(vFacing, 1.5);
    gl_FragColor = vec4(fuzz * intensity * along * edge, 1.0);
    #include <colorspace_fragment>
  }
`;

export class TruckLightRig {
  /**
   * @param {object[]} lights         the assembly's light records, truck space in feet
   * @param {object[]} lightTextures  decoded flare and fuzz bitmaps from the truck POD
   */
  constructor(lights, lightTextures) {
    this.group = new THREE.Group();
    this.group.name = "truck_lights";
    this.lamps = [];
    this.textures = [];
    this.spots = [];
    this.switchedOn = false;
    this.braking = false;
    this.reversing = false;
    this._toCamera = new THREE.Vector3();
    this._direction = new THREE.Vector3();
    this._worldPosition = new THREE.Vector3();
    this._worldQuaternion = new THREE.Quaternion();

    const bitmaps = new Map((lightTextures ?? []).map((texture) => [textureKey(texture.name), texture]));
    const flares = new Map();
    const fuzzes = new Map();
    const flareFor = (name, type) => {
      const key = textureKey(name) || `__type${type}`;
      if (!flares.has(key)) {
        const bitmap = bitmaps.get(textureKey(name));
        flares.set(key, this._track(bitmap ? bitmapTexture(bitmap) : fallbackFlare(type)));
      }
      return flares.get(key);
    };
    const fuzzFor = (name) => {
      const key = textureKey(name);
      if (!fuzzes.has(key)) {
        const bitmap = bitmaps.get(key);
        const texture = bitmap ? bitmapTexture(bitmap) : fallbackFuzz(key);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        fuzzes.set(key, this._track(texture));
      }
      return fuzzes.get(key);
    };

    for (const light of lights ?? []) {
      const lamp = {
        light,
        groupKey: lightGroupOf(light.type),
        position: truckVector(light.pos),
        flare: null,
        beam: null,
      };
      lamp.flare = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flareFor(light.sourceBitmap, light.type),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }));
      lamp.flare.scale.setScalar(light.radius * 2 * INNER_PER_FOOT);
      lamp.flare.renderOrder = 2;
      lamp.flare.visible = false;
      this.group.add(lamp.flare);

      if (light.coneLength > 0) {
        const length = light.coneLength * INNER_PER_FOOT;
        lamp.beam = new THREE.Mesh(
          beamGeometry(length, light.coneBaseRadius * INNER_PER_FOOT, light.coneRimRadius * INNER_PER_FOOT),
          new THREE.ShaderMaterial({
            uniforms: {
              map: { value: fuzzFor(light.coneTexture) },
              repeat: { value: new THREE.Vector2(BEAM_TEXTURE_AROUND, Math.max(1, light.coneLength / BEAM_TEXTURE_FEET)) },
              intensity: { value: BEAM_INTENSITY },
            },
            vertexShader: BEAM_VERTEX_SHADER,
            fragmentShader: BEAM_FRAGMENT_SHADER,
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
          })
        );
        lamp.beam.position.copy(lamp.position);
        lamp.beam.renderOrder = 1;
        lamp.beam.visible = false;
        lamp.beam.castShadow = false;
        this.group.add(lamp.beam);
      }
      this.lamps.push(lamp);
    }

    for (const groupKey of Object.keys(SPOT_INTENSITY)) {
      const spot = this._buildSpot(groupKey);
      if (spot) this.spots.push(spot);
    }
  }

  /*
    One spotlight standing in for a group's lamps: at their centre, aimed along their mean
    heading, as wide as their widest beam. Kept in the scene at zero intensity while off, so
    switching the lights does not change the number of lights and recompile every material.
  */
  _buildSpot(groupKey) {
    const lamps = this.lamps.filter((lamp) => lamp.groupKey === groupKey && lamp.light.coneLength > 0);
    if (!lamps.length) return null;
    const centre = new THREE.Vector3();
    const aim = new THREE.Vector3();
    let halfAngle = 0;
    let length = 0;
    for (const { light, position } of lamps) {
      centre.add(position);
      aim.add(lampDirection(light.heading, light.pitch * SPOT_PITCH_SHARE, new THREE.Vector3()));
      halfAngle = Math.max(halfAngle, Math.atan2(light.coneRimRadius, light.coneLength));
      length = Math.max(length, light.coneLength);
    }
    centre.divideScalar(lamps.length);
    aim.normalize();

    const spot = new THREE.SpotLight(0xfff2d8, 0);
    spot.position.copy(centre);
    spot.distance = Math.max(SPOT_MIN_REACH_FEET, length * SPOT_REACH) * INNER_PER_FOOT;
    spot.angle = Math.min(SPOT_MAX_ANGLE, Math.max(SPOT_MIN_ANGLE, halfAngle * SPOT_SPREAD));
    spot.penumbra = SPOT_PENUMBRA;
    spot.decay = SPOT_DECAY;
    spot.castShadow = false;
    spot.target.position.copy(centre).addScaledVector(aim, 20);
    this.group.add(spot, spot.target);
    return { groupKey, light: spot };
  }

  /** L: headlights, light bar and specials. */
  get on() { return this.switchedOn; }
  setOn(on) { this.switchedOn = !!on; }
  toggle() { this.switchedOn = !this.switchedOn; return this.switchedOn; }

  /** From the driving: brake lights while braking, reverse lights while backing up. */
  setDriving({ braking = false, reversing = false } = {}) {
    this.braking = braking;
    this.reversing = reversing;
  }

  /** How bright the spotlights are, from the scene's light scale. */
  setSpotScale(scale) {
    this._spotScale = scale;
  }

  _groupLit(groupKey) {
    if (SWITCHED.has(groupKey)) return this.switchedOn;
    if (groupKey === "brake") return this.braking;
    if (groupKey === "reverse") return this.reversing;
    return false;
  }

  /** Once per frame: spins, blinks and fades each lamp for the camera, and sets the spots. */
  update(camera, timeMs) {
    const seconds = timeMs / 1000;
    this.group.getWorldQuaternion(this._worldQuaternion);
    for (const lamp of this.lamps) {
      const { light } = lamp;
      const lit = this._groupLit(lamp.groupKey) && blinkOn(light, timeMs);
      lamp.flare.visible = lit;
      if (lamp.beam) lamp.beam.visible = lit;
      if (!lit) continue;

      lampDirection(light.heading + light.spinSpeed * seconds, light.pitch, this._direction);
      if (lamp.beam) lamp.beam.quaternion.setFromUnitVectors(BEAM_AXIS, this._direction);

      // Facing and the pull toward the camera are judged in the world, where the camera is.
      this._worldPosition.copy(lamp.position);
      this.group.localToWorld(this._worldPosition);
      this._direction.applyQuaternion(this._worldQuaternion);
      this._toCamera.subVectors(camera.position, this._worldPosition);
      const distance = this._toCamera.length();
      this._toCamera.divideScalar(distance || 1);
      lamp.flare.material.opacity = smoothstep(-0.2, 0.35, this._direction.dot(this._toCamera));
      // Pulled a little toward the camera so the lens the lamp sits on does not cut it in
      // half; the pull is in the chassis's own axes, where the sprite lives.
      const pull = Math.min(light.radius * 0.6 * INNER_PER_FOOT, distance * 0.5);
      this._toCamera.applyQuaternion(this._worldQuaternion.clone().invert());
      lamp.flare.position.copy(lamp.position).addScaledVector(this._toCamera, pull);
    }
    const scale = this._spotScale ?? 1;
    for (const { groupKey, light } of this.spots) {
      light.intensity = this._groupLit(groupKey) ? SPOT_INTENSITY[groupKey] * scale : 0;
    }
  }

  dispose() {
    for (const lamp of this.lamps) {
      lamp.flare.material.dispose();
      if (lamp.beam) {
        lamp.beam.geometry.dispose();
        lamp.beam.material.dispose();
      }
    }
    for (const { light } of this.spots) light.dispose();
    for (const texture of this.textures) texture.dispose();
    this.group.removeFromParent();
    this.group.clear();
    this.lamps = [];
    this.spots = [];
    this.textures = [];
  }

  _track(texture) {
    this.textures.push(texture);
    return texture;
  }
}

const BEAM_AXIS = new THREE.Vector3(0, 0, 1);

/** A TRK vector (feet, truck axes) in chassis space: x, up, forward becomes x, y, -z. */
function truckVector(v) {
  return new THREE.Vector3((v?.x ?? 0) * INNER_PER_FOOT, (v?.y ?? 0) * INNER_PER_FOOT, -(v?.z ?? 0) * INNER_PER_FOOT);
}

/*
  Heading 0 is straight ahead (+z in the TRK), heading grows toward +x, and pitch lifts the
  lamp up. Truck +z is chassis -z, the same flip as every other TRK vector.
*/
function lampDirection(heading, pitch, target) {
  const cosPitch = Math.cos(pitch);
  return target.set(Math.sin(heading) * cosPitch, Math.sin(pitch), -Math.cos(heading) * cosPitch).normalize();
}

function blinkOn(light, timeMs) {
  const period = (light.msOn ?? 0) + (light.msOff ?? 0);
  if (!(light.msOn > 0) || period <= 0) return true;
  return timeMs % period < light.msOn;
}

// An open cone from the lamp (base radius) to the rim, laid along +z from the origin.
function beamGeometry(length, baseRadius, rimRadius) {
  const geometry = new THREE.CylinderGeometry(
    Math.max(rimRadius, 0.01), Math.max(baseRadius, 0.01), length, BEAM_RADIAL_SEGMENTS, 1, true);
  geometry.translate(0, length / 2, 0);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

function bitmapTexture(bitmap) {
  const texture = new THREE.DataTexture(new Uint8Array(bitmap.rgba), bitmap.width, bitmap.height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// A soft round glow, for a lamp whose flare bitmap is not in the archive.
function fallbackFlare(type) {
  const size = 64;
  const tint = lightGroupOf(type) === "brake" ? [1, 0.25, 0.3] : [1, 1, 1];
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const glow = Math.max(0, 1 - r) ** 2;
      const core = r < 0.25 ? 1 : 0;
      const out = (y * size + x) * 4;
      for (let c = 0; c < 3; c += 1) data[out + c] = Math.round(255 * Math.min(1, glow * tint[c] + core * glow));
      data[out + 3] = 255;
    }
  }
  return generatedTexture(data, size);
}

/*
  Stand-in for LITEFUZZ, REDFUZZ and BLUEFUZZ, which the stock game keeps in STARTUP.POD
  rather than beside the trucks: 64x64 speckle in the one hue, seeded so every load matches.
*/
function fallbackFuzz(key) {
  const size = 64;
  const tint = key.startsWith("RED") ? [1, 0, 0] : key.startsWith("BLUE") ? [0, 0, 1] : [1, 1, 1];
  const data = new Uint8Array(size * size * 4);
  let seed = 0x2f6b1d;
  for (let i = 0; i < size * size; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const value = 0.3 + 0.5 * (seed / 0xffffffff);
    for (let c = 0; c < 3; c += 1) data[i * 4 + c] = Math.round(255 * value * tint[c]);
    data[i * 4 + 3] = 255;
  }
  return generatedTexture(data, size);
}

function generatedTexture(data, size) {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function textureKey(name) {
  const upper = String(name ?? "").replace(/\\/g, "/").trim().toUpperCase();
  const title = upper.includes("/") ? upper.slice(upper.lastIndexOf("/") + 1) : upper;
  return title.replace(/\.[^.]+$/, "");
}

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
