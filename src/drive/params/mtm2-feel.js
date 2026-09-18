/*
  The feel-alike parameter set.

  EVERY NUMBER IN THIS FILE IS A SEED, NOT A MEASUREMENT. MTM2 keeps its handling in the
  executable: a .TRK carries no mass, no spring rate, no gearing, not even a tire radius, so
  there is nothing in the game's data to read these off. What the data DOES give is the shape
  of the model, and that is what this file follows.

  Where the shape comes from:

    - The SIT save-state block names the engine's own state vector: ipos, bvel, theta/phi/psi,
      p/q/r, faxle/raxle steering_angle, per-tire on_gnd, xm.gear. That is a 6-DOF rigid body
      in body axes with per-axle steering and a gearbox, which is what vehicle-sim.js
      implements.
    - 4x4 Evolution, by the same studio and using the same faxle./raxle./xm./eng. naming,
      exposes in its own manifests the parameters MTM2 hides: spring_rate, maxcompr, maxangle,
      torque_pct, axleBias, slipDiffType, tire CF, eng.torqueTable, xm.gear_ratio, final_drive.
      The field names below are deliberately Evo's, so a measured value can be dropped in
      without renaming anything.

  Units are feet, seconds, slugs and pounds-force throughout, which is the consistent set:
  1 lbf = 1 slug ft/s^2, so F = ma needs no conversion factor anywhere.

  Each entry says how Phase 4 is expected to pin it down. Until then this is tuned by eye and
  should be described as such to anyone who asks how close to MTM2 it is.
*/

/** Standard gravity, ft/s^2. */
export const GRAVITY = 32.174;

/*
  A monster truck's real-world numbers, used as the starting point.

  Racing monster trucks run to a 10,000 lb minimum weight on 66 inch tires; MTM2's stock
  trucks model 72 inch tires (measured: BIGFOOT's tire is exactly 6.00 ft across), a roughly
  18.4 x 8.4 ft body and about 1,500 hp. Starting from the real vehicle rather than from
  nothing means the first drive is in the right order of magnitude everywhere.
*/
/*
  The truck's mass in SLUGS, which is also the unit a .SIT box's `mass` is written in.

  MEASURED, not assumed. Traxx's notes say only that "0.000000 mass means unmoveable", and the
  unit is never stated, but every mass in every stock track is one of eighteen values and each
  one is a round number of POUNDS once multiplied by g:

    0.093243 -> 3 lb (a traffic cone)      31.081  -> 1,000 lb (a hay bale)
    3.1081   -> 100 lb                     77.7025 -> 2,500 lb (TPARK's fence sections)
    7.7702   -> 250 lb                     124.324 -> 4,000 lb (TPARK's lamp posts)
    15.5405  -> 500 lb (a Chevy shell)     310.81  -> 10,000 lb
    23.3107  -> 750 lb                     559.4579-> 18,000 lb (AZTEC's stone head)

  So the editor takes pounds and stores pounds over g, and a box's mass needs NO conversion to
  reach the simulation: it is already slugs.

  An earlier version read the unit as about a thousand pounds each, from the Chevy alone, and
  multiplied every mass by 31. That made a 4,000 lb lamp post weigh 124,000 lb and nothing on a
  track would move, which is exactly how it drove.
*/
export const TRUCK_MASS_SLUGS = 10000 / GRAVITY;

export const MTM2_FEEL = {
  provenance: "gearing and brakes measured from a CP3 capture; the rest still tuned by eye",

  chassis: {
    // 10,000 lb / g. Measured replacement: from the jump arc and the braking distance, which
    // pin mass only in combination with tire grip, so they are fitted together.
    mass: 10000 / GRAVITY,

    /*
      Rotational inertia about the body axes, as a uniform box of the truck's own dimensions:
      I = m (a^2 + b^2) / 12. A real truck is not uniform, but the box is within the range the
      step-steer and roll tests will correct, and it scales automatically with a truck whose
      body measures differently.

      Replaced by: yaw from step-steer response, roll from the rollover threshold in a
      constant-radius turn, pitch from the landing bounce after a jump.
    */
    inertiaFromBodyBox: true,
    // Used only when a truck's body bounds cannot be measured.
    inertiaFallback: { roll: 4400, pitch: 11400, yaw: 10600 },

    /*
      Centre of gravity, in TRK axes relative to the body origin (x right, y up, z forward).

      Height matters more than anything else here: it sets the rollover threshold and how much
      weight transfers under power and braking, which is most of what a monster truck's
      handling IS. At rest the body origin rides about 6.8 ft up, so -3.0 puts the CG a little
      under 4 ft off the ground.

      Replaced by: the lateral acceleration at which the inside wheels lift.
    */
    cg: { x: 0, y: -3.0, z: 0.2 },

    /*
      Aerodynamic drag, as an equivalent CdA in ft^2 against 0.5 rho v^2.

      MEASURED, and the seeded 30 was four times too little. Five clean coast-downs in a CP3
      capture (session-20260917-233915-testtrack2), fitted by matching DISTANCE travelled rather
      than by differentiating position, give

        deceleration = 0.90 + 0.00050 * v^2   ft/s2, v in ft/s

      which reproduces a 59 s coast over 2,360 ft to within 25 ft. Converting the v^2 term
      through 0.5 * rho * A / m at 310.8 slugs gives A = 131 ft^2, and sweeping the simulation
      against both the coast AND the captured acceleration curve independently picks 130.

      It matters more than it looks: with only 30 ft^2 the truck reached its top speed in five
      seconds and then sat on the limiter, while the real one takes about fourteen. Drag is what
      shapes the whole middle of the acceleration run.
    */
    dragArea: 130,
    airDensity: 0.00238, // slugs/ft^3 at sea level

    /*
      How much of an impact against an OBJECT is allowed to turn the truck.

      A rigid body takes all of it, and against terrain that is what happens. Against scenery it
      is plainly not what MTM2 does. In a TPARK replay the truck loses 69 mph in one frame, about
      11 g, and comes out of it with 6 degrees of roll; across that whole lap, with six separate
      impacts, it never passes 29 degrees of roll and never turns over.

      So the game stops the truck hard and hardly rotates it. At 1.0 a wooden fence would put the
      truck on its roof, which is exactly what was reported. A measured replacement would be a
      replay of a deliberate crash into a known object at a known speed, reading the roll rate
      that comes out of it.
    */
    objectSpinShare: 0.3,
  },

  /*
    Suspension, per axle.

    spring_rate is in lbf per foot of compression. The seed comes from the one suspension
    observation available: SUMMIT1 parks its trucks 0.8 ft lower than their own geometry says
    they rest at, and if that gap is static sag then k = (m g / 4) / sag = 2500 / 0.8, about
    3100 lbf/ft per corner. That reading is NOT established (ALASKA and CRAZY98 park their
    trucks 9 and 10 ft up, which is above any settled pose, so those altitudes are authored
    drop heights), but it is the right order and it is where a measurement would start.

    Damping is given as a ratio of critical for that corner, because that is the number with
    physical meaning: the sim converts it with c = ratio * 2 sqrt(k m_corner). Rebound damping
    exceeds bump damping, as on any real long-travel vehicle, which is what stops a truck
    pogoing after a landing.

    Replaced by: a drop test. Bounce frequency gives the rate, decay per cycle gives the ratio.
  */
  suspension: {
    front: {
      spring_rate: 3100,
      dampingBump: 0.30,
      dampingRebound: 0.45,
      maxcompr: 1.6,   // ft of travel up from rest
      maxdroop: 1.2,   // ft below rest before the wheel hangs free
      /*
        Steering lock, radians. MEASURED: a TPARK replay records fsteering_angle reaching
        exactly +-0.450000 rad, which is 25.8 degrees, and never a fraction more.
      */
      maxangle: 0.45,
    },
    rear: {
      spring_rate: 3400,
      dampingBump: 0.32,
      dampingRebound: 0.48,
      maxcompr: 1.6,
      maxdroop: 1.2,
      /*
        MTM2's state carries raxle.steering_angle, so the engine can steer the rear axle. The
        stock trucks do not appear to, so this is off until something says otherwise; leaving
        the field present means turning it on later is a value change, not a code change.
      */
      maxangle: 0,
    },
  },

  /*
    Tires.

    CF is the peak friction coefficient, Evo's name for it. Dirt and grass are softer than the
    hard surfaces a road car model assumes, and a monster truck's paddle tread bites harder
    under power than sideways, hence longitudinal above lateral.

    The slip values are where the curve peaks: force rises roughly linearly to there and
    saturates after, which is a Pacejka curve without the cost of one.

    Replaced by: lateral from the constant-radius turn, longitudinal from the acceleration and
    braking runs.
  */
  tire: {
    /*
      Longitudinal grip raised from 1.25 once acceleration turned out to be grip limited.

      With the stronger engine the truck sat at 5,200 rpm in first gear doing 14 mph: the
      tires were spinning rather than driving, and 0 to 60 got SLOWER as torque went up. A
      paddle-tread tire six feet across, on dirt, under ten thousand pounds, bites much harder
      than the road-car figure seeded here first.

      Lateral stays lower than longitudinal on purpose: these tires drive better than they
      corner, which is most of why a monster truck understeers.
    */
    CF_long: 1.90,
    CF_lat: 1.10,
    peakSlipRatio: 0.15,
    peakSlipAngle: 0.17,  // radians, about 10 degrees
    rollingResistance: 0.035,
    // The radius is NOT here: it is measured from the tire model at load (BIGFOOT: 3.00 ft).

    /*
      Weight of one wheel and tire, lb.

      This is a real number with real consequences, not a fudge factor. A 66 to 72 inch
      monster truck tire is around 800 to 900 lb on its own, and the resulting rotational
      inertia is what decides how readily a wheel spins up against the tire's grip. An
      earlier version took a twelfth of the corner mass, giving roughly 9 slugs, and at that
      inertia a single step of tire torque reversed the wheel's rotation outright: the spin
      oscillated every step, the tire force alternated sign, and the truck both crept while
      parked and refused to accelerate past 14 mph.
    */
    wheelWeight: 900,
  },

  /*
    Engine and drivetrain.

    The torque table is rpm -> lb-ft, which is Evo's eng.torqueTable shape. These values are a
    1,500 hp methanol V8 read off its power peak: 1,400 lb-ft at 4,000 rpm is about 1,070 hp,
    rising to roughly 1,500 hp near 5,600.

    Replaced by: the acceleration run. Speed against time in each gear gives torque against
    rpm directly once mass and gearing are known.
  */
  engine: {
    idleRpm: 800,
    redline: 6500,
    /*
      Raised about 45% from the first pass, which felt heavy next to MTM2.

      The truck was engine limited rather than grip limited, which is what makes this the
      right lever: at full throttle it was pulling roughly 6,550 lbf at the wheels, 0.65 g,
      while the tires could have taken 12,500 lbf. Torque therefore turns straight into
      acceleration instead of wheelspin, up to the point where the two meet.

      MEASURED, and the seed was 25% too strong. A TPARK replay records a standing start frame
      by frame at the 1400 transfer setting:

        0-30 mph 1.50 s, 0-44 (the upshift) 2.35 s, 0-60 3.88 s, 0-75 5.60 s

      The truck pulls a steady 0.80 g all the way to 44 mph in first, so nothing in the real
      game is spinning its wheels off the line. Scaling this whole curve by 0.80 reproduces
      those four times to within half a second in total (1.48, 2.52, 3.72, 5.77) and leaves the
      top speed alone at 93.5 mph.

      The SHAPE is still a seed: only the overall level has been measured, because a single
      run at full throttle cannot separate torque at 2,000 rpm from torque at 5,000.
    */
    torqueTable: [
      [800, 1040], [1500, 1320], [2500, 1520], [3200, 1600],
      [4000, 1624], [4800, 1568], [5600, 1448], [6500, 1160],
    ],
    // Internal friction, lb-ft per rpm, which is what brings the revs down off throttle.
    friction_cf: 0.045,
    inertia: 1.8, // slug ft^2, flywheel and rotating assembly
  },

  transmission: {
    // Park/Reverse/Neutral are Evo's leading entries; here reverse is its own field.
    /*
      MEASURED from a TPARK replay, which records the gear every frame.

      MTM2 numbers its gears Park, Reverse, Neutral first, so the replay's 4, 5 and 6 are the
      three forward gears. It upshifts at 44 mph and at 69 mph and tops out at 88.9, and the
      ratio of those speeds is the ratio of the gears: 88.9/44 = 2.02 and 88.9/69 = 1.29.

      The old 2.48 first gear was too short by a quarter, which is why the truck used to run out
      of first so early. Note the replay was recorded with the transfer gear at 1400 of the
      600 to 2000 the game offers, so this whole set is specific to that setting.
    */
    gear_ratio: [2.02, 1.29, 1.00],
    /*
      Reverse is short and limited, which the first version was not.

      At 2.20 it sat alongside first gear's 2.48 and inherited the whole torque table, so
      holding the brake to a stop backed the truck up to 33 mph and kept pulling. No vehicle
      reverses like that, and in a game where the brake selects reverse for you it is actively
      unpleasant: stopping hard turns into driving away backwards.

      A tall ratio plus a speed ceiling gives what reverse is for, which is getting off an
      obstacle and turning around.
    */
    reverse_ratio: 3.60,
    /** Reverse stops pulling here, in ft/s. About 11 mph, a brisk walk to a slow jog. */
    reverse_max_speed: 16,

    /*
      About 19.5:1, not a car's 4:1, because the wheels are six feet across.

      Sized from the tire rather than copied from a road vehicle. A 3.0 ft rolling radius
      covers 18.85 ft per wheel revolution, so 70 mph (103 ft/s) needs only 328 wheel rpm, and
      at a 6,500 rpm redline in top gear that is 6500 / 328 = 19.8:1 overall. Real monster
      trucks get there the same way, through planetary reduction hubs on top of the axle
      ratio.

      The car-like 4.86 that was here first gave 12.05:1 in first gear, which put the truck at
      95 mph in FIRST and 144 mph and still pulling in second. That is the kind of error a
      test suite does not catch, because nothing about it is unstable: it simply drives like
      the wrong vehicle.

      MEASURED, and the seed above was 34% too short. A CP3 capture on a flat empty track
      (session-20260917-230752-testtrack) holds 15.1 s of full throttle with no steering:

        t      0.0   0.9   1.9   2.8   3.7   5.1   6.5   7.9   9.3  10.7  14.9
        mph   24.2  35.6  49.3  61.0  68.6  78.7  85.9  90.0  92.4  93.7  95.0

      so the real truck tops out near 95 mph, and a separate run covers 10 to 31 mph in 1.4 s.
      Sweeping this ratio against both targets at once lands on 14.5: it gives 95.5 mph and
      1.45 s, while every attempt to fix acceleration with more torque made it SLOWER, because
      the tires were already at the limit of their grip.
    */
    final_drive: 14.5,
    pct_loss: 0.12,
    // Both measured upshifts (44 mph in first, 69 in second) work out at about 6,000 rpm with
    // the measured ratios and final drive, so that is where the game changes up.
    upshift_rpm: 6000,
    dnshift_rpm: 2600,
    shiftTime: 0.25, // seconds with no drive
    /*
      Torque split front to rear. MTM2's trucks are four wheel drive; an even split is the
      neutral starting point and matches Evo's torque_pct being authored per axle.
    */
    torque_pct: { front: 0.5, rear: 0.5 },
    // Locked means both wheels on an axle turn together. Evo's slipDiffType selects this.
    slipDiffType: "locked",
  },

  brakes: {
    /*
      lb-ft of torque at each wheel at full pedal, split forward as any vehicle's is.

      MEASURED. The same capture brakes from 96 mph to a stop in 229 ft and 3.4 s, which is
      1.28 g. The seeded 9,000 and 7,000 gave 1.02 g and took 302 ft, so both are 30% higher
      now, which reproduces 241 ft in 3.39 s at 1.28 g.

      There is a ceiling worth knowing about: past about twice these values the stop stops
      improving at 1.76 g, because the tires run out of grip rather than the brakes running out
      of torque, and raising CF_long does not move it.
    */
    maxTorqueFront: 11700,
    maxTorqueRear: 9100,
  },

  steering: {
    /*
      How fast the wheel moves to full lock, and how much lock is available at speed.

      MONSTER.INI carries steeringResponse=10 in its [Control] section, so the game has a
      notion of steering rate; what the number means is not known yet, which is why this is a
      rate in seconds rather than a copy of it.
    */
    lockTime: 0.35,
    returnTime: 0.25,
    // Lock is reduced with speed, or a truck at 60 mph spins on the first input.
    speedReductionStart: 20,   // ft/s
    speedReductionFull: 90,    // ft/s
    minLockFraction: 0.35,
  },

  /*
    Arcade assists, all off until something measured says the game has them.

    MTM2 is an arcade game and probably does help the player in the air and on landing, but
    "probably" is not a reason to build the help in and then tune the physics around it. They
    are listed so the sim has one place to turn them on from.
  */
  assists: {
    airPitchControl: 0,
    airRollControl: 0,
    landingStabilization: 0,
    autoUnflip: false,
  },
};

export default MTM2_FEEL;
