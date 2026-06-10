import { openDB, type IDBPDatabase } from 'idb';
import type { AnalysisProgress, SongAnalysis } from '../types/song-analysis';
import { SONG_ANALYSIS_VERSION } from '../types/song-analysis';
import type { AnalyzeRequest } from './worker';

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB('resonance', 1, {
    upgrade(d) {
      d.createObjectStore('analysis');
    },
  });
  return dbPromise;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getCachedAnalysis(hash: string): Promise<SongAnalysis | null> {
  const hit = (await (await db()).get('analysis', hash)) as SongAnalysis | undefined;
  return hit && hit.version === SONG_ANALYSIS_VERSION ? hit : null;
}

export async function cacheAnalysis(a: SongAnalysis): Promise<void> {
  await (await db()).put('analysis', a, a.contentHash);
}

/** Mix an AudioBuffer down to mono and analyze it off-thread. */
export function analyzeInWorker(
  buffer: AudioBuffer,
  contentHash: string,
  onProgress: (p: AnalysisProgress) => void,
): Promise<SongAnalysis> {
  const mono = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<AnalysisProgress | { stage: 'error'; message: string }>) => {
      const msg = e.data;
      if (msg.stage === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      } else if (msg.stage === 'done') {
        worker.terminate();
        resolve(msg.analysis);
      } else {
        onProgress(msg);
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    const req: AnalyzeRequest = { mono, sampleRate: buffer.sampleRate, contentHash };
    worker.postMessage(req, [mono.buffer]);
  });
}
