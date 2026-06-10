import { neuralBeats } from './beat-this';
import { analyzeAudio } from './dsp';
import type { AnalysisProgress } from '../types/song-analysis';

export interface AnalyzeRequest {
  /** 22050 Hz mono (Beat This! native rate; classical DSP adapts). */
  mono: Float32Array;
  sampleRate: number;
  contentHash: string;
}

self.onmessage = async (e: MessageEvent<AnalyzeRequest>) => {
  const { mono, sampleRate, contentHash } = e.data;
  const post = (p: AnalysisProgress): void => {
    (self as unknown as Worker).postMessage(p);
  };
  let analysis;
  try {
    analysis = analyzeAudio(mono, sampleRate, contentHash, post);
    post({ stage: 'done', analysis });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      stage: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Neural refinement: playback is already running on the classical
  // grid; swap in the transformer's beats when they're ready.
  try {
    const neural = await neuralBeats(mono, (stage, pct) => post({ stage, pct }));
    post({
      stage: 'refined',
      analysis: {
        ...analysis,
        engine: 'beat-this@onnx + classical-dsp@1',
        tempo: { bpm: neural.bpm, confidence: neural.confidence },
        beats: neural.beats,
        downbeats: neural.downbeats,
      },
    });
  } catch (err) {
    // Classical result stands; surface why refinement was skipped.
    console.warn('[resonance] neural beats unavailable:', err);
    post({ stage: 'refined', analysis });
  }
};
