# resonance

Song-aware music visualizer. Successor to Vibing-Audiovisual (C++/Cinder) and audiovisual-web (p5.js).
Architecture decisions live in the project memory `resonance-project-vision`; honor them.

## Stack
- Vite + TypeScript (strict) + Three.js r184 WebGPURenderer + TSL compute. No EffectComposer — post goes through TSL RenderPipeline.
- `npm run dev` → http://localhost:5197 (strict port). `npm run build` type-checks first.

## Architecture invariants
- `src/types/song-analysis.ts` — SongAnalysis is the stable contract; analysis engines are swappable behind it.
- `src/audio/features.ts` — FrameFeatures bus; scenes never know the audio source. Live mode leaves lookahead fields null.
- Conductor (src/conductor) owns feature→parameter mappings as data; scenes only declare parameters.
- Additive blending + depthWrite:false instead of GPU depth sorting.

## Live capture
- `L` = system audio via getDisplayMedia (Chromium; tick "Share tab audio"). `M` = input device via getUserMedia (use BlackHole loopback for cross-browser system audio).
- Permission prompts are browser chrome — NOT automatable via chrome-devtools MCP; live-capture paths need one manual grant to verify end-to-end.

## Validation workflow
- Validate in Chrome via chrome-devtools MCP. `window.__resonance` exposes { features, playing, time, frames } for scripted checks.
- Test MP3s in test-audio/ (gitignored). Drive the hidden #file-input with upload_file.
