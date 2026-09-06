# CPR Track and Wall Layer: Documentation Analysis vs JSTrackViewer

Source material for this analysis:

1. Arne Martin Klemetsrud's "Guide to editing tracks in CART Precision Racing", archived at
   `web.archive.org/web/19990209012952/http://cart.gamestats.com/tracks/editing/editing.htm`
   (18 pages, captured 1999-02-09).
2. String tables recovered from `CPREDIT.EXE` (the "Demented(R) Track Editor(TM)").
3. Direct measurement of `LAGUNA.TRK`, `LAGUNA.TTX`, `LAGUNA.TEX` and the `ART/` textures
   extracted from `LAGUNA.POD`.
4. The current implementation in `src/worker/racetrack-loader.js` and
   `src/scene.js` (`_buildRaceTrackLayer`).

The headline result: the CPR track layer is not a free-form mesh. It is a **fixed 20 point
cross section** extruded along up to 700 segments, with a named role for every point and
every section. That schema was never guessed at during the original reverse engineering, and
knowing it fixes most of what currently looks approximate.

---

## 1. What the documentation establishes

### 1.1 The structural model

From `basics.htm`:

> The track is made up of segments. The shortest ovals in the game consists of about 150
> segments, while the maximum number of segments a track can have is 700.
> By default each segment is divided horizontally into 6 sections, but there can be as many
> as 20. As with segments, all lines bordering a section is straight. Each section can be
> only one surface type (e.g. road, grass, curb etc) and be only one texture.
> All you do in the track editor is change the lines between segments and between sections,
> change the texture of the sections and put up walls between sections.

So the three primitives are:

| Primitive | Lives on | Count in `LAGUNA.TRK` |
|---|---|---|
| Segment (a cross section slice) | `pointCount` / `plist` | 331 |
| Section (a lane between two adjacent points) | `type`, `!texture` | 19 per segment |
| Wall (a vertical panel raised at a point) | `wallType`, `wallTexture` | 20 per segment |

Confirmed against the file: `CRaceTrack.trackCount = 331`, `CRaceTrack.length = 11816.64`
(feet, which is 2.238 miles, the correct Laguna Seca length), every record has
`pointCount 20` and `segmentCount 19`.

### 1.2 The wall types

From `walls.htm`, the editor's wall keys are:

```
1 - short wall        5 - wall with tall catch fence
2 - tall wall         6 - med wall
3 - wall with catch fence   7 - tree wall
4 - very tall wall
```

`CPREDIT.EXE` carries the authoritative table at `0x1aca99`, and it matches exactly:

| `wallType` | Editor string | Count in LAGUNA |
|---|---|---|
| 0 | `None.` | 5914 |
| 1 | `Short wall` | 508 |
| 2 | `Tall wall` | 46 |
| 3 | `Short wall with catch fencing` | 107 |
| 4 | `Very tall` | 10 |
| 5 | `Wall-catch-wall` | 4 |
| 6 | `Wall med` | 31 |
| 7 | `Tree` | 0 (unused at Laguna) |

### 1.3 Wall parts and texture slices

From `walls.htm`:

> On walls higher than short wall you can change which part of the wall you want to apply
> texture to by pressing W. Also each raw-file containing wall-textures contain 4 textures.
> To change between the four use R.

Both statements are directly visible in the data. `wallTexture` is four comma separated
values per point, one per wall part, and each value packs a texture index plus a slice
selector:

```
value & 0x0FFF  ->  index into the .TTX texture list
(value >> 12) & 3  ->  which of the 4 sub textures inside that RAW
```

Sample from `LAGUNA.TRK` segment 0, point 3, `wallType 1`:

```
107,4103,4103,4103
  107   = 0x006B -> tex 107 (LG4SIGN1.RAW), slice 0
  4103  = 0x1007 -> tex   7 (LG4SIGN1.RAW), slice 1
```

### 1.4 The `catch fencing` is a global asset, not a track texture

`CPREDIT.EXE` references `catch.raw` / `catch.act` and `catch3d.raw` / `catch3d.act`
directly. Both live in `STARTUP.POD` under `ART\`, never in a track POD, and they never
appear in any `.TTX`. `CATCH.RAW` is 64x64, `CATCH3D.RAW` is 256x256 (the 3D accelerated
variant). Rendering `CATCH3D.RAW` confirms it is a grey chain link mesh drawn on palette
index 0, which resolves to pure black, so it is a colour keyed cutout using exactly the
black key rule already implemented in `decodeRawTexture(..., { cutout: true })`.

This explains why wall types 3 and 5 have no fence texture stored in the TRK. The fence
geometry is implicit in the wall type.

### 1.5 Tree walls

`CPREDIT.EXE` builds tree wall textures by name pattern `ZTREE0%d.RAW`, and the track
editor has a dedicated `J. Tree me` menu entry that generates them. From `walls.htm`:

> You can also put up a special tree wall, which is about three times higher than the tall
> wall. This is intended to be used as a tree line a little bit away from the track.

Laguna does not use them. Mid-Ohio and Elkhart Lake do (the guide names both).

---

## 2. The finding that matters most: the fixed cross section schema

`CPREDIT.EXE` at `0x1ac990` holds twenty consecutive strings. They are the names the wall
editor prints for `Section : %s`. There are exactly twenty of them and `pointCount` is
exactly twenty in every record of every CPR track:

| Point | Editor name | Section (point -> point+1) | `type` at Laguna |
|---:|---|---|---:|
| 0 | `Left unused 1` | 0 | 0 |
| 1 | `Left unused 2` | 1 | 0 |
| 2 | `Left tree` | 2 | 0 |
| 3 | `Left shoulder` | 3 | 0 |
| 4 | `Left shoulder/Curb` | 4 | **1** |
| 5 | `Curb/Main` | 5 | **2** |
| 6 | `Main` | 6 | **2** |
| 7 | `Main/Pit curb` | 7 | **1** |
| 8 | `Pit curb/Pit grass` | 8 | 0 |
| 9 | `Pit grass` | 9 | 0 |
| 10 | `Pit grass` | 10 | 0 |
| 11 | `Pit grass/Pit curb` | 11 | **1** |
| 12 | `Pit curb/Main` | 12 | **2** |
| 13 | `Main` | 13 | **2** |
| 14 | `Main/Curb` | 14 | **1** |
| 15 | `Curb/Right shoulder` | 15 | 0 |
| 16 | `Right shoulder` | 16 | 0 |
| 17 | `Right tree` | 17 | 0 |
| 18 | `Right unused 1` | 18 | 0 |
| 19 | `Right unused 2` | (none) | |

The `type` column is the per section array already parsed into `surface.segmentTypes`, and
it lines up perfectly:

- `type 2` sits exactly on sections 5, 6, 12, 13, which the names call `Main`.
- `type 1` sits exactly on sections 4, 7, 11, 14, which the names call curbs.
- `type 0` is everything else.

Across all 331 segments: 1324 sections of type 1 and 1324 of type 2, which is exactly
4 and 4 per segment. Distribution is `{0: 3641, 1: 1324, 2: 1324}` out of 6289 sections.

**So `type` is not the paint surface type. It is the structural slot role: 0 = off track,
1 = curb slot, 2 = drivable road slot.** This is the layout the `details.htm` `F` / `J` /
`P` keys build:

> P - double width of track plus center section in the middle (for pitlane, and grass in
> the middle)

The cross section is a mirrored double road: `Main` band on the left, `Pit grass` in the
middle, `Main` band on the right. On a segment without a pit lane, one band collapses to
zero width by duplicating its points, which is exactly what the `plist` shows.

This schema is a hard invariant and can be relied on completely.

---

## 3. The paint surface type is in the TTX, not the TRK

From `textures.htm`:

> You must also select what type of surface each texture should be [...] press t to cycle
> through the different surface types (road, curb, grass, sand, rock).
> You only have to set the type of a texture once. That means that if you have applied a
> grass texture to one section and set it's type to grass, all other sections with this
> texture will be grass.

That is the second column of every `.TTX` line, which `racetrack-loader.js` already parses
as `flags` and then never uses. `CPREDIT.EXE` at `0x1acafa` gives the enum:

| Value | Editor string |
|---|---|
| 0 | `Road` |
| 1 | `Curb` |
| 2 | `Grass` |
| 3 | `Dirt` |
| 4 | `Rocks` |

Measured against LAGUNA.TTX (115 entries, flags `{0: 88, 1: 7, 3: 20}`) the correlation with
the structural `type` is total:

```
tex  0  flag=3 (Dirt)  LAGSAND3.RAW   only ever on type 0 sections  (2961x)
tex  1  flag=0 (Road)  TORED.RAW      only ever on type 1 sections  (1178x)
tex 14  flag=1 (Curb)  CURB1.RAW      only ever on type 1 sections    (30x)
tex 18  flag=0 (Road)  RD4C.RAW       only ever on type 2 sections   (230x)
```

Note the guide says "sand" where the editor says `Dirt`. The editor string is authoritative.

---

## 4. Where the current implementation diverges

### 4.1 Wall texture slices are split on the wrong axis (confirmed defect)

`scene.js:1161` `raceWallUvs()` divides **U**:

```js
const tile = (((value ?? 0) >> 12) & 3) / 4;
const u0 = tile;
const u1 = tile + 0.25 * uRepeat;
```

Rendering `LG4SIGN1.RAW` (65536 bytes, 256x256) shows the four sub textures are stacked
**vertically**, as four 256x64 strips:

```
strip 0  concrete wall
strip 1  stacked tyre wall
strip 2  TOYOTA banner
strip 3  "WE CARE" roundel banner
```

`LG4SIGN5.RAW` is the same layout: Firestone / VISA / Omega Timing / Hewlett Packard.
These are advertising hoardings, one per strip, each the full width of a wall panel.

The current code slices horizontally, so every wall renders a quarter width vertical sliver
of all four adverts tiled sideways instead of one advert. This alone accounts for a large
share of the "approximate" look.

The fix is a V split with the U left free to tile along the wall run:

```js
const strip = ((value >> 12) & 3) / 4;   // 0, 0.25, 0.5, 0.75
const v0 = strip;
const v1 = strip + 0.25;
// U runs 0..uRepeat along the wall length
```

Slice ordering (whether slice 0 is the top or bottom strip) still needs one visual check
against the game, but the axis is not in doubt.

### 4.2 Road U coordinates are tiled instead of read from the file

`scene.js` currently derives road UVs from world size:

```js
const uRepeat = Math.max(1, width / 256);
```

The file stores them. `CPREDIT.EXE` prints `u1: %f, u2: %f, u3: %f, u4: %f` for a section,
and every `!texture` line has exactly five fields:

```
texIndex, u1, u2, u3, u4
0,262144,16384000,262144,16384000
```

Those are 16.16 fixed point in a 0..256 normalised space:

```
262144   / 65536 = 4.0     -> u = 4/256   = 0.0156
16384000 / 65536 = 250.0   -> u = 250/256 = 0.9766
```

6120 of 6289 sections use the default `(4, 250, 4, 250)`, which is "map the texture once
across this section, inset two pixels at each edge to stop bilinear bleed". The remaining
107 distinct tuples belong to the editor's auto generated quantised textures (named by the
`xxxQ%x.RAW` pattern, which is why LAGUNA.TTX contains `LAGQ41C6.RAW`, `LAGQ167E.RAW` and
friends) and carry genuine atlas sub rectangles such as `(130.8, 130.8, 134.1, 134.1)`.

Why this matters: `RD4A.RAW` and `RD4B.RAW` are 64x64 asphalt tiles with the **white edge
line baked into one side** (RD4A on the left, RD4B on the right). They are the left and
right halves of the carriageway. Tiling U by `width / 256` repeats that white line across
the road surface. Reading `u1..u4` maps each half exactly once and puts the line where it
belongs.

Concretely, `parseRaceTrackSurface` already keeps `textureCoordinates`, so the data is
there and just needs wiring into the quad:

```js
const [ , u1, u2, u3, u4 ] = a.textureCoordinates[lane];
const U = (v) => v / 65536 / 256;
```

The V coordinate is genuinely not stored and has to be derived from segment length, so the
existing `len / 256` heuristic stays until it can be checked against the game.

### 4.3 Wall parts 1 to 3 are discarded

`scene.js:1156`:

```js
function selectRaceWallTexture(aValues, bValues) {
  const first = (aValues ?? [])[0] ?? (bValues ?? [])[0];
  return Number.isFinite(first) ? first : 0;
}
```

Only part 0 is ever used, and the whole wall is one quad of height
`Math.min(18, 6 + wallType * 2)`.

Measuring how many parts are actually authored per wall type (distinct values and how
strongly each part collapses onto a single leftover default, which is `4103` at Laguna):

| `wallType` | part 0 | part 1 | part 2 | part 3 | reading |
|---|---|---|---|---|---|
| 1 Short wall | 21 distinct | collapses (58% one value) | collapses | collapses | 1 part |
| 3 Short wall + catch fencing | 19 distinct | collapses (47%) | collapses | collapses | 1 part + implicit fence |
| 6 Wall med | 16 | 14 spread | 13 spread | 13 spread | 2+ parts |
| 2 Tall wall | 19 | 12 spread | 14 spread | 19 spread | multi part |
| 4 Very tall | 7 | 7 spread | 6 spread | 6 spread | multi part |
| 5 Wall-catch-wall | 2 | 4 spread | 2 | 2 | wall, fence, wall |

The guide's "walls higher than short wall" wording plus the `Wall-catch-wall` name gives
the intended stacking. A wall should be built as a stack of quads, one per part, and types
3 and 5 should insert a cutout `CATCH3D.RAW` quad at the fence position.

Note that points with `wallType 0` still carry non default `wallTexture` values. The guide
explains this exactly:

> Pressing X when editing walls removes the wall, not just the texture (well, it doesn't
> remove the texture at all, if you put up another wall it will still have the same texture).

So `wallTexture` must only be read where `wallType > 0`, which the current code already
does correctly.

### 4.4 Lane visibility is heuristic where it can be exact

`isRaceLaneInsideWalls()` at `scene.js:1135` renders only the lanes between the leftmost
and rightmost walled point, and falls back to rendering everything when fewer than two
walls exist on the pair of segments.

With the fixed schema this can be exact. Sections 0 to 3 and 16 to 18 are the
`unused` / `tree` / `shoulder` slots; sections 4 to 14 are the track proper. Zero width
sections are directly detectable because `pointOffset[i] === pointOffset[i+1]` (the
`pointOffset` array is already parsed and currently unused; at Laguna segment 0 it runs
`-48, -48, -48, -36, -24, -24, 0, 24, 24, 24, 24, 24, 24, 48, 72, 72, 82, 94, 94, 96` in
feet from the centreline).

The current heuristic drops shoulders and gravel traps whenever walls happen to sit inboard
of them, which at Laguna means the sand traps that define the corners can go missing.

### 4.5 Surface type is parsed and then dropped

`flags` survives all the way from `racetrack-loader.js` through `track-worker.js:228` into
`trackData.raceTrackTextures[i].flags`, and `scene.js` never reads it. It is the only thing
that tells road from curb from dirt from grass from rock.

---

## 5. Implementation status

All of items 1 to 7 below are implemented. The schema tables live in
`src/shared/cpr-track-schema.js`, the geometry in `scene.js` `_buildRaceTrackLayer`, the
fence asset in `racetrack-loader.js` and `track-worker.js`.

| # | Change | Status |
|---|---|---|
| 1 | Split wall texture slices on V instead of U | done |
| 2 | Use stored `u1..u4` for road section U | done |
| 3 | Stack wall parts instead of one quad | done |
| 4 | Render `CATCH3D.RAW` as a cutout fence for wall types 3 and 5 | done |
| 5 | Replace `isRaceLaneInsideWalls` with a `pointOffset` zero width test | done |
| 6 | Surface `flags` as a named surface type | done, in the stats panel |
| 7 | Expose the named cross section slots | done, `CPR_POINT_NAMES` |
| 8 | Tree walls from `ZTREE0n.RAW` | partial, drawn as a tall panel from the wall texture |
| 9 | Per wall type heights | calibrated, not known, see below |

### What the change actually does to Laguna

Replaying the new selection logic over all 331 records of `DATA/LAGUNA.TRK`:

```
road sections drawn now                          3068
  of which the old wall-bounded heuristic dropped  955   real geometry that was missing
zero-area quads the old heuristic emitted        2177   now skipped
wall panels                                       863   was 706 single quads
catch fence panels                                111   was 0
texture indexes out of range                        0
```

The 955 recovered sections are the shoulders and gravel traps: the old heuristic only drew
lanes between the leftmost and rightmost walled point, so anything outboard of a wall was
dropped. The 2177 zero-area quads were the collapsed pit lane slots on segments with no pit
lane.

### Invariants checked against the file

Every one of these holds for all 331 records, which is what makes the schema safe to rely on
rather than treat as a heuristic:

- `pointCount` is 20 and `segmentCount` is 19, always.
- `!texture` always has exactly 5 fields.
- `wallTexture` always has exactly 4 parts.
- `pointOffset` always has 20 entries.
- Every `wallType` present has an entry in `CPR_WALL_LAYERS`, and every part index that table
  names exists.
- No packed texture index falls outside the 115 entry `.TTX`.

### Two defects found by testing the first cut

Both were reported against Laguna after the changes above landed, and both are fixed.

**The right-hand wall drew its textures mirrored.** A wall quad runs along the track and is
extruded straight up, so its front face normal is horizontal and perpendicular to the run:
`T x up`, which is `(-Tz, 0, Tx)`. That normal points to one fixed side of the direction of
travel for every wall, so walls on one side of the track present their front face to the
driver and walls on the other present their back, and a back face draws its texture
mirrored.

Measured over Laguna, walls at `pointOffset < 0` face away from the track (330 of 330) and
walls at `pointOffset > 0` face toward it (372 of 374). The catch is that this does not
survive as a point-index rule, because `pointToWorld` mirrors Z (`ws - wy`) and so reverses
the handedness of the whole layer: what the file calls the left of the track lands on the
driver's right. The fix tests the geometry as it actually reaches world space, comparing the
front face normal against the across-section direction and the cross section midpoint at
index 10, then mirrors U when the wall can only be seen from behind. Replayed over Laguna it
flips exactly the 330 and leaves exactly the 374.

**The whole layer floated about 11 feet above the terrain.** This is what made surrounding
objects look buried. `pointToWorld` was adding a constant 8 world unit lift, plus 10 for
walls, presumably against z-fighting.

No lift is warranted. Sampling the terrain beneath the centreline of every segment confirms
`point[1] / zDivisor` already lands on the terrain height:

```
seg   trkAlt   alt/4   terrain sample   raw16/64
  0    789.4   197.3             196      196.9
 40    751.5   187.9             187      187.3
200    929.9   232.5             232      232.1
```

Across all 6620 track points the track sits a median of 1.07 terrain units above the
interpolated ground, with the 5th to 95th percentile spanning +0.54 to +1.84. That is exactly
what `Match ground alt` produces, since it levels the ground to the minimum altitude under
the track and banking then drops one side below that. Only 0.36% of points fall more than one
unit below the terrain, and terrain poking through the track is an authentic artifact of the
original engine anyway, which the guide calls out at Memorial.

So the bias is now zero and coplanar z-fighting is handled with `polygonOffset` on the
material instead. Units only, with no slope factor: the road and the walls share materials,
and a slope factor would be amplified enormously on a wall seen edge on.

### The one thing still missing

Actual wall heights per type are hardcoded in the engine and were not recoverable from the
strings. `CPR_WALL_PART_HEIGHT_FT` is set to 9 feet, derived from the art: wall panel strips
are 256x64, and Laguna averages 11816.64 / 331 = 35.7 feet per segment, so a panel spanning
one segment at the texture's own 4:1 aspect is 8.9 feet tall. That is calibration, not
knowledge. Two ways to replace it with the real number:

- Measure from screenshots of the original game at a known track position.
- Disassemble `CRaceTrack::makeWallList` in `CPREDIT.EXE` (the symbol is at `0x1abc72`).

Two smaller open points, both flagged in the code:

- Whether slice 0 is the top or the bottom 256x64 strip. The axis is certain, the direction
  is one visual check against the game.
- Whether a wall belongs to the segment it is stored on and spans forward, which is what the
  code assumes, or spans backward. Either way it only changes the panel at each end of a run.

## 6. Things the documentation confirms we already handle correctly

- `.TRK` is a line oriented text format keyed by labels, parsed correctly.
- `.TTX` is a count followed by `NAME.RAW,flags` lines, parsed correctly.
- Texture index masking with `& 0x0FFF` and slice extraction with `>> 12` is correct.
- Reading `wallTexture` only where `wallType > 0` is correct.
- Textures are `RAW` plus `ACT` palette, with the 6 bit versus 8 bit palette detection
  already handled in `texture-decoder.js`.
- The black key cutout rule needed for catch fencing is already implemented, it just is not
  being applied to the fence.

---

## 7. Reference tables

### 7.1 `.TRK` record layout (verified against LAGUNA.TRK)

```
CRaceTrack.trackCount      <n>
CRaceTrack.trackBackground <name.raw>
CRaceTrack.scale           <float>
CRaceTrack.length          <float, feet>

  repeated <n> times:
    pointCount     20
    segmentCount   19
    curveFlag      <0|1>
    p              <x,y,z>                 anchor, equals plist[6] at Laguna
    type           19 lines                0 off track, 1 curb slot, 2 road slot
    plist          20 lines <x,y,z>        world position of each cross section point
    !texture       19 lines <idx,u1,u2,u3,u4>
    wallType       20 lines                0..7
    wallTexture    20 lines <p0,p1,p2,p3>  packed index | slice << 12
    h              <x,y,z>                 segment normal
    pointOffset    20 lines <float, feet>  lateral offset from centreline
    !altitude      <float>
    grade          <float>
    %interpGrade   <float>
    $width,interpWidth  <float,float>
    ^heightOffset  20 lines <float>        per point vertical offset
```

### 7.2 Packed texture value

```
bits 0..11   texture index into .TTX
bits 12..13  sub texture slice, 0..3, stacked vertically as 4 strips
```

### 7.3 Texture coordinate decode

```
u = value / 65536 / 256
default (262144, 16384000, 262144, 16384000) = (0.0156, 0.9766, 0.0156, 0.9766)
```

### 7.4 Editor menus (from CPREDIT.EXE, useful for naming things in the viewer)

Track editor, `Demented(R) Track Editor(TM)`:

```
1. Create a new track              A. Edit track textures
2. Edit current track control points   B. Edit track mesh points
3. Add grade/alt/pit/curb information  C. Edit wall types & textures
4. Load track                      D. Autoset track type
5. Save track                      E. Level out runoff areas
6. Recreate track                  F. Reverse track
7. Slice max size                  G. Smooth height/gradient
8. Match ground alt                H. Smooth all
                                   I. Smooth some
                                   J. Tree me
                                   L. Fix mid ohio
                                   P. Pi editor
```

Ground editor, `Level Editor`:

```
A. Edit Level Details          H. Place Boxes
B. Texture Map Editor          I. Move/Edit/Delete Boxes
C. Altitude Map Editor         J. Place race cars
D. Ground Light Editor         K. Move/Edit/Delete race cars
E. Course Editor               N. Edit Texture Animation
```

Note `D. Ground Light Editor` and `N. Edit Texture Animation` are not covered anywhere in
Arne Martin's guide. `LAGUNA.LTE` (131072 bytes, matching the 256x256 altitude and colour
maps at 2 bytes per cell) is the ground light layer, and `LAGUNA.ANI` is the texture
animation file. Neither is currently read by the viewer.

### 7.5 Track type

`CPREDIT.EXE` prompts `4 = road, 5 = speedway, 6 = short oval, 7 = street :` under
`D. Autoset track type`. This value drives AI behaviour and is stored in the `.SIT`.
