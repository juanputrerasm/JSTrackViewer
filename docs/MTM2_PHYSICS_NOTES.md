# MTM2 physics notes

Facts about Monster Truck Madness 2's simulation, gathered without its source, for Test Drive
mode in JSTrackViewer. Only facts and numbers are recorded here (addresses, field layouts,
constants, observed behaviour). The simulation in `src/drive/` is written from these, and no
game code is copied into it.

Every claim carries its evidence. Anything not yet confirmed is marked **hypothesis**.

## 0. Which build these addresses belong to

Two builds matter, and **their absolute addresses are not interchangeable**:

| Build | Version | Machine | Image base | ASLR | Notes |
|---|---|---|---|---|---|
| Retail | 2.0.41 | i386, PE32 | 0x400000 | off | `MONSTER.EX_` in MTM2.zip, an ordinary PE despite the name |
| Community Patch 3 | 2.0.52.0 | x86-64, PE32+ | 0x140000000 | off | `monster.exe`, built 1 September 2026, what people play today |

Sections 1 to 5 were derived from the retail build. Section 9 carries the CP3 equivalents.

**The truck object survived the 64-bit port unchanged.** Every field in section 2 sits at the
same offset in both, `damageCode` excepted. Only the globals, which are absolute, differ. Both
builds have ASLR off, so their addresses are usable as written; the logger reads the module base
anyway and shifts everything by the difference.

## 1. The executable

- **File:** `MTM2/MONSTER.EX_` from `MTM2.zip`, 2,920,448 bytes.
- **Not compressed.** The `_` suffix suggested an SZDD archive; the file starts `MZ` and is a
  plain PE32 (i386). It can be analysed as is.
- **Build timestamp:** 891472023, which is 1 April 1998.
- **Image base:** 0x400000, with no ASLR (a 1998 linker sets no dynamic base flag). Every
  address below is valid in the running game as written.

| Section | Virtual address | Virtual size | File offset |
|---|---|---|---|
| .text | 0x401000 | 0x20463c | 0x400 |
| .rdata | 0x606000 | 0x36ec5 | 0x204c00 |
| .data | 0x63d000 | 0x6a18b0 | 0x23bc00 |
| .idata | 0xcdf000 | 0x43d3 | 0x25bc00 |
| .rsrc | 0xce4000 | 0x1ed4b | 0x260000 |

For `.rdata`, virtual address = file offset + 0x401400.

### Source modules

Assertion strings name the source files (`D:\METAL\CRUSH2\core\Truck.c`,
`D:\metal\crush2\engine\Ground.c`, ...). Mapping each code address that pushes one of them
gives an approximate layout of the code:

| Module | Code range (first to last assertion) |
|---|---|
| Main.c | 0x44cd93 to 0x450131 |
| Model.c | 0x4504fe to 0x451877 |
| Object.c | 0x4673d0 to 0x467946 |
| *(no assertions)* | 0x467946 to 0x4bb596 |
| Truck.c | 0x4bb596 to 0x4c37db |
| Ground.c | 0x4f6edc to 0x502890 |
| Matrix.c | 0x527ec0 to 0x52a5e9 |
| View.c | 0x52c113 to 0x52cbc5 |
| TruckDmg.c | 0x531872 to 0x532c9b |
| Simobj.c | 0x54e919 to 0x554c09 |
| Demo.c | 0x564b1c to 0x565c1c |

**The physics is almost certainly the unlabelled block between Object.c and Truck.c.** Every
multiply by gravity in the executable falls inside it (section 4), and it contains no assertion
strings at all, which fits hand-tuned numeric code.

### MTM2 hard-codes its physics

None of the 4x4 Evolution parameter labels occur anywhere in the executable: `spring_rate`,
`maxcompr`, `torque`, `gear_ratio`, `final_drive` and `redline` all have zero hits. The TRK
parser only reads geometry labels (`static_bpos`, scrape points, lights, model names). So
**editing a TRK cannot tune the real game's physics**; the values live in code and must be
measured or read out of the unlabelled block.

## 2. The truck object

The routine that writes a vehicle block into a saved .SIT (0x4c0180, Truck.c) formats each
labelled field from the truck object passed in `esi`. The label it prints next to each read
gives the field's name. All floats are 32-bit.

| Field (SIT label) | Offset | Type | Evidence |
|---|---|---|---|
| `ipos` x, y, z (ft) | +0xfe0, +0xfe4, +0xfe8 | float | 0x4c01f1 |
| `bvel` x, y, z (ft/s) | +0xff8, +0xffc, +0x1000 | float | 0x4c0234 |
| `theta, phi, psi` (rad) | +0x101c, +0x1020, +0x1024 | float | 0x4c0277 |
| `p, q, r` (rad/s) | +0x1034, +0x1038, +0x103c | float | 0x4c02ba |
| `faxle.angle` | +0x274 | float | 0x4c0303 |
| `faxle.steering_angle` | +0x298 | float | 0x4c02fd |
| `faxle.rtire.on_gnd` | +0x50 | int | 0x4c033c |
| `faxle.ltire.on_gnd` | +0x164 | int | 0x4c0336 |
| `raxle.angle` | +0x4e4 | float | 0x4c0361 |
| `raxle.steering_angle` | +0x508 | float | 0x4c035b |
| `raxle.rtire.on_gnd` | +0x2c0 | int | 0x4c039a |
| `raxle.ltire.on_gnd` | +0x3d4 | int | 0x4c0394 |
| `xm.gear` | +0x58c | int | 0x4c03bf |
| `ap.autopilot`, `ap.cnumber` | +0x894, +0x898 | int | 0x4c03e2 |
| `ap.speed_control`, `ap.course_control`, `ap.lasterror` | +0x8a8, +0x8ac, +0x8d4 | float | 0x4c040a |
| `!ap.courseToFollow` | +0xfb4 | int | 0x4c0450 |
| `@damageCode` | +0x1764 | int | 0x4c0473 |
| `heliTimer, heliTheta, heliPhi, heliPsi` | +0x1078 to +0x1084 | float | 0x4c0493 |
| `heliPos` | +0x1088 to +0x1090 | float | 0x4c04e4 |
| `truckFile` name | +0x10ac | char[] | 0x4c019d |
| `body` index (when no file) | +0x109c | int | 0x4c01d1 |

Derived layout, consistent across all four wheels:

- **One tire block is 0x114 bytes.** Right and left `on_gnd` on the same axle are 0x114 apart.
- **One axle block is 0x270 bytes.** Front and rear `angle`, `steering_angle` and both
  `on_gnd` fields are each exactly 0x270 apart.

The `truckFile` string at +0x10ac is what the capture logger searches for: a name ending in
`.trk` at that offset, with plausible values at every offset above, locates a live truck
without any manual memory scanning.

Not yet located: engine rpm, throttle and brake state, suspension compression, tire spin.
The demo recorder (section 3) reads throttle, brake and tire angles, so its recording routine
will give their offsets. Until then the logger dumps the whole object every sample so they can
be found by correlation.

## 3. The demo recorder (Demo.c)

MTM2 contains a complete per-frame state recorder, with debug menu entries `7. Load demo` and
`8. Save demo`, the prompt `Save demo (CR to abort) :`, the strings `demoLevel`,
`demoRecordPtr` and `demoRecordCount`, and a `showDemoFlag` key in MONSTER.INI. Its writer (0x5655b0) walks a buffer of fixed-size records:

- **Buffer:** 0xaf38b8, record count in `[0x655964]`, **0x6c bytes per record**.

| Offset | Field | Type |
|---|---|---|
| +0x00, +0x04 | `type`, `time` | int |
| +0x08 | `ipos` x, y, z | float |
| +0x14 | `bvel` x, y, z | float |
| +0x20 | `theta, phi, psi` | float |
| +0x2c | `p, q, r` | float |
| +0x38 | `number` (vehicle) | int |
| +0x3c, +0x40 | `fsteering_angle`, `rsteering_angle` | float |
| +0x44 to +0x50 | `frtire_theta, fltire_theta, rrtire_theta, rltire_theta` | float |
| +0x54, +0x58, +0x5c | `eng_throttle`, `faxle_brake_pct`, `raxle_brake_pct` | float |
| +0x60 | `ap_cnumber` | int |
| +0x64, +0x68 | `damageCode`, `gear` | uint, int |

The fields after `number` are written only for records of type 0.

This matters for Phase 5 in two ways:

1. It is the engine's own statement of what is needed to replay a truck. It is exactly the
   state vector `vehicle-sim.js` already uses, plus throttle and brake as percentages.
2. **Hypothesis:** if the debug menu can be reached, a saved demo is ground truth recorded by
   the game itself, with no timing jitter from an external logger. How to open the menu is not
   yet known.

## 4. Constants

Found as IEEE values in `.rdata` and confirmed used by code:

| Value | Meaning | Where used |
|---|---|---|
| 32.174 (double) | gravity, ft/s² | 10 multiplies at 0x470932, 0x470e79, 0x475348, 0x475557, 0x475790, 0x478296, 0x4783fe, 0x482358, 0x48240a, 0x488974 |
| 0.681818... (double) | ft/s to mph (15/22) | four constants, uses not yet traced |
| 1/60 (float, double) | a sixtieth | 0x50839f, 0x52d9bf, 0x41eea4 |
| 1/30 (double) | autopilot only | 0x482b98 |

**Gravity is 32.174 ft/s²**, the value `vehicle-sim.js` already uses. Units throughout are
feet, seconds and radians, as the SIT labels say.

**Hypothesis: `[0x6f0bc8]` is the frame time step.** The autopilot's course integrator at
0x482b43 divides a clamped error by it and multiplies the result by it again before adding it
to `ap.course_control`. That is the shape of `x += rate * dt`. The logger records it so a
capture shows whether it is fixed or tracks the frame rate.

## 5. Globals

| Address | Name | Type | Evidence |
|---|---|---|---|
| 0x6f51d8 | `racetime` | float | SIT writer 0x552e28 |
| 0x6f4f98 | `raceStartTime` | float | SIT writer 0x552e22 |
| 0x64664c | `dragDebugTimer` | float | SIT writer 0x552e1c |
| 0x6f0bc8 | frame time step (**hypothesis**) | float | 0x482b43 |
| `[0x64f4bc]` | pointer to camera state | pointer | SIT writer 0x552dea |

Camera state, through the pointer at 0x64f4bc (ints, as the SIT writes `%d`):

| Offset | Field |
|---|---|
| +0x00 | `spotd` |
| +0x04 | `spotp` |
| +0x0c | `spoth` |
| +0x14 | `zoom` |
| +0x18 | `viewmode` |

+0x08 and +0x10 are skipped by the writer and still unexplained.

## 6. Moving objects

`Simobj.c` raises `Too many trains` immediately after it parses the box blocks (`ipos`,
`theta,phi,psi`, `length,width,height`, `model`, `mass`, `bvel`, `p,q,r`, `!type,flags`). So
type 10 objects, "moving - use bvel" in Traxx's notes, are **trains** to the engine, and there
is a fixed limit on how many a track can have.

TPARK is the only stock track with any: ten cars in two trains, all mass 0, all with bvel
(0, 0, -70).

What JSTrackViewer infers, not yet confirmed against the game:

- **bvel is read in world axes.** Cars within one train are authored facing both ways, so body
  axes would drive them apart. In world axes both trains move with their locomotives leading.
- **A train wraps at the world edge.** Nothing records whether MTM2 wraps, reverses, or
  respawns its trains. This is on the capture list.

## 7. Object mass is in slugs

Traxx's notes say only that "0.000000 mass means unmoveable" and never give the unit. The stock
tracks give it away. Across every shipped .SIT there are eighteen distinct masses, and every one
of them is a round number of POUNDS after multiplying by g = 32.174:

| Stored | Pounds | What carries it |
|---|---|---|
| 0.093243 | 3 | a traffic cone (CRAZY98) |
| 3.1081 | 100 | a rowing boat |
| 7.7702 | 250 | cones, railway signs |
| 15.5405 | 500 | Chevy shells, portaloos, barbed wire |
| 31.081 | 1,000 | hay bales |
| 62.162 | 2,000 | scrapyard fencing (JUNK) |
| 77.7025 | 2,500 | TPARK's fence sections |
| 124.324 | 4,000 | TPARK's lamp posts |
| 186.486 | 6,000 | a cow (OUTBACK, TPARK) |
| 310.81 | 10,000 | a gate post (ROCKQRY), and the truck itself |
| 559.4579 | 18,000 | AZTEC's stone head |

So the editor takes pounds and stores pounds over g, and **a box's mass needs no conversion at
all to reach a simulation that runs in slugs**. 119 of the 155 models placed in the stock tracks
are always mass 0, so most scenery is fixed and the rest is deliberately movable.

This corrected a real error. An earlier reading took the unit as about a thousand pounds each,
from the Chevy alone, and multiplied every mass by 31: a 4,000 lb lamp post became 124,000 lb
and nothing on any track could be moved.

## 7a. Measured from CP3 captures

Two sessions on a flat empty test track (`tools/capture/test.pod`, ground at 200 ft, no objects,
no water), driving Grave Digger with no CPU trucks. Analysis in the session folders named
`testtrack` and `testtrack2`.

| Quantity | Measured | How |
|---|---|---|
| Physics update rate | about 30 Hz (33 to 50 ms) | position changes in steps, not continuously |
| Top speed | 95 mph | 15.1 s of full throttle, no steering |
| Acceleration | 24 to 95 mph in about 14 s | the same run |
| Launch | 0 to 23.9 mph in 1.5 s | one clean standing start |
| Braking | 96 to 0 mph in 229 ft, 3.4 s, 1.28 g | confirmed twice, 1.29 g in the second session |
| Coasting | deceleration = 0.90 + 0.00050 v^2 ft/s2 | five coast-downs, fitted on distance |

**The 30 Hz update is the single most useful fact.** The game moves the truck in steps of 33 to
50 ms, so any speed taken over a shorter window alternates between roughly 1x and 1.5x the truth.
Several hours went into chasing that artifact before it was understood. Measure over a second, or
fit to distance travelled, never differentiate the position over two samples.

**The live truck is NOT laid out like the saved record.** The offsets in section 2 come from the
.SIT writer, and they describe a record the game keeps in parallel: it holds the authored start
positions and never changes while driving. Three capture sessions were recorded against it before
that was noticed. The live position sits at 0x146c8b448 in CP3 (stable across launches, no ASLR),
54 bytes from the racetime global, and the four wheels are at 0x146da23d8 and every 0x114 after
it. Velocity, gear and rpm have NOT been located; they are outside the 8 KB window dumped so far.

**What it fixed in the simulation**, all in `params/mtm2-feel.js`:

| Parameter | Was | Now | Evidence |
|---|---|---|---|
| `final_drive` | 19.5 | 14.5 | top speed and the 10 to 31 mph time |
| `dragArea` | 30 ft2 | 130 ft2 | the coast-down fit, and the shape of the acceleration curve |
| `maxTorqueFront/Rear` | 9000 / 7000 | 11700 / 9100 | the 1.28 g stop |

The acceleration curve now tracks the capture to 3.7 mph mean error over 15 s, against 5.6 mph
before drag was measured and far worse before the gearing was.

## 7b. Replays are the best source of all

CP3 saves replays from the results screen after a race, as `Replays\<name>.rpl`. **The file is
TEXT**, in the same label-and-value layout as a .SIT, and it is exactly the Demo.c record from
section 3:

```
demoLevel / tpark.sit / vehicleCount / 1 / DIGGER.TRK / demoRecordCount / 3940
Original object locations      (398 of them, x,y,z and three angles)
type,time                      0 = the player truck, 1 = a train
ipos / bvel / theta,phi,psi / p,q,r / number
fsteering_angle,rsteering_angle
frtire_theta,fltire_theta,rrtire_theta,rltire_theta
eng_throttle,faxle_brake_pct,raxle_brake_pct,ap_cnumber
damageCode,gear
```

- `time` is in **1/65536 s**, and frames land 16,384 apart, so a replay samples at **4 Hz**.
- Type 1 records are the moving objects. TPARK's appear with bvel (0, 0, -70), which confirms
  the train reading taken from the .SIT.
- 4 Hz is coarse, but every value is the GAME's own rather than something differentiated out of
  position, so `bvel` gives exact speed and, being in body axes, exact slip angle too.

**THE GAME HAS DRIVER SETTINGS, and they change the physics.** Tire cut (shallow, medium, deep),
suspension (soft, medium, hard) and a transfer gear from 2000 down to 600. Every number below
came from one lap at **medium cut, soft suspension, transfer 1400**, and the gearing in
particular belongs to that transfer setting rather than to the truck.

| Measured from the replay | Value |
|---|---|
| Steering lock | +-0.450 rad, 25.8 degrees, exactly |
| Forward gears | the replay's 4, 5, 6 (Park, Reverse and Neutral come first) |
| Upshifts | 44 mph and 69 mph, both at about 6,000 rpm |
| Gear ratios, from those speeds | 2.02 : 1.29 : 1.00 |
| Launch | a steady 0.80 g to 44 mph, so nothing is spinning off the line |
| 0-30, 0-44, 0-60, 0-75 | 1.50, 2.35, 3.88, 5.60 s |
| Top speed on this lap | 88.9 mph (a lap, not a top speed run) |

What it changed: `maxangle` 0.52 to 0.45, `gear_ratio` 2.48/1.48/1.00 to 2.02/1.29/1.00,
`upshift_rpm` 5800 to 6000, and the torque table scaled by 0.80 (peak 2030 to 1624 lb-ft).

**The torque result is the important one.** The old curve was 25% too strong and the excess went
into wheelspin, which is why an earlier attempt to fix acceleration by ADDING torque made the
truck slower. After scaling, the simulation reproduces the flat-track acceleration curve to
1.6 mph mean error over 15 seconds, against 5.6 mph before any of this fitting.

## 8. Open questions, in order of payoff

1. Offsets of engine rpm, throttle, brake, suspension compression and tire spin. Find them
   from the demo recording routine (callers of 0x655964 around 0x50abba), or by correlating
   the raw dumps from a capture.
2. Whether `[0x6f0bc8]` is fixed, and at what rate the truck integrates.
3. The integration order and contact handling in the unlabelled block. Start from the gravity
   multiply sites; the one that also writes `bvel` (+0xff8..+0x1000) is the body integrator.
4. Where the tire model's constants live: look for float constants loaded next to reads of
   `on_gnd` (+0x50, +0x164, +0x2c0, +0x3d4).
5. How the demo menu is opened, which would give the game's own recordings.
6. How trains behave at the edge of the world.

## 9. Community Patch 3 (2.0.52, x86-64)

Derived the same way, from the label strings the SIT writer prints. Its `.rdata` maps as file
offset + 0x140001200.

**Identical to retail:** every truck field in section 2, and the whole demo record layout in
section 3, including its 0x6c stride. The SIT vehicle writer is at 0x140203300 and the demo
writer at 0x140151630.

**Different:**

| What | CP3 | Retail |
|---|---|---|
| `damageCode` | +0x1ec8 | +0x1764 |
| truck object size | at least 0x1ed0, read 0x2000 | 0x1800 |
| `racetime` | 0x146c8b4f0 | 0x6f51d8 |
| `raceStartTime` | 0x146c8b49c | 0x6f4f98 |
| `dragDebugTimer` | 0x146c8b4ac | 0x64664c |
| camera pointer | 0x140727208 | 0x64f4bc |
| camera `spotd, spotp, spoth, zoom, viewmode` | +0xa0, +0xa4, +0xac, +0xb8, +0xbc | +0x00, +0x04, +0x0c, +0x14, +0x18 |
| demo buffer, count | 0x141393b00, 0x1413939dc | 0xaf38b8, 0x655964 |

CP3 also adds race state to the truck object that retail did not write: a
`segments, laps, staged, bonusLaps, finishedRace, nextcheckpoint` block around +0x8f0 to +0x904
with +0xfa8, `totalracetime, fastestLap, dragTimer` at +0xfa0, +0xfa4 and +0x90c, and per lap and
per checkpoint time arrays from +0xf50 upward.

Gravity is still 32.174, as a float at 0x1405e1c78 and 0x1406f1028 and a double at 0x1405e22f8.
The physics functions have not been located in this build yet; the retail approach (find what
multiplies by gravity) works but its constants are pooled differently.

## 10. Capturing telemetry

Tools are in `tools/capture/`:

- `mtm2_telemetry.py`: Python 3.8+, standard library only, Windows.
- `maneuvers.ahk`: AutoHotkey v2.

### Setup

1. Install MTM2 on the Windows PC or VM, and make sure it runs.
2. Install Python 3 (python.org) and AutoHotkey v2.
3. Copy `tools/capture/` to the Windows machine.

### A capture session

1. Start MTM2 and load **Tumbleweed Flats** (BAJA). Get to the starting grid.

   Measured across the stock circuits and rallies, from the real grid slots: its eight starting
   positions are level to 0.0 ft, it has 1,075 ft of clear straight ground in the direction the
   grid faces, the nearest obstacle is 137 ft away, and the whole track carries only 100 solid
   objects. Nothing else comes close on all four.

   Rumbles (the SUMMIT tracks) and drag strips are multiplayer shapes and are no use here.
2. In a console, run (64-bit Python, which is needed to read the CP3 build):

   ```
   python mtm2_telemetry.py --list
   ```

   It prints which build it detected before anything else. If that is wrong, pass
   `--build cp3` or `--build retail`.

   It should report every truck it found, by TRK name and address. If it finds none, run the
   console as Administrator. If it still finds none, locate a truck's `ipos` with Cheat Engine
   and pass the object's address (the `ipos.x` address minus 0xfe0) as `--base 0x...`.
3. Start recording:

   ```
   python mtm2_telemetry.py --rate 120 --out captures
   ```

4. Double-click `maneuvers.ahk` to start it, then click back into the game. A green H in the
   system tray means it is running; without it, the maneuver keys do nothing.
5. Start the race and drive the maneuvers. The countdown drop is itself useful: the trucks fall
   from their authored SIT height, which is a free suspension drop test.
6. Stop with Ctrl+C. Zip the session folder and bring it back.

### The maneuver suite

Run keypad 1, 2, 3 and 9 from a standstill on the **Tumbleweed Flats** grid, which faces its own
straight. Run the cornering set (keypad 4 to 8) on **Crazy '98**, which has the flattest ground
around its grid of any stock track (level within 5 ft for 75 ft in every direction). Save
**Farm Road 29** for the object and train tests; its grid faces something 75 ft away, so it is
the worst of the three for a standing start.

**The maneuvers are on the NUMERIC KEYPAD, with NumLock on**, and keypad 0 aborts. The function
keys cannot be used: F1 opens MTM2's help file, F4 toggles CP3's windowed mode, and F11 and F12
change CD tracks. The game binds nothing on the keypad's digits. On a machine with no keypad,
set `UseNumpad := false` in the script and use Shift with the top row instead.

Start the script by double-clicking `maneuvers.ahk`; a green H in the system tray means it is
running, and its hotkeys only fire while the game window is in front.

| Key | Maneuver | What it measures |
|---|---|---|
| Keypad 1 | full throttle 15 s, coast 3 s | engine torque, gearing, shift points, top speed |
| Keypad 2 | throttle 8 s, coast 20 s | rolling resistance and drag |
| Keypad 3 | throttle 8 s, brake 5 s | brake torque, tire grip, reverse engagement at a stop |
| Keypad 4, 5, 6 | throttle 3, 5 or 8 s, then hold right with throttle 12 s | lateral grip, understeer, rollover speed |
| Keypad 7 | throttle 6 s, then a 0.6 s right step | yaw response and damping |
| Keypad 8 | throttle 5 s, then alternate left and right each second for 8 s | transient handling |
| Keypad 9 | brake 3 s from a stop, then throttle 5 s | reverse speed limit, and the switch back to forward |
| Keypad 0 | abort, releasing every key | the way out of a run that is heading for a wall |

By hand, with the logger running:

- a ramp jump, for launch and landing and air rotation;
- parking across a side slope, for lateral friction at rest;
- driving into a wall and into light objects, for contact response and pushed-object mass;
- on TPARK, waiting at the edge of the map for the train.

### Output files

Each session writes a folder named for its start time:

- `session.json`: the trucks found, their addresses, the sampling rate, and the address table
  used, so a capture can be re-read if an offset is later corrected.
- `telemetry.csv`: one row per truck per sample, holding every named field from sections 2
  and 5, the camera state, and the arrow, shift and horn key states.
- `raw-<n>.bin`: the whole truck object (0x1800 bytes) for every sample, for finding the fields
  not yet located. The format is described at the top of the script.
