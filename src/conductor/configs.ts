import type { ConductorConfig } from './conductor';

/**
 * Default feature→parameter wiring per scene. Hand-tuned for now; the
 * LLM director will eventually emit these per song.
 */
export const DEFAULT_CONFIGS: Record<string, ConductorConfig> = {
  particles: {
    pulseDecay: 5,
    mappings: [
      { feature: 'bass', param: 'breathe', out: [0, 1], curve: 'pow2', attack: 0.03, release: 0.2 },
      { feature: 'treble', param: 'turbulence', in: [0, 0.8], out: [0.5, 4], attack: 0.08, release: 0.4 },
      { feature: 'level', param: 'brightness', in: [0, 0.5], out: [0.25, 0.9], attack: 0.05, release: 0.3 },
      { feature: 'pulse', param: 'pulse', out: [0, 0.6], attack: 0, release: 0 },
      { feature: 'centroid', param: 'drift', out: [0.2, 1.5], attack: 0.3, release: 0.6 },
      { feature: 'inhale', param: 'inhale', out: [0, 1], attack: 0, release: 0.05 },
      { feature: 'drop', param: 'burst', out: [0, 1], attack: 0, release: 0.02 },
    ],
  },
  boids: {
    pulseDecay: 6,
    mappings: [
      // Quiet music = tight lazy murmuration; loud = fast and loose.
      { feature: 'energyPercentile', param: 'cohesion', out: [1.4, 0.5], attack: 0.5, release: 0.5 },
      { feature: 'level', param: 'speed', in: [0, 0.5], out: [0.5, 2.2], attack: 0.1, release: 0.5 },
      { feature: 'pulse', param: 'scatter', out: [0, 0.9], curve: 'pow2', attack: 0, release: 0 },
      { feature: 'level', param: 'brightness', in: [0, 0.5], out: [0.4, 1.1], attack: 0.05, release: 0.3 },
      { feature: 'treble', param: 'alignment', in: [0, 0.8], out: [1.4, 0.6], attack: 0.2, release: 0.5 },
      { feature: 'inhale', param: 'inhale', out: [0, 1], attack: 0, release: 0.05 },
      { feature: 'drop', param: 'burst', out: [0, 1], attack: 0, release: 0.02 },
    ],
  },
  terrain: {
    pulseDecay: 4,
    mappings: [
      { feature: 'bass', param: 'amplitude', out: [1.2, 4.5], curve: 'sqrt', attack: 0.06, release: 0.35 },
      { feature: 'centroid', param: 'detail', out: [0.05, 1], attack: 0.3, release: 0.6 },
      { feature: 'level', param: 'scrollSpeed', in: [0, 0.5], out: [0.8, 7], attack: 0.15, release: 0.8 },
      { feature: 'pulse', param: 'glow', out: [0.5, 2.2], attack: 0, release: 0 },
      { feature: 'inhale', param: 'inhale', out: [0, 1], attack: 0, release: 0.05 },
      { feature: 'drop', param: 'burst', out: [0, 1], attack: 0, release: 0.02 },
    ],
  },
  physarum: {
    pulseDecay: 5,
    mappings: [
      // Bass widens the sensor cone (blobby webs); treble tightens it (fine filaments).
      { feature: 'bass', param: 'sensorAngle', out: [0.35, 0.95], attack: 0.1, release: 0.5 },
      { feature: 'level', param: 'moveSpeed', in: [0, 0.5], out: [0.02, 0.1], attack: 0.1, release: 0.6 },
      { feature: 'treble', param: 'turnSpeed', in: [0, 0.8], out: [2, 6.5], attack: 0.1, release: 0.5 },
      // Quiet passages keep long memory; loud ones churn.
      { feature: 'level', param: 'decay', in: [0, 0.5], out: [0.99, 0.93], attack: 0.3, release: 0.8 },
      { feature: 'level', param: 'brightness', in: [0, 0.5], out: [0.6, 1.4], attack: 0.05, release: 0.3 },
      { feature: 'inhale', param: 'inhale', out: [0, 1], attack: 0, release: 0.05 },
      { feature: 'drop', param: 'burst', out: [0, 1], attack: 0, release: 0.02 },
    ],
  },
  fractal: {
    pulseDecay: 5,
    mappings: [
      { feature: 'centroid', param: 'speed', out: [0.03, 0.22], attack: 0.4, release: 0.8 },
      { feature: 'bass', param: 'warp', out: [0.74, 0.86], curve: 'sqrt', attack: 0.08, release: 0.4 },
      { feature: 'level', param: 'brightness', in: [0, 0.5], out: [0.5, 1.3], attack: 0.05, release: 0.3 },
      { feature: 'pulse', param: 'pulse', out: [0, 1], attack: 0, release: 0 },
      { feature: 'inhale', param: 'inhale', out: [0, 1], attack: 0, release: 0.05 },
      { feature: 'drop', param: 'burst', out: [0, 1], attack: 0, release: 0.02 },
    ],
  },
};
