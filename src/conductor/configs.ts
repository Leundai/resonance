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
      { feature: 'level', param: 'brightness', in: [0, 0.5], out: [0.3, 1.6], attack: 0.05, release: 0.3 },
      { feature: 'pulse', param: 'pulse', out: [0, 1], attack: 0, release: 0 },
      { feature: 'centroid', param: 'drift', out: [0.2, 1.5], attack: 0.3, release: 0.6 },
    ],
  },
};
