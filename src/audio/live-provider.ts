import type { AudioFeatureProvider, FrameFeatures } from './features';
import type { Palette } from '../types/song-analysis';

export type LiveSource = 'display' | 'mic';

/**
 * Realtime capture provider. Same FrameFeatures contract as pre-analyzed
 * playback, but computed on the fly: spectral-flux onsets with an
 * adaptive median threshold and running-max normalization (any input
 * gain works). Lookahead fields stay null — scenes degrade gracefully.
 *
 * Sources: 'display' = system/tab audio via getDisplayMedia (Chromium);
 * 'mic' = any input device via getUserMedia — including a BlackHole
 * loopback device for cross-browser system audio.
 */
export class LiveProvider implements AudioFeatureProvider {
  readonly ctx: AudioContext;
  private analyser: AnalyserNode;
  private stream: MediaStream | null = null;

  private freqData: Uint8Array<ArrayBuffer>;
  private prevSpectrum: Float32Array;
  private spectrumOut: Float32Array;
  private smoothed = { level: 0, bass: 0, mid: 0, treble: 0, centroid: 0 };
  /** Running maxima with slow decay — adaptive gain normalization. */
  private runningMax = { level: 0.1, bass: 0.1, mid: 0.1, treble: 0.1 };

  private fluxRing: number[] = [];
  private lastOnsetAt = 0;
  private startedAt = 0;

  palette: Palette | null = null;

  constructor() {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.5;
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.prevSpectrum = new Float32Array(this.analyser.frequencyBinCount);
    this.spectrumOut = new Float32Array(this.analyser.frequencyBinCount);
  }

  get isPlaying(): boolean {
    return this.stream !== null;
  }

  async start(source: LiveSource): Promise<void> {
    this.stop();
    await this.ctx.resume();
    if (source === 'display') {
      // Chromium-only: video must be requested; we discard it.
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (this.stream.getAudioTracks().length === 0) {
        this.stop();
        throw new Error('no audio track — check "Share tab audio" in the picker');
      }
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    }
    const node = this.ctx.createMediaStreamSource(this.stream);
    node.connect(this.analyser);
    this.startedAt = this.ctx.currentTime;
    this.stream.getVideoTracks().forEach((t) => t.stop());
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  frame(): FrameFeatures {
    this.analyser.getByteFrequencyData(this.freqData);
    const n = this.freqData.length;
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const t = this.ctx.currentTime - this.startedAt;

    let sum = 0;
    let weighted = 0;
    let flux = 0;
    for (let i = 0; i < n; i++) {
      const v = this.freqData[i] / 255;
      this.spectrumOut[i] = v;
      sum += v;
      weighted += v * i;
      const d = v - this.prevSpectrum[i];
      if (d > 0) flux += d;
      this.prevSpectrum[i] = v;
    }
    const centroidHz = sum > 0 ? (weighted / sum) * binHz : 0;
    const centroid = clamp01(Math.log2(Math.max(centroidHz, 100) / 100) / Math.log2(8000 / 100));

    // Adaptive-normalized bands.
    const rawLevel = sum / n;
    const rawBass = this.bandMean(20, 250, binHz);
    const rawMid = this.bandMean(250, 2000, binHz);
    const rawTreble = this.bandMean(2000, 8000, binHz);
    const level = this.normalize('level', rawLevel);
    const bass = this.normalize('bass', rawBass);
    const mid = this.normalize('mid', rawMid);
    const treble = this.normalize('treble', rawTreble);

    // Spectral-flux onset with median threshold over ~1.5 s.
    this.fluxRing.push(flux);
    if (this.fluxRing.length > 90) this.fluxRing.shift();
    const sorted = [...this.fluxRing].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] ?? 0;
    let onset = false;
    if (flux > median * 1.8 + 0.02 && t - this.lastOnsetAt > 0.12) {
      onset = true;
      this.lastOnsetAt = t;
    }

    const s = this.smoothed;
    smooth(s, 'level', level);
    smooth(s, 'bass', bass);
    smooth(s, 'mid', mid);
    smooth(s, 'treble', treble);
    smooth(s, 'centroid', centroid);

    return {
      time: t,
      level: s.level,
      bass: s.bass,
      mid: s.mid,
      treble: s.treble,
      centroid: s.centroid,
      onset,
      beatPhase: null,
      nextBeatIn: null,
      energyPercentile: null,
      section: null,
      nextSectionIn: null,
      nextSectionEnergy: null,
      spectrum: this.spectrumOut,
    };
  }

  private bandMean(loHz: number, hiHz: number, binHz: number): number {
    const lo = Math.max(1, Math.floor(loHz / binHz));
    const hi = Math.min(this.freqData.length - 1, Math.ceil(hiHz / binHz));
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += this.freqData[i];
    return sum / (hi - lo + 1) / 255;
  }

  private normalize(key: keyof LiveProvider['runningMax'], value: number): number {
    const m = this.runningMax;
    m[key] = Math.max(value, m[key] * 0.9995); // ~30 s half-life at 120fps
    return m[key] > 1e-4 ? clamp01(value / m[key]) : 0;
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function smooth(obj: Record<string, number>, key: string, target: number): void {
  const current = obj[key];
  const k = target > current ? 0.55 : 0.12;
  obj[key] = current + (target - current) * k;
}
