import { analyzeAudio } from './dsp';
import type { AnalysisProgress } from '../types/song-analysis';

export interface AnalyzeRequest {
  mono: Float32Array;
  sampleRate: number;
  contentHash: string;
}

self.onmessage = (e: MessageEvent<AnalyzeRequest>) => {
  const { mono, sampleRate, contentHash } = e.data;
  const post = (p: AnalysisProgress): void => {
    (self as unknown as Worker).postMessage(p);
  };
  try {
    const analysis = analyzeAudio(mono, sampleRate, contentHash, post);
    post({ stage: 'done', analysis });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      stage: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
