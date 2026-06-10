# resonance

A song-aware music visualizer. Drop in a track and it *learns* it before playing — beat grid,
section structure, energy arc, and a palette pulled from the cover art — then choreographs
mathematical art to it: the visuals inhale in the last bar before a drop and explode on impact.

Successor to [Vibing-Audiovisual](https://github.com/) (C++/Cinder, 2020) and audiovisual-web
(p5.js) — rebuilt on Three.js WebGPU with TSL compute.

## Scenes (keys 1–6)

1. **particles** — 100k curl-noise flow-field particles in a breathing shell
2. **boids** — 4096-agent GPU murmuration; calm music pulls it tight, drops scatter it
3. **terrain** — ridged-FBM landscape, domain-scrolled, palette fog
4. **fractal** — animated Julia set; the c-parameter orbits with the music, drops flip the gradient
5. **physarum** — 120k-agent slime mold forming living neon vein networks
6. **attractor** — 150k particles in strange-attractor phase spaces (Lorenz/Thomas/Aizawa/Halvorsen); every section morphs to the next attractor

Scenes auto-rotate on section boundaries by energy band; all are palette-aware and wired to
the beat-pulse / inhale / drop signals. Post: beat-modulated bloom, afterimage trails,
chromatic aberration on drops (TSL RenderPipeline).

## Controls

- **drag & drop** an audio file, or **O** to open
- **L** live system audio (Chromium screen-share with "Share tab audio"), **M** live input device (use a BlackHole loopback for cross-browser system audio)
- **Space** play/pause · **1–6** scenes · **`** dev panel (Tweakpane: live param tuning, conductor toggle)

## How it works

- `src/types/song-analysis.ts` — **SongAnalysis**, the stable contract. Engines behind it are swappable; v1 is classical DSP in a Web Worker (radix-2 FFT → feature curves → spectral-flux onsets → autocorrelation tempo + phase-fitted beat grid → Foote novelty sections), ~2 s per song, cached in IndexedDB by content hash.
- `src/audio/` — one **FrameFeatures** bus; `FilePlayer` (pre-analyzed: beat lookahead, sections, energy percentiles) and `LiveProvider` (realtime flux onsets + adaptive normalization; lookahead fields null) are interchangeable.
- `src/conductor/` — feature→parameter mappings as *data* (range/curve/attack/release), plus derived signals: `pulse` (beat), `inhale` (ramps up before a louder section), `drop` (fires on impact). This layer is what a future LLM director will emit configs into.
- `src/analysis/palette.ts` — ID3 APIC cover art → node-vibrant → semantic color roles for every scene.

## Run

```sh
npm install
npm run dev   # http://localhost:5197 — Chromium recommended (WebGPU)
```

## Roadmap

- Neural beat/downbeat tracking (Beat This!, MIT, via onnxruntime-web) for non-EDM material
- Essentia.js MusiCNN valence/arousal → emotion-driven palettes
- LLM-as-director: per-song conductor configs from lyrics + structure (BYO Anthropic key)
- Spatial-grid boids (100k+), raymarched KIFS fractals, cached Demucs stems → per-stem scenes
