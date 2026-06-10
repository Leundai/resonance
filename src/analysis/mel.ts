import { Fft } from './fft';

/**
 * Log-mel spectrogram matching Beat This! preprocessing exactly
 * (CPJKU beat_this/preprocessing.py): 22050 Hz mono, n_fft 1024,
 * hop 441 (50 fps), 128 slaney-scale mels over 30–11000 Hz, magnitude
 * STFT normalized by sqrt(frame_length), then log1p(1000·x).
 */

const SR = 22050;
const N_FFT = 1024;
const HOP = 441;
const N_MELS = 128;
const F_MIN = 30;
const F_MAX = 11000;

export const MEL_FPS = SR / HOP; // 50

interface MelFilter {
  start: number; // first FFT bin with nonzero weight
  weights: Float32Array;
}

function hzToMelSlaney(hz: number): number {
  return hz < 1000 ? (hz * 3) / 200 : 15 + Math.log(hz / 1000) / (Math.log(6.4) / 27);
}

function melToHzSlaney(mel: number): number {
  return mel < 15 ? (mel * 200) / 3 : 1000 * Math.exp((mel - 15) * (Math.log(6.4) / 27));
}

function buildMelFilters(): MelFilter[] {
  const nBins = N_FFT / 2 + 1;
  const binHz = SR / N_FFT;
  const melLo = hzToMelSlaney(F_MIN);
  const melHi = hzToMelSlaney(F_MAX);
  const points: number[] = [];
  for (let i = 0; i < N_MELS + 2; i++) {
    points.push(melToHzSlaney(melLo + ((melHi - melLo) * i) / (N_MELS + 1)));
  }

  const filters: MelFilter[] = [];
  for (let m = 0; m < N_MELS; m++) {
    const [lo, center, hi] = [points[m], points[m + 1], points[m + 2]];
    const start = Math.max(0, Math.ceil(lo / binHz));
    const end = Math.min(nBins - 1, Math.floor(hi / binHz));
    const weights = new Float32Array(Math.max(0, end - start + 1));
    for (let k = start; k <= end; k++) {
      const hz = k * binHz;
      weights[k - start] =
        hz <= center ? (hz - lo) / (center - lo || 1) : (hi - hz) / (hi - center || 1);
    }
    filters.push({ start, weights });
  }
  return filters;
}

/**
 * Returns time-major [nFrames * 128] float32 (ONNX input layout) and the
 * frame count. Input must already be 22050 Hz mono.
 */
export function logMelSpectrogram(mono: Float32Array): { data: Float32Array; nFrames: number } {
  const fft = new Fft(N_FFT);
  const filters = buildMelFilters();

  // torch.stft(center=True): reflect-pad by n_fft/2 on both sides.
  const pad = N_FFT / 2;
  const padded = new Float32Array(mono.length + 2 * pad);
  padded.set(mono, pad);
  for (let i = 0; i < pad; i++) {
    padded[pad - 1 - i] = mono[i + 1] ?? 0;
    padded[pad + mono.length + i] = mono[mono.length - 2 - i] ?? 0;
  }

  const nFrames = 1 + Math.floor(mono.length / HOP);
  const window = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N_FFT));

  const norm = 1 / Math.sqrt(N_FFT); // normalized='frame_length'
  const frame = new Float32Array(N_FFT);
  const mags = new Float32Array(N_FFT / 2);
  const out = new Float32Array(nFrames * N_MELS);

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N_FFT; i++) frame[i] = padded[off + i] * window[i];
    fft.magnitudes(frame, mags);

    for (let m = 0; m < N_MELS; m++) {
      const { start, weights } = filters[m];
      let s = 0;
      for (let k = 0; k < weights.length; k++) {
        // Fft.magnitudes yields bins [0, n/2); bin n/2 (nyquist) is
        // excluded — its mel weight is negligible at 11 kHz cutoff.
        const bin = start + k;
        if (bin < mags.length) s += mags[bin] * weights[k];
      }
      out[f * N_MELS + m] = Math.log1p(1000 * s * norm);
    }
  }
  return { data: out, nFrames };
}
