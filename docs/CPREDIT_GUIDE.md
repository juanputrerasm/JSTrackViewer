# CPREdit Quick Guide

A working reference for `CPREDIT.EXE`, the "Demented(R) Track Editor(TM)" shipped for
CART Precision Racing. Distilled from Arne Martin Klemetsrud's 1998 editing guide
(archived at `web.archive.org/web/19990209012952/http://cart.gamestats.com/tracks/editing/`)
plus the menu and key strings recovered from `CPREDIT.EXE` itself.

Two things to know before anything else:

1. The editor is unforgiving about filenames. **Always type the extension** when it asks for
   a file, except when cloning a track, where it wants a bare name. A wrong name crashes the
   editor and you lose everything since your last save.
2. Save often, with option `5` in the track editor, and **always with the `.trk` extension**.

---

## 1. Keyboard notes for a Latin American layout

### The short version

CPREdit binds both `+` / `-` (zoom) **and** keypad `+` / `-` (tilt) as separate actions. A
program can only tell those apart by reading raw scancodes, not characters. That means
CPREdit almost certainly keys off **physical US positions** and ignores whatever your
Windows layout prints on the keycap.

So the first thing to try is: just press the key that **sits where the US key would be**,
and ignore the legend. If that does not work, set the Windows input language to
**English (US)** before launching CPREdit and the problem disappears either way.

### Physical position map, Latin American to US

| Editor wants | Press the key labelled | Where it is |
|---|---|---|
| `` ` `` (cycle courses) | `\|` `°` `¬` | far left of the number row, left of `1` |
| `-` (zoom out) | `'` `?` `\` | right of `0` |
| `+` (zoom in) | `¿` `¡` | right of the above, last key on the number row |
| `[` (previous texture / object) | `´` `¨` | right of `P` |
| `]` (next texture / object) | `+` `*` `~` | right of the above |
| `,` (previous segment) | `,` `;` | right of `M`, same position as US |
| `.` (next segment) | `.` `:` | two right of `M`, same position as US |

`SHIFT + ,` and `SHIFT + .` (previous / next section) use those same two keys.

Everything else the editor uses is a letter, a cursor key, a function key or
`INS` / `DEL` / `END` / `PGDN`, and those are identical on both layouts.

### If your K619 has no numeric keypad

`keypad +` and `keypad -` are the camera tilt controls in the track editor, and they are
genuinely a different binding from the main row `+` / `-`. On a tenkeyless board there is no
way to send them from the board itself. Options:

- Plug in a cheap external numpad. This is the least painful fix.
- Remap two spare keys to `NumpadAdd` and `NumpadSub` with AutoHotkey:

  ```ahk
  ; while CPREDIT is focused, map F11/F12 to numpad plus/minus
  #IfWinActive ahk_exe CPREDIT.EXE
  F11::Send {NumpadAdd}
  F12::Send {NumpadSub}
  #IfWinActive
  ```

  Note this only helps if CPREdit reads through the Windows message queue. If it reads
  scancodes directly, use an external numpad or a firmware level remap instead.
- Or skip tilt entirely. You can reach most viewing angles with `INS` / `DEL` (pan) and
  `+` / `-` (zoom), and the four saved views in the ground editor.

### AutoHotkey shim for the bracket keys

If you would rather not switch layouts, this remaps the two keys right of `P` while CPREdit
is focused:

```ahk
#IfWinActive ahk_exe CPREDIT.EXE
SC01A::Send {[}     ; key right of P
SC01B::Send {]}     ; key right of that
SC029::Send {`}     ; key left of 1
#IfWinActive
```

---

## 2. Getting a track open

CPREdit cannot start from nothing. You always clone an existing track.

1. Put `CPREDIT.EXE` in the main CPR directory, next to `CART.EXE` and the `.POD` files.
2. Start the editor, go into the **file manager**.
3. Option `2`, extract a POD. Type the full name with extension, for example `laguna.pod`.
4. First time only: also extract `vehicle\lagpace.car` and `vehicle\pacwest.car` from
   `racecar.pod`. Skip this and the ground editor fails with `Unable to build truck list!`.
5. Option `a`, clone. Type the source sit file **with** extension, for example `laguna.sit`.
   This is the one prompt where the new name is entered **without** an extension.
6. Now you can enter the track editor or the ground editor. Both ask for a sit file, and
   both want the extension.

To get back out to the game: option `b` builds a POD, then edit a `.rce` file in `races\`,
add your race to the bottom of `races\drivers.txt`, and add your POD to `pod.ini` while
bumping the count on the first line. `pod.ini` holds a maximum of 30 entries.

---

## 3. Track editor

Menu as it appears on screen:

```
1. Create a new track                A. Edit track textures
2. Edit current track control points  B. Edit track mesh points
3. Add grade/alt/pit/curb information C. Edit wall types & textures
4. Load track                        D. Autoset track type
5. Save track                        E. Level out runoff areas
6. Recreate track                    F. Reverse track
7. Slice max size                    G. Smooth height/gradient
8. Match ground alt                  H. Smooth all
                                     I. Smooth some
                                     J. Tree me
                                     L. Fix mid ohio
                                     P. Pi editor
```

`D. Autoset track type` prompts `4 = road, 5 = speedway, 6 = short oval, 7 = street`.
This drives AI behaviour.

### View controls, shared by every track editor mode

| Key | Action |
|---|---|
| `INS` | pan left |
| `DEL` | pan right |
| keypad `+` | tilt down |
| keypad `-` | tilt up |
| `+` | zoom in |
| `-` | zoom out |
| `F1` | toggle grid |
| `F2` | toggle objects |
| `F3` | toggle horizon |
| `ESC` | leave the current mode |

### Option 1, create a new track

Needs a 1024x756 greyscale `.raw` track map in `art\`. Enter its name with the `.raw`
extension when asked for a background image, then click your way around the track in the
direction the cars travel. Two points per straight, as many as you can fit through corners.
`x` deletes the last point. `ESC` when done, then enter the track length.

Point orientation cannot be changed later, so do not let a corner "turn the wrong way".

### Option 2, edit control points

| Key | Action |
|---|---|
| `.` / `,` | next / previous segment |
| arrow keys | move the current segment point |
| `n` | insert a new segment point after the current one |
| `d` | delete the current segment point |

The top left of the screen shows the current segment coordinates as
`across, height, along`, all in feet. Useful for laying out constant radius oval corners
from real data.

New points inherit the orientation of the point before them. Run option `6` and answer yes
to "reset point offset" to make the editor reorient every segment to its new position.

### Option 3, grade, altitude, pit and curb

| Key | Action |
|---|---|
| `.` / `,` | next / previous segment |
| `L` / `R` | select left or right side |
| `SPACE` | set an altitude control point |
| `W` | set a width control point |
| `G` | set a banking control point, in degrees, negative banks right |
| `C` | add a curb to the selected side |
| `F` or `J` | double the track width, for a pit lane against the track |
| `P` | double the width **plus** a centre section, for a pit lane set apart |

Values interpolate linearly between control points. Enter `0` to delete a control point,
which is why a true zero degree banking has to be entered as `0.1`.

Set a base altitude on segment 1 before anything else. 500 feet is a sensible floor. Any
part of the track ending up below zero causes problems, and banking lowers one side.

Nothing changes on screen until you run option `6` (recreate track). It asks four questions:
proceed, change mesh points, interpolate altitudes, reset textures. Answer no to "change
mesh points" once you have added pit lanes or curbs, otherwise they get wiped.

After changing height or banking, run option `G` (smooth height/gradient), then option `8`
(match ground alt). Option `8` asks whether to reset to minimum altitude, yes the first
time, and **you must press Enter after answering**. It then appears to hang for about a
minute before a counter appears in the top left.

### Option A, track textures

| Key | Action |
|---|---|
| `.` / `,` | next / previous segment |
| `SHIFT` + `.` / `,` | next / previous section |
| `]` / `[` | next / previous texture |
| `SPACE` | apply the texture to the current section |
| `x` | remove the texture from the current section |
| `t` | cycle the surface type |
| `m` | mark, to apply across a run of segments |

Surface types cycle through `Road`, `Curb`, `Grass`, `Dirt`, `Rocks`. The type belongs to
the **texture**, not the section, so setting it once applies everywhere that texture is used.

Mark and fill: press `m` on the first segment, move to the last with `.` or `,`, then press
`SPACE` once to texture the whole run.

The engine applies no shadow to the track surface. Shadows under bridges and grandstands
have to be baked as darker texture variants. Vancouver ships roughly half a megabyte of
shadow textures for this reason.

### Option C, walls

| Key | Action |
|---|---|
| `.` / `,` | next / previous segment |
| `SHIFT` + `.` / `,` | next / previous section |
| `]` / `[` | next / previous texture |
| `SPACE` | apply the texture |
| `1` | Short wall |
| `2` | Tall wall |
| `3` | Short wall with catch fencing |
| `4` | Very tall |
| `5` | Wall-catch-wall |
| `6` | Wall med |
| `7` | Tree |
| `x` | delete the wall (the texture stays assigned) |
| `w` | change which part of the wall you are texturing |
| `r` | rotate through the 4 sub textures in the RAW |
| `m` | mark, to apply across a run |
| `CTRL` + `SPACE` | pick up the texture on the current wall |

Two things that are easy to miss:

- Every wall texture RAW is 256x256 and holds **four** 256x64 panels stacked vertically.
  `r` picks which one. `LG4SIGN1.RAW` at Laguna holds concrete, a tyre wall, a TOYOTA
  banner and a "WE CARE" roundel.
- Walls taller than `Short wall` have several parts stacked vertically, each with its own
  texture. `w` moves between them. The catch fencing in types `3` and `5` is not one of
  those textures, it is drawn from the global `art\catch3d.raw`.

Do not stack several walls in the same place. The editor throws
`CRaceTrack::makeWallList - too many walls!` and the game can crash. Trees are the one
exception.

### Option B, mesh points

Mesh points are the intersections of segment lines and section lines. This is where the
detail work happens.

| Key | Action |
|---|---|
| `.` / `,` | next / previous segment |
| `SHIFT` + `.` / `,` | next / previous section |
| left / right arrows | move the point inward or outward |
| `q` / `a` | move the point up or down |
| `SPACE` | type an exact height |
| `p` | copy the offsets from the previous segment |
| `n` | copy the offsets from the next segment |

Use it for pit lane entry and exit blending, gravel trap and run off shapes, curb size,
bumps, and service roads. `p` and `n` make repeating a profile along a straight quick.

### Smoothing

Option `G` smooths height and gradient, but there is a bug: it does not take effect until
each segment is touched. The usual workaround is to open the mesh editor and nudge one
unused section point on every segment you want smoothed.

Smoothing works better when segments are evenly spaced and close together. Option `E`
levels out run off areas, which is what you want on an oval where the infield should stay
flat while the racing surface is banked.

---

## 4. Ground editor

Menu as it appears on screen:

```
A. Edit Level Details        H. Place Boxes
B. Texture Map Editor        I. Move/Edit/Delete Boxes
C. Altitude Map Editor       J. Place race cars
D. Ground Light Editor       K. Move/Edit/Delete race cars
E. Course Editor             N. Edit Texture Animation
```

`A. Edit Level Details` exposes description, altitude map, colour map, palette, texture
list, sky texture and palette, background music, fog colour, light source vector, animation
file and ambient light.

The altitude scale in the ground editor is **not** the same scale as the track editor.

### View controls, shared by every ground editor mode

| Key | Action |
|---|---|
| `E` | toggle whether the cursor keys move the camera or the selection |
| `+` / `-` | zoom in / out |
| `F1`..`F4` | recall saved view 1 to 4 |
| `SHIFT` + `F1`..`F4` | save the current view into slot 1 to 4 |
| `R` | rotate view clockwise |
| `SHIFT` + `R` | rotate view counter clockwise |
| `D` | toggle the grid |
| `J` | jump to a typed coordinate |
| `ESC` | leave the current mode |

Cursor key movement speed: `SHIFT` for faster, `ALT` for finer. This applies everywhere in
the ground editor and is the single most useful habit to build.

### C, altitude map

The terrain is a 256x256 grid.

| Key | Action |
|---|---|
| `[` / `]` | lower / raise the selection |
| `SHIFT` + `[` / `]` | lower / raise faster |
| `SPACE` | type an exact altitude |
| `F6` | grow the selection area, up to 11x11 |
| `F7` | grow the selection length |
| `F8` | grow the selection width |
| `SHIFT` + `F6`..`F8` | shrink instead |
| `F9` / `F10` | copy / paste the selected area |

Run `8. Match ground alt` in the track editor **before** touching the terrain, and never
raise the terrain that sits directly under the track or it will poke through the surface.
If you do it by accident, run `Match ground alt` again to reset it.

### B, texture map

Same movement, selection and copy or paste keys as the altitude map.

| Key | Action |
|---|---|
| `[` / `]` | cycle textures |
| `SHIFT` + `[` / `]` | cycle faster |
| `SPACE` | place the texture |
| `SHIFT` + `SPACE` | pick up the texture under the cursor |
| `X` | flip the texture axis |

There is no rotate, only flip.

### H and I, objects

Placing (`H`):

| Key | Action |
|---|---|
| `F` | choose the model to place |
| arrows | move it |
| `END` / `PGDN` | rotate |
| `1` / `2` | longer / shorter |
| `3` / `4` | wider / narrower |
| `5` / `6` | taller / shorter |
| `SPACE` | place it |

Editing (`I`):

| Key | Action |
|---|---|
| `[` / `]` | cycle through placed objects |
| arrows | move |
| `END` / `PGDN` | rotate |
| `X` | delete |
| `B` | box properties |

`B` opens Box Settings with priority, type and flags. Setting the type to tree makes the
object always face the camera, which is what you want for trees and for spectators.

There is a known bug where `SPACE` silently refuses to place anything. The fallback is to
add the entry by hand in the `.sit` file with a text editor and bump the model count.

### Checkpoints

Every track needs at least 4 checkpoints, usually 6 or 7. One is start and finish, one is
speed limit start, one is pit lane start, one is speed limit end, the rest are ordinary.

The workflow is to open the **original** track first, note the box numbers of its
checkpoints and where they sit, then reopen your clone and move the matching boxes into
place with the arrow keys. Rotate with `END` and `PGDN` so the arrows point in the
direction of travel. Do not create new ones.

### E, course editor

| Key | Action |
|---|---|
| `` ` `` | cycle through courses 0 to 4 |
| `[` / `]` | cycle through course points |
| arrows | move the current point |
| `SPACE` | place a new course point |
| `N` | add a course point |
| `X` | delete a course point |

The five courses:

| Course | Purpose |
|---|---|
| 0, 1, 2 | AI racing lines, a full lap each |
| 3 | pit entry and exit road, still a full lap, on the right of pit row |
| 4 | pit row only, not a lap, on the left of pit row |

A course is a chain of straight white segments. The editor computes a constant radius red
curve between the end of one segment and the start of the next. **If a red curve fails to
draw, the game locks up when loading the track**, so walk the whole course with `[` and `]`
and fix any gap. A black screen on load usually means exactly this.

Because the red curves are constant radius, a corner that tightens needs several short
white segments so the editor can fit several different radii.

Practical shortcuts:

- Build course 0, then copy it into courses 1 and 2 by editing the `.sit` in a text editor.
- Deleting the lines after `VARLOW` at the bottom of the `.sit` makes the AI follow your
  lines literally. Leave them in and the AI works out its own line from a centre line, less
  accurately. The tradeoff is that cars will sometimes run wide when passing.
- Make the pit lane long enough. Exit and re-enter the ground editor, and it will warn you
  if it is too short.

### J and K, race cars

Use `pacwest.car` for cars 0 to 35 and `lagpace.car` for car 36, the pace car. Place the
pace car first, then the field two abreast with a little room between rows. The grid
reorders itself at the start of the pace lap regardless of the order you place them in.

Move the existing cars rather than deleting and placing new ones. Deleting them tends to
break the track.

---

## 5. File types and where they live

| Extension | Directory | Holds | Editable how |
|---|---|---|---|
| `.pod` | CPR root | everything, packed | editor file manager only |
| `.sit` | `world\` | situation, references every other file | text editor, and often the fastest route |
| `.trk` | `data\` | the track shape, everything from the track editor | track editor only |
| `.ttx` | `data\` | track texture list, `NAME.RAW,surfaceType` | text editor |
| `.tex` | `data\` | terrain texture list | text editor |
| `.raw` + `.act` | `art\` | textures and their palettes | CPRToolbox to and from BMP |
| `.bin` | `models\` | objects | BinEdit |
| `.rce` | `races\` | race setup, laps, which `.sit` to load | text editor |
| `drivers.txt` | `races\` | the race list shown in game | text editor |

`EDITOR.INI` in the CPR root persists the four saved camera views, grid options, the last
edit location, map scale and rotation step. It is plain text and safe to edit by hand.

---

## 6. Things that will bite you

- Typing a filename without its extension crashes the editor. The clone prompt is the only
  exception.
- `Recreate track` resets curbs and pit lanes. Do that work last.
- A missing red curve in any course locks the game on load.
- Stacked walls in the same section throw `too many walls!` and can crash the game.
- `Match ground alt` looks frozen for around a minute, twice. Let it finish, and remember to
  press Enter after the min altitude prompt.
- `pod.ini` tops out at 30 entries and the count on line 1 has to match.
- Always build a POD before deleting the loose files in `art\` and `models\`. Without one,
  the track is effectively lost.

---

## 7. Credits

The workflow, the key lists and nearly all of the practical advice come from Arne Martin
Klemetsrud's CPR editing guide, written in 1998 and preserved by the Internet Archive.
Menu text, wall type names, surface type names and the cross section slot names were
recovered from `CPREDIT.EXE` for this document.
