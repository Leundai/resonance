import type { Palette, Section } from '../types/song-analysis';

/**
 * The per-frame feature bus every scene and the conductor consume.
 * Scenes never know whether audio came from a pre-analyzed file or a
 * live capture — LiveProvider simply leaves the lookahead fields null.
 */
export interface FrameFeatures {
  /** Playback / capture clock in seconds. */
  time: number;
  /** Overall loudness 0..1 (adaptively normalized). */
  level: number;
  bass: number;
  mid: number;
  treble: number;
  /** Spectral centroid 0..1 (brightness). */
  centroid: number;
  /** True on the frame an onset/beat fires. */
  onset: boolean;
  /** True on the frame a downbeat (the "1") fires. */
  downbeat: boolean;
  /** Continuous 0..1 phase between beats; null when no beat grid. */
  beatPhase: number | null;
  /** Seconds until the next beat; null when unknown (live mode). */
  nextBeatIn: number | null;
  /** Energy percentile of this moment relative to the whole song; null live. */
  energyPercentile: number | null;
  /** Current section; null when unknown. */
  section: Section | null;
  /** Seconds until the next section boundary; null when unknown. */
  nextSectionIn: number | null;
  /** Energy of the UPCOMING section — the drop-anticipation signal. */
  nextSectionEnergy: number | null;
  /** Raw magnitude spectrum 0..1 for per-bin effects. */
  spectrum: Float32Array;
}

export interface AudioFeatureProvider {
  /** Pull the latest frame. Called once per render frame. */
  frame(): FrameFeatures;
  readonly palette: Palette | null;
  readonly isPlaying: boolean;
}
