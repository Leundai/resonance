import * as THREE from 'three/webgpu';
import { FilePlayer } from './audio/file-player';
import type { FrameFeatures } from './audio/features';
import { ParticleField } from './scenes/particles';
import type { SceneContext } from './scenes/scene';

const app = document.getElementById('app')!;
const hud = document.getElementById('hud')!;
const statusEl = document.getElementById('status')!;

const IDLE_SPECTRUM = new Float32Array(1024);

/** Inspection hook for automated validation (chrome-devtools MCP). */
const debugState = {
  features: null as FrameFeatures | null,
  playing: false,
  time: 0,
  frames: 0,
};
(window as unknown as Record<string, unknown>).__resonance = debugState;

function idleFeatures(t: number): FrameFeatures {
  // Gentle synthetic breathing so the scene is alive before any audio.
  const breathe = 0.5 + 0.5 * Math.sin(t * 0.4);
  return {
    time: t,
    level: 0.12 + breathe * 0.05,
    bass: 0.1 + breathe * 0.08,
    mid: 0.1,
    treble: 0.08 + (1 - breathe) * 0.05,
    centroid: 0.4,
    onset: false,
    beatPhase: null,
    nextBeatIn: null,
    energyPercentile: null,
    section: null,
    nextSectionIn: null,
    spectrum: IDLE_SPECTRUM,
  };
}

async function boot(): Promise<void> {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  await renderer.init();
  app.appendChild(renderer.domElement);
  const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  setStatus(`backend: ${isWebGPU ? 'webgpu' : 'webgl2'}`);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#050510');
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    200,
  );
  camera.position.set(0, 0, 22);

  const ctx: SceneContext = { renderer, scene, camera };
  const particles = new ParticleField();
  await particles.init(ctx);

  let player: FilePlayer | null = null;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  async function loadFile(file: File): Promise<void> {
    setStatus(`decoding ${file.name}…`);
    try {
      player ??= new FilePlayer();
      await player.load(await file.arrayBuffer());
      await player.play();
      hud.classList.add('hidden');
      setStatus('');
      document.title = `resonance — ${file.name.replace(/\.[^.]+$/, '')}`;
    } catch (err) {
      setStatus(`failed to load: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Drag & drop
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const file = e.dataTransfer?.files[0];
    if (file) void loadFile(file);
  });

  // File picker on "O"
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.id = 'file-input';
  input.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void loadFile(file);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'o' || e.key === 'O') input.click();
    if (e.code === 'Space' && player) {
      e.preventDefault();
      void player.toggle();
      hud.classList.toggle('hidden', player.isPlaying);
    }
  });

  let last = performance.now();
  let elapsed = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    elapsed += dt;
    const features =
      player && player.isPlaying ? player.frame() : idleFeatures(elapsed);
    particles.update(features, dt);
    debugState.features = features;
    debugState.playing = player?.isPlaying ?? false;
    debugState.time = player?.currentTime ?? 0;
    debugState.frames++;

    // Slow orbital drift; level adds a subtle push-in.
    const t = elapsed * 0.04;
    const radius = 22 - features.level * 4;
    camera.position.set(Math.sin(t) * radius, Math.sin(t * 0.7) * 3, Math.cos(t) * radius);
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  });
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

void boot().catch((err) => {
  setStatus(`boot failed: ${err instanceof Error ? err.message : err}`);
  console.error(err);
});
