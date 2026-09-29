# JSTrackViewer

[![JavaScript](https://img.shields.io/badge/JavaScript-ES%20modules-F7DF1E?logo=javascript&logoColor=000)](https://developer.mozilla.org/docs/Web/JavaScript)
[![Three.js](https://img.shields.io/badge/Three.js-r169-000?logo=threedotjs)](https://threejs.org/)
[![Platform](https://img.shields.io/badge/platform-web-blue)](https://developer.mozilla.org/docs/Web)
[![GitHub Pages](https://img.shields.io/badge/demo-GitHub%20Pages-222?logo=github)](https://juanputrerasm.github.io/JSTrackViewer/)
[![License](https://img.shields.io/badge/license-Apache%202.0-green)](LICENSE)

**A browser-based 3D track viewer for classic Terminal Reality games.**

JSTrackViewer opens POD and ZIP archives from disk or URL and renders their terrain, textures, objects, courses, ground boxes, water, backdrops, and game-specific track data in Three.js. It supports tracks from **Monster Truck Madness**, **Monster Truck Madness 2**, **Terminal Velocity**, **Fury3/F-Zone**, **Hellbender**, **CART Precision Racing**, **4x4 Evolution**, and **4x4 Evolution 2**. Archive processing happens locally in the browser.

**Live application:** [Open JSTrackViewer on GitHub Pages](https://juanputrerasm.github.io/JSTrackViewer/)

![JSTrackViewer displaying the Voodoo Island track from Monster Truck Madness 2](docs/screenshot.jpg)

---

## Features

- **POD and ZIP loading**: open a local archive or fetch one from a URL.
- **Multi-track archives**: an archive with more than one `.SIT` or `.LVL` track opens a track chooser over the viewport, and the top bar picker switches between them without reopening the archive. A ZIP holding several PODs offers every track of every POD, grouped by POD.
- **Broad game support**: inspect MTM/MTM2, Terminal Velocity/Fury3, Hellbender, CART Precision Racing, and 4x4 Evolution 1/2 track formats.
- **Modern MTM2 (Community Patch 3) support**: read `.SI2` track scripts, long BIN texture names, material records, and PNG/TGA textures.
- **Detailed track rendering**: display terrain, textures, models, courses, checkpoints, ramps, ground boxes, collision boxes, trucks, water, and backdrops. Tracks that name more than one background model show all of them. The Backdrop toggle hides that scenery and keeps the sky.
- **Route markers**: numbered checkpoint markers for MTM, MTM2, CART Precision Racing and 4x4 Evolution 1/2, plus the navigation point, tunnel and powerup markers for Terminal Velocity, Fury3 and Hellbender. CART Precision Racing checkpoints are labelled by purpose (pit entry, pit speed limit start and end, start/finish, then the lap's gates), and its five courses are drawn in their own colours and named: three AI racing lines, the pit road lap and pit row. MTM, MTM2 and 4x4 Evolution 1/2 tracks show every course too: the main course and each of the AI lines the computer trucks follow. Each course has its own checkbox under Markers, labelled and coloured to match its line, and a Style choice draws them three ways: Smooth, with the joins rounded off along the road the way a truck turns and the corners 4x4 Evolution leaves out put back; Joined, the runs as stored joined straight; or Traxx, as Traxx and JTraxx show a course, each segment on its own and numbered at its start. A 4x4 Evolution rally is a one-way run, so its course ends at the finish instead of closing back to the start. 4x4 Evolution stores only the straight runs of a course, so the corners and hairpin legs between them are drawn back in along the roads. When a 4x4 Evolution track ships its computer drivers' recorded laps (`AI\CLASSn\AI_*.TXT`), each distinct lap is shown as its own AI line course, and course runs listed after the lap that no driver uses are left out of the main course. Monster Truck Madness 1 checkpoint banners are drawn like the rest of the scenery; only the closing `CKBOX.BIN` trigger, as in MTM2, waits behind the Checkpoints toggle.
- **Terminal Velocity and Fury3 level data**: objects stand where the game puts them, at their exact position within a terrain square and on the ground under them, and are drawn at the size the game draws them, in their true proportions and turned about their own origin. Scale and placement were checked and every object's own hit radius. Powerups are named (Laser, Shield Restore, AfterBurner and so on), and the bunkers and other objects that always drop one are marked too, which is where most of a level's powerups are.
- **Terminal Velocity, Fury3 and Hellbender sky and fog**: the sky is the game's flat textured ceiling above the world, not a dome, recoloured for each level through its sky palette the way the engine does it, or a star field on space levels. Fog fades the world into each level's horizon colour and follows the view Distance slider, so the short visibility of these games can be dialled in. Sky and Fog have their own toggles under View Options, in place of Backdrop.
- **Hellbender level data**: the underground cavern layer with its own terrain, ground boxes and objects, plus navigation points with their objective text, animated textures, tunnels, powerups, and the per-world planet and mission names.
- **CPR racetrack layers**: render `.TRK` and `.TTX` road surfaces, walls, textures, and wireframe overlays, following the game's own rules: closed circuits are joined across the start/finish line, the layer stops at its walls, and the road is always drawn over the terrain, never under ground poking through it. In Test Drive the road carries the truck and the walls stop it.
- **Sun position**: every game states where its sun is, and the viewer reads it, names the compass point, and lets you move it. MTM, MTM2, CART Precision Racing, Terminal Velocity, Fury3 and Hellbender store it as a fixed-point vector on `.LVL` line 17; 4x4 Evolution stores the same thing as `lightSourceVector`.
- **Sun shadows**: objects, vegetation and the driven truck cast shadows onto the terrain and the road surface, out to the full view distance. Cascaded shadow maps keep them sharp close to the camera and coarser far away, and are only redrawn when the camera has moved far enough to need it, never just for looking around. Trees, including 4x4 Evolution vegetation, cast shadows, and the Test Drive truck is shaded by them. Sun light and its shadows are separate toggles, so the lighting can stay while the shadows go.
- **Weather**: Monster Truck Madness 1 and 2, CART Precision Racing and 4x4 Evolution 1/2 tracks get a sky and a Weather choice under View Options: Clear, Cloudy, Dusk or Night. Each has its own sky and light; Cloudy greys the backdrop scenery, Dusk and Night darken it, and at Night the moon casts faint shadows. The choice is remembered between tracks.
- **Sky style**: beside the weather, choose the weather's textured sky or the plain Gradient sky MTM1 and MTM2 draw with their textured sky switched off. Monster Truck Madness 1 tracks also offer Classic: the game's own flat sky from the level's `.LVL` (`ALIENSKY.RAW` with `EARTHSKY.ACT`, or `NEWSKY.RAW` with `SUNSET.ACT`), recoloured the way Terminal Velocity recolours its sky and kept at a fixed height above the camera so it can never be reached, with the horizon haze that goes with it.
- **Animated models**: animated BINs (MTM2's oil pumpjacks, CRAZY98's dinosaur) play their keyframes, blending each frame smoothly into the next instead of jumping between them.
- **Moving objects**: MTM2 and 4x4 Evolution trains (type 10 objects and Evo 2's `CTrain`) travel along their velocity, following the terrain and ground boxes, and 4x4 Evolution 2's banked flying objects circle overhead with whatever is attached to them, such as a plane's banner. A Moving objects toggle under View Options stops them and puts them back where the track places them.
- **Truck lights in Test Drive**: MTM2 trucks carry their own lamps, drawn as JSTruckViewer draws them (flares and beam cones from the TRK and its bitmaps). The headlights and roof light bar also light the terrain and objects ahead, so the track can be driven at Dusk and Night, where they start switched on. L toggles them; brake lights come on with the brake and reverse lights in reverse.
- **Sun, moon and lens flare**: on those same tracks the sun is drawn in a Clear or Dusk sky with MTM2's own lens flare (its `SUN.TXT` layout and textures), fading as terrain or objects cover the sun; Night shows MTM2's moon instead. Lens flare has its own toggle.
- **MTM lighting and view**: Monster Truck Madness 1 and 2 terrain is drawn at the brightness its `.LTE` file bakes in, as the games draw it, and the free camera uses MTM2's field of view (its fixed 512-pixel focal length at 1280x720, about 70 degrees vertically).
- **Texture presentation**: switch between smooth and sharp (pixelated) filtering, and toggle the two-pixel tile crop that the older games relied on, to compare it against the full tile.
- **Interactive navigation**: fly through the level, adjust the camera, and jump to a location by clicking the minimap.
- **Inspection controls**: use separate Markers and View Options panels to toggle scene helpers, layers, and object shadows, and adjust view distance, sunlight, and gamma. Sidebar panels collapse from their headings. Controls and track data fields appear only where the loaded track has that content.
- **Test Drive**: put a Monster Truck Madness truck on the track and drive it, with two chase cameras, a cockpit view and a free orbit, a live speed, gear and engine readout, lap timing on tracks that have checkpoints, and an optional hitbox overlay. MTM1 and MTM2 Top Crush cars flatten gradually under the truck, as the game morphs their two-frame cab. See [Test Drive](#test-drive).
- **Track diagnostics**: review metadata and statistics for textures, objects, courses, ground boxes, and CPR surface and wall types.
- **Client-side operation**: archives and extracted assets remain in temporary browser storage.

## Supported content

| Content | Support |
|---|---|
| POD1 | Original Terminal Reality archive layout with 32-byte directory name fields |
| POD2 | Indexed archive layout used by 4x4 Evolution 1 and 2 |
| ZIP | POD archives packaged in ZIP files, including ZIPs with several PODs |
| SIT | MTM, MTM2, and CART Precision Racing track definitions |
| SIT v6 / v7 | 4x4 Evolution 1 and 2 scene scripts, placements, starting grids, and course centrelines |
| LVL + DEF | Terminal Velocity/Fury3-family and Hellbender levels and object placement |
| NAV, PUP, TDF, ANI | Terminal Velocity/Fury3 navigation points, powerups, tunnel definitions, and animated textures |
| Sky RAW + sky ACT, FOG | Terminal Velocity/Fury3 and Hellbender sky ceiling, horizon colour and fog, and the `STARS.VOX` star field |
| NAV, TXT | Hellbender navigation points and mission headings |
| RA2-RA5, CL1, CL2 | Hellbender underground cavern floor, ceiling, textures, and ground boxes |
| LVL + TEX + CLR | 4x4 Evolution terrain manifest, texture table, and tile-index grid |
| TRK + TTX | CART Precision Racing road surfaces, walls, and textures |
| BIN | Static textured models and game-family scale handling |
| SMF | 4x4 Evolution static models, versions 2 to 4, including bump materials |
| VEG | 4x4 Evolution 2 vegetation, drawn with instancing |
| RAW + ACT | Legacy paletted textures with fallback palette resolution |
| RAW + ACT + OPA | 4x4 Evolution paletted textures with an 8-bit opacity plane |
| TIFF | 4x4 Evolution 2 palette-indexed art, with an optional alpha sample |
| RA0, RA1, and CL0 | Ground-box and collision data |

## Requirements

- A modern browser with JavaScript modules, Web Workers, WebGL, and Origin Private File System support
- An HTTP or HTTPS origin; the application cannot run correctly from `file://`
- Network access to the Three.js and fflate CDN modules

## Getting started

### Use the hosted application

1. Open [JSTrackViewer on GitHub Pages](https://juanputrerasm.github.io/JSTrackViewer/).
2. Choose **Open POD/ZIP from disk**, or paste an archive URL and choose **Open from URL**.
3. Select a track when the archive contains more than one supported track.
4. Use the keyboard, mouse, and view controls to explore the level.
5. Use the **Markers** and **View Options** panels to choose what is drawn. Every panel collapses from its heading, and controls appear only where the loaded track has that content.

> [!NOTE]
> Remote archives must be served over HTTP or HTTPS. Cross-origin servers must also allow the browser request through CORS.

### Run locally

Clone the repository and serve its root directory with any static HTTP server:

```bash
git clone https://github.com/juanputrerasm/JSTrackViewer.git
cd JSTrackViewer
python3 -m http.server 8080
```

Then open <http://localhost:8080/>. There is no build step and no package installation.

## Viewer controls

| Control | Action |
|---|---|
| Up / Down Arrow | Move forward / backward |
| Left / Right Arrow | Turn the camera |
| Page Up / Page Down | Pitch the camera |
| A / Z | Raise / lower the camera |
| Mouse drag | Look around |
| Mouse wheel | Move along the view direction |
| Home | Reset near course segment 0 |
| Minimap click | Move to the selected map position while preserving camera orientation |
| Minimap double-click (Test Drive) | Move the truck to the selected map position, keeping its heading |
| Speed slider (under the minimap) | Scale arrow-key and A/Z travel speed, 5% to 100%; defaults to 25% and is remembered per browser |

## Test Drive

Test Drive puts a truck on the track you are viewing and lets you drive it. The truck comes from its own archive, so a track POD and a truck POD are open at the same time.

1. Load a track as usual.
2. In the **Test Drive** panel, choose **Load truck POD** and open a Monster Truck Madness or Monster Truck Madness 2 truck archive. The **Drive** button appears once a truck archive is open.
3. Pick a truck from the list.
4. Choose **Drive**. The truck is placed at the first starting grid slot.

While driving, the panel reports speed in mph and km/h, the selected gear, whether the gearbox is automatic or manual, engine rpm, the surface under the tires and the active camera. On a track that carries checkpoints it also reports the lap number, the next checkpoint, the current lap time and your best lap; a track without checkpoints, such as a drag strip or a stadium, simply omits those rows.

**Surfaces**: Monster Truck Madness 1 and 2 give every terrain texture a ground type and a depth in the track's `.TTY` file (Default, Cement, Dirt, Water, Mud, Sand, Grass, Gravel, Ice, Snow, Metal, Wood or Rocks, as Traxx names them), and ground box tops carry the type of their top texture. The tires feel it: road and metal grip best, dirt and grass a little less, gravel and sand are loose, mud and snow drag at the truck, ice barely steers, and water slows it the faster it goes. Deeper ground drags harder. The game's own values are not known, so these are plausible readings of each type rather than measured ones.

**Show hitboxes** draws a wireframe around everything the simulation can collide with, which is the quickest way to tell an invisible wall from a rendering gap. Objects that have a model are collided against the model itself rather than an oversized authored box, so you can pull up against a tree instead of stopping several metres short of it, and tree foliage no longer stops the truck while its trunk does. Light objects with a mass, such as cones, are knocked aside. CART Precision Racing stores no masses, so its Cone and Sign objects borrow Monster Truck Madness 2's weights (the stock cones and Laguna Seca's distance markers are saved untyped and are recognised by model). Trees and other camera-facing billboards are not solid, except Monster Truck Madness 2's "Collide (facing)" objects (type 9), which turn to face the camera like the rest but keep a solid trunk.

While driving, the minimap marker turns green and follows the truck. Picking another truck from the list swaps it in where you are, keeping your speed, heading, gearbox mode and camera; **Load truck POD** is disabled until you stop, since a different archive needs a fresh start. Loading a different track parks you automatically. The truck stays loaded, so you can drop straight into the next track.

| Control | Action |
|---|---|
| Up Arrow / W | Throttle |
| Down Arrow / S | Brake and reverse |
| Left / Right Arrow, or A / D | Steer (arrows only in manual) |
| M | Toggle the manual gearbox |
| L | Toggle the truck's lights (headlights, roof light bar and beacons) |
| A / Z | Shift up / down in manual; Z from first selects reverse at a standstill, and the throttle drives it |
| Space | Handbrake |
| V | Cycle the cameras: chase near, chase far, cockpit, free orbit |
| R | Return to the starting grid |
| Mouse drag and wheel | Swing and zoom the free orbit camera |
| Gamepad | Sticks and triggers, where the browser reports one |

> [!NOTE]
> Drive mode borrows the arrow keys while it is active, so the free-flight camera stands down until you stop driving.

## Loading from URLs

Paste a POD or ZIP location into the URL field and choose **Open from URL**. The viewer accepts absolute, root-relative, and page-relative URLs, for example:

```text
https://example.com/tracks/circuit.pod
/downloads/track-pack.zip
../archives/track.pod
```

Relative paths are resolved against the viewer page, and cross-origin URLs must allow CORS. ZIP loading uses the first POD found in the archive.

## Architecture

| Component | Role |
|---|---|
| ES modules | Application controller, archive staging, navigation, and scene management |
| Module Web Worker | POD indexing, track parsing, model decoding, and terrain construction |
| OPFS | Isolated temporary archive and extracted-asset storage |
| Three.js r169 | Terrain, model, water, backdrop, lighting, and overlay rendering |
| fflate | ZIP extraction |

```text
src/
├── app.js                  User-interface controller and track-loading flow
├── scene.js                Three.js scene, terrain, objects, and overlays
├── nav.js                  Free-flight camera navigation
├── worker-client.js        Promise wrapper for the module worker
├── zip-utils.js            POD-in-ZIP extraction
├── drive/                  Test Drive: truck simulation, colliders, cameras, and input
├── shared/                 OPFS, path, palette, and CPR schema helpers
└── worker/                 POD, SIT, LVL, TRK, BIN, texture, and terrain decoders
```

## Known limitations

- Rendering is intended for inspection. Apart from Test Drive, the viewer does not emulate the games: no AI, audio, weapons, enemies, or game scripting.
- Test Drive reads Monster Truck Madness and Monster Truck Madness 2 truck archives. 4x4 Evolution trucks use a different manifest and are refused rather than misread.
- Test Drive handling is a feel-alike, not the original. Monster Truck Madness 2 keeps its mass, spring rates, gearing and tire grip in the executable rather than in track or truck files, so those values are approximated; see the [physics notes](docs/MTM2_PHYSICS_NOTES.md).
- Test Drive collides with terrain, track objects, and the CART Precision Racing road surface and walls. It does not simulate other trucks, damage, or race rules beyond checkpoint order and lap timing.
- CART Precision Racing absolute wall height is approximate.
- CART Precision Racing catch fencing falls back to a synthesized panel unless `ART/CATCH3D.RAW` is reachable, since it ships in `STARTUP.POD` rather than in a track POD.
- CART Precision Racing tree walls (`wallType` 7) are drawn as a tall textured panel, not as billboarded foliage.
- Terminal Velocity/Fury3 and Hellbender tunnels are not supported. Hellbender's underground is not a tunnel: it is part of the same level and is drawn.
- Terminal Velocity/Fury3 chambers render as the hollow in the raised plateau that the level stores. Their ceiling is generated by the game, by mirroring the chamber floor and reading each square's ceiling texture from the square ten to its right, and that generated half is not reproduced.
- Hellbender's cavern floor and ceiling textures are read in that order from `.CL1`, which is a strong reading from the shipped levels rather than a documented one; see the format analysis for the evidence.
- 4x4 Evolution `.SDW` baked shadow overlays and `.RTD` grids are read and carried but not drawn, so tracks that paint shadow tiles render without them.
- 4x4 Evolution 2 material stages beyond diffuse and alpha - bump, cubic reflection, gloss, and projected shadows - are not reproduced.
- 4x4 Evolution vegetation is grounded on the drawn terrain surface and yawed by a viewer convention, because a `.VEG` record carries no orientation and its own elevation sits below the surface; `treeBiasY` is parsed but not applied.
- 4x4 Evolution water height is read on a half-unit scale, established from the stock tracks rather than from engine source; see the format analysis for the evidence.
- Standalone downloadable 4x4 Evolution `.LTE` tracks are not supported; they are a compressed format that reuses assets the track does not carry.
- Terminal Velocity/Fury3 fog distance is not read from the game: the engine's fog colour and sky are reproduced, but how far away its fog starts was not found, so the viewer ties it to the Distance slider.
- Terminal Velocity/Fury3 powerup pickup models ship in `STARTUP.POD`, not in a level archive, so loose powerups are drawn as named markers unless the opened archive carries the models.
- Hellbender's sky is drawn by the Terminal Velocity engine's rules. Its files have the same layout.
- Animated models are not supported, and animated textures only where the level's `.ANI` file names them.
- Assets referenced by a track but absent from its POD cannot be rendered.

## Format documentation

- [4x4 Evolution 1/2 track rendering analysis](docs/4X4_EVO_TRACK_RENDERING_ANALYSIS.md)
- [CART Precision Racing track layer analysis](docs/CPR_TRACK_LAYER_ANALYSIS.md)
- [Terminal Velocity/Fury3 level format analysis](docs/TV_F3_LEVEL_FORMAT_ANALYSIS.md)
- [Hellbender level format analysis](docs/HELLBENDER_LEVEL_FORMAT_ANALYSIS.md)
- [CPREdit guide](docs/CPREDIT_GUIDE.md)
- [CART Precision Racing racetrack layer implementation guide](docs/cpr-racetrack-layer-implementation-guide.md)
- [Monster Truck Madness 2 physics notes](docs/MTM2_PHYSICS_NOTES.md)

## Related projects

- [JSPod](https://github.com/juanputrerasm/JSPod): browser-based POD archive and individual-asset viewer.
- [JSMTM2Converter](https://github.com/juanputrerasm/JSMTM2Converter) browser-based EVO to MTM2 track & truck converter.
- [JSTruckViewer](https://github.com/juanputrerasm/JSTruckViewer): browser-based MTM1 and MTM2 truck viewer.

JSTrackViewer follows the lineage of JTraxx and the original Traxx track editor for Monster Truck Madness and Monster Truck Madness 2.

## Credits and license

Developed by **Juan Pablo Utreras** for the Monster Truck Madness Guild.

Released under the [Apache License 2.0](LICENSE).

The game names and Terminal Reality are trademarks of their respective owners. This project is an independent community tool and is not affiliated with or endorsed by their owners.
