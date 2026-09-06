# Terminal Velocity / Fury3 Level Support: Format Findings and Viewer Improvements

Source material:

1. The *F!Zone for Fury³* instruction manual (WizardWorks, 4/96, P/N 3250), OCR text at
   [docs/fzone for fury3 manual.txt](fzone%20for%20fury3%20manual.txt). F!Zone is the shipping
   level editor for the Fury3 engine, so the "Using Fury3 Editor to Create New Levels" chapter
   is the authoring specification for the data JSTrackViewer reads.
2. Direct measurement of the shipped archives: `FURY3.POD` (3202 entries, comment
   "Fury3 Rel 26"), `FURYSE.POD` (1330 entries, "Furyse with AVI") and `TV.pod` (2349 entries,
   "TV 1.2 CD-ROM").
3. The current implementation in [src/worker/lvl-parser.js](../src/worker/lvl-parser.js),
   [src/worker/def-loader.js](../src/worker/def-loader.js),
   [src/worker/terrain-builder.js](../src/worker/terrain-builder.js) and
   [src/worker/track-loader.js](../src/worker/track-loader.js).

Every claim below is measured against those three archives, not inferred from the manual
alone. The manual supplied the vocabulary; the PODs supplied the proof.

## Scope

JSTrackViewer is a 3D map viewer, not the game and not a level editor. This document is
scoped accordingly:

- **In scope**: content that exists on the map and can be shown or marked there. Objects,
  powerups, navigation points, tunnel entrances and exits, terrain, textures.
- **Out of scope**: reproducing engine behaviour (edge wrapping, gameplay logic, in-cockpit
  instrumentation), editor affordances (coordinate entry, altitude painting), and interior
  spaces that cannot be understood from an exterior view (tunnels, chambers). Section 8
  records these and why.

---

## 1. The LVL header is now fully mapped

The header was previously known only in part, with six unexplained lines. Dumping
`LEVELS\ATMOS.LVL` against `LEVELS\ATMOS-T1.LVL` resolves all of them:

```
  0: 4                        surface = 4, tunnel = 1
  1: atmos.txt                mission briefing text
  2: atmos.raw                heightfield, or <name>.tnl on a tunnel level
  3: atmos.clr                texture map
  4: atmos.act                palette
  5: atmos.tex                texture list
  6: atmos.qke                screen shake table
  7: atmos.pup                powerup placements
  8: atmos.ani                animated texture definitions
  9: atmos.tdf                tunnel definitions
 10: sky.raw                  sky texture
 11: fog.act                  fog palette
 12: atmos.def                object placements
 13: atmos.nav                navigation points
 14: fog.mod                  music
 15: atmos.fog                fog table
 16: atmos.lte                lighting table
 17: -46333,-46333,0          sun vector
 18: 32768                    shadow intensity
 19: -46333,-46333,0          sun position
 20: 32768                    sun intensity
 21: 255                      level value
 22: ;New story stuff         trailer marker
 23: enfog.avi                video, then null padding
```

Line 0 was checked across all 214 levels in the three archives and is unanimous: 4 on all 66
surface levels, 1 on all 148 tunnel levels. Nothing else occurs.

| Line | Content | Read today | Value to the viewer |
|---|---|---|---|
| 0 | Level kind, 4 = surface, 1 = tunnel | no | Cheaper tunnel filter than the current line-2 sniff |
| 1 | `.TXT` briefing | no | None, out of scope |
| 2 to 5 | RAW, CLR, ACT, TEX | yes | Already correct |
| 6 | `.QKE` shake table | no | None |
| 7 | **`.PUP` powerups** | **no** | **Section 4, unrendered map content** |
| 8 | **`.ANI` animated textures** | **no** | **Section 6** |
| 9 | **`.TDF` tunnel definitions** | **no** | **Section 3, the tunnel markers** |
| 10, 11 | Sky RAW, fog ACT | 10 only | Minor |
| 12 | `.DEF` objects | yes | Already correct, see section 5 |
| 13 | **`.NAV` navigation points** | **no** | **Section 2, the marker layer** |
| 14 to 21 | Music, fog, LTE, lighting | all but 15 | Minor |
| 22+ | Display name, video trailers | name only | Minor |

Note that a tunnel level nulls out exactly the lines that describe a surface: `null.txt`,
`null.raw`, `null.map`, `null.act`, `null.nav`. Only line 2 changes to a `.TNL`.

---

## 2. Navigation points: format fully decoded

`.NAV` is plain ASCII, CRLF, count-prefixed. 25 files in FURY3, 10 in FURYSE, 34 in TV.

```
<entryCount>
  per entry:
    <type>
    <x>,<y>,<z>
    <description>
    <type-specific payload>
```

Types match the manual's menu order exactly, and all seven occur in shipped content:

| Type | Name | Payload after the description |
|---|---|---|
| 0 | Target List | `<count>` then `<count>` enemy indices |
| 1 | Tunnel Entrance | tunnel `.LVL` filename, then one filler line |
| 2 | Checkpoint | none |
| 3 | Jump Zone | none |
| 4 | Tunnel Exit | two filler lines |
| 5 | Boss | boss enemy index, `.MOD` filename, filler, `!NewH` marker, `<count>` then `<count>` secondary target indices |
| 6 | Start Point | `<pitch>,<bank>,<heading>` |

The filler lines are literal editor placeholders (`;place1`, `;place2`, `;place3`, `;place4`),
not data.

### Validation

A parser built to the table above was run over all 69 `.NAV` files in the three archives:

```
files 69   failed 0
StartPoint 110  TargetList 221  TunnelEntrance 78  TunnelExit 78
Checkpoint 73   JumpZone 53     Boss 25
non-empty trailing content: DOS EOF (0x1A) in 12 files, nothing else
```

Every file consumes to EOF. Entrance and exit counts match at 78 each, which is what the
manual's "Tunnel Exit (Automatic after a tunnel Entrance)" predicts. Cross-reference checks:

- **Enemy indices**: 0 out of range, across every target list, boss and secondary target in
  all three archives. They are positional indices into the `.DEF` placement list.
- **Tunnel filenames**: 0 unresolved. Every name in a type 1 entry exists in the POD.
- **Start points**: exactly one per level, with the sole exception of TV's `MULTI1` through
  `MULTI6`, which have 8 each. Those are the multiplayer maps, so the extra type 6 entries are
  spawn points.

### Coordinates

NAV positions are in the same space as `.DEF` placements, which is directly demonstrable. For
`ATMOS.NAV`, each target list's first enemy index resolves to a placement at the identical
X and Z:

```
type=0 pos=[16257432, 1525760, 11010264] targets=[7]
   enemy[7] x=16257432 z=11010264   dx=0  dz=0
type=0 pos=[24506568, 3932160, 27693768] targets=[2]
   enemy[2] x=24506568 z=27693768   dx=0  dz=0
type=0 pos=[21507040, 2181120, 44530912] targets=[8]
   enemy[8] x=21507040 z=44530912   dx=0  dz=0
```

So the existing conversion in [def-loader.js:53-62](../src/worker/def-loader.js#L53-L62)
applies unchanged: X and Z at 2^20 units per cell, Y at 2^15 per altitude step. Coordinates
are signed and frequently negative (`-69776144`), so the existing `((v % g) + g) % g` wrap is
required, not optional.

Heading on the start point follows the manual: 65536 per full turn, 0 north, 16384 east.
Pitch and bank are present in the data but the manual states they are unused.

---

## 3. Tunnel definitions: `.TDF` is the tunnel marker source

Line 9 of the LVL header points at a `.TDF`, which is the tunnel table the Tunnel Editor
writes. Plain ASCII, count-prefixed, **10 lines per tunnel**:

```
<tunnelCount>
  per tunnel:
    <tunnel .LVL filename>
    <entranceX>,<entranceY>,<entranceZ>
    <exitX>,<exitY>,<exitZ>
    <entrance logic 0..3>
    <entrance ground texture>
    <entrance texture>
    <exit logic 0..3>
    <exit ground texture>
    <exit texture>
    <exits into chamber, 0 or 1>
```

A real example, `DATA\CITY3.TDF`:

```
2
city-t3.lvl
-71827456,3276800,76021760
131576152,7444517,131602224
1                          entrance: remain open
DBROWN.RAW
litskyho.raw
0                          exit: hidden, uses ground texture
DBROWN.RAW
DENTER.RAW
1                          exits into a chamber
city-t4.lvl
...
```

The logic values are the manual's four tunnel logics, in order: 0 use ground texture
(hidden), 1 remain open, 2 remain open but closed for boss, 3 close upon entering or exiting.

### Validation

Across 214 `.TDF` files in the three archives:

```
tunnels parsed 183
logic values   {0: 68, 1: 264, 2: 16, 3: 18}     (only 0..3 occur)
chamber flag   {0: 123, 1: 60}                    (only 0/1 occurs)
files with unexplained trailing content: 6, all of them TV's MULTI1..MULTI6
```

Every value falls in the range the manual predicts. 208 of 214 files parse exactly to EOF;
the six exceptions are the same multiplayer maps that carry 8 start points.

`.TDF` is a better marker source than `.NAV` for tunnels, because the manual notes that a
tunnel omitted from the NAV list is a hidden bonus tunnel. There are 183 tunnels in the TDFs
against 78 tunnel entrance NAV points, so roughly half of all tunnels are reachable only
through the TDF.

---

## 4. Powerups: 548 placements the viewer draws nothing for

Line 7 points at a `.PUP`. Format is count-prefixed, one line per powerup:

```
<count>
  <x>,<y>,<z>,<type>
```

`DATA\AMINE-T1.PUP`:

```
3
2488567,604523,24721947,4
3190578,2028107,37848377,6
3403752,2730027,8390440,4
```

Across the three archives: 206 files, **548 powerup placements**, all four fields present on
every line, type values in 0 to 11. Coordinates are the same space as DEF and NAV.

Most of those sit in tunnel levels. Restricted to the 66 surface levels a map view actually
opens, the count is 40, which is consistent with the manual's account of how authors worked:
loose powerups were the exception, and the usual practice was to hide them inside destructible
bunkers that are ordinary `.DEF` objects with a spawn probability.

These are physical pickups sitting on the map. The viewer currently has no concept of them at
all, so every one is invisible. They are the closest thing in the TV/F3 format to MTM2's
checkpoints, and the existing checkpoint marker machinery is the natural model.

The manual explains why they cluster the way they do: authors mostly hid powerups inside
destructible bunkers rather than placing them in the open, so a level with few loose powerups
is normal, and tunnels carry proportionally more.

---

## 5. Object placement: one real bug, and a pipeline confirmed correct

### 5.1 The existing DEF mapping is exactly right

For every placement in `ATMOS.DEF`, the placement altitude equals the terrain height at the
placement cell, with zero error:

```
  3dplant.bin  placAlt= 90  terrainAlt= 90  delta=0
  conplant.bin placAlt= 50  terrainAlt= 50  delta=0
  conplant.bin placAlt= 80  terrainAlt= 80  delta=0
  fogtnk.bin   placAlt=120  terrainAlt=120  delta=0
```

sampling terrain at `((x >> 20) % 256, (z >> 20) % 256)` and altitude as `y >> 15`. That is
precisely what [def-loader.js:53-62](../src/worker/def-loader.js#L53-L62) already computes, so
the whole TV/F3 placement path is confirmed against shipped data.

### 5.2 The definition Y offset is the only thing that lifts an object

Because placements always sit exactly on the ground, an object that hovers in the game must
be lifted by something else. The manual names it as Enemy Editor field C, "Ground Position
from Centroid (X, Y, Z)", and says outright: "We never change the X or Z coordinates ... But
we may want to change the Y coordinate if we want an object to float off the ground."

Every definition header in all three archives has the same shape: exactly six integers, then
the complex asset, then the simple asset.

```
14,0,1311753,0,0,0,facboss.bin,cube.bin
0,0,229166,0,0,0,hitzo1.bin,cube.bin
0,10,1799762,0,51200,0,conplant.bin,cube.bin
```

Non-zero counts per slot across 1532 definitions:

```
slot 0: 1165    slot 1: 149    slot 2: 1532
slot 3: 0       slot 4: 72     slot 5: 3
```

Slot 3 is never non-zero. Slot 5 is non-zero in exactly three definitions, and all three are
the same line, `9,0,940771,0,51,200,bunker.bin,bunk.bin`, where an intended `51200` was typed
with a stray comma in the original data. So slots 3, 4 and 5 are the (X, Y, Z) offset with
only Y ever used, exactly as the manual describes, and slot 2 is field B, the size.

The models carrying an offset are exactly the ones that should hover:

```
hovercft.bin  400000     octoani.bin  1000000    mother.bin    155000
dushp.bin      51200     redshp2.bin    66000    bionmssl.bin  400000
forcegen.bin 2000000     radar.bin      51200    roofgun.bin    51200
```

and the magnitude tracks object size, which is what the manual instructs ("based on how big
the object is and how many times that size you want it off the ground"): `forcegen` has size
3535039 and offset 2000000, `octoani` has size 2376001 and offset 1000000.

**Consequence**: JSTrackViewer draws every hovering enemy, gun platform and mothership resting
on the terrain. [def-loader.js:127-136](../src/worker/def-loader.js#L127-L136) discards the
six integers when it parses the header. Keeping slot 4 and adding it to the placement height
fixes it. The natural unit reading is the same 2^15 per altitude step the placement Y uses,
since it is the same quantity in the same file, but the exact divisor is worth a visual check
against `hovercft` or `octoani` before committing.

### 5.3 Definition blocks are a 14-line record in TV and Fury3

Useful if the DEF parser is ever tightened up. From `ATMOS.DEF`:

```
 0  <6 ints>,<complex>.bin,<simple>.bin
 1  thrust, rotation, fire speed, fire strength, flag
 2  ...
 3  ...
 4  ;NewHit
 5  <hit / weapon table>
 6  !NewAtakRet
 7  attack distance, retreat distance, ...
 8  <description text>
 9  #New2ndweapon
10  <secondary weapon data>
11  %SFX
12  <boss fire wav or null>
13  <boss yell wav or null>
```

Field meanings follow the manual's Enemy Editor hotkey list. The description on line 8 is real
author-written text ("Boss - This crazy guy drives the factories on this world.").

### 5.4 Hellbender extends the record, and the separators do not say so

Hellbender uses the same header and the same four separators at the same offsets, then appends
four more named sections, making the record 25 lines instead of 14:

```
14  null
15  : Path to follow
16  0
17  = cannonDamage, laserDamage, missileDamage
18  65536 / 32768 / 65536
21  @ Friendly flag
22  0
23  { Escape and destroy sound files
24  null / <wav>
```

So the separators identify a shared *prefix*, not a record length, and treating 14 lines as
the whole record is wrong. It is worth spelling out because it fails destructively rather than
partially: the last definition's skip lands on `: Path to follow`, `parseDefStructure` reads
that as the placement count, fails, and returns no objects at all. Every one of Hellbender's
26 `.DEF` files loses its entire object list, along with 4 Fury3 and 6 TV files whose last
definition happens to sit the same way.

The loader therefore uses the fixed offsets only to locate the description, and lets the body
scan decide where the record ends. Checked against all four archives, that reproduces the
original scan's results exactly: 232 `.DEF` files, zero parse failures, zero differing results,
6294 placements in Fury3, 3926 in F!Zone, 4826 in TV and 7606 in Hellbender.

---

## 6. Animated textures

Line 8 points at an `.ANI`. Count-prefixed, and each animation is a base texture name, a
`<frameCount>,<rate>` line, then the frame names:

```
4
FAN1.RAW
4,16384
FAN1.RAW
FAN2.RAW
FAN3.RAW
FAN4.RAW
FS1.RAW
4,16384
...
```

169 files, 564 animations across the three archives. The rate 16384 is the usual 16.16 fixed
point, so a quarter unit per frame.

**These are mostly model textures, not terrain.** Checking every frame name against its own
level's `.TEX` list: only 111 of 2624 frame and base names are terrain slots, and only 49 of
the 564 animations have a terrain-slot base. The rest animate art carried by `.BIN` models,
which is what the names say (`FAN1.RAW` through `FAN4.RAW`, `FS1..FS4`, `LFAN1..LFAN4`). Of
the 49 terrain animations, most are in tunnel levels, which a map view does not open.

That split decides the implementation. A model texture is shared by every mesh naming it, so
animating one means rewriting a single image's pixels; a terrain slot is a fixed tile in the
atlas, so animating one means blitting into that tile. Both reduce to copying bytes and
raising a dirty flag, and both are worth having, but the model path is the one that carries
the content.

This is polish rather than missing content: the base frame already renders, so a viewer that
ignores `.ANI` shows a valid still.

---

## 7. Verified correct, no action needed

Measuring the archives closed two questions in the viewer's favour, which is worth recording
so nobody re-opens them.

**CLR is a plain 8-bit texture index on TV/F3, with no rotation or mirror bits.** Across all
66 surface levels in the three archives:

```
RAW size: 65536 bytes in 66 of 66 levels     (256 x 256, one byte per cell)
CLR size: 65536 bytes in 66 of 66 levels     (256 x 256, one byte per cell)
texture counts: 2 to 171
levels where max CLR byte != textureCount - 1: 0 of 66
```

The maximum byte in the CLR is always exactly one less than the texture count, so the byte is
a full 8-bit index with no spare bits. The manual's "each of the 65536 textures" is loose
phrasing; the real per-level ceiling is 256, and levels do exceed 64 (171 in one case).

The existing decoder in
[terrain-builder.js:97-113](../src/worker/terrain-builder.js#L97-L113) handles this correctly
by both of its paths. When `textureCount <= 64` the packed 6+2 branch runs, but every byte is
below 64 so the index is unchanged and the rotation comes out 0. When `textureCount > 64` the
fallback branch runs and `Math.min(b, textureCount - 1)` is just `b`. Either way the result is
right, and rotation is always 0 for TV/F3.

That also means the hardcoded `(rot + 3) & 3` at
[terrain-builder.js:116](../src/worker/terrain-builder.js#L116) is a constant three-quarter
turn applied uniformly to TV/F3 terrain, which is the global map rotation the manual describes
under the Texture Placement Editor. Since no shipped level carries per-cell rotation, one
constant is sufficient and there is no need to expose a control.

**The DEF coordinate conversion is confirmed**, as shown in section 5.1.

---

## 8. Deliberately out of scope

Recorded with reasons so the question does not come back.

| Subject | Why not |
|---|---|
| Edge wrapping of the map | Every TRI game wraps at the boundary, but this is a viewer. A single representation of the map is the right presentation. The only residue is that [terrain-builder.js:280](../src/worker/terrain-builder.js#L280) clamps rather than wraps when sampling corner heights, which flattens the last row and column of quads. A one-line change if the seam ever looks wrong, otherwise ignorable |
| Mission briefing text and planet | Game presentation, not map content |
| Editor coordinate and altitude readout | Editor affordance. Possibly worth revisiting if the viewer ever grows editing features |
| Compass and heading readout | In-game instrumentation |
| Tunnel interior geometry | Tunnels are separate levels with their own `.TNL` spine. Marking the entrance and exit on the surface map conveys everything a map view can convey; the interior needs to be flown to be understood |
| Chamber ceilings | Same reasoning. A chamber only reads as a chamber from inside it. The one useful residue is the TDF chamber flag, which lets a tunnel marker be labelled as leading into a chamber |

---

## 9. What was implemented

All of section 9's recommendations are in the tree. New files:

| File | Purpose |
|---|---|
| [src/worker/tv-coords.js](../src/worker/tv-coords.js) | The shared TV-family coordinate conversion and side-file line splitter |
| [src/worker/nav-parser.js](../src/worker/nav-parser.js) | `.NAV` navigation points, all seven types |
| [src/worker/tdf-parser.js](../src/worker/tdf-parser.js) | `.TDF` tunnel definitions |
| [src/worker/pup-parser.js](../src/worker/pup-parser.js) | `.PUP` powerup placements |
| [src/worker/ani-parser.js](../src/worker/ani-parser.js) | `.ANI` animated texture definitions |

### 9.1 Navigation and tunnel marker layers

[lvl-parser.js](../src/worker/lvl-parser.js) now resolves header lines 7, 8, 9 and 13 through
the existing `DATA/`-preferring resolver, after the `.DEF` so the grid size is known. Every
parser is total: a malformed side file costs its own marker layer and nothing else.

**Terminal Velocity and Fury3 only.** Hellbender uses the same header line numbers but not the
same record shapes. Its `.NAV` interleaves named sections the TV form has no place for, so the
description and the start point's pitch/bank/heading sit several lines lower:

```
6
13893632,3997696,32243712
!priority,time
0,0
@Completion sound & completion text (39 chars max)
null
null: line ignored
; Proximity Sound file
null
Start for Snow City Level 1
0,0,0
```

Read with the TV parser that yields one bogus point and stops, which would put a wrong marker
on the map and open the camera facing the wrong way. The Hellbender variant has not been
validated against its archive, so it is left unread rather than half-read. It costs little:
Hellbender ships one powerup placement in the entire game and `HOTH.TDF` declares no tunnels.

[scene.js](../src/scene.js) gains three groups, `navPoints`, `tunnels` and `powerups`, each
with its own View Options toggle. A marker is a small solid sitting on the terrain with a text
label above it, drawn with depth testing off so one inside a hill is still findable.

**Markers are not joined to each other.** A tunnel's two mouths, or two consecutive navigation
points, are routinely on opposite sides of the map, and since the viewer draws a single
unwrapped copy of the world, a line between them would cut across terrain the route never
crosses and imply a path that does not exist. The labels carry the association instead:

| Layer | Label |
|---|---|
| Navigation points | `NAV1 start`, `NAV2 target x3`, `NAV3 checkpoint`, `NAV4 enter ATMOS-T2`, `NAV5 boss`, `NAV6 jump zone`, numbered in `.NAV` order |
| Tunnels | `T1 start` and `T1 exit`, numbered in `.TDF` order, with `(chamber)` appended to an exit whose record sets the chamber flag |
| Powerups | `PUP1 t4`, numbered in `.PUP` order with the record's type index |

Labels are canvas sprites with `sizeAttenuation` off, so a marker on the far side of the world
stays readable instead of shrinking to a pixel. That is affordable only because the counts are
small: a handful of navigation points and tunnels per level, and 40 powerups across every
shipped surface level put together.

The start point additionally gets a heading arrow on the ground.

**Markers sit on the terrain**, sampled from the heightfield at the marker's own cell, rather
than at the altitude stored in the record. Most records are already flush with the ground, but
not all: across FURY3's 233 surface navigation points the stored altitude matches the sampled
terrain at the median, while 28 points sit more than five altitude steps above it and one sits
180 steps below. Those outliers read as position errors when drawn where the file says. The
sample averages the cell's four corners, which is the bilinear height at the cell centre where
markers land.

The powerup type index is reported as a number, not expanded into a name. STARTUP.POD carries
thirteen `POWER*.BIN` pickup models (`POWERSHE`, `POWERMIS`, `POWERLAS` and so on), and the
`.PUP` type values observed run 0 to 11, but nothing in any level file maps an index onto a
model, and the manual describes the powerup list only as an editor enumeration. Naming them
would mean guessing an order the data does not state.

[nav.js](../src/nav.js) opens the camera at the `.NAV` start point with its authored heading
instead of the map centre. Game headings run clockwise from north over 65536 units, which is
already what `TrackCamera.yaw` means, so the conversion is a scale.

A "Navigation Points" panel lists the route in order with each entry's detail: target counts,
the tunnel a tunnel point leads to, a boss's enemy index and shield count, the start heading.
It stays hidden for any track without a `.NAV`, which is every MTM-family track.

The placement-index caveat is handled: each box now carries `placementIndex`, the index into
the raw `.DEF` placement list that `.NAV` target lists actually name, which is not the box's
own index because placements without a `.BIN` never become boxes.

### 9.2 Powerups

Parsed from line 7 and drawn as their own toggleable marker group.

Worth knowing before looking for them: **almost no surface level has any.** Across the three
TV-family archives only three of the 66 surface levels carry powerup records, all in Terminal
Velocity: `GEIGER` (32), `MCORE` (5) and `CANYON3` (3). No Fury3 or F!Zone surface level has a
single one, and Hellbender ships exactly one in the whole game. The 548 total counted in
section 4 is dominated by tunnel levels, which a map view does not open. This is the manual's
account showing up in the data: authors hid powerups inside destructible bunkers, which are
ordinary `.DEF` objects with a spawn probability, rather than placing them loose.

### 9.3 The definition Y offset

[def-loader.js](../src/worker/def-loader.js) keeps the six leading integers of a definition
header and adds slot 4 to the placement height, so objects authored to hover now hover. Only
the canonical six-integer shape is trusted to carry the offset in a known slot. Applied to the
TV/F3 path only; Hellbender keeps its own mapper untouched.

The base height keeps its existing truncating shift and the offset is added as a separate
term. Measuring first showed why that matters: 8052 of 15046 placement Y values are not
multiples of 2^15, so converting the base term to a division would have raised every existing
TV/F3 object by a fraction of an altitude step. Whether the engine intends that fraction is a
real question, but it is a different one from this fix, and answering both in one change would
make it impossible to tell which one moved an object.

### 9.4 Smaller items

- The track picker filters tunnel levels on header line 0, with the old line-2 `.TNL` sniff
  kept as a fallback.
- Definition bodies skip past the shared record prefix when the four named separators confirm
  it, and the existing scan still finds where the record actually ends. See the Hellbender
  note in section 5.4: the prefix is shared but the record length is not.
- Definition descriptions are captured and carried on each placement. The fixed record has one
  at a known offset; for the short form, a scan for the first body line that is neither a
  numeric row nor an asset name recovers all 154 remaining descriptions.
- `.ANI` animations run, on both paths described in section 6, under an "Animate" toggle.
- Stats gain Nav points, Tunnels, Powerups and Animated textures, shown only when the level
  carries them.

### Verification

There is no JavaScript runtime in the environment this was written in, so the parsing logic
was mirrored line for line in Python and run against the three archives:

```
LVL header line 0        1 on 148 tunnel levels, 4 on 66 surface levels, nothing else
                         4 on all 26 Hellbender levels, none dropped by the filter
surface levels opened    66
nav points parsed        616      (683 including tunnel levels)
tunnels parsed           183
powerups parsed          40       (548 including tunnel levels)
.DEF files parsed        232 across all four archives, zero failures
placements               6294 Fury3, 3926 F!Zone, 4826 TV, 7606 Hellbender
definitions              1556 in the TV family, 1402 matching the shared prefix
descriptions recovered   1556 of 1556
positions out of bounds  0
tunnel logic out of 0..3 0
```

The rendering itself has not been run. What is verified is the parsing, the cross-references
and the coordinate conversion; what is not is how the markers look on screen.

A caution learned the hard way: the first version of this mirror reproduced the parser I
*meant* to write rather than the one I had written, and so passed while the shipped code lost
every Hellbender object. The mirror now transcribes the JS control flow line by line, and the
Hellbender archive is part of the check.

## Appendix A: verified constants

| Constant | Value | How established |
|---|---|---|
| Grid | 256 by 256 | RAW is 65536 bytes in 66 of 66 surface levels |
| Heightfield | 1 byte per cell, 0 to 255 | same, plus the manual |
| Texture map | 1 byte per cell, plain index, no flag bits | max CLR byte == textureCount - 1 in 66 of 66 levels |
| Textures per level | 2 to 171 observed, 256 ceiling | measured across all surface levels |
| DEF/NAV/PUP/TDF horizontal | 2^20 units per cell, signed, wraps | NAV to DEF exact position match |
| DEF/NAV/PUP/TDF vertical | 2^15 units per altitude step | placement altitude == terrain height, zero error |
| Heading | 65536 per full turn, 0 north, 16384 east | manual, Navigation Points |
| Angles | 65536 per full turn | existing `TR_ANGLE_TO_RAD`, unchanged |
| Speeds and rates | 65536 = 1.0 per second | manual, Enemy Editor |
| Hit point | 4096 units | manual, Enemy Editor field K |
| NAV entry types | 0 to 6, all seven occur | 69 files, 683 entries |
| NAV targets per entry | 12 maximum | manual; no shipped file exceeds it |
| Tunnel logic | 0 to 3 | 366 values measured, none outside the range |
| Chamber flag | 0 or 1 | 183 tunnels measured |
| Powerup types | 0 to 11 observed | 548 placements measured |
| Enemy definitions | 50 maximum per level | manual |
| Enemy placements | 500 maximum per level | manual |

## Appendix B: manual sections, by OCR line number

| Section | Lines |
|---|---|
| Creating a New World | 267 to 298 |
| General Fury3 editor Information | 300 to 332 |
| Ground Altitude Editor | 334 to 393 |
| Texture Placement Editor | 395 to 475 |
| Fractal Landscaper | 477 to 524 |
| Enemy Editor and field descriptions | 526 to 789 |
| Placing Enemies and Powerups | 791 to 903 |
| Tunnels and Tunnel Editor | 905 to 996 |
| Edit Tunnel Attributes | 998 to 1068 |
| Tunnel Segment Editor | 1070 to 1250 |
| Placing Enemies and Powerups in Tunnels | 1252 to 1303 |
| Chambers | 1305 to 1419 |
| Navigation Points | 1421 to 1589 |
| Mission briefing text and planet | 1591 to 1658 |
| Building a POD, VOX, file layout | 1660 to 1752 |
| Troubleshooting | 1754 to 1830 |
