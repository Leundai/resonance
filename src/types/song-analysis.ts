/**
 * SongAnalysis is the stable contract between analysis engines and the
 * rest of the app. Engines (classical DSP, neural ONNX models, server
 * pre-computation) are swappable behind this schema; consumers — the
 * conductor, scenes, the loading visual — only ever read this shape.
 */

export const SONG_ANALYSIS_VERSION = 3;

export interface SongAnalysis {
  version: number;
  /** Which engine produced this (e.g. "classical-dsp@1", "beat-this@onnx"). */
  engine: string;
  /** SHA-256 of the audio file content — the cache key. */
  contentHash: string;
  durationSec: number;
  sampleRate: number;

  tempo: TempoInfo;
  /** Beat onset times in seconds, ascending. */
  beats: number[];
  /** Downbeat times in seconds (subset of beats), empty if unknown. */
  downbeats: number[];
  /** Detected onset (transient) times in seconds. */
  onsets: number[];
  sections: Section[];
  curves: FeatureCurves;
  palette: Palette | null;
  emotion: Emotion | null;
  /** Reserved: per-stem curves once stem separation lands. */
  stems?: Record<string, FeatureCurves>;
}

export interface TempoInfo {
  bpm: number;
  confidence: number; // 0..1
}

export interface Section {
  startSec: number;
  endSec: number;
  /** Semantic label (verse/chorus/...) — null until a labeling engine exists. */
  label: string | null;
  /** Mean energy of the section, normalized 0..1 over the song. */
  energy: number;
}

/**
 * Per-frame curves sampled at a fixed hop. Float32Arrays normalized 0..1
 * over the whole song (so "energy 0.9" means a top-decile moment).
 */
export interface FeatureCurves {
  /** Seconds between consecutive frames. */
  hopSec: number;
  energy: Float32Array;
  bass: Float32Array;
  mid: Float32Array;
  treble: Float32Array;
  /** Spectral centroid, normalized 0..1 across the song. */
  centroid: Float32Array;
  /** Spectral flux (novelty), normalized 0..1. */
  flux: Float32Array;
}

/**
 * Classical valence/arousal estimate: Krumhansl-Schmuckler key/mode
 * (valence) + tempo and onset density (arousal). A neural upgrade
 * (MusiCNN) can swap in behind the same shape.
 */
export interface Emotion {
  /** 0 = dark/sad, 1 = bright/happy. */
  valence: number;
  /** 0 = calm, 1 = frenetic. */
  arousal: number;
  mode: 'major' | 'minor';
  key: string;
  /** Key-detection confidence 0..1. */
  confidence: number;
}

export interface Palette {
  /** OKLCH-normalized hex colors, semantic roles from cover art. */
  background: string;
  primary: string;
  secondary: string;
  accent: string;
  /** All raw extracted swatches, most prominent first. */
  swatches: string[];
  /** Object URL / data URL of the cover art, if any. */
  coverArtUrl: string | null;
}

/** Progress events streamed from the analysis worker to the loading UI. */
export type AnalysisProgress =
  | { stage: 'decoding'; pct: number }
  | { stage: 'curves'; pct: number }
  | { stage: 'beats'; pct: number }
  | { stage: 'sections'; pct: number }
  | { stage: 'palette'; pct: number }
  | { stage: 'model'; pct: number }
  | { stage: 'infer'; pct: number }
  | { stage: 'done'; analysis: SongAnalysis }
  /** Neural pass finished after playback already started. */
  | { stage: 'refined'; analysis: SongAnalysis };
