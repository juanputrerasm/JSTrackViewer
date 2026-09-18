# Reading MTM2 replay files (.rpl)

A replay is the best source of truth about how Monster Truck Madness 2 drives. It is the game's
own record of a race, written by the engine, and it contains values that are otherwise very hard
to obtain: velocity in body axes, the selected gear, throttle and brake positions, steering
angle, and the position of every object the truck disturbed.

It is also, happily, a **plain text file**.

This document describes the format, how to parse it, and the traps that cost time when it was
first worked out.

## Where a replay comes from

In the Community Patch build, finish a race and choose **Save Replay** on the results screen. The
file lands in `Replays\<name>.rpl` beside the game.

The format is the engine's own demo record. The executable still carries the source path
`core\Demo.cpp` and the strings `demoRecordPtr`, `demoRecordCount`, `Load which demo :` and
`Save demo (CR to abort) :`, and the record layout below matches the one that code writes.

## Quick facts

| | |
|---|---|
| Encoding | ASCII text, CRLF line endings |
| Structure | label line, then a value line, repeating |
| Sample rate | **4 Hz** (one frame every 0.25 s) |
| Time unit | 1/65536 second |
| Distance | feet |
| Speed | feet per second |
| Angles | radians |
| Size | about 860 KB for an 80 second lap with one truck |

A replay is **not** a high rate capture. Four samples a second is enough for gear changes, shift
speeds, steady state cornering and inputs, and too coarse for suspension response or impact
detail.

## File layout

```
demoLevel
tpark.sit                     the track this was recorded on
weather
0
vehicleCount
1
DIGGER.TRK                    one line per vehicle, naming its truck
DriverX                       one line per vehicle, naming its driver
detailLevel
2
demoRecordPtr
3940
demoRecordCount
3940                          how many records follow
Original object locations
398                           how many objects the track has
1677.515625,178.841797,4028.761719,0.000000,0.000000,7.881210
...                           one line per object: x, y, z, theta, phi, psi
type,time                     the records begin here
...
```

The header of the sample file is 414 lines: fourteen lines of metadata, the object locations
header and count, then 398 object lines. There is no footer; the file simply ends after the last
record.

**`Original object locations` is worth keeping.** It is where every object on the track started,
in the same order as the boxes in the track's own .SIT, which is what the `number` field in a
record refers to.

## Records

Every record starts with `type,time`:

```
type,time
0,16792
```

- **`type`** is 0 for a vehicle and 1 for an object.
- **`time`** is in 1/65536 of a second. Successive frames are 16,384 apart, which is 0.25 s.

### Type 0: a vehicle (20 lines, 9 fields)

```
ipos                          position, feet, y is up
bvel                          velocity in BODY axes, feet per second
theta,phi,psi                 orientation, radians (pitch, roll, yaw)
p,q,r                         angular rates in body axes, radians per second
number                        which vehicle this is, 0 for the player
fsteering_angle,rsteering_angle          radians, front and rear
frtire_theta,fltire_theta,rrtire_theta,rltire_theta    wheel rotation, radians
eng_throttle,faxle_brake_pct,raxle_brake_pct,ap_cnumber   0 to 1, 0 to 1, 0 to 1, integer
damageCode,gear               integer, integer
```

### Type 1: an object (12 lines, 5 fields)

```
ipos
bvel
theta,phi,psi
p,q,r
number                        the object's index in the track's box list
```

The fields after `number` are written only for vehicles, which is why the two records differ in
length. A parser must not assume a fixed record size.

**Which objects appear.** Every moving object appears in every frame: on Farm Road 29 those are
the ten trains, box indices 179, 180, 210 and 242 to 248, each carrying `bvel` (0, 0, -70).
Other objects appear only in the frames where they were moving, which in practice means **the
scenery the truck knocked about**. In the sample lap, 56 other boxes show up for a few frames
each. That makes a replay a record of object collision response as well as of the truck.

## Conventions and traps

**Gears count from Park.** The gear field reads 4, 5 and 6 for the three forward gears, because
Park, Reverse and Neutral come first. A value of 1 appears while staging at the start line.

**`bvel` is in body axes**, so it gives sideways speed for free. In the sample lap the forward
component is `bvel[2]` and the lateral component is `bvel[0]`. The slip angle is
`atan2(lateral, |forward|)`, which is the measurement a cornering model needs and which nothing
else in the game exposes.

**Position is the game's own, and its z is NOT mirrored.** JSTrackViewer's world frame flips z
(`frame z = 8192 - game z`) so that the scene renders the way the editor draws it. Comparing a
replay's `ipos.z` against a viewer coordinate without that flip will place events in the wrong
part of the map. This cost an hour and produced a confident, wrong statement that a lap never
crossed a bridge it crossed twice.

**Time is not milliseconds.** Reading 16,384 as milliseconds turns an 80 second lap into 87
minutes, and that error is not obvious until something else contradicts it.

**Driver settings are not in the file.** The game offers tire cut (shallow, medium, deep),
suspension (soft, medium, hard) and a transfer gear from 2000 down to 600, and all three change
how the truck behaves. None of them are recorded. **Write them down when you save a replay**, or
its numbers cannot be interpreted later: the gearing alone moves top speed from 80 to 100 mph
across that range.

## A parser

```python
"""Parse an MTM2 replay into a list of records."""

def parse_replay(path):
    lines = open(path, errors="replace").read().replace("\r\n", "\n").split("\n")
    start = next(i for i, line in enumerate(lines) if line.strip() == "type,time")

    records, i = [], start
    while i < len(lines) - 1:
        if lines[i].strip() != "type,time":
            i += 1
            continue
        kind, time = (int(v) for v in lines[i + 1].split(","))
        record = {"type": kind, "time": time}
        i += 2
        # Fields run until the next record starts, so the length is never assumed.
        while i < len(lines) - 1 and lines[i].strip() != "type,time":
            label, value = lines[i].strip(), lines[i + 1].strip()
            parts = [p for p in value.split(",") if p]
            try:
                record[label] = [float(p) for p in parts]
            except ValueError:
                record[label] = parts
            i += 2
        records.append(record)
    return records
```

Then, for the player's truck:

```python
import math

TICKS = 65536.0
FT_TO_MPH = 0.681818

records = parse_replay("tpark.rpl")
truck = [r for r in records if r["type"] == 0]
start = truck[0]["time"]

for r in truck:
    r["t"] = (r["time"] - start) / TICKS
    r["mph"] = math.hypot(*r["bvel"]) * FT_TO_MPH
    r["gear"] = int(r["damageCode,gear"][1])
    throttle, front_brake, rear_brake, _ = r["eng_throttle,faxle_brake_pct,raxle_brake_pct,ap_cnumber"]
    r["throttle"], r["brake"] = throttle, front_brake
    r["steer"] = r["fsteering_angle,rsteering_angle"][0]
```

## What a replay can measure

These all worked on a single lap and a few straight line runs.

| Question | How |
|---|---|
| Shift points | the speed at each frame where `gear` increases |
| Gear ratios | the ratio of the speeds at successive upshifts |
| Steering lock | the largest `fsteering_angle` seen |
| Acceleration | speed against time from a standing start |
| Cornering | `bvel` lateral against forward, with yaw rate `r` |
| Collisions | a large single frame drop in speed, often with `damageCode` changing |
| Object response | type 1 records for the boxes the truck hit |

Measured this way from one lap at medium tire cut, soft suspension and transfer 1400: steering
lock 0.450 rad exactly, upshifts at 44 and 69 mph, gear ratios 2.02 : 1.29 : 1.00, a steady
0.80 g launch, and 0 to 60 mph in 3.88 s.

### Pitfalls when analysing

**Four hertz is coarse.** Any event shorter than 0.25 s is invisible, and a timing read off
consecutive frames carries a quarter second of uncertainty. Take long baselines.

**Yaw rate times speed is not lateral acceleration once the truck is sideways.** In the sample
lap that product peaks at 3.6 g, which no tire produces: those frames are spins. The median of
0.97 g over frames with real steering and speed is the honest figure.

**A lap is not a top speed run.** The sample lap peaks at 88.9 mph, while the same truck reaches
95 on a straight. Use purpose driven runs for limits.

## How the format was established

1. Strings in the executable named the fields and the source file (`core\Demo.cpp`).
2. Disassembling the routine that writes them gave the field order and which fields belong to
   which record type.
3. A sample replay confirmed both, and the object locations block matched the track's own .SIT
   box list, which identified the `number` field.

The corresponding notes on the game's physics, including what has been measured from replays and
what is still guessed, are in `MTM2_PHYSICS_NOTES.md`.
