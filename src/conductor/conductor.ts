import type { FrameFeatures } from '../audio/features';
import type { VisualScene } from '../scenes/scene';

/**
 * Feature sources the conductor can read. `pulse` is derived: 1 on each
 * beat onset, exponential decay — the universal "hit" signal.
 */
export type FeatureSource =
  | 'level'
  | 'bass'
  | 'mid'
  | 'treble'
  | 'centroid'
  | 'pulse'
  | 'beatPhase'
  | 'energyPercentile';

export type Curve = 'linear' | 'pow2' | 'sqrt';

/**
 * One feature→parameter wire, defined as data. This shape is the
 * eventual LLM-director output format: a director emits ConductorConfig,
 * never code.
 */
export interface Mapping {
  feature: FeatureSource;
  param: string;
  /** Input range mapped to 0..1 before the curve. Default [0, 1]. */
  in?: [number, number];
  /** Output range for the scene parameter. */
  out: [number, number];
  curve?: Curve;
  /** Smoothing time constants in seconds; 0 = instant. */
  attack?: number;
  release?: number;
}

export interface ConductorConfig {
  mappings: Mapping[];
  /** Beat-pulse decay rate (per second). Higher = snappier. */
  pulseDecay?: number;
}

interface MappingState {
  smoothed: number;
}

export class Conductor {
  private config: ConductorConfig;
  private scene: VisualScene;
  private state: MappingState[] = [];
  private pulse = 0;
  private lastSectionStart = -1;

  /** Fires when playback crosses a section boundary. */
  onSectionChange: ((sectionStart: number, energy: number) => void) | null = null;

  constructor(scene: VisualScene, config: ConductorConfig) {
    this.scene = scene;
    this.config = config;
    this.resetState();
  }

  setConfig(config: ConductorConfig): void {
    this.config = config;
    this.resetState();
  }

  setScene(scene: VisualScene): void {
    this.scene = scene;
    this.resetState();
  }

  private resetState(): void {
    this.state = this.config.mappings.map((m) => ({
      smoothed: (m.out[0] + m.out[1]) / 2,
    }));
  }

  update(f: FrameFeatures, dt: number): void {
    if (f.onset) this.pulse = 1;
    else this.pulse *= Math.exp(-dt * (this.config.pulseDecay ?? 5));

    if (f.section && f.section.startSec !== this.lastSectionStart) {
      const isFirst = this.lastSectionStart === -1;
      this.lastSectionStart = f.section.startSec;
      if (!isFirst) this.onSectionChange?.(f.section.startSec, f.section.energy);
    }

    for (let i = 0; i < this.config.mappings.length; i++) {
      const m = this.config.mappings[i];
      const raw = this.read(f, m.feature);
      if (raw === null) continue; // unknown in live mode — hold last value

      const [inLo, inHi] = m.in ?? [0, 1];
      let x = clamp01((raw - inLo) / (inHi - inLo || 1));
      if (m.curve === 'pow2') x *= x;
      else if (m.curve === 'sqrt') x = Math.sqrt(x);
      const target = m.out[0] + (m.out[1] - m.out[0]) * x;

      const st = this.state[i];
      const tau = target > st.smoothed ? (m.attack ?? 0.05) : (m.release ?? 0.25);
      const k = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
      st.smoothed += (target - st.smoothed) * k;
      this.scene.setParam(m.param, st.smoothed);
    }
  }

  private read(f: FrameFeatures, source: FeatureSource): number | null {
    switch (source) {
      case 'level':
        return f.level;
      case 'bass':
        return f.bass;
      case 'mid':
        return f.mid;
      case 'treble':
        return f.treble;
      case 'centroid':
        return f.centroid;
      case 'pulse':
        return this.pulse;
      case 'beatPhase':
        return f.beatPhase;
      case 'energyPercentile':
        return f.energyPercentile;
    }
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
