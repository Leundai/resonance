# resonance

**Live: [leundai.github.io/resonance](https://leundai.github.io/resonance/)** (Chromium recommended — WebGPU)

A song-aware music visualizer. Drop in a track and it *learns* it before playing — neural beat
grid, section structure, energy arc, key/mode, valence/arousal, and a palette pulled from the
cover art — then choreographs mathematical art to it: the visuals inhale in the last bar before
a drop and explode on impact. Optionally, Claude directs the whole show.

Successor to Vibing-Audiovisual (C++/Cinder, 2020) and audiovisual-web (p5.js). Built on
Three.js WebGPU with TSL compute.

## Controls

| Key | Action |
| --- | --- |
| **drag & drop** | load any audio file |
| **O** | open file picker |
| **L** | live system audio (Chromium screen-share — tick "Share tab audio") |
| **M** | live input device (mic, or a [BlackHole](https://github.com/ExistentialAudio/BlackHole) loopback for cross-browser system audio) |
| **Space** | play / pause |
| **1–7** | switch scene manually |
| **`** (backtick) | dev panel — live param tuning, scene/conductor control, LLM director settings |

Scenes auto-rotate on section boundaries (by energy band, or by the director's plan).

## Scenes (keys 1–7)

1. **particles** — 100k curl-noise flow-field particles in a breathing shell
2. **boids** — 32k-agent GPU murmuration (counting-sort spatial grid); calm music pulls it tight, drops scatter it
3. **terrain** — ridged-FBM landscape, domain-scrolled, palette fog
4. **fractal** — animated Julia set; the c-parameter orbits with the music, drops flip the gradient
5. **physarum** — 120k-agent slime mold forming living neon vein networks
6. **attractor** — 150k particles in strange-attractor phase spaces (Lorenz / Thomas / Aizawa / Halvorsen); every section morphs to the next attractor
7. **kifs** — raymarched kaleidoscopic IFS fractal; the fold angle rides the spectral centroid, drops kick the rotation

All scenes are palette-aware and wired to three choreography signals: `pulse` (every beat),
`inhale` (ramps through the last ~1.2 s before a louder section), and `drop` (fires on impact).
Post stack: beat-modulated bloom → afterimage trails → chromatic aberration on drops.

## The intelligence pipeline

1. **Classical DSP** (Web Worker, ~2 s/song): FFT feature curves, spectral-flux onsets,
   autocorrelation tempo + phase-fitted beat grid, Foote novelty sections, Krumhansl-Schmuckler
   key/mode → valence/arousal. Playback starts on this.
2. **Neural beats** ([Beat This!](https://github.com/CPJKU/beat_this), ISMIR 2024, MIT) via
   onnxruntime-web on the WebGPU EP: beat + downbeat grid that handles non-4/4 and non-EDM
   material. The 83 MB model downloads once (Cache API) and the refined grid hot-swaps in
   mid-playback. Detected a corrido's 3/4 meter that classical autocorrelation missed entirely.
3. **Palette**: ID3 cover art → node-vibrant swatches → semantic roles. No art? The song's
   emotion paints a synthetic palette (valence picks the hue, arousal the saturation).
4. **LLM director** (optional, BYO Anthropic key in the panel): one Messages API call per song —
   Claude reads bpm/sections/energy/emotion/palette and returns a mood, a scene-per-section
   plan, and per-scene conductor configs. Schema-validated, range-clamped, falls back to
   defaults. Claude never draws; the math stays the art.

Everything runs client-side. Analysis results cache in IndexedDB by content hash.

## Architecture

- `src/types/song-analysis.ts` — **SongAnalysis**, the stable engine-swappable contract
- `src/audio/` — one **FrameFeatures** bus; `FilePlayer` (pre-analyzed, with beat lookahead) and `LiveProvider` (realtime flux onsets + adaptive normalization) are interchangeable
- `src/conductor/` — feature→parameter mappings as *data* (range/curve/attack/release) + derived signals; the director emits configs into this layer
- `src/scenes/` — each scene declares typed params; the conductor (or your sliders) drives them

## Demo track

The one-click demo plays **"Adventures" by [A Himitsu](https://www.youtube.com/channel/UCgFwu-j5-xNJml2FtTrrB3A)**
(Creative Commons — Attribution 3.0 Unported — CC BY 3.0, released by
[Argofox](https://youtu.be/8BXNwnxaVQE)), shipped with a precomputed neural analysis so it
starts instantly.

## Run locally

```sh
npm install
npm run dev   # http://localhost:5197
```

The dev panel (backtick) is the tuning workflow: toggle "conductor drives" off, drag scene
params live, bake good values back into `src/conductor/configs.ts`.

## Roadmap

- Downbeat-aware accents (hit harder on the "1" — the data's already there)
- One-click demo preset on the live site
- MusiCNN neural emotion, cached Demucs stems → per-stem scenes (boids on the vocal line)
