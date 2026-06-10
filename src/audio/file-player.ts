import type { AudioFeatureProvider, FrameFeatures } from './features';
import type { Palette, Section, SongAnalysis } from '../types/song-analysis';

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

  private analysis: SongAnalysis | null = null;
  private lastBeatIndex = -1;
  private lastDownbeatIndex = -1;
  private sortedEnergy: Float32Array | null = null;

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

  attachAnalysis(analysis: SongAnalysis): void {
    this.analysis = analysis;
    this.palette = analysis.palette;
    this.lastBeatIndex = -1;
    this.lastDownbeatIndex = -1;
    this.sortedEnergy = Float32Array.from(analysis.curves.energy).sort();
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

    const t = this.currentTime;
    const grid = this.beatGrid(t);

    return {
      time: t,
      level: s.level,
      bass: s.bass,
      mid: s.mid,
      treble: s.treble,
      centroid: s.centroid,
      onset: grid.onset,
      downbeat: this.downbeatCrossing(t),
      beatPhase: grid.beatPhase,
      nextBeatIn: grid.nextBeatIn,
      energyPercentile: this.energyPercentile(t),
      section: grid.section,
      nextSectionIn: grid.nextSectionIn,
      nextSectionEnergy: grid.nextSectionEnergy,
      spectrum: this.spectrumOut,
    };
  }

  /** Fires true exactly once when t crosses a downbeat. */
  private downbeatCrossing(t: number): boolean {
    const downs = this.analysis?.downbeats;
    if (!downs || downs.length === 0) return false;
    let lo = 0;
    let hi = downs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (downs[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const idx = downs[lo] <= t ? lo : -1;
    const fired = idx !== this.lastDownbeatIndex && idx >= 0 && t - downs[idx] < 0.1;
    if (idx !== this.lastDownbeatIndex) this.lastDownbeatIndex = idx;
    return fired;
  }

  private beatGrid(t: number): {
    onset: boolean;
    beatPhase: number | null;
    nextBeatIn: number | null;
    section: Section | null;
    nextSectionIn: number | null;
    nextSectionEnergy: number | null;
  } {
    const a = this.analysis;
    if (!a || a.beats.length < 2) {
      return {
        onset: false,
        beatPhase: null,
        nextBeatIn: null,
        section: null,
        nextSectionIn: null,
        nextSectionEnergy: null,
      };
    }

    // Index of the last beat at or before t.
    let lo = 0;
    let hi = a.beats.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a.beats[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const beatIndex = a.beats[lo] <= t ? lo : -1;

    const prev = beatIndex >= 0 ? a.beats[beatIndex] : 0;
    const next = a.beats[Math.min(beatIndex + 1, a.beats.length - 1)];
    const span = Math.max(next - prev, 1e-3);
    const beatPhase = Math.min(1, Math.max(0, (t - prev) / span));
    const nextBeatIn = Math.max(0, next - t);

    // Fire onset exactly once per beat crossing (and not on seek jumps).
    const onset = beatIndex !== this.lastBeatIndex && beatIndex >= 0 && t - prev < 0.1;
    if (beatIndex !== this.lastBeatIndex) this.lastBeatIndex = beatIndex;

    let section: Section | null = null;
    let nextSectionIn: number | null = null;
    let nextSectionEnergy: number | null = null;
    for (let i = 0; i < a.sections.length; i++) {
      const sec = a.sections[i];
      if (t >= sec.startSec && t < sec.endSec) {
        section = sec;
        nextSectionIn = sec.endSec - t;
        nextSectionEnergy = a.sections[i + 1]?.energy ?? null;
        break;
      }
    }
    return { onset, beatPhase, nextBeatIn, section, nextSectionIn, nextSectionEnergy };
  }

  private energyPercentile(t: number): number | null {
    const a = this.analysis;
    const sorted = this.sortedEnergy;
    if (!a || !sorted || sorted.length === 0) return null;
    const idx = Math.min(a.curves.energy.length - 1, Math.floor(t / a.curves.hopSec));
    const value = a.curves.energy[idx];
    // Rank via binary search in the sorted copy.
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo / sorted.length;
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
