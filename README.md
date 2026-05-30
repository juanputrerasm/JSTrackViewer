# JS Track Viewer

A pure browser JavaScript 3D viewer for classic Terminal Reality game track/level archives, including **Monster Truck Madness**, **Monster Truck Madness 2**, **Terminal Velocity**, **Fury3/F-Zone**, **Hellbender** and **CART Precision Racing** track data. Drop in a POD or ZIP file from local storage, or point it at a CORS-enabled URL, and the viewer decodes terrain, textures, objects, ground boxes, courses, trucks, water, backdrops, and CPR racetrack layers all client-side. 

JSTrackViewer is based on JTraxx, which in turn is based on the original Traxx track editor for MTM1 & MTM2.

---

## Stack

| Layer | Technology |
|---|---|
| 3D rendering | [Three.js](https://threejs.org/) v0.169 (via CDN import map) |
| Camera controls | Custom free-flight track navigation |
| Asset storage | [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) (Origin Private File System) |
| Heavy parsing | [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API) |
| ZIP extraction | [fflate](https://github.com/101arrowz/fflate) via CDN |
| Module system | Native ES modules (no bundler required) |
| Styling | Vanilla CSS |

---

## Getting started

OPFS and module workers require a proper HTTP origin, `file://` won't work. Serve the folder locally:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080/
```

Live deployment on GitHub Pages:

https://juanputrerasm.github.io/JSTrackViewer/

Load a track by clicking **Open POD/ZIP from disk** and selecting a `.POD` or `.ZIP` file, or paste a CORS-enabled POD/ZIP URL into the URL field. ZIP files are scanned for the first POD inside them. If an archive contains multiple tracks, choose one from the title-bar selector and click **Load Track**.

---

## Features

- Load `.POD` archives from local disk or remote URL
- Load `.ZIP` archives containing POD files from local disk or remote URL
- Multi-track POD support for archives with multiple `.SIT` or `.LVL` entries
- OPFS-backed per-session staging, with a **Clear temp** control
- Navigation minimap with greyscale height map and clickable camera repositioning
- Viewer toggles for terrain, textures, grid, courses, objects, billboard behavior, checkpoints, ground boxes, collision boxes, wireframe, trucks, water, background, and sunlight
- Separate track data and stats panels, including background model, music, weather, texture/object/ground-box/course counts
- Adjustable view distance, sun intensity, and gamma
- Static BIN model decoding, including textured meshes, known transparent face types, and TV-family/Hellbender scale handling
- `RAW` + `ACT` texture decoding with fallback palette support
- Ground box layer support from `RA0`, `RA1`, and `CL0`
- MTM/MTM2 `.SIT` parsing for terrain, metadata, courses, trucks, objects, and backdrops
- TV/Fury3-family and Hellbender `.LVL` support, including `.DEF` object placement
- CPR `.TRK` / `.TTX` racetrack layer support, including walls, wireframe display, and wall-bounded surface rendering

---

## Controls

| Control | Action |
|---|---|
| Arrow Up / Arrow Down | Move forward / backward |
| Arrow Left / Arrow Right | Turn camera |
| Page Up / Page Down | Pitch camera |
| A / Z | Raise / lower camera |
| Mouse drag | Look around |
| Mouse wheel | Move along view direction |
| Home | Reset near course segment 0 |
| Minimap click | Move to selected map position while keeping camera orientation |

---

## Project structure

```text
index.html
styles.css
src/
  main.js                - entry point
  app.js                 - UI controller and track loading flow
  scene.js               - Three.js scene, terrain, objects, overlays
  nav.js                 - free-flight camera navigation
  worker-client.js       - promise wrapper around the Web Worker
  zip-utils.js           - ZIP extraction helper for POD-in-ZIP loading
  shared/
    opfs.js              - OPFS read/write helpers
    path-utils.js        - archive path normalization
  worker/
    track-worker.js      - worker message handler
    track-loader.js      - track choice listing helpers
    pod-format.js        - POD archive indexing and entry extraction
    sit-parser.js        - SIT track parser
    lvl-parser.js        - TV-family/HB LVL track parser
    def-loader.js        - TV-family/HB DEF object loader
    gbox-loader.js       - RA0/RA1/CL0 ground box loader
    racetrack-loader.js  - CPR TRK/TTX racetrack layer loader
    terrain-builder.js   - terrain mesh and atlas builder
    bin-decoder.js       - BIN mesh decoder
    texture-decoder.js   - RAW/ACT texture decoder to RGBA
    binary-reader.js     - low-level typed binary reader
```

---

## Loading From URLs

The viewer can load archives from the page itself, or from query parameters. This makes it easy to host `JSTrackViewer` on a site and point it at a track archive in another folder on the same domain.

Examples:

- Root-relative path on the same domain: `/JSTrackViewer/?file=/resources/tracks/circuit.pod`
- Relative path from the viewer folder: `/JSTrackViewer/?file=../archives/track.pod`
- Full URL: `/JSTrackViewer/?url=https://example.com/resources/tracks/track.pod`
- ZIP URL: `/JSTrackViewer/?url=https://example.com/resources/tracks/track.zip`

Notes:

- `?file=` and `?url=` are both supported.
- Relative URLs are resolved from the viewer page location.
- Root-relative URLs that start with `/` are usually the clearest choice for webmasters.
- Remote loading still uses browser `fetch()`, so cross-origin URLs must allow CORS.
- ZIP loading extracts the first `.POD` file found inside the archive.

---

## Known limitations

- Rendering is inspection-focused; it does not emulate race physics, AI, audio playback, weapons, enemies, checkpoint, tunnels or game scripting.
- CPR racetrack wall rendering is supported but still approximate compared with the original renderer.
- TV/F3/HB tunnels are not supported.
- Animated models or textures are not supported.
- Ramps are not displayed.
- TopCrush models are not supported.
- Models or art not available on the POD file is not rendered.
- Must be served over `http://localhost` or HTTPS; `file://` is not supported.

---

## License

This project is licensed under the Apache License 2.0. See [LICENSE](./LICENSE).
