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
  | 'energyPercentile'
  /** 1 on each downbeat (the "1"), slower decay than pulse. */
  | 'downbeatPulse'
  /** Ramps 0→1 in the ~1.2 s before a significantly louder section. */
  | 'inhale'
  /** Fires 1 the moment that louder section lands; fast decay. */
  | 'drop';

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
  /** When false, mappings stop writing params (manual tuning mode);
   *  derived signals keep flowing for the post stack. */
  enabled = true;

  /** Global temperament from the song's absolute arousal (0..1).
   *  Song-relative features can't tell a breakcore track from a ballad —
   *  this can. High arousal drives every mapping toward its upper range. */
  intensity = 0.5;

  private config: ConductorConfig;
  private scene: VisualScene;
  private state: MappingState[] = [];
  private pulse = 0;
  private downbeatPulse = 0;
  private inhale = 0;
  private drop = 0;
  private lastSectionStart = -1;
  private lastSectionEnergy = 0;

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

  /** Derived signals, exposed for the post stack. */
  get signals(): { pulse: number; downbeat: number; inhale: number; drop: number } {
    return {
      pulse: this.pulse,
      downbeat: this.downbeatPulse,
      inhale: this.inhale,
      drop: this.drop,
    };
  }

  update(f: FrameFeatures, dt: number): void {
    if (f.onset) this.pulse = 1;
    else this.pulse *= Math.exp(-dt * (this.config.pulseDecay ?? 5));
    if (f.downbeat) this.downbeatPulse = 1;
    else this.downbeatPulse *= Math.exp(-dt * 2.8);

    // Drop anticipation: a meaningfully louder section is imminent.
    const INHALE_WINDOW = 1.2;
    const energyJump =
      f.section !== null && f.nextSectionEnergy !== null
        ? f.nextSectionEnergy - f.section.energy
        : 0;
    if (energyJump > 0.12 && f.nextSectionIn !== null && f.nextSectionIn < INHALE_WINDOW) {
      this.inhale = Math.min(1, (INHALE_WINDOW - f.nextSectionIn) / INHALE_WINDOW + 0.2);
    } else {
      this.inhale = Math.max(0, this.inhale - dt * 4);
    }

    if (f.section && f.section.startSec !== this.lastSectionStart) {
      const isFirst = this.lastSectionStart === -1;
      const prevEnergy = this.lastSectionEnergy;
      this.lastSectionStart = f.section.startSec;
      this.lastSectionEnergy = f.section.energy;
      if (!isFirst) {
        if (f.section.energy - prevEnergy > 0.12) this.drop = 1;
        this.onSectionChange?.(f.section.startSec, f.section.energy);
      }
    }
    this.drop *= Math.exp(-dt * 3);

    if (!this.enabled) return;
    for (let i = 0; i < this.config.mappings.length; i++) {
      const m = this.config.mappings[i];
      const raw = this.read(f, m.feature);
      if (raw === null) continue; // unknown in live mode — hold last value

      const [inLo, inHi] = m.in ?? [0, 1];
      let x = clamp01((raw - inLo) / (inHi - inLo || 1));
      if (m.curve === 'pow2') x *= x;
      else if (m.curve === 'sqrt') x = Math.sqrt(x);
      x = clamp01(x * (0.65 + this.intensity * 0.7));
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
      case 'downbeatPulse':
        return this.downbeatPulse;
      case 'beatPhase':
        return f.beatPhase;
      case 'energyPercentile':
        return f.energyPercentile;
      case 'inhale':
        return this.inhale;
      case 'drop':
        return this.drop;
    }
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
