import type { AudioFeatureProvider, FrameFeatures } from './features';
import type { Palette } from '../types/song-analysis';

/**
 * Decoded-file playback with realtime FFT features. This is the playback
 * backbone for pre-analyzed mode: AudioBufferSourceNode gives a
 * sample-accurate clock, which the beat grid needs for lookahead.
 */
export class FilePlayer implements AudioFeatureProvider {
  readonly ctx: AudioContext;
  private analyser: AnalyserNode;
  private gainNode: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;

  private startedAt = 0; // ctx.currentTime when playback began
  private offsetSec = 0; // position within the buffer at play()
  private playing = false;

  private freqData: Uint8Array<ArrayBuffer>;
  private spectrumOut: Float32Array;
  private smoothed = { level: 0, bass: 0, mid: 0, treble: 0, centroid: 0 };

  palette: Palette | null = null;
  onEnded: (() => void) | null = null;

  constructor() {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.65;
    this.gainNode = this.ctx.createGain();
    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.spectrumOut = new Float32Array(this.analyser.frequencyBinCount);
  }

  async load(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    this.stop();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.offsetSec = 0;
    return this.buffer;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentTime(): number {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offsetSec;
    return Math.min(this.ctx.currentTime - this.startedAt + this.offsetSec, this.duration);
  }

  async play(): Promise<void> {
    if (!this.buffer || this.playing) return;
    await this.ctx.resume();
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.gainNode);
    this.source.onended = () => {
      if (this.playing && this.currentTime >= this.duration - 0.05) {
        this.playing = false;
        this.offsetSec = 0;
        this.onEnded?.();
      }
    };
    this.startedAt = this.ctx.currentTime;
    this.source.start(0, this.offsetSec);
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    this.offsetSec = this.currentTime;
    this.stop();
  }

  async toggle(): Promise<void> {
    if (this.playing) this.pause();
    else await this.play();
  }

  seek(sec: number): void {
    const wasPlaying = this.playing;
    if (this.playing) this.pause();
    this.offsetSec = Math.max(0, Math.min(sec, this.duration));
    if (wasPlaying) void this.play();
  }

  private stop(): void {
    if (this.source) {
      this.playing = false; // before stop() so onended sees an intentional stop
      try {
        this.source.stop();
      } catch {
        // already stopped
      }
      this.source.disconnect();
      this.source = null;
    }
  }

  frame(): FrameFeatures {
    this.analyser.getByteFrequencyData(this.freqData);
    const n = this.freqData.length;
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;

    let sum = 0;
    let weighted = 0;
    for (let i = 0; i < n; i++) {
      const v = this.freqData[i] / 255;
      this.spectrumOut[i] = v;
      sum += v;
      weighted += v * i;
    }
    const level = sum / n;
    const centroidHz = sum > 0 ? (weighted / sum) * binHz : 0;
    // Map centroid to 0..1 over a perceptually useful 100 Hz – 8 kHz log range.
    const centroid = clamp01(Math.log2(Math.max(centroidHz, 100) / 100) / Math.log2(8000 / 100));

    const bass = this.bandMean(20, 250, binHz);
    const mid = this.bandMean(250, 2000, binHz);
    const treble = this.bandMean(2000, 8000, binHz);

    const s = this.smoothed;
    smooth(s, 'level', level);
    smooth(s, 'bass', bass);
    smooth(s, 'mid', mid);
    smooth(s, 'treble', treble);
    smooth(s, 'centroid', centroid);

    return {
      time: this.currentTime,
      level: s.level,
      bass: s.bass,
      mid: s.mid,
      treble: s.treble,
      centroid: s.centroid,
      onset: false,
      beatPhase: null,
      nextBeatIn: null,
      energyPercentile: null,
      section: null,
      nextSectionIn: null,
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
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Fast attack, slow release — punchy but not jittery. */
function smooth(obj: Record<string, number>, key: string, target: number): void {
  const current = obj[key];
  const k = target > current ? 0.55 : 0.12;
  obj[key] = current + (target - current) * k;
}
