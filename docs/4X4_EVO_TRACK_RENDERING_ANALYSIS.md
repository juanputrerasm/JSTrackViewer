# 4x4 Evolution 1/2 track rendering analysis

## Purpose and scope

This document is an implementation brief for adding 4x4 Evolution 1 and 4x4
Evolution 2 tracks to JSTrackViewer. It deliberately excludes vehicle physics,
vehicle data, AI, race rules, sound, menus, and gameplay. It follows only the data
needed to discover a track, build its terrain, place its visible objects, and render
its materials, sky, water, shadows, and vegetation.

The two requested repositories are:

- `/Users/juanpabloutreras/dev/4x4e` — reverse-engineered Evo 1 Build 57 renderer/runtime interfaces.
- `/Users/juanpabloutreras/dev/4x4e2` — reverse-engineered Evo 2 Build 139 renderer/runtime interfaces.

The most important caveat is that neither repository currently contains the game
layer that parses POD, LTE, LVL, SIT, TEX, SMF, VEG, or the terrain grids. They are
useful evidence for the renderer contract, especially the Evo 1/Evo 2 graphics
generation boundary, but they are not track loaders to port. Their READMEs call
both projects incomplete; `4x4e` even says the available LTE files were useful for
testing, but the LTE decoder itself is not present in checked-in source.

To keep conclusions honest, this document uses three evidence labels:

- **Verified** — directly observed in source code or in a parsed sample.
- **Correlated** — observed consistently across multiple fields/files but the
  original reader code is unavailable.
- **Unknown** — requires more reverse engineering; do not bake a guess into the
  public TrackDoc schema.

## Bottom line

Full Evo tracks and downloadable `.LTE` tracks are two substantially different
ingestion projects.

| Input | Container | Terrain/world description | Custom assets | JSTrackViewer status |
|---|---|---|---|---|
| Evo 1 complete track | POD2 | SIT v6 + LVL v1 + 16-bit grids + TEX v1 | SMF, indexed RAW/ACT, OPA | Not loadable |
| Evo 2 complete track | POD2 | SIT v7 + LVL v1 + same core grids + TEX v1 | SMF, RAW/ACT/OPA, indexed TIFF, VEG; optional WAT | Not loadable |
| Evo 1 downloadable track | Standalone binary LTE | Compressed/packed terrain and track state | Designed to reuse installed assets | Codec/schema unresolved; not loadable |

The fastest credible milestone is complete Evo 1 POD rendering. It needs POD2,
an Evo LVL/TEX path, SIT v6 handling, and an SMF decoder. Much of the current
terrain atlas code can then be reused after correcting Evo scale and palette
resolution. Evo 2 builds on that base but needs SIT v7, TIFF with indexed alpha,
VEG, and richer material/lighting behavior. LTE should be a separate research
spike: it is not a small wrapper around the POD files.

## What the `4x4e` repositories actually establish

### Shared facts

Both projects expose the same broad renderer-module architecture: indexed polygon
lists, texture selection, culling, fog, Z buffering, transforms, and several
renderer backends. Neither contains calls that open `.SIT`, `.LVL`, `.TEX`,
`.SMF`, `.VEG`, `.RTD`, `.SDW`, `.POD`, or `.LTE` files. Searches for those file
formats in checked-in source return no track loader.

Therefore these repositories can answer “what vertex/material state did the game
renderer accept?” but not “how did the game decode a track file?” Any format claim
below comes from actual track samples, existing POD readers, or linked community
documentation rather than being attributed to code that is not there.

### Evo 1 rendering contract

**Verified:** `4x4e/Source/TRX/Renderers.Basic.Vertexes.hxx:30-35` defines `RVX`
as position, per-vertex BGRA, and UV:

```text
XYZ + BGRA + UV
```

`4x4e/Source/TRX/Renderers.Modules.Export.hxx:48-69` exposes the older immediate
polygon-list interface. This points to a predominantly pre-lit rendering path:
the scene/game layer supplies vertex colors rather than normals to this vertex
type. The renderer still has fog, blending, culling, texture selection, and other
fixed-function state, so “pre-lit” must not be interpreted as “unlit textures
only.”

### Evo 2 rendering contract

**Verified:** `4x4e2/Source/TRX/Renderers.Basic.Vertexes.hxx:31-42` changes `RVX`
to position, normal, and UV and adds an `RBVX` basis vertex:

```text
XYZ + normal + UV
RBVX basis data (six uint32 fields, still unidentified in the project)
```

`4x4e2/Source/TRX/Renderers.Modules.Export.hxx:39-82` adds dynamic lights,
hardware lighting controls, optimized meshes, render-to-texture/cubemap entry
points, gloss, light vector/color/constants, multiple texture-stage selection,
and explicit source/destination blend controls. The original shader assets under
`4x4e2/Source/R.DirectX.8.0.TL/Assets/` include prelit, directional-light,
detail, decal/alpha-test, cubic reflection, bump, bump+cubic, bump+specular,
gloss, fog, and projected-shadow paths.

This is the clearest graphics difference between the games. An Evo 2 loader must
retain normals and material intent instead of flattening everything into Evo 1-like
diffuse color. A first milestone can render diffuse SMF geometry, but that is a
compatibility preview rather than faithful Evo 2 output.

One ABI oddity is not a format limit: Evo 1 defines `MAX_TEXTURE_NAME_LENGTH` as
256 (`4x4e/.../Renderers.Basic.Textures.hxx:53`), while Evo 2 defines 64
(`4x4e2/.../Renderers.Basic.Textures.hxx:53`). POD2 names are variable-length;
the renderer's in-memory field should not be used as the archive parser's limit.

## Complete POD tracks

### POD2 container

Both inspected Evo 1 stock track PODs and Evo 2 custom track PODs begin with
`POD2`. This is a different archive format from the POD1/POD1-64 formats currently
accepted by JSTrackViewer.

**Verified POD2 layout:**

| Offset | Size | Meaning |
|---:|---:|---|
| `0x00` | 4 | ASCII `POD2` |
| `0x04` | 4 | archive CRC-32/MPEG-2, covering `0x08` through EOF |
| `0x08` | 80 | NUL-terminated archive comment |
| `0x58` | 4 | little-endian directory entry count |
| `0x5c` | 4 | audit-record count |
| `0x60` | `count * 20` | directory records |

Each 20-byte directory record is five little-endian `uint32` values:

1. path offset relative to the name table;
2. payload length;
3. absolute payload offset;
4. Unix timestamp;
5. payload CRC-32/MPEG-2.

The NUL-terminated, variable-length name table immediately follows the directory.
Optional 312-byte audit records follow payloads. For viewing, audit records and CRC
validation can initially be optional, but all bounds must still be validated.

This layout is already implemented in nearby workspace projects:

- `/Users/juanpabloutreras/dev/JSPod/src/worker/pod-format.js`
- `/Users/juanpabloutreras/dev/JPod/docs/POD_FORMAT.md`, section 6
- `/Users/juanpabloutreras/dev/JPod/src/main/java/.../PodArchiveReader.java`

Port the indexed reader rather than extending the POD1 layout heuristics. Detect
`POD2` by signature before attempting POD1.

### Observed package inventories

These inventories are direct observations from representative files, not a claim
that every track contains every extension.

| Sample | Game | Entries | Render-relevant inventory |
|---|---|---:|---|
| `Jyard.pod` | Evo 1 stock/demo | 1,982 | 965 ACT, 967 RAW, 35 SMF, 9 OPA; one each of LVL/SIT/TEX/CLR/RAW-height/RTD/SDW |
| `ZONA.pod` | Evo 1 stock/demo | 1,736 | 843 ACT, 845 RAW, 35 SMF, 7 OPA; same core world files |
| `DEN1.pod` | Evo 2 custom | 602 | 271 ACT, 272 RAW, 33 SMF, 14 TIF, 3 OPA, one VEG and WAT; same core world files |
| `STG2ROAD.pod` | Evo 2 custom | 1,980 | 933 ACT, 934 RAW, 62 SMF, 30 TIF, 5 OPA, one VEG; same core world files |

The apparent one-extra RAW in the counts is the 16-bit terrain height file; the
remaining RAW files are generally 8-bit indexed images. Classify RAW by the
referencing field and expected size, not extension alone.

### Asset graph and expected loading order

```text
POD2
└── WORLD/<track>.SIT
    ├── track metadata
    ├── LEVELS/<track>.LVL
    │   ├── DATA/<track>.RAW   16-bit height grid
    │   ├── DATA/<track>.CLR   16-bit terrain tile-index grid
    │   ├── DATA/<track>.TEX   terrain and shadow texture table
    │   │   └── ART/*.RAW + *.ACT
    │   ├── sky RAW (+ matching ACT)
    │   ├── detail RAW (+ ACT/OPA where present)
    │   ├── water and light parameters
    │   └── Evo 2 vegetation texture hint
    ├── visible object placements
    │   └── MODELS/*.SMF
    │       └── ART/*.RAW + *.ACT + optional *.OPA, or ART/*.TIF
    ├── DATA/<track>.VEG       Evo 2 procedural/instanced vegetation
    ├── DATA/<track>.SDW       per-cell shadow overlay selection
    ├── DATA/<track>.RTD       unresolved 16-bit auxiliary grid
    └── DATA/<track>.WAT       optional Evo 2 water material settings
```

Paths in the samples use backslashes and mixed case. Normalize separators and
case for lookup but retain the source name for diagnostics. At minimum, resolution
must search `WORLD`, `LEVELS`, `DATA`, `MODELS`, and `ART`; filename-only fallback
is useful for imperfect custom PODs but must report ambiguity.

## World formats

### SIT: scene metadata and placements

Both games use line-oriented text, but their object sections are incompatible.
They should have distinct versioned parsers feeding one normalized scene model.

#### Common header

The inspected files begin:

```text
version
<6 or 7>
<track>.lvl
authorName
...
!Race Track Name
...
```

This matters immediately: JSTrackViewer's current `parseSitTrack()` treats line 0
as the LVL filename. On an Evo track it looks for an asset named `version`, finds
no terrain, and then applies the wrong box parser.

The header also contains track logo, race type, ambient/weather fields, view data,
and vehicles. For this project's rendering scope, keep display name, LVL link,
weather/ambient identifiers only if they influence sky/fog, and discard vehicles
and race state.

#### Evo 1 SIT v6

**Verified:** v6 uses the older sequential `*** Boxes ***` layout. After the count,
each `Box N of M` record consists of label/value pairs such as:

```text
wPos
3429.6,255,2561.21
wOrient
0,0,3.14159
model
jy3fence.smf
mass
0
!type,flags
0,0
priority
0
...
```

For rendering, parse `wPos`, `wOrient`, `model`, type/flags, parent,
`timePerFrame`, and `castShadowOnMe`. Ignore mass, velocities, and other physics.
The current JSTrackViewer parser recognizes some labels but expects MTM-style
`ipos` and `theta,phi,psi`, so it does not obtain the Evo placement or orientation.
Do not run Evo coordinates through `parseLegacyWorldTriplet()`; Evo records are
already floating-point world coordinates.

#### Evo 2 SIT v7

**Verified:** v7 replaces the sequential layout with a class registry and
brace-delimited instances:

```text
*** Boxes ***
// boxTypeList
15
CVehicle 6
CBox 1
CCollide 3
CNonCollide 2
...
// boxCount
100
// Box name list
1 CCollide
...
{ 1 CCollide
    ""              // name
    "AUSTART.SMF"   // staticName
    18,12.3165,3.41832 // size
    3919.62,272.395,6789.87 // wPos
    0,5.95616,0     // wOrient
    ...
    0               // castShadowOnMe
    0               // collisionType
} CCollide
```

The integer after each class name in the type list is its serialized schema
version, not an object count. Instance fields are ordered and vary by class/schema.
For a first renderer, the common prefix is enough: class, name, `staticName`, size,
world position/orientation, parent, animation rate, and cast-shadow flag. Class
tails concerned only with collision, triggering, treasure, trains, or physics can
be skipped by parsing to the closing brace. `CNonCollideFacing` likely needs a
billboard render policy; `CTree` and `CTreeCollisionBox` need vegetation/tree
handling. Keep unknown classes as diagnostic records rather than aborting.

#### Course section

SIT v6 and v7 both contain `*** Course ***` segments with `cstart` and `cend` in
the same world-coordinate family. Course lines are not required to draw terrain,
but retaining their centerline is useful for initial camera placement and a track
overlay. Race logic and checkpoints are out of scope.

### LVL v1: terrain manifest and environment

The inspected Evo 1 and Evo 2 LVLs share this structure:

```text
// .LVL version
1
0
<track>.raw
<track>.clr
<track>.tex
<sky>.raw
<sound>.wav
!waterHeight,waterTideHeight,waterTidePeriod
<height>,<tide-height>,<period>
@waterR,waterG,waterB,waterOpacity
<r>,<g>,<b>,<a>
#detailTexture
<detail>.RAW
$lightSourceVector
<x>,<y>,<z>
%vegTexture
<vegetation-mask-or-texture>.RAW
```

Some Evo 1 stock LVLs append a signature warning line. Treat it as trailing
metadata.

This is not JSTrackViewer's existing positional LVL schema. In particular, the
current parser assumes line 4 is a global ACT palette, line 10 is a sky RAW, and
lines 14-21 are music/fog/LTE/light values. On Evo, line 4 is CLR, line 5 is TEX,
line 6 is the sky, and the rest is label-driven. A dedicated Evo LVL parser is
safer than adding more positional exceptions.

There is no single track palette in the observed Evo package. Each indexed image
normally resolves a same-stem `.ACT` (or otherwise associated palette), so the
terrain atlas must retain palette-per-slot instead of relying on `doc.palette`.

### RAW heightfield

**Verified for all four POD samples:** the track height RAW is 131,072 bytes:
`256 * 256 * 2`, little-endian unsigned 16-bit values. It is not an 8-bit texture.

**Correlated scale:** Evo's native horizontal terrain cell is 32 world units,
making an 8192-unit square. Height values behave as 5-bit fixed point:

```text
nativeHeight = uint16LE / 32.0
nativeX = column * 32
nativeZ = row * 32
```

This correlation is strong: at an Evo 2 placement `(3919.62, 272.395, 6789.87)`,
the corresponding cell near `(122, 212)` contains raw value 8704, and
`8704 / 32 = 272`. Other Evo 1/Evo 2 placements land near the terrain under the
same mapping. Preserve the fractional low bits; do not integer-shift them away.

JSTrackViewer currently uses a 64-unit cell and, for two-byte RAW, returns
`uint16 >>> 6`, then multiplies by a user/default height scale. That geometry is
not native Evo scale. Recommended implementation: make `cellSize` and raw height
divisor explicit in the terrain descriptor and build Evo at `cellSize: 32`,
`heightDivisor: 32`, `heightScale: 1`. This also lets SIT/SMF use native coordinates
without the MTM `*2` conversion.

Confirm row direction visually against landmarks. The current Three.js builder
flips Z when emitting geometry; that presentation transform can remain if object
placements receive the identical transform exactly once.

### CLR terrain selection grid

**Verified:** the samples contain a 131,072-byte, 256-by-256 little-endian
`uint16` grid. Values in all four samples span exactly the ordinary TEX slot range
(`0..textureCount-1`). The current 16-bit decoder interprets:

```text
bits  0..11  texture index
bits 12..13  mirror
bits 14..15  quarter-turn rotation
```

That packing is compatible with the samples (all inspected stock/sample CLR flags
happen to be zero), and should be retained, but add a fixture containing nonzero
Evo mirror/rotation flags before declaring it verified for Evo-authored maps.

### TEX v1: terrain and shadow texture table

The header is:

```text
Version
1
textureCount,shadowTextureCount
<ordinaryCount>,<shadowCount>
<integer>,<integer>,<filename>
...
```

There are `ordinaryCount + shadowCount` records. CLR indexes the first group.
SDW references the appended shadow group.

The two integers before each filename are material/alignment metadata. Observed
first values include `0`, `100`, `203`, `602`, `603`, `701`, `1001`, `1200`,
`1204`, and `1205`; observed second values include `0..3`. Their exact bit/decimal
semantics are **unknown**. Preserve them verbatim as `param0`/`param1` until the
original reader or controlled rendering tests identify them. Do not call the first
one “friction” or the second one “rotation” in the normalized API without evidence.

### SDW: shadow overlay grid

**Correlated:** SDW is another 131,072-byte, 256-by-256 `uint16` grid. In the Evo 1
samples, non-sentinel values exactly cover the TEX table's appended shadow range;
for example Jyard's ordinary count is 432, shadow count is 494, and SDW references
432 through 925. `0x8000` is overwhelmingly the empty/no-overlay value. One Evo 2
sample also uses `0x4000`; its exact meaning is unknown. Render SDW as a second
terrain layer only after confirming sentinel/flag behavior and UV alignment.

Ignoring SDW produces recognizable but visibly incomplete terrain on tracks with
painted/baked shadow tiles. It is not required for the first geometry milestone.

### RTD: unresolved per-cell grid

**Verified shape, unknown meaning:** RTD is also a 131,072-byte `uint16` grid.
Jyard's is all zero; the other samples contain dense high-entropy values. No RTD
reader exists in either requested repository, and the values do not behave like a
simple texture index. It may include driving-surface or terrain-detail information,
but that is not established. Preserve it as an opaque optional grid and defer it
until an A/B render or original reader trace proves a visual role.

### SMF v4: static model geometry

Both Evo 1 and Evo 2 samples use text `C3DModel` files whose second line is version
4. This format is substantially documented by Dummiesman's open-source Blender
SMFImportExport add-on. Comparing its reader/writer with the sampled models gives
the following grammar:

```text
"C3DModel"
fileVersion
objectCount
if fileVersion >= 4: lodEnabled,lodSwitchHeight

repeat objectCount times:
    objectName
    if fileVersion >= 2: visible
    objectVersion                 // importer supports 1
    vertexCount,frameCount,faceCount,unknown0
    ["v1"]                       // optional Evo 2 material marker
    material0,material1,material2,transparent,reflective,textureName
    if v1: "bumpTextureName"
    repeat vertexCount: x,y,z,nx,ny,nz,u,v       // first frame
    repeat frameCount - 1:
        repeat vertexCount: x,y,z,nx,ny,nz,u,v   // animation frames
    repeat faceCount: i0,i1,i2
```

For example:

```text
C3DModel
4
1
0,50.000000
OPAQUE
1
1
86,1,88,0
1.000000,1.000000,32.000000,0,0,ALRAIL1.RAW
x,y,z,nx,ny,nz,u,v
...
i0,i1,i2
...
```

**Verified:** every object is a separately named mesh/group with one material.
Vertex records carry position, normal, and UV; faces are indexed triangles. The
add-on converts SMF coordinates from feet and remaps axes for Blender, reverses
triangle winding, and flips V. JSTrackViewer should retain SMF's native feet and
apply only its own Three.js coordinate/winding convention, not copy the Blender
meter conversion.

The add-on identifies material fields 3 and 4 as transparent and reflective flags
and field 5 as the diffuse texture. It preserves fields 0-2 only indirectly (its
exporter writes `1.0,1.0,32.0`), so their names remain unknown. The optional `v1`
form uses `.TIF` material art and adds a quoted bump/normal texture name for Evo 2.
Preserve all three unknown scalars and the final `unknown0` object-info value.

The file-level v4 pair enables screen-height LOD switching. Conventionally named
low-detail objects such as `OPAQUEL` and `TRANSL` are paired with high-detail
groups such as `OPAQUE` and `TRANS`; the second value is the screen-height switch
threshold. A viewer can initially show only the high-detail visible objects, then
implement switching after validating the complete naming set.

Implement the reader as a counted state machine and validate every count and face
index. This is much safer than guessing the vertex/index boundary from commas.
The Blender add-on skips extra animation frames, but their counted location is now
known; JSTrackViewer can likewise preserve or skip them without desynchronizing.
More samples are still needed to validate animation meaning, every group-name/LOD
combination, empty bump names, and unusual object/material versions.

JSTrackViewer's existing `BIN` decoder is not reusable as a byte-layout parser,
but its normalized mesh/material output and scene hydration path are good targets
for an SMF adapter. Preserve normals for Evo 2 lighting.

### RAW + ACT images and OPA alpha

The image RAW files are square, unheadered 8-bit palette indices. Their dimensions
are inferred from byte length. ACT is a 256-entry RGB palette (768 bytes); existing
JSTrackViewer RAW/ACT decoding can be reused, including 6-bit-vs-8-bit channel
detection, but lookup must be per texture.

OPA is an unheadered, one-byte-per-pixel opacity plane paired by stem with an
indexed texture. Observed examples are 64x64, 128x128, and 256x256 and contain full
0..255 gradients. It is not merely a binary color key. Merge it into the decoded
RGBA alpha channel; verify orientation against the paired RAW. This is needed for
trees, fences, vegetation, detail overlays, and other cutout/translucent geometry.

### Evo 2 TIFF

Evo 2 track art adds `.TIF`. Browsers do not reliably decode TIFF natively, and
JSTrackViewer currently only handles RAW/ACT plus PNG/TGA true-color paths.

**Verified in the inspected Evo 2 PODs:** files use little-endian TIFF (`II 42`),
uncompressed data, and palette photometric interpretation. Common forms are:

- 64, 128, 256, or 512 square; 8-bit, one sample/pixel, palette indexed.
- 64 or 256 square; two 8-bit samples/pixel, palette indexed plus an extra
  unspecified sample used as an alpha/opacity plane in these assets.

Examples include 256x256 single-sample model art, 256x256 two-sample vegetation
art, and 512x512 track map images. A minimal decoder needs TIFF IFD parsing,
little-endian SHORT/LONG values, uncompressed strips, ColorMap conversion from
16-bit channels, PlanarConfiguration 1, and the second sample as alpha. Reject or
diagnose unsupported compression/planar forms rather than silently producing bad
textures.

Community notes describe Evo 2 TIFF as carrying opacity information. The samples
show exactly how the relevant track art does this; avoid generalizing that every
TIFF in the game has two samples.

### VEG v6: Evo 2 vegetation

VEG is line-oriented text and appears only in the inspected Evo 2 tracks. It
contains:

- version (`6`) and maximum tree count;
- four tree model names and a tree texture;
- density/minimum-distance settings;
- four tree size/bias triplets;
- tree interaction flag (gameplay can be ignored);
- grass/scrub texture, size ranges, and color parameters;
- repeated `treeGrid`, count, then `x,y,z,value` records.

The coordinates are already world coordinates. The fourth per-tree value is in
the byte range in observed files, but its exact random seed/model/color selection
semantics are **unknown**. Preserve it. A baseline renderer can deterministically
choose one of the four models from it, then refine that mapping from visual tests.
VEG should use instancing; the samples permit 5,000 or 10,000 trees.

### WAT v1 and LVL water

LVL supplies water height/tide and RGBA. Some Evo 2 tracks add a small text WAT
file with base name, two cycle speeds, two scales, and specular alpha. Render a
flat plane at native water height first. WAT-driven animated layers/specular can
follow. A zero alpha LVL water color means no visible plane even if a nominal
height exists.

## Evo 1 versus Evo 2

| Area | Evo 1 | Evo 2 | Viewer consequence |
|---|---|---|---|
| POD container | POD2 | POD2 | One new archive reader serves both |
| Terrain core | 256² 16-bit RAW/CLR/RTD/SDW, TEX v1 | Same observed core | Share terrain parser |
| LVL | v1, same observed labels | v1, same observed labels | Share label-driven Evo LVL parser |
| SIT objects | v6 sequential label/value boxes | v7 class registry + brace objects | Separate object decoders |
| Models | SMF v4 | SMF v4 | One parser; retain normals/material metadata |
| Indexed images | RAW + ACT + OPA | RAW + ACT + OPA | Share decoder |
| TIFF | Not present in inspected Evo 1 stock samples | Common for model/vegetation/map art | Evo 2 decoder requirement |
| Vegetation | No VEG in inspected stock samples | VEG v6 | Evo 2 instanced vegetation pass |
| Renderer vertex | XYZ/BGRA/UV | XYZ/normal/UV, optional basis stream | Evo 2 lighting/material fidelity |
| Effects | Older pre-lit fixed-function path | detail/decal/bump/cube/gloss/projected shadow paths | Stage fidelity after baseline |

The format boundary is not absolute for community content: custom tracks may mix
assets from different tools or omit optional files. Detect capabilities per file,
while using SIT version to select the scene parser.

## Downloadable LTE tracks versus complete POD tracks

### What is verified

The public Evo 1 LTE catalog contains standalone files, and four inspected downloads
were approximately 52-71 KB. They share the initial bytes
`32 2a 44 11 60 04 45 ...`, contain no useful cleartext manifest or filenames, are
not ZIP/gzip/tar/POD, and end in dense bit-oriented data. The exact format signature,
field table, compression, and checksums remain unknown.

Community Dreamcast documentation explains the design pressure: downloadable tracks
were stored on the VMU, while an uncompressed 256x256 16-bit heightmap alone is
128 KB. It also distinguishes this workflow from full custom POD tracks, which the
Dreamcast cannot use without modifying the disc/install. That is consistent with
the observed LTE sizes and binary packing.

### What is strongly inferred

LTE is a compact track delta/state package intended to reuse art/models already
installed with the game, whereas a complete POD carries its own LVL/SIT, terrain
grids, texture tables, models, palettes, opacity maps, and other assets. An LTE
decoder will therefore need an installed/base-asset catalog or a deliberate set of
viewer substitutes after it reconstructs the terrain and placements. A standalone
LTE cannot be expected to provide the same custom-art freedom as a POD.

### What must not be assumed yet

Do not assume LTE is compressed POD2, compressed RAW+CLR, an embedded SIT, or the
`.LTE` field seen in JSTrackViewer's older MTM/TV-family LVL parsing. The sampled
files do not expose those structures, and neither `4x4e` repository supplies the
decoder. The shared header may be a magic value, serialized object preamble, or
codec state; its meaning is not established.

LTE support should begin with a corpus and differential analysis:

1. obtain matching LTE exports whose source editor settings are known;
2. change exactly one property at a time (one height, one texture cell, display
   name, course point, object placement) and compare the binaries;
3. locate the Evo 1 Build 57 import/decompression routine through runtime tracing
   or disassembly and document its bit reader;
4. write a standalone decoder with golden JSON/grid outputs;
5. define how stock asset identifiers resolve when the user has not supplied game
   data.

Until those steps are complete, LTE support is a research blocker, not a normal
parser implementation task.

## JSTrackViewer gap analysis

### Current strengths worth reusing

- Worker-based loading and transferable terrain buffers.
- Case-insensitive archive lookup with `DATA`, `ART`, and `MODELS` fallbacks.
- 256² terrain mesh generation, atlas packing, normals, and 16-bit CLR
  index/mirror/rotation support.
- Square RAW image and ACT palette decoding.
- Normalized TrackDoc/scene separation, water plane, course camera positioning,
  model hydration, and diagnostics/statistics.

### Current hard failures

1. **POD2 is rejected.** `src/worker/pod-format.js` starts by interpreting byte 0
   as a POD1 item count. For `POD2`, that integer is nonsensical and indexing stops.
2. **SIT header is misread.** `src/worker/sit-parser.js` treats line 0 as the LVL
   path; Evo line 0 is `version` and the actual LVL is line 2.
3. **LVL fields are shifted/incompatible.** The existing parser expects an ACT
   field and an older fixed-position schema. Evo LVL is a label-bearing manifest
   with per-texture palettes.
4. **SIT placements are incompatible.** Evo 1 uses `wPos/wOrient`; Evo 2 v7 uses
   typed braces. The current parser expects MTM-style `ipos/theta,phi,psi` blocks.
5. **Scale is wrong.** Terrain builder fixes cells at 64 and truncates 16-bit height
   with `>>> 6`; Evo evidence supports cell 32 and height `/32` in native units.
6. **Models are missing.** The viewer decodes BIN, not text SMF v4.
7. **Texture association is incomplete.** Evo needs palette per RAW and optional
   same-stem OPA alpha; there is no single LVL ACT.
8. **TIFF is missing.** Evo 2 indexed/alpha TIFF cannot use the existing PNG/TGA
   path.
9. **SDW, VEG, and Evo lighting/material state are not represented.** Baseline
   rendering will lack baked shadow overlays, vegetation, and advanced effects.
10. **Standalone LTE is not accepted or decoded.** The file input permits only
    `.pod,.zip`; the loader also extracts only the first POD from ZIP.

The current code may store a legacy LVL-referenced `.LTE` blob, but never decodes
or renders it. That is not partial support for the standalone Evo LTE format.

## Recommended implementation plan

### Phase 0 — fixtures and format boundaries

- Add legally redistributable/minimal synthetic fixtures for POD2, Evo LVL/TEX,
  SIT v6, SIT v7, SMF v4, OPA, TIFF, VEG, SDW, and malformed variants.
- Add format detection before parsing: POD2 magic, SIT version, SMF magic/version,
  TIFF byte order/magic.
- Add structured warnings for preserved unknown fields.

Acceptance: the indexer inventories the four representative packages with the
same counts shown above, without extracting them to disk.

### Phase 1 — POD2 and discovery

- Port the POD2 index logic from JSPod/JPod into `src/worker/pod-format.js`.
- Preserve timestamp/CRC metadata; validate offsets, lengths, name-table bounds,
  NUL termination, duplicate normalized paths, and a reasonable count.
- Search SIT first and identify Evo by its `version` header. Do not route an Evo
  SIT into the MTM parser.

Acceptance: Evo track names appear in the chooser and their LVL assets resolve.

### Phase 2 — native terrain

- Add `parseEvoLvl()` and `parseEvoTex()`.
- Make terrain `cellSize`, `heightDivisor`, and presentation transform explicit.
- Decode 16-bit RAW without losing fractional bits; decode 16-bit CLR.
- Decode every ordinary TEX slot with its own RAW/ACT association and OPA alpha.
- Render sky, LVL light vector, water height/color, and detail texture at a basic
  fidelity level. Preserve RTD and SDW for later passes.

Acceptance: terrain dimensions, elevation at golden coordinates, tile indices,
and water height match fixtures; Evo 1/Evo 2 terrain is recognizable.

### Phase 3 — Evo 1 complete POD

- Parse SIT v6 `wPos/wOrient/model` records and course lines.
- Implement SMF v4 multi-group mesh/material decoding with bounds/count checks.
- Resolve RAW/ACT/OPA model materials and map visible box types to scene policies.
- Ignore physics fields explicitly, not by losing record synchronization.

Acceptance: Jyard/ZONA-like tracks render terrain and static models at correct
native positions, scale, and orientation with opaque/alpha materials.

### Phase 4 — Evo 2 complete POD

- Parse SIT v7 registry and brace instances using per-class schema adapters plus a
  safe common-prefix fallback.
- Add minimal indexed TIFF/alpha decoding.
- Parse VEG v6 and render trees/ground vegetation through instancing.
- Add SDW overlay, WAT animation, billboards, directional lighting, and then
  detail/decal/gloss/bump/cubemap features in descending visual impact.

Acceptance: an Evo 2 track renders all static scene classes without parser
desynchronization, with TIFF alpha and stable vegetation placement.

### Phase 5 — LTE research and implementation

Keep this behind a separate input type and feature flag until the codec is known.
Do not let LTE experiments complicate POD2/SIT/LVL code. Its output should be the
same normalized TrackDoc plus a list of unresolved stock dependencies.

Acceptance must use golden files with known editor inputs, not only “looks plausible.”

## Suggested normalized data additions

Avoid naming unresolved source fields prematurely. A minimal extension could be:

```js
track.source = { family: "EVO", game: 1 | 2, container: "POD2" | "LTE", sitVersion };
track.terrain = {
  gridSize: 256,
  cellSize: 32,
  heightEncoding: "u16le-fixed",
  heightDivisor: 32,
  rawData,
  clrData,
  shadowData,       // SDW, optional
  auxiliaryRtdData // opaque until understood
};
track.environment = {
  skyTexture,
  detailTexture,
  water: { height, tideHeight, tidePeriod, color, material },
  lightVector
};
track.materials = [{ name, source, paletteSource, opacitySource, param0, param1 }];
track.instances = [{ sourceClass, schemaVersion, modelName, position, orientation,
                     size, parent, billboard, castShadow, sourceFields }];
track.vegetation = { version, models, textures, settings, grids };
```

Coordinate conversion belongs at the parser/normalization boundary. The renderer
should not need to infer that an Evo position differs from an MTM `ipos` position.

## Tests that will prevent plausible-looking errors

- POD2 offset/name-table bounds, duplicate paths, CRC opt-in, truncated records.
- SIT v6 and v7 parser synchronization with an unknown field/class inserted.
- Golden terrain elevations including raw values whose low five bits are nonzero.
- Golden CLR cells for each mirror/rotation combination.
- TEX ordinary/shadow split and missing palette/texture placeholders without index
  collapse.
- RAW/ACT/OPA orientation and alpha-gradient tests.
- TIFF one-sample palette and two-sample palette+alpha tests at multiple strip sizes.
- SMF multi-material, multiple mesh, transparent material, missing texture, and bad
  count/index tests.
- Object/terrain landmark test proving the same Z transform is applied once.
- SDW `0x8000`, `0x4000`, and ordinary appended-index behavior.
- VEG deterministic instance count and placement test.
- Cross-game regression: existing MTM/CPR/POD1 tracks must still select their old
  parsers and preserve their current scale.

## Open questions, in priority order

1. What is the LTE bitstream/header/compression schema?
2. What do TEX `param0` and `param1` mean for rendering and surface metadata?
3. What exactly does RTD encode, and does it affect a static view?
4. What is SDW `0x4000`, and how are any orientation flags packed?
5. What do the first three SMF material scalars and the fourth object-info integer
   mean, and which complete set of object names participates in v4 LOD switching?
6. How does SIT v7's common prefix vary across all 15 class/schema combinations?
7. How does the VEG record byte choose tree variant, tint, or scale?
8. Which Evo 2 shader/material combinations materially affect track assets, and
   how are they selected from SMF/TEX metadata?

These questions should remain visible in code and fixtures. The first blocks LTE;
questions 2-8 do not block a useful complete-POD preview.

## Evidence and references

### Local source

- `/Users/juanpabloutreras/dev/4x4e/README.MD`
- `/Users/juanpabloutreras/dev/4x4e/Source/TRX/Renderers.Basic.Vertexes.hxx`
- `/Users/juanpabloutreras/dev/4x4e/Source/TRX/Renderers.Modules.Export.hxx`
- `/Users/juanpabloutreras/dev/4x4e2/README.MD`
- `/Users/juanpabloutreras/dev/4x4e2/Source/TRX/Renderers.Basic.Vertexes.hxx`
- `/Users/juanpabloutreras/dev/4x4e2/Source/TRX/Renderers.Modules.Export.hxx`
- `/Users/juanpabloutreras/dev/4x4e2/Source/R.DirectX.8.0.TL/Assets/`
- `/Users/juanpabloutreras/dev/JSTrackViewer/src/worker/`
- `/Users/juanpabloutreras/dev/JPod/docs/POD_FORMAT.md`
- `/Users/juanpabloutreras/dev/JSPod/src/worker/pod-format.js`

Representative samples were inspected in `/private/tmp` and are intentionally not
added to the repository. Evo 1 samples came from the public 4x4 Evolution test/demo
installer; Evo 2 and LTE samples came from the community track archive. Reproduce
the analysis from sources with appropriate redistribution rights before turning a
sample into a committed test fixture.

### Public references

- 4x4 Evolution Revival Project, file formats:
  <https://www.4x4evolution.net/doku.php?id=file_formats>
- Evo 1 downloadable LTE track catalog:
  <https://www.4x4evolution.net/doku.php?id=4x4_evolution_lte_tracks>
- Evo 1 full track catalog:
  <https://www.4x4evolution.net/doku.php?id=4x4_evolution_tracks>
- Evo 2 track catalog:
  <https://www.4x4evolution.net/doku.php?id=4x4_evolution_2_-_tracks>
- Dreamcast/VMU limitations:
  <https://www.4x4evolution.net/doku.php?id=4x4_evolution_-_dreamcast>
- `podextract`, independent POD1-versus-POD2 format evidence:
  <https://github.com/foone/podextract>
- Dummiesman's SMFImportExport is a useful next source for completing the SMF
  grammar; its documented importer handles RAW/ACT/OPA, model detail switching,
  transparency/specular settings, and Evo 2 v1 bump-mapped materials:
  <https://github.com/Dummiesman/SMFImportExport>

SMFImportExport's Python files declare CC BY-NC-SA 3.0. Treat it as format evidence
and attribution-worthy research material; do not copy its implementation into
JSTrackViewer without first confirming license compatibility. A fresh JavaScript
parser based on the grammar and independently observed fixtures is straightforward.
