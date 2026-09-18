/*
  The driving cameras.

  MTM2 stores its camera in the .SIT as `viewmode,spotd,spotp,spoth,zoom`, alongside a
  separate helicopter cam with its own heading, pitch and position. That naming is the shape
  this follows: a chase camera is a boom of length `spotd` at pitch `spotp` and heading
  `spoth` relative to the truck, seen through `zoom`. MONSTER.INI adds boomZoom and the
  stickyView flags, and the README says V cycles the views while Ctrl+1 returns to the
  cockpit.

  WHAT IS AND IS NOT KNOWN. The field names and the stock values are real (a stock SIT holds
  `0,16384,-16383,33648,4096`), but their units are not: 16384 could be a distance in 1/256 ft
  or a binary angle, and 4096 could be a 4.12 fixed point 1.0. Nothing here pretends to have
  decoded them. These are hand-set distances and angles in feet and radians that look right,
  and the plan's camera work is to measure the real ones by matching screenshots.

  The follow behaviour is a critically damped spring on position, and a separate one on
  heading. Only the heading is followed: a chase camera that copied the truck's roll and pitch
  would tumble with it on every landing, which no game does.
*/
import * as THREE from "three";
import { UNITS_PER_FOOT_H } from "./world-frame.js";

const FT = UNITS_PER_FOOT_H;

/*
  The views, in the order V cycles them.

  Distances are in feet from the truck's origin; pitch is how far the camera sits above the
  truck, as an angle; fov is the vertical field of view in degrees.
*/
export const VIEWS = [
  { id: "chase-near", label: "Chase (near)", distance: 26, height: 11, pitch: 0.22, fov: 60, follow: 6.0, lag: 4.5 },
  { id: "chase-far", label: "Chase (far)", distance: 46, height: 18, pitch: 0.26, fov: 55, follow: 4.0, lag: 3.0 },
  { id: "cockpit", label: "Cockpit", fov: 70 },
  /*
    Free orbit carries follow and lag like the others even though it places its camera
    directly, because the aim point is still smoothed and the smoothing reads these.

    Leaving them off is what broke every camera in the app. `approach(v.follow * 1.5, dt)` with
    an undefined follow is NaN, `lookAt.lerp(target, NaN)` makes the shared aim point NaN, and
    since that point survives view changes, cycling once through this view left every other
    view aiming at nothing. Cockpit alone escaped, because it never uses the aim point.
  */
  { id: "orbit", label: "Free orbit", distance: 40, height: 16, fov: 55, follow: 8.0, lag: 8.0 },
];

export function createDriveCameras(camera) {
  let index = 0;
  let orbitHeading = 0;
  let orbitPitch = 0.3;
  let orbitDistance = VIEWS[3].distance;

  // Smoothed state, so a view keeps its place between frames.
  const position = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  let heading = 0;
  let started = false;

  const scratch = new THREE.Vector3();

  function view() { return VIEWS[index]; }

  /*
    A first-order lag, framed as "how much of the gap is closed per second".

    Written as 1 - exp(-rate * dt) rather than rate * dt so that the smoothing does not change
    character with the frame rate: at 30 fps and at 144 fps the camera settles at the same
    speed, which a naive lerp does not.
  */
  const approach = (rate, dt) => {
    // Defensive about its own inputs: this feeds a lerp whose result is kept between frames,
    // so a single NaN here is permanent rather than momentary. A missing rate snaps.
    if (!Number.isFinite(rate) || !Number.isFinite(dt)) return 1;
    return 1 - Math.exp(-rate * dt);
  };

  return {
    get view() { return view(); },
    get viewLabel() { return view().label; },

    next() {
      index = (index + 1) % VIEWS.length;
      started = false;
      return view();
    },

    select(id) {
      const found = VIEWS.findIndex((v) => v.id === id);
      if (found >= 0) {
        index = found;
        started = false;
      }
      return view();
    },

    /** Drag in the free orbit view; ignored elsewhere. */
    orbit(dx, dy) {
      if (view().id !== "orbit") return;
      orbitHeading -= dx * 0.005;
      orbitPitch = Math.max(-0.4, Math.min(1.2, orbitPitch + dy * 0.005));
    },

    /** Wheel zoom in the free orbit view, MONSTER.INI's boomZoom in spirit. */
    zoom(delta) {
      if (view().id !== "orbit") return;
      orbitDistance = Math.max(12, Math.min(160, orbitDistance * (1 + delta * 0.001)));
    },

    /**
     * @param {number} dt
     * @param {object} target  { position: THREE.Vector3 in scene units, heading: radians,
     *                           quaternion: THREE.Quaternion, driverHeight: feet }
     * @param {Function} groundAt  (x, z in scene units) -> scene y, to keep the camera clear
     */
    update(dt, target, groundAt) {
      const v = view();
      camera.fov = v.fov;

      /*
        Refuse to follow a truck that has stopped making sense.

        A camera is a filter over the target's position, and a filter has memory: feed it one
        NaN and every later frame is NaN too, so the view is lost for good rather than for a
        moment. The same goes for a truck that teleports, whether because it was reset or
        because the physics threw it somewhere absurd, where the smoothing would spend seconds
        sweeping across the map with the camera pointed at nothing in particular.

        So: ignore a non-finite target outright, keeping the last good view, and snap rather
        than smooth when the target has moved further than any real frame could carry it.
      */
      const p = target?.position;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
      // 400 scene units is 200 ft, well past what 100 mph covers in a frame.
      if (started && position.distanceTo(p) > 400 * 4) started = false;

      if (v.id === "cockpit") {
        /*
          Roughly where a driver sits: above and a little ahead of the body origin. MTM2 has no
          driverHead field (4x4 Evolution does, as driverHead.initBPos), so this is an estimate
          until a measured one replaces it.
        */
        const eye = new THREE.Vector3(0, (target.driverHeight ?? 3.2) * FT, -1.2 * FT)
          .applyQuaternion(target.quaternion)
          .add(target.position);
        camera.position.copy(eye);
        // The cockpit DOES take the truck's full attitude: that is the whole point of it.
        scratch.set(0, 0, -40 * FT).applyQuaternion(target.quaternion).add(eye);
        camera.lookAt(scratch);
        camera.updateProjectionMatrix();
        return;
      }

      const orbiting = v.id === "orbit";
      const wantHeading = orbiting ? orbitHeading : target.heading;
      const distance = (orbiting ? orbitDistance : v.distance) * FT;
      const height = (orbiting ? Math.sin(orbitPitch) * orbitDistance + 6 : v.height) * FT;

      /*
        Whether this frame places the camera outright instead of easing it.

        Captured BEFORE the heading is updated, because that block sets `started` and every
        test below would otherwise read the value this frame just wrote. That made snap() do
        nothing at all: after a view change or a respawn the camera eased across from wherever
        it had been, and switching views a few times while driving left it sweeping after a
        truck it never caught, aimed at the horizon.
      */
      const snapping = !started;

      if (!started) {
        heading = wantHeading;
        started = true;
      } else if (!orbiting) {
        // Shortest way round, or the camera unwinds the long way through a spin.
        const delta = Math.atan2(Math.sin(wantHeading - heading), Math.cos(wantHeading - heading));
        heading += delta * approach(v.lag, dt);
      } else {
        heading = wantHeading;
      }

      // Behind the truck along its heading: forward is (sin h, 0, -cos h), so behind negates.
      const wanted = new THREE.Vector3(
        target.position.x - Math.sin(heading) * distance,
        target.position.y + height,
        target.position.z + Math.cos(heading) * distance
      );

      /*
        Keep the camera above the ground it is flying over. Without this a chase camera
        buries itself in the hill behind the truck on every climb, which these tracks are
        made of.
      */
      if (groundAt) {
        const clearance = 4 * FT;
        const ground = groundAt(wanted.x, wanted.z);
        if (Number.isFinite(ground) && wanted.y < ground + clearance) wanted.y = ground + clearance;
      }

      if (snapping || orbiting) {
        position.copy(wanted);
      } else {
        position.lerp(wanted, approach(v.follow, dt));
      }

      camera.position.copy(position);
      // The aim point snaps with the camera. Easing the position while the aim stays behind is
      // what pointed the view at empty sky rather than at the truck.
      if (snapping) lookAt.copy(target.position);
      else lookAt.lerp(target.position, approach((v.follow ?? 6) * 1.5, dt));
      // Last line of defence: an aim point that has gone bad is rebuilt rather than carried,
      // since it outlives the view that broke it.
      if (!Number.isFinite(lookAt.x) || !Number.isFinite(lookAt.y) || !Number.isFinite(lookAt.z)) {
        lookAt.copy(target.position);
      }
      camera.lookAt(lookAt.x, lookAt.y + 3 * FT, lookAt.z);
      camera.updateProjectionMatrix();
    },

    /** Drop the smoothing, so the next frame places the camera outright. */
    snap() { started = false; },
  };
}
