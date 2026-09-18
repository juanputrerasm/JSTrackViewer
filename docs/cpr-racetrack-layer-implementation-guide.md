# CART Precision Racing racetrack layer implementation guide

```yaml
document_kind: implementation-specification
format_family: Terminal Reality POD1 / legacy SIT
game: CART Precision Racing (CPR)
primary_audience:
  - MTM2 engine and tool developers
  - track viewer authors
  - format converters
source_of_truth:
  implementation: JSTrackViewer current working-tree build, inspected 2026-09-15
  reference_track: stock LAGUNA.POD
  validation_set: 17 stock CPR track PODs, 5040 TRK records
certainty_labels:
  verified: established from code, editor strings, and stock files
  current_behavior: what JSTrackViewer does, including known limitations
  calibrated: visually/data-derived value not recovered from game code
  unresolved: requires original-game comparison or disassembly
```

## 1. Purpose and short version

CPR adds a second, independently textured racing-surface layer above the ordinary
MTM-family terrain. MTM2 has no stock equivalent. The layer is not a BIN model, a set of
ground boxes, or a free-form triangle mesh. It is a sequence of cross sections stored in a
text `.TRK` file. Each stock cross section has 20 points, making 19 horizontal sections.
Adjacent cross sections are stitched into road, curb, grass, dirt, and rock quads. Walls are
vertical stacks raised from any of the 20 points.

The complete asset chain is:

```text
WORLD/<track>.SIT
  first line -> LEVELS/<track>.LVL
    LVL zero-based line 2 (third physical line) -> DATA/<terrain>.RAW
      replace .RAW with .TRK -> DATA/<terrain>.TRK
        replace .TRK with .TTX -> DATA/<terrain>.TTX
          each TTX row -> ART/<texture>.RAW and usually <texture>.ACT
        wall types 3/5 -> global ART/CATCH3D.RAW + .ACT from STARTUP.POD
```

The `.SIT` does **not** explicitly name the `.TRK` or `.TTX`. They are found by the terrain
RAW basename convention. For example, `WORLD\LAGUNA.SIT` starts with `laguna.lvl`; LVL
zero-based line 2 (the third physical line) is `laguna.raw`; the optional racetrack layer is
therefore `DATA\LAGUNA.TRK`, with
`DATA\LAGUNA.TTX` as its texture table.

An MTM2-oriented loader should keep the normal SIT/LVL/RAW/CLR terrain path and attach this
layer optionally when the companion `.TRK` has the `CRaceTrack.trackCount` signature. Do not
replace the terrain. The terrain remains visible around and, geometrically, underneath the
CPR layer.

## 2. Scope and evidence

This document describes the implemented path in these JSTrackViewer files:

- `src/worker/sit-parser.js`: SIT-family detection, LVL loading, terrain-layout inference,
  and the call that discovers the racetrack layer.
- `src/worker/racetrack-loader.js`: `.TRK`, `.TTX`, and catch-fence loading and parsing.
- `src/shared/cpr-track-schema.js`: verified CPR enums, cross-section names, packed texture
  fields, wall stacks, and vertical conversion.
- `src/worker/track-worker.js`: palette completion, RAW decoding, fallback catch-fence
  synthesis, serialization, and statistics.
- `src/scene.js`, `_buildRaceTrackLayer`: road and wall mesh generation.
- `src/worker/terrain-builder.js`: the terrain height decode against which the layer must
  align.

The reverse-engineering evidence is summarized in JSTrackViewer's
`docs/CPR_TRACK_LAYER_ANALYSIS.md` and comes from CPREDIT strings, the archived CPREDIT
guide, and direct measurements of stock data. JTraxx3's earlier investigation is in
[cpr-pod-reverse-engineering.md](cpr-pod-reverse-engineering.md).

The local stock validation set contains 17 CPR PODs with `.TRK` layers:

- 5,040 declared and successfully delimited records.
- Every record has `pointCount = 20` and `segmentCount = 19`.
- Declared track counts range from 138 to 616, within the editor's documented maximum of
  700.
- Every corresponding terrain RAW is 131,072 bytes: `256 * 256 * 2`.
- All `curveFlag` values are 0 or 1.
- All wall types 0 through 7 occur across the set.
- All `.TTX` surface flags 0 through 4 occur across the set.

These are strong stock-format invariants. A defensive tool may accept non-stock counts, but
it must not blindly apply the 20-slot names or the fixed midpoint rule to another layout.

## 3. Keep the three coordinate spaces separate

Most CPR implementation errors come from mixing these spaces:

1. **File/authoring space**: floating-point triples in SIT and TRK. The ordering is
   `(x, altitude, along-map)` even though different code calls the last coordinate `y` or
   `z`.
2. **Legacy terrain-height space**: the scalar height consumed by the Traxx-style terrain
   renderer. CPR converts file altitude to this space with `/ 4`; ordinary 8-bit MTM data
   uses `/ 2` for SIT placements.
3. **Renderer scene space**: JSTrackViewer uses X-right, Y-up, Z mirrored relative to the
   second horizontal map axis. A default altitude scale of 3 is applied after conversion to
   legacy height space.

For a stock CPR `.TRK` point `p = [px, pAltitude, pAlong]`, current JSTrackViewer uses:

```text
sceneX = 2 * trunc(px)
sceneY = (pAltitude / 4) * heightScale
sceneZ = worldSize - 2 * trunc(pAlong)

worldSize   = terrainGridSize * 64
heightScale = 3 by default
```

For the stock 256-square grid, `worldSize = 16,384` scene units. The Z subtraction mirrors
the map so it agrees with the terrain mesh. Horizontal values are truncated before doubling
to reproduce the legacy Traxx conversion. The fractional altitude is retained.

This is specifically the current TRK rendering path. JSTrackViewer's shared SIT placement
parser keeps the horizontal floats before doubling, so the current build is asymmetric:
TRK horizontal points are truncated while SIT vehicle/box/course positions are not. An
implementation should choose deliberately between exact current-viewer behavior and a
fully floating-point path; it should not lose precision accidentally in scattered casts.

If an engine works directly in CPR authoring units, it does not need to copy this anisotropic
scene transform. It does need to use one consistent transform for terrain, TRK points, SIT
placements, wall heights, checkpoints, and models.

### 3.1 CPR altitude encoding and precision versus MTM2

This is the important cross-game difference.

Stock MTM2 terrain normally stores one unsigned byte per cell. A raw value is a whole legacy
height step. An MTM2 SIT placement's middle component converts approximately as:

```text
legacyHeight = sitAltitude / 2
sceneY        = legacyHeight * heightScale
```

Stock CPR terrain stores a little-endian unsigned 16-bit value per cell. It is a 10.6
fixed-point legacy height:

```text
raw16         = raw[2*i] | (raw[2*i + 1] << 8)
legacyHeight  = raw16 / 64.0
sceneY        = legacyHeight * heightScale
```

CPR SIT placements and TRK point altitudes use a source scale four times the legacy height:

```text
legacyHeight  = cprFileAltitude / 4.0
sceneY        = (cprFileAltitude / 4.0) * heightScale
```

Consequently, a terrain point and a TRK point align when approximately:

```text
raw16 / 64 == trkAltitude / 4
raw16       == 16 * trkAltitude
```

At Laguna, a grid sample around a vehicle with SIT altitude `762.388062` is about `12160`:

```text
762.388062 / 4 = 190.597 legacy steps
12160 / 64     = 190.000 legacy steps
```

The difference includes terrain interpolation and the vehicle's authored clearance. This is
the correct scale; using the MTM2 `/ 2` rule on CPR makes placements and the road layer float
far above the terrain.

If the authoring altitude values are treated as feet, which is how CPREDIT presents its
coordinates, CPR's RAW quantization is `1/16` foot while an MTM2 byte height is a much coarser
2-foot step. More safely stated without assigning physical units: CPR has 64 fractional
levels per legacy height step, while stock MTM2 has only whole steps.

### 3.2 Current JSTrackViewer precision caveat

The current terrain builder samples a two-byte legacy height as follows:

```js
if (hi === 0) return lo;
return (lo | (hi << 8)) >>> 6;
```

That reproduces the legacy integer height and provides a compatibility fallback for an
8-bit value stored in a two-byte cell, but `>>> 6` discards CPR's six fractional bits. The
TRK renderer does not discard its fractional altitude. A new implementation that values
geometric precision should use `raw16 / 64.0`, while retaining an explicit compatibility
mode if exact current-viewer or legacy raster behavior is required.

Do not add a constant vertical lift to the racetrack. Measurements over Laguna put the TRK
surface a median of about 1.07 legacy terrain units above the interpolated terrain, with the
difference explained by CPREDIT's “Match ground alt” operation and banking. JSTrackViewer
previously added a lift and made the whole road hover. It now keeps the coordinates unchanged
and uses a depth-buffer polygon offset instead:

```text
polygonOffset       = true
polygonOffsetFactor = 0
polygonOffsetUnits  = -2
```

Wall heights must pass through the same CPR altitude transform as their base points. Adding
an unscaled scene-space wall height makes walls change relative size when the height-scale
control changes.

## 4. Detection and loading

### 4.1 Distinguishing CPR, MTM1, and MTM2 SIT files

Legacy SIT files have no version field and do not name their game. Looking for the literal
strings `CPR` or `MTM1` is ineffective; they do not occur in the stock SIT bodies.

JSTrackViewer detects CPR before testing MTM2 or falling back to MTM1. Its exact CPR markers
are:

```text
^currentPitStop
@ap.guy2follow,ap.lineOffset,ap.place,ap.pit
*** VARLOW ***
```

Its MTM2 markers are:

```text
!ambient sound,track length,weather mask
!stadiumFlag,x,z,sx,sz,stadiumModelName
```

`.SI2` is an MTM2 Community Patch 3 extension and is classified as MTM2 immediately.
Anything with neither CPR nor MTM2 markers falls back to MTM1.

A new detector should also accept CPR's very clear schema markers:

```text
vehicleFile
yourVehicleNumber,paceLaps
&performanceScalar,deadCar,deadCarTimer
*** More stuff ***
```

JSTrackViewer's current detector does not need those for the stock set, but they make a
damaged or reduced CPR SIT easier to classify. Companion `DATA/<stem>.TRK` content beginning
with `CRaceTrack.trackCount` is strong supporting evidence, although detection should not
depend on the optional layer alone.

### 4.2 Asset lookup algorithm

Use the following order:

```text
1. Enumerate WORLD/*.SIT (and MTM2-only *.SI2).
2. Decode SIT and all related text as ISO-8859-1/Latin-1.
3. Read the SIT's first line as the LVL resource name.
4. Resolve the LVL by full normalized path, then by basename if necessary.
5. Read LVL zero-based line index 2 (the third physical line) as the terrain RAW name.
6. Resolve the terrain RAW in DATA/ or by its supplied path.
7. Replace the RAW extension with .TRK and resolve that resource.
8. If no TRK exists, continue with an ordinary MTM-family level.
9. Decode TRK as Latin-1, normalize CRLF/CR to LF, trim lines, and discard blanks.
10. Require the exact label `CRaceTrack.trackCount` followed by a valid count.
11. Derive `.TTX` from the resolved TRK entry's basename/path; fall back to the RAW-derived
    basename.
12. Load TTX textures and then parse the declared TRK records.
13. If any parsed wall type needs fencing, resolve `ART/CATCH3D.RAW`, then
    `ART/CATCH.RAW`, preferably across mounted/shared archives including STARTUP.POD.
```

JSTrackViewer calls this lookup for every legacy SIT after its LVL is loaded; it does not
hard-gate the optional layer on `origin === CPR`. The content signature is the gate. This is
a useful design for MTM2 tools because a custom MTM2-family package can carry the optional
geometry without changing the base level loader.

### 4.3 `.TRK` filename ambiguity

`.TRK` has two unrelated meanings in this game family:

- `DATA/<terrain>.TRK` with `CRaceTrack.trackCount` is a CPR racetrack layer.
- `TRUCK/<name>.TRK`, or a truck archive's manifest found by content, is an MTM truck
  definition.

Path context and the first recognized label must determine the parser. Never dispatch on the
extension alone.

## 5. `.TRK` text format

The file is line-oriented Latin-1 text. Labels and values occupy separate lines. Current
JSTrackViewer trims and removes blank lines, then parses the record fields in the exact order
below.

### 5.1 File header

```text
CRaceTrack.trackCount
<recordCount>
CRaceTrack.trackBackground
<backgroundRawName>
CRaceTrack.scale
<float>
CRaceTrack.length
<float, documented/validated as feet>
```

Laguna's header is:

```text
CRaceTrack.trackCount
331
CRaceTrack.trackBackground
laguna.raw
CRaceTrack.scale
0.999987
CRaceTrack.length
11816.639648
```

The length equals approximately 2.238 miles, which independently confirms the horizontal
foot scale. Current JSTrackViewer reads only `trackCount`; it ignores background, scale, and
length. A format-preserving tool should retain all four.

### 5.2 Repeated record grammar

The following block repeats `trackCount` times:

```text
pointCount
P
segmentCount
S
curveFlag
<0-or-1>
p
<x,altitude,along>
type
S lines of <integer>
plist
P lines of <float,float,float>
!texture
S lines of <textureRef,u1,u2,u3,u4>
wallType
P lines of <integer>
wallTexture
P lines of <part0,part1,part2,part3>
h
<float,float,float>
pointOffset
P lines of <float>
!altitude
<float>
grade
<float>
%interpGrade
<float>
$width,interpWidth
<float,float>
^heightOffset
P lines of <float>
```

For stock data, `P = 20` and `S = 19`. The parser should validate at least:

```text
P > 0
S > 0
S == P - 1 for the stock cross-section model
number of parsed records == CRaceTrack.trackCount
each !texture row has at least 1 and normally exactly 5 integers
each wallTexture row has exactly 4 integers for the stock schema
all referenced texture indices are in range after masking
```

Use bounded counts before allocating. CPREDIT documents a maximum of 700 track slices.
JSTrackViewer stops parsing the layer when an expected label is missing; records already
parsed remain in memory, but callers should prefer reporting the malformed layer rather than
silently presenting a partial circuit.

### 5.3 Meaning and use of each field

| Field | Cardinality | Meaning | Current rendering use |
|---|---:|---|---|
| `pointCount` | 1 | Number of points across this slice | Controls arrays; stock value 20 |
| `segmentCount` | 1 | Number of sections between points | Controls arrays; stock value 19 |
| `curveFlag` | 1 | Curve/interpolation flag; exact engine effect is not established | Preserved, not rendered |
| `p` | 3 floats | Slice anchor/centerline-related point; equals `plist[6]` at Laguna | Preserved, not rendered |
| `type` | S ints | Structural section role: off-track/curb-slot/road-slot | Preserved, not used to select paint or collision |
| `plist` | P triples | Final authored cross-section vertices | Authoritative rendered geometry |
| `!texture` | S rows | Texture reference and four stored U coordinates | Texture and U mapping |
| `wallType` | P ints | Wall stack at each point | Selects wall geometry |
| `wallTexture` | P × 4 ints | Packed texture/slice for each possible wall part | Selects wall panel art |
| `h` | 3 floats | Stored slice normal | Preserved; renderer recomputes mesh normals |
| `pointOffset` | P floats | Lateral distance from centerline in feet | Zero-width detection and schema inspection |
| `!altitude` | 1 float | Editor altitude control value, not the final vertex height | Preserved, not rendered |
| `grade` | 1 float | Editor grade control value | Preserved, not rendered |
| `%interpGrade` | 1 float | Interpolated grade | Preserved, not rendered |
| `$width,interpWidth` | 2 floats | Authored and interpolated widths | Preserved, not rendered |
| `^heightOffset` | P floats | Per-point editor vertical offsets | Preserved, not rendered directly |

For rendering, `plist` is already the final result of the editor's altitude, banking, width,
pit, curb, and per-point operations. Do not reconstruct vertices from `p`, grade, width,
offset, and height-offset fields unless implementing an editor that must reproduce CPREDIT's
regeneration algorithm.

## 6. Fixed stock cross-section schema

The 20 names below come from CPREDIT's wall editor. An array position is a **point**. The
section at index `i` lies between point `i` and point `i + 1`, so point 19 has no section
after it within the same cross section.

| Point | CPREDIT name | Section starting here | Structural `type` |
|---:|---|---:|---:|
| 0 | Left unused 1 | 0 | 0 |
| 1 | Left unused 2 | 1 | 0 |
| 2 | Left tree | 2 | 0 |
| 3 | Left shoulder | 3 | 0 |
| 4 | Left shoulder/Curb | 4 | 1 |
| 5 | Curb/Main | 5 | 2 |
| 6 | Main | 6 | 2 |
| 7 | Main/Pit curb | 7 | 1 |
| 8 | Pit curb/Pit grass | 8 | 0 |
| 9 | Pit grass | 9 | 0 |
| 10 | Pit grass | 10 | 0 |
| 11 | Pit grass/Pit curb | 11 | 1 |
| 12 | Pit curb/Main | 12 | 2 |
| 13 | Main | 13 | 2 |
| 14 | Main/Curb | 14 | 1 |
| 15 | Curb/Right shoulder | 15 | 0 |
| 16 | Right shoulder | 16 | 0 |
| 17 | Right tree | 17 | 0 |
| 18 | Right unused 1 | 18 | 0 |
| 19 | Right unused 2 | none | none |

Constants:

```text
type 0 = off-track structural slot
type 1 = curb structural slot
type 2 = drivable-road structural slot
cross-section midpoint = 10
```

The layout is a mirrored double carriageway with pit grass in the middle. Where no pit lane
exists, points repeat and the unused band collapses to zero width. Therefore duplicated
coordinates are intentional, not corrupt data.

The `type` array is **not** the painted or physical surface type. It says what role that
fixed slot has in the cross-section template. Surface behavior comes from the `.TTX` entry
used by the section.

### 6.1 Detecting collapsed sections

For section `i` on record `r`:

```text
collapsed(r, i) = pointOffset[i] == pointOffset[i + 1]
```

If `pointOffset` is absent, compare `plist[i]` and `plist[i + 1]`. JSTrackViewer skips a
section quad only when the section is collapsed at **both** ends of the longitudinal span:

```text
if collapsed(recordA, i) and collapsed(recordB, i): skip
```

If only one end is collapsed, keep the quad. It represents a valid triangular transition as
a pit lane, shoulder, or curb grows from zero width.

Do not use the innermost and outermost walls to decide which sections exist. That earlier
heuristic removed real shoulders and gravel traps while emitting thousands of zero-area pit
quads.

## 7. `.TTX` texture table and surface semantics

`.TTX` is also trimmed Latin-1 text:

```text
<textureCount>
<name0.raw>,<surfaceType0>
<name1.raw>,<surfaceType1>
...
```

The second value is a property of the texture, not of a TRK section. Applying the same
texture elsewhere applies the same surface behavior. CPREDIT's enum is:

| Value | Surface name |
|---:|---|
| 0 | Road |
| 1 | Curb |
| 2 | Grass |
| 3 | Dirt |
| 4 | Rocks |

The archived guide calls value 3 “sand”; CPREDIT itself calls it `Dirt`, so `Dirt` is the
preferred canonical name.

An implementation should expose the surface flag to physics, audio, particles, AI, and
diagnostics. Current JSTrackViewer preserves it and reports counts, but does not change
rendering or driving behavior from it.

### 7.1 Texture resource and palette resolution

Texture names normally resolve to `ART/<name>.RAW`. The RAW contains 8-bit palette indices
and has no embedded dimensions. JSTrackViewer accepts square power-of-two RAWs from 32×32 to
1024×1024 by deriving the side from byte length. Known wall sheets are 256×256.

Palette priority should be explicit. JSTrackViewer's general palette resolver can rank:

1. Same-stem `<texture>.ACT`.
2. POD entry palette metadata when present.
3. The track ACT named at LVL zero-based line 4 for terrain-class art.
4. Archive/global CPR palettes such as `METALCR2.ACT`.
5. A bundled CPR palette fallback.

There is a current racetrack-specific shortcut to know about: `racetrack-loader.js` eagerly
assigns a same-stem ACT when present and otherwise assigns the track ACT. The later general
resolver runs only when `actData` is still absent. Therefore current racetrack textures do
not always receive the full metadata/global fallback ranking shown above. A new
implementation should use one explicit resolver consistently.

Unlike current JSTrackViewer's terrain and model paths, its racetrack-texture path does not
look for same-stem Community Patch 3 `.PNG` or `.TGA` replacements and does not attach `.ANI`
animation frames. It decodes only the `.RAW` named by `.TTX`. An MTM2-derived engine may add
HD sibling resolution, but should keep the `.TTX` RAW name as the material identity and keep
the legacy UV/slice semantics.

ACT files may contain 8-bit channels (0–255) or VGA 6-bit channels (0–63). JSTrackViewer
treats a palette as 8-bit if any channel exceeds 63; otherwise it expands with:

```text
channel8 = round((channel6 * 255 + 31) / 63)
```

This matters because using a CPR RAW with an MTM2 palette produces plausible but incorrect
colors rather than a decode error.

## 8. Road mesh construction

Let `A` be record `i`, `B` record `i + 1`, and `lane` be section index `0..S-1`.

After transforming the four file points to scene/world coordinates, construct:

```text
p0 = world(A.plist[lane])
p1 = world(B.plist[lane])
p2 = world(B.plist[lane + 1])
p3 = world(A.plist[lane + 1])

triangles = (p0,p1,p2), (p0,p2,p3)
```

Current JSTrackViewer groups quads by texture index, builds indexed buffer geometry, and
computes vertex normals from the resulting geometry. Materials are Lambert-lit and
double-sided. A wireframe group is generated from mesh edges.

### 8.1 Road texture reference

The first value on `!texture` is the `.TTX` index. The shared decoder masks it as:

```text
textureIndex = value & 0x0FFF
```

No stock road-section reference in the inspected set uses bits above bit 11, while wall
references use them extensively for sub-texture selection. Masking road references is still
a safe common decode. An out-of-range index falls back to texture 0 in JSTrackViewer.

### 8.2 Road U coordinates

Each texture row is:

```text
textureIndex,u1,u2,u3,u4
```

The U values are signed/ordinary integer text containing 16.16 fixed point over a 0–256
texture-coordinate space:

```text
normalizedU = storedU / 65536.0 / 256.0
```

The common row:

```text
0,262144,16384000,262144,16384000
```

decodes to approximately:

```text
0.015625, 0.9765625, 0.015625, 0.9765625
```

This maps the art once across the section with an inset at its edges. The inset prevents
bilinear filtering from bleeding adjacent source pixels. It is also essential for asphalt
textures whose white road-edge line is baked into one side; deriving U from road width and
tiling it repeats the white line across the carriageway.

JSTrackViewer maps the four stored values in quad order as:

```text
p0 <- u1
p3 <- u2
p1 <- u3
p2 <- u4
```

### 8.3 Road V coordinate

The file does not store a longitudinal V value in the parsed record. Current JSTrackViewer
uses the horizontal scene length of the section's first edge:

```text
length  = hypot(p1.x - p0.x, p1.z - p0.z)
vRepeat = max(1, length / 256)

p0.v = 1
p1.v = 1 - vRepeat
p2.v = 1 - vRepeat
p3.v = 1
```

This is current behavior and a heuristic, not a recovered CPR engine formula. Keep it behind
a named texture-mapping policy if exact game matching may be added later.

### 8.4 Circuit closure

The current build only connects record pairs `0->1` through `N-2->N-1`. It does not connect
`N-1->0`. Laguna's last and first anchors are about one normal slice spacing apart, not
duplicates, so this leaves a potential seam in both roads and walls.

This is a known current-build limitation. A complete circuit renderer should test a closing
span from the last record to the first, but exact original-game parity still requires
confirming whether `trackCount` means cross sections with implicit wrap or forward-owned
segments with a special terminal convention. Make closure a deliberate policy rather than
an accidental array-bound result.

## 9. Wall representation

`wallType` is stored once per cross-section point. Value 0 means no wall. Nonzero values are:

| Value | CPREDIT name |
|---:|---|
| 1 | Short wall |
| 2 | Tall wall |
| 3 | Short wall with catch fencing |
| 4 | Very tall |
| 5 | Wall-catch-wall |
| 6 | Wall med |
| 7 | Tree |

JSTrackViewer treats a wall on record `A`, point `j`, as owning the forward panel to record
`B` at the same point index:

```text
base0 = world(A.plist[j])
base1 = world(B.plist[j])
```

Whether CPR formally defines forward or backward ownership is still unresolved. It matters
only at the ends of wall runs and at circuit closure.

`wallTexture[j]` always contains four packed values even when no wall exists. CPREDIT leaves
texture assignments behind when a wall is deleted. Therefore:

```text
if wallType[j] == 0:
    ignore wallTexture[j]
```

Do not infer a wall from nonzero texture values.

### 9.1 Packed wall texture reference

Each part value is decoded as:

```text
textureIndex = packed & 0x0FFF
sliceIndex   = (packed >> 12) & 0x0003
```

Bits 0–11 index `.TTX`. Bits 12–13 select one of four panels inside the RAW. The four panels
are stacked **vertically** in a 256×256 wall sheet, each occupying 256×64 pixels. They are not
four columns.

For slice `s`:

```text
vTop    = s / 4
vBottom = vTop + 1/4
```

JSTrackViewer's `DataTexture` is not Y-flipped, so source row 0 maps to `v = 0` in this
pipeline. Whether CPR itself presents slice 0 as the visually top or bottom source strip is
still an original-game visual check.

U is free to run along the wall:

```text
wallLength = hypot(base1.x - base0.x, base1.z - base0.z)
uRepeat    = max(1, wallLength / 256)
```

As with road V, the `/ 256` repeat rule is current renderer behavior, not a recovered engine
constant.

### 9.2 Wall stacks

The current wall construction table is:

| Type | Bottom-to-top stack | Total calibrated height |
|---:|---|---:|
| 1 | texture part 0 × 1 | 9 ft |
| 2 | parts 0, 1, 2 × 1 each | 27 ft |
| 3 | part 0 × 1; catch fence × 2 | 27 ft |
| 4 | parts 0, 1, 2, 3 × 1 each | 36 ft |
| 5 | part 0 × 1; catch fence × 2; part 1 × 1 | 36 ft |
| 6 | parts 0, 1 × 1 each | 18 ft |
| 7 | part 0 × 9 | 81 ft |

One unit is `CPR_WALL_PART_HEIGHT_FT = 9` feet. The stack ordering is supported by CPREDIT
names, editor behavior, and which part columns vary in stock data. The 9-foot unit itself is
**calibrated**, not verified from executable logic: a 256×64 panel has a 4:1 aspect, and
Laguna's average longitudinal slice is about 35.7 feet, implying an 8.9-foot panel.

To replace the calibration with an exact value, measure a known original-game view or
disassemble `CRaceTrack::makeWallList` in CPREDIT. Do not present 9 feet as a proven file
constant.

For each layer in a wall stack:

```text
partHeightScene = (9 / 4) * heightScale
top             = base + layer.units * partHeightScene

q0 = base0 + vertical(base)
q1 = base1 + vertical(base)
q2 = base1 + vertical(top)
q3 = base0 + vertical(top)
```

Texture layers use their named `wallTexture` part. If that part is absent, current behavior
falls back to part 0 and then zero. Fence layers use the global fence material.

### 9.3 Catch fencing

Wall types 3 and 5 imply catch fencing. The fence texture is not present in `.TTX` and is not
one of the four `wallTexture` parts. Resolve it globally in this order:

```text
ART/CATCH3D.RAW  # preferred 256x256 hardware version
ART/CATCH.RAW    # 64x64 software version
```

Both normally live in CPR's `STARTUP.POD`, not the track POD. A production engine should
mount shared archives as well as the selected track archive. Because JSTrackViewer commonly
loads only one POD, its worker synthesizes a 256×256 gray frame/rail/cable stand-in when the
asset cannot be found.

The synthesized fallback is deterministic: it has a 4-pixel outer frame, a center post at
X 126–129, horizontal rails at Y 63–66, 126–131, and 190–193, and thin horizontal cables
every 12 rows starting at Y 15. All unpainted pixels remain transparent. This is a viewer
fallback, not CPR file-format data.

The real fence is a hard color-key cutout. Decode palette-indexed RGB, then set alpha 0 only
when the resolved RGB is pure black; keep other pixels opaque. Render with an alpha test
around 0.5, not general alpha blending. This avoids sorting artifacts and matches the binary
mask.

### 9.4 Tree walls

CPREDIT references generated names matching `ZTREE0n.RAW`. The editor guide describes tree
walls as about three times taller than a tall wall. Current JSTrackViewer implements type 7
as one very tall panel using wall texture part 0. It does not implement the full CPREDIT tree
generation behavior. Treat tree-wall support as partial.

### 9.5 Preventing mirrored wall art

Meshes are double-sided, but a texture seen through a quad's back face is mirrored. Since
file left/right is also reflected by JSTrackViewer's `worldSize - along` transform, point
index alone is not enough to decide whether to reverse U.

Current behavior computes in final world space:

```text
trackTangent   = base1 - base0
frontNormalXZ  = (-trackTangent.z, trackTangent.x)
acrossXZ       = world(A.plist[last]) - world(A.plist[first])
desiredSign    = +1 if pointIndex < 10 else -1
seenFromBehind = dot(frontNormalXZ, acrossXZ) * desiredSign < 0
```

If `seenFromBehind`, swap the wall's `u = 0` and `u = uRepeat` ends. Perform this test after
all reflections and axis conversions.

## 10. Suggested in-memory model

This TypeScript-like model carries everything needed for viewing and preserves editor fields
for future round-trip support:

```ts
type CprSurfaceType = 0 | 1 | 2 | 3 | 4;
type CprWallType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

interface CprTexture {
  name: string;
  surfaceType: CprSurfaceType;
  indexedPixels?: Uint8Array;
  rgba?: Uint8Array;
  width: number;
  height: number;
}

interface CprTrackSlice {
  pointCount: number;
  sectionCount: number;
  curveFlag: number;
  anchor: [number, number, number];
  sectionRoles: number[];                 // S
  points: [number, number, number][];      // P; rendering authority
  sectionTextures: {
    packedRef: number;
    storedU: [number, number, number, number];
  }[];                                    // S
  wallTypes: CprWallType[];                // P
  wallTextures: [number, number, number, number][]; // P
  storedNormal: [number, number, number];
  pointOffsets: number[];                  // P
  altitudeControl: number;
  grade: number;
  interpolatedGrade: number;
  width: number;
  interpolatedWidth: number;
  heightOffsets: number[];                 // P
}

interface CprRaceTrackLayer {
  declaredCount: number;
  backgroundName: string;
  scale: number;
  lengthFeet: number;
  textures: CprTexture[];
  slices: CprTrackSlice[];
  catchFence?: CprTexture;
}
```

Keep `surfaceType` distinct from `sectionRoles`. Calling both `type` is a common source of
wrong friction and rendering decisions.

## 11. End-to-end implementation pseudocode

```text
loadLegacySit(pod, sitEntry):
    sitLines = decodeLatin1PreservingBlankLines(sitEntry)
    origin = detectSitFamily(sitLines)
    lvlName = normalizePath(sitLines[0])
    lvl = resolveFlexible(pod, lvlName)
    doc = loadCommonMtmFamilyLevel(lvl, origin)

    rawName = normalizePath(lvlPhysicalLines[2])  # zero-based; third physical line
    raw = resolveDataAsset(pod, rawName)
    infer gridSize and bytesPerHeightCell from RAW length

    trkName = replaceExtension(rawName, ".TRK")
    trk = resolveDataAsset(pod, trkName)
    if trk exists and contains exact line "CRaceTrack.trackCount":
        ttx = resolveDataAsset(pod, replaceExtension(trk.resolvedName, ".TTX"))
        layer.textures = ttx ? parseTtx(ttx) : []
        layer.slices = parseTrk(trk)
        layer.catchFence = resolveGlobalFenceIfNeeded(podSet, layer)
        doc.cprRaceTrack = layer

    return doc

buildCprMeshes(doc):
    if layer.slices.length < 2: return
    decode all TTX textures with CPR-aware palettes

    for each longitudinal pair (A, B):
        for lane in 0 .. min(A.P, B.P)-2:
            if collapsed at A and B: continue
            ref, u1, u2, u3, u4 = A.sectionTextures[lane]
            emit road quad using A's texture and stored U values

        across = world(A.lastPoint) - world(A.firstPoint)
        for point in 0 .. min(A.P, B.P)-1:
            wallType = A.wallTypes[point]
            if wallType == 0: continue
            for layerPart in wallStack[wallType]:
                emit textured wall quad or implicit fence quad
                reverse U when the track-facing side would be mirrored

    bucket geometry by material
    calculate normals
    render road and wall meshes with no position lift and a small depth bias
```

For physics, build a separate acceleration structure from the same emitted road triangles
and wall panels. Do not derive collision from the visual material buckets, because rendering
may merge distant panels and use double-sided faces while collision needs stable ownership,
surface flags, and one-sided/two-sided policy.

## 12. Significant CPR SIT/LVL differences from MTM2

CPR forked the same broad TrackEd-era format, so much of the level remains compatible:
SIT metadata, boxes/checkpoints, courses, LVL-referenced terrain, CLR texture mapping, ACT
palettes, TEX terrain textures, objects, sky, and backdrop models. The following differences
must be explicit in a shared parser.

### 12.1 Vehicles are cars, not truck manifests

Both formats retain the misleading section title:

```text
*** Your Truck (Not used anymore) ***
```

But the resource key differs:

```text
CPR:  vehicleFile
      pacwest.car

MTM2: truckFile
      bigfoot.trk
```

The later section is named `*** Vehicles ***` in both formats. Its next line is the record
count. Laguna declares 37 CPR vehicles; stock MTM2 Aztec declares 8 trucks. CPR records add
open-wheel race state such as driver identity, pit strategy, performance scaling, fuel,
brake bias, boost, anti-roll bars, weight jacker, and rev limiter.

The first historical player block is saved player state, not a starting-grid marker. Mark it
as `playerSlot = true`. Records under `*** Vehicles ***` are actual grid/AI slots.

Current JSTrackViewer's shared vehicle parser searches only for `truckFile`. It still parses
CPR `ipos` and `theta,phi,psi`, but CPR vehicle names become empty. A correct shared parser
must select `vehicleFile` for CPR or accept either key while recording which schema was used.

### 12.2 CPR-specific SIT state

CPR includes, among other fields:

```text
*** More stuff ***
yourVehicleNumber,paceLaps
brakeBias,fuelKnob,boostKnob,brakeProportion
weightJacker,revLimiter,fAntiRollBar,rAntiRollBar
@ap.guy2follow,ap.lineOffset,ap.place,ap.pit
ap.pitTimer,ap.pitCTF,ap.pitOffset
driverName
modelStatus
^currentPitStop
&performanceScalar,deadCar,deadCarTimer
*** VARLOW ***
```

JSTrackViewer currently uses some of these only as origin markers and otherwise ignores the
racing simulation state. A converter must preserve unknown/state blocks even when it cannot
interpret them.

MTM2 instead has the ambient/weather record:

```text
!ambient sound,track length,weather mask
```

CPR and MTM1 do not. Do not synthesize a zero weather mask for an absent field; absence and
zero are different facts.

### 12.3 Race-type enums are different

The numeric `Track Race Type` field is game-specific.

| Value | MTM2 | CPR |
|---:|---|---|
| 0 | Unset/unknown | not a normal stock value |
| 1 | Drag | not a normal stock value |
| 2 | Circuit | not a normal stock value |
| 3 | Rally | not a normal stock value |
| 4 | Rumble | Road |
| 5 | unknown to MTM2 enum | Speedway |
| 6 | unknown to MTM2 enum | Short oval |
| 7 | unknown to MTM2 enum | Street |

All stock CPR tracks in the inspected set use 4–7. Current JSTrackViewer applies the MTM2
lookup to every legacy SIT, so it reports CPR value 4 as `RUMBLE` and values 5–7 as
`UNKNOWN`. Dispatch the enum by detected origin.

### 12.4 Terrain and LVL differences

| Concern | Stock MTM2 | Stock CPR layer set |
|---|---|---|
| Terrain RAW | Usually 256×256×1 byte | 256×256×2-byte little-endian 10.6 fixed point |
| SIT/course altitude divisor | 2 | 4 for two-byte CPR terrain |
| Terrain fractional precision | Whole legacy steps | 1/64 legacy step in source RAW |
| `!waterHeight` in LVL | Present in stock MTM2, including real zero | Absent; CPR LVL stops earlier |
| Dedicated road layer | None | Optional basename-matched `.TRK` + `.TTX` |
| LTE handling | MTM2 assumptions may apply | Do not assume MTM2 layout/meaning; JSTrackViewer does not apply LTE modulation |

Infer grid size and sample width from file size rather than assuming every CPR/custom track
is 256 square:

```text
if byteLength is an integer square N*N:       grid=N, bytesPerCell=1
else if byteLength/2 is an integer square N*N: grid=N, bytesPerCell=2
else use CLR/LTE evidence or reject explicitly
```

Use the two-byte layout, not the `origin` label alone, to select the `/ 4` placement divisor.
This is how the current shared parser keeps custom/malformed data behavior tied to the actual
terrain encoding.

### 12.5 Stadium and backdrop differences

MTM2 can use the placed stadium record:

```text
!stadiumFlag,x,z,sx,sz,stadiumModelName
```

CPR Laguna retains a legacy “Stadium is not / used anymore!” block and uses four backdrop
models:

```text
*** Backdrop ***
backdropType,backdropCount
0,4
backdropModelName
lg4drop1.bin
lg4drop2.bin
lg4drop3.bin
lg4drop4.bin
```

MTM2 tracks commonly have one backdrop model. Current JSTrackViewer loads only the first
model even when CPR declares four. This does not change the racetrack mesh, but it materially
changes the surrounding scene and should be fixed by any complete CPR implementation.

## 13. Rendering, collision, and driving responsibilities

Current JSTrackViewer implements the CPR layer as a visual scene group with an optional
wireframe group. The UI exposes a CPR-only racetrack toggle when surfaces exist. Statistics
report slice count, wall count/type distribution, TTX surface-type distribution, and whether
the catch fence came from real or synthesized art.

It does **not** currently:

- Add the road triangles to drive-mode ground collision.
- Add wall panels to drive-mode colliders.
- Apply `.TTX` surface types as grip, drag, sound, dust, or damage.
- Use `type` as a driveability mask.
- Reconstruct AI splines or pit behavior from the TRK.

For a gameplay implementation:

1. Keep the terrain collider, because off-track terrain remains part of the world.
2. Add road triangles as a higher-priority surface where they overlap terrain.
3. Associate each road triangle with the selected TTX surface type.
4. Build wall collision from `wallType > 0`; decide separately whether catch fence and tree
   extensions change collision height.
5. Use SIT course/AI/pit records for navigation. The TRK cross sections describe geometry,
   not a complete AI route.
6. Resolve transitions and the last-to-first seam consistently in both render and collision
   meshes.

Exact CPR friction coefficients, collision response, and catch-fence collision behavior are
not established by JSTrackViewer and must not be invented as format facts.

## 14. Robustness rules

An implementation intended to read community content should follow these rules:

- Normalize `\` and `/` for lookup and compare archive paths case-insensitively.
- Decode text as Latin-1, not UTF-8.
- Derive `.TRK` from the LVL terrain RAW, not directly from the SIT filename.
- Prefer the resolved TRK basename when deriving `.TTX`.
- Validate declared counts and cap them before allocation.
- Preserve floats until the final legacy-compatibility transform.
- Keep terrain sample width (`1` or `2`) in the track document.
- Keep structural section role separate from TTX physical surface type.
- Treat duplicate points as legitimate collapsed slots.
- Ignore stale `wallTexture` values when wall type is zero.
- Mask packed texture references and bounds-check the result.
- Allow missing TTX/art and render a diagnostic fallback rather than crashing.
- Search mounted global archives for catch-fence art before synthesizing or omitting it.
- Apply palette-key transparency only to the implicit catch fence, not indiscriminately to
  every black texel in every track texture.
- Preserve ignored editor fields and unknown SIT blocks for round-trip tools.
- Avoid a geometry lift for z-fighting; use renderer depth bias.
- Make circuit closure, wall ownership, and precision mode named policies.

## 15. Conformance tests

At minimum, add the following tests.

### 15.1 Discovery and family detection

- A CPR SIT containing `vehicleFile`, `^currentPitStop`, or `*** VARLOW ***` is CPR.
- An MTM2 SIT containing ambient/weather and placed-stadium labels is MTM2.
- An MTM1 SIT with neither marker family remains MTM1.
- `.SI2` remains MTM2.
- `WORLD/X.SIT -> LEVELS/Y.LVL -> DATA/Z.RAW` discovers `DATA/Z.TRK`, not `X.TRK`.
- A `.TRK` truck manifest is never sent to the CPR parser.

### 15.2 TRK/TTX parser

- Parse a minimal 20/19 record and verify every array length.
- Reject or diagnose a missing label without desynchronizing later records.
- Preserve all five `!texture` values and all four `wallTexture` values.
- Parse TTX flags 0–4 independently of structural types 0–2.
- Verify `packed=0x306B` gives texture 107 and slice 3.
- Verify common U values decode to `0.015625` and `0.9765625`.

### 15.3 Geometry

- Two slices generate one quad for every non-collapsed section.
- A section collapsed at both ends generates nothing.
- A section collapsed at one end generates a transition triangle/degenerate quad without
  corrupt indices.
- Road U ordering is `p0=u1`, `p3=u2`, `p1=u3`, `p2=u4`.
- Wall sheets split on V into four 1/4-height bands, never on U.
- Wall types 1–7 produce the configured layer sequence.
- Types 3 and 5 include implicit fence layers.
- Left and right wall art faces the track without mirroring after the world Z reflection.
- Missing art uses a stable fallback material.

### 15.4 Altitude

- CPR raw bytes `00 40` decode as `0x4000 / 64 = 256` legacy steps in precise mode.
- CPR TRK altitude `1024` maps to the same 256 legacy steps.
- MTM2 SIT altitude `512` maps to 256 legacy steps with `/ 2`, not `/ 4`.
- The same CPR base transform is used for road vertices and wall-part heights.
- No constant road lift is present.
- A precise-mode terrain test retains nonzero low six bits.

### 15.5 Stock-data invariants

For each available stock CPR POD:

- Parsed record count equals `CRaceTrack.trackCount`.
- Stock records are 20/19.
- TTX indices after masking are within range.
- Wall part indexes requested by the stack table exist.
- No emitted vertex/UV is NaN or infinite.
- First/last anchor distance is reported so closure policy is visible.

## 16. Known unknowns and current-build limitations

These must remain labeled rather than silently hardened into “format facts”:

| Item | Status |
|---|---|
| 20 points / 19 sections in stock CPR | Verified across 5,040 records |
| Structural point names and enums | Verified from CPREDIT strings and stock layout |
| TTX surface enum | Verified from CPREDIT and stock data |
| Packed wall texture bits and vertical slicing | Verified |
| Catch fence is global implicit art | Verified |
| CPR `/ 4` versus MTM2 `/ 2` altitude conversion | Verified by terrain/placement alignment |
| CPR RAW six fractional height bits | Verified format; discarded by current terrain rendering |
| Horizontal float handling | Current TRK path truncates; current SIT placement path preserves floats |
| 9-foot wall part | Calibrated, not recovered from code |
| Slice 0 visual top/bottom convention in original CPR | Unresolved |
| Wall record owns forward or backward span | Unresolved; current build assumes forward |
| Last-to-first circuit closure | Current build omits it; original convention needs confirmation |
| Tree wall generation/exact appearance | Partial implementation |
| Exact road longitudinal V formula | Unresolved; current build uses length/256 |
| Exact CPR friction/collision behavior | Not implemented or established |
| HD/animated racetrack textures | Not implemented; current path decodes only TTX-named RAW |
| CPR `vehicleFile` parsing | Current build misses it because it searches `truckFile` |
| CPR race-type display | Current build incorrectly uses MTM2 enum |
| Multiple CPR backdrop models | Current build loads only the first |

## 17. Implementation checklist for an MTM2 codebase

- [ ] Detect CPR from SIT schema before the MTM2/MTM1 fallback.
- [ ] Accept `vehicleFile`/`.CAR` without confusing it with `truckFile`/truck `.TRK`.
- [ ] Dispatch the race-type enum by game family.
- [ ] Infer one-byte versus two-byte terrain samples from the RAW.
- [ ] Decode CPR little-endian 10.6 heights, preferably without discarding the low six bits.
- [ ] Use `/ 4` for CPR two-byte SIT/TRK altitude and `/ 2` for classic MTM placements.
- [ ] Locate the layer from the LVL RAW basename.
- [ ] Parse and preserve the complete TRK record in order.
- [ ] Parse TTX texture flags as surface types.
- [ ] Build cross-section quads from adjacent `plist` records.
- [ ] Skip only sections collapsed at both longitudinal endpoints.
- [ ] Use stored road U coordinates.
- [ ] Decode and vertically slice packed wall textures.
- [ ] Build wall stacks by wall type.
- [ ] Load global catch-fence art with color-key alpha, with a documented fallback.
- [ ] Correct wall U direction after final coordinate reflections.
- [ ] Use depth bias instead of lifting the road.
- [ ] Decide and test last-to-first closure and wall-span ownership.
- [ ] Add road and wall geometry to collision separately if implementing gameplay.
- [ ] Use TTX surface type for physical behavior; do not use the structural slot role.
- [ ] Preserve CPR-only SIT state and multiple backdrop models even if not yet interpreted.

Following this separation lets an MTM2 engine support CPR cleanly: the existing terrain and
scene format remains the base, while the CPR `.TRK`/`.TTX` pair becomes an optional,
well-typed overlay with its own geometry, materials, surface semantics, and walls.
