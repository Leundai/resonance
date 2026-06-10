import { Fft } from './fft';
import type {
  AnalysisProgress,
  Emotion,
  FeatureCurves,
  Section,
  SongAnalysis,
  TempoInfo,
} from '../types/song-analysis';
import { SONG_ANALYSIS_VERSION } from '../types/song-analysis';

const FRAME = 2048;
const HOP = 512;

/**
 * Classical-DSP analysis engine. Pure function of (mono samples, rate) —
 * runs in a worker, but has no worker dependencies so it's unit-testable.
 */
export function analyzeAudio(
  mono: Float32Array,
  sampleRate: number,
  contentHash: string,
  onProgress: (p: AnalysisProgress) => void,
): SongAnalysis {
  const nFrames = Math.max(1, Math.floor((mono.length - FRAME) / HOP) + 1);
  const hopSec = HOP / sampleRate;
  const fft = new Fft(FRAME);
  const window = hann(FRAME);
  const frame = new Float32Array(FRAME);
  const mags = new Float32Array(FRAME / 2);
  const prevMags = new Float32Array(FRAME / 2);
  const binHz = sampleRate / FRAME;

  const energy = new Float32Array(nFrames);
  const bass = new Float32Array(nFrames);
  const mid = new Float32Array(nFrames);
  const treble = new Float32Array(nFrames);
  const centroid = new Float32Array(nFrames);
  const flux = new Float32Array(nFrames);

  // Coarse log-band energies (~1 s blocks) for section analysis.
  const N_BANDS = 16;
  const bandEdges = logBandEdges(N_BANDS, 40, 10_000, binHz, FRAME / 2);
  const framesPerBlock = Math.max(1, Math.round(1 / hopSec));
  const nBlocks = Math.ceil(nFrames / framesPerBlock);
  const blockBands = new Float32Array(nBlocks * N_BANDS);

  const bassLo = Math.max(1, Math.floor(20 / binHz));
  const bassHi = Math.floor(250 / binHz);
  const midHi = Math.floor(2000 / binHz);
  const trebHi = Math.min(FRAME / 2 - 1, Math.floor(8000 / binHz));

  // Pitch-class accumulator for key/mode (bins 80–4000 Hz).
  const chroma = new Float64Array(12);
  const chromaLo = Math.max(1, Math.ceil(80 / binHz));
  const chromaHi = Math.min(FRAME / 2 - 1, Math.floor(4000 / binHz));
  const pitchClassOfBin = new Int8Array(chromaHi + 1);
  for (let k = chromaLo; k <= chromaHi; k++) {
    const midi = 69 + 12 * Math.log2((k * binHz) / 440);
    pitchClassOfBin[k] = ((Math.round(midi) % 12) + 12) % 12;
  }

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) frame[i] = mono[off + i] * window[i];
    fft.magnitudes(frame, mags);

    let e = 0;
    let weighted = 0;
    let fl = 0;
    for (let i = 1; i < mags.length; i++) {
      const m = mags[i];
      e += m * m;
      weighted += m * i;
      const d = m - prevMags[i];
      if (d > 0) fl += d;
      prevMags[i] = m;
    }
    energy[f] = Math.sqrt(e / mags.length);
    const magSum = mags.reduce((a, b) => a + b, 0);
    centroid[f] = magSum > 0 ? (weighted / magSum) * binHz : 0;
    flux[f] = fl;

    bass[f] = bandMean(mags, bassLo, bassHi);
    mid[f] = bandMean(mags, bassHi + 1, midHi);
    treble[f] = bandMean(mags, midHi + 1, trebHi);

    for (let k = chromaLo; k <= chromaHi; k++) chroma[pitchClassOfBin[k]] += mags[k];

    const block = Math.floor(f / framesPerBlock);
    for (let b = 0; b < N_BANDS; b++) {
      blockBands[block * N_BANDS + b] += bandMean(mags, bandEdges[b], bandEdges[b + 1] - 1);
    }

    if (f % 2000 === 0) onProgress({ stage: 'curves', pct: f / nFrames });
  }
  onProgress({ stage: 'curves', pct: 1 });

  // Onsets from raw (pre-normalization) flux.
  const onsets = pickOnsets(flux, hopSec);
  onProgress({ stage: 'beats', pct: 0.3 });
  const { tempo, beats } = trackBeats(flux, hopSec, mono.length / sampleRate);
  onProgress({ stage: 'beats', pct: 1 });

  // Centroid maps to a log scale before normalization (perceptual brightness).
  let brightnessSum = 0;
  for (let i = 0; i < nFrames; i++) {
    centroid[i] = centroid[i] > 0 ? Math.log2(Math.max(centroid[i], 100) / 100) : 0;
    brightnessSum += centroid[i];
  }
  // Absolute brightness 0..1 (log range 100 Hz – ~6.4 kHz center of mass).
  const brightness = Math.min(1, brightnessSum / nFrames / 6);
  normalizeInPlace(energy);
  normalizeInPlace(bass);
  normalizeInPlace(mid);
  normalizeInPlace(treble);
  normalizeInPlace(centroid);
  normalizeInPlace(flux);

  const sections = findSections(blockBands, nBlocks, N_BANDS, framesPerBlock * hopSec, energy, hopSec);
  onProgress({ stage: 'sections', pct: 1 });

  const durationSec = mono.length / sampleRate;
  const emotion = estimateEmotion(chroma, tempo.bpm, onsets.length / durationSec, brightness);

  const curves: FeatureCurves = { hopSec, energy, bass, mid, treble, centroid, flux };
  return {
    version: SONG_ANALYSIS_VERSION,
    engine: 'classical-dsp@1',
    contentHash,
    durationSec: mono.length / sampleRate,
    sampleRate,
    tempo,
    beats,
    downbeats: [],
    onsets,
    sections,
    curves,
    palette: null,
    emotion,
  };
}

const KEY_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
// Krumhansl-Kessler probe-tone profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/**
 * Classical valence/arousal: mode + brightness → valence; tempo +
 * onset density → arousal. Crude but honest — and song-relative
 * features stay out of it so values compare across tracks.
 */
function estimateEmotion(
  chroma: Float64Array,
  bpm: number,
  onsetsPerSec: number,
  brightness: number,
): Emotion {
  let bestR = -2;
  let bestKey = 0;
  let bestMode: 'major' | 'minor' = 'major';
  let bestOppositeR = -2;
  for (const [mode, profile] of [
    ['major', MAJOR_PROFILE],
    ['minor', MINOR_PROFILE],
  ] as const) {
    for (let root = 0; root < 12; root++) {
      let r = 0;
      for (let i = 0; i < 12; i++) r += profile[i] * chroma[(root + i) % 12];
      if (r > bestR) {
        if (mode !== bestMode) bestOppositeR = bestR;
        bestR = r;
        bestKey = root;
        bestMode = mode;
      } else if (mode !== bestMode && r > bestOppositeR) {
        bestOppositeR = r;
      }
    }
  }
  const total = chroma.reduce((a, b) => a + b, 0) || 1;
  const separation = Math.max(0, (bestR - bestOppositeR) / total / 4);
  const confidence = Math.min(1, separation * 30);

  const majorness = bestMode === 'major' ? 0.5 + confidence * 0.5 : 0.5 - confidence * 0.5;
  const valence = clamp01(0.15 + majorness * 0.5 + brightness * 0.35);
  const tempoN = clamp01((bpm - 60) / 120);
  const onsetN = clamp01((onsetsPerSec - 0.5) / 3.5);
  const arousal = clamp01(tempoN * 0.55 + onsetN * 0.45);

  return { valence, arousal, mode: bestMode, key: KEY_NAMES[bestKey], confidence };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

function bandMean(mags: Float32Array, lo: number, hi: number): number {
  if (hi < lo) return 0;
  let s = 0;
  for (let i = lo; i <= hi; i++) s += mags[i];
  return s / (hi - lo + 1);
}

function logBandEdges(
  bands: number,
  loHz: number,
  hiHz: number,
  binHz: number,
  maxBin: number,
): Uint32Array {
  const edges = new Uint32Array(bands + 1);
  for (let b = 0; b <= bands; b++) {
    const hz = loHz * Math.pow(hiHz / loHz, b / bands);
    edges[b] = Math.min(maxBin, Math.max(1, Math.round(hz / binHz)));
  }
  // Ensure strictly increasing so every band has at least one bin.
  for (let b = 1; b <= bands; b++) edges[b] = Math.max(edges[b], edges[b - 1] + 1);
  return edges;
}

/** Normalize to 0..1 by the 98th percentile (robust to single spikes). */
function normalizeInPlace(arr: Float32Array): void {
  const sorted = Float32Array.from(arr).sort();
  const p98 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] || 1;
  const scale = p98 > 0 ? 1 / p98 : 1;
  for (let i = 0; i < arr.length; i++) arr[i] = Math.min(1, arr[i] * scale);
}

/** Peak-pick spectral flux with a moving median + MAD threshold. */
function pickOnsets(flux: Float32Array, hopSec: number): number[] {
  const n = flux.length;
  const half = Math.round(0.5 / hopSec); // 1 s context window
  const minGap = Math.round(0.12 / hopSec);
  const onsets: number[] = [];
  let lastPeak = -minGap;
  const win: number[] = [];
  for (let i = 0; i < n; i++) {
    win.length = 0;
    for (let j = Math.max(0, i - half); j < Math.min(n, i + half); j++) win.push(flux[j]);
    win.sort((a, b) => a - b);
    const median = win[win.length >> 1];
    const threshold = median * 1.6 + 1e-4;
    if (
      flux[i] > threshold &&
      flux[i] >= (flux[i - 1] ?? 0) &&
      flux[i] > (flux[i + 1] ?? 0) &&
      i - lastPeak >= minGap
    ) {
      onsets.push(i * hopSec);
      lastPeak = i;
    }
  }
  return onsets;
}

/**
 * Tempo via autocorrelation of the flux envelope, then a beat grid fitted
 * by exhaustive phase search. Steady-tempo assumption — good enough for the
 * classical engine; the neural engine (Beat This!) replaces this wholesale.
 */
function trackBeats(
  flux: Float32Array,
  hopSec: number,
  durationSec: number,
): { tempo: TempoInfo; beats: number[] } {
  const n = flux.length;
  if (n < 64) return { tempo: { bpm: 0, confidence: 0 }, beats: [] };

  // Smooth + de-mean the envelope.
  const env = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) env[i] = (flux[i - 1] + flux[i] * 2 + flux[i + 1]) / 4;
  const mean = env.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) env[i] -= mean;

  const minLag = Math.round(60 / 220 / hopSec); // 220 BPM
  const maxLag = Math.min(n - 1, Math.round(60 / 40 / hopSec)); // 40 BPM
  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += env[i] * env[i];
  if (r0 === 0) return { tempo: { bpm: 0, confidence: 0 }, beats: [] };

  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += env[i] * env[i + lag];
    ac[lag] = s / r0;
  }

  // Score each lag with harmonic support; prefer the 90–180 BPM octave.
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSec);
    const harmonic = lag * 2 <= maxLag ? ac[lag * 2] * 0.5 : 0;
    const octaveBias = bpm >= 90 && bpm <= 180 ? 1.15 : 1;
    const score = (ac[lag] + harmonic) * octaveBias;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  const periodSec = bestLag * hopSec;
  const bpm = 60 / periodSec;
  const confidence = Math.max(0, Math.min(1, ac[bestLag]));

  // Phase search: maximize summed flux at grid points.
  const periodFrames = bestLag;
  let bestPhase = 0;
  let bestSum = -Infinity;
  for (let p = 0; p < periodFrames; p += 0.25) {
    let s = 0;
    for (let g = p; g < n; g += periodFrames) {
      const i = Math.floor(g);
      const frac = g - i;
      s += flux[i] * (1 - frac) + (flux[i + 1] ?? 0) * frac;
    }
    if (s > bestSum) {
      bestSum = s;
      bestPhase = p;
    }
  }

  const beats: number[] = [];
  for (let t = bestPhase * hopSec; t < durationSec; t += periodSec) beats.push(t);
  return { tempo: { bpm: Math.round(bpm * 10) / 10, confidence }, beats };
}

/**
 * Section boundaries via checkerboard-kernel novelty on a cosine
 * self-similarity matrix of coarse log-band blocks (Foote 2000).
 */
function findSections(
  blockBands: Float32Array,
  nBlocks: number,
  nBands: number,
  blockSec: number,
  energyCurve: Float32Array,
  hopSec: number,
): Section[] {
  const durationSec = nBlocks * blockSec;
  if (nBlocks < 8) {
    return [{ startSec: 0, endSec: durationSec, label: null, energy: 0.5 }];
  }

  // Normalize each block vector.
  const norms = new Float32Array(nBlocks);
  for (let i = 0; i < nBlocks; i++) {
    let s = 0;
    for (let b = 0; b < nBands; b++) s += blockBands[i * nBands + b] ** 2;
    norms[i] = Math.sqrt(s) || 1;
  }
  const sim = (i: number, j: number): number => {
    let s = 0;
    for (let b = 0; b < nBands; b++) s += blockBands[i * nBands + b] * blockBands[j * nBands + b];
    return s / (norms[i] * norms[j]);
  };

  const K = Math.min(16, nBlocks >> 2); // checkerboard half-width in blocks
  const novelty = new Float32Array(nBlocks);
  for (let c = K; c < nBlocks - K; c++) {
    let score = 0;
    for (let a = 0; a < K; a++) {
      for (let b = 0; b < K; b++) {
        const within = sim(c - 1 - a, c - 1 - b) + sim(c + a, c + b);
        const across = sim(c - 1 - a, c + b) + sim(c + a, c - 1 - b);
        score += within - across;
      }
    }
    novelty[c] = score / (K * K);
  }

  const minGapBlocks = Math.round(10 / blockSec);
  const sorted = Float32Array.from(novelty).sort();
  const threshold = sorted[Math.floor(sorted.length * 0.8)];
  const bounds: number[] = [];
  for (let i = 1; i < nBlocks - 1; i++) {
    if (
      novelty[i] > threshold &&
      novelty[i] >= novelty[i - 1] &&
      novelty[i] > novelty[i + 1] &&
      (bounds.length === 0 || i - bounds[bounds.length - 1] >= minGapBlocks)
    ) {
      bounds.push(i);
    }
  }

  const edges = [0, ...bounds.map((b) => b * blockSec), durationSec];
  const sections: Section[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const startSec = edges[i];
    const endSec = edges[i + 1];
    const f0 = Math.floor(startSec / hopSec);
    const f1 = Math.min(energyCurve.length, Math.floor(endSec / hopSec));
    let e = 0;
    for (let f = f0; f < f1; f++) e += energyCurve[f];
    sections.push({
      startSec,
      endSec,
      label: null,
      energy: f1 > f0 ? e / (f1 - f0) : 0,
    });
  }
  return sections;
}
