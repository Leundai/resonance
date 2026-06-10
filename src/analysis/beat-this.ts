import * as ort from 'onnxruntime-web/webgpu';
import { MEL_FPS, logMelSpectrogram } from './mel';

/**
 * Beat This! (Foscarin et al., ISMIR 2024, MIT) — transformer
 * beat/downbeat tracker via onnxruntime-web. Runs as a refinement pass
 * after the classical engine so playback never waits on the 83 MB
 * model download (Cache API after first fetch).
 */

const MODEL_URL =
  'https://raw.githubusercontent.com/mosynthkey/beat_this_cpp/main/onnx/beat_this.onnx';
const CACHE_NAME = 'resonance-models';
// 30 s chunks with 6 s overlap, interior halves stitched.
const CHUNK = 1500;
const OVERLAP = 300;

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/';

export interface NeuralBeats {
  beats: number[];
  downbeats: number[];
  bpm: number;
  confidence: number;
}

async function fetchModel(onProgress: (pct: number) => void): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(MODEL_URL);
  if (hit) return hit.arrayBuffer();

  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`model fetch failed: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 83_000_000;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    onProgress(Math.min(0.99, received / total));
  }
  const buf = new Uint8Array(received);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  await cache.put(MODEL_URL, new Response(buf.slice().buffer)).catch(() => {});
  return buf.buffer;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(onProgress: (pct: number) => void): Promise<ort.InferenceSession> {
  sessionPromise ??= (async () => {
    const model = await fetchModel(onProgress);
    try {
      return await ort.InferenceSession.create(model, {
        executionProviders: ['webgpu', 'wasm'],
      });
    } catch {
      return await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    }
  })();
  return sessionPromise;
}

/** Sigmoid + local-max peak picking ("minimal" postprocessor). */
function pickPeaks(logits: Float32Array, threshold: number, minGapSec: number): number[] {
  const minGap = Math.round(minGapSec * MEL_FPS);
  const times: number[] = [];
  let lastIdx = -minGap;
  for (let i = 1; i < logits.length - 1; i++) {
    const p = 1 / (1 + Math.exp(-logits[i]));
    if (p < threshold) continue;
    if (logits[i] < logits[i - 1] || logits[i] <= logits[i + 1]) continue;
    if (i - lastIdx < minGap) continue;
    times.push(i / MEL_FPS);
    lastIdx = i;
  }
  return times;
}

export async function neuralBeats(
  mono22k: Float32Array,
  onProgress: (stage: 'model' | 'infer', pct: number) => void,
): Promise<NeuralBeats> {
  const session = await getSession((pct) => onProgress('model', pct));
  const { data, nFrames } = logMelSpectrogram(mono22k);

  const inputName = session.inputNames[0];
  const beatName = session.outputNames.find((n) => n.includes('beat') && !n.includes('down'));
  const downName = session.outputNames.find((n) => n.includes('down'));

  const beatLogits = new Float32Array(nFrames).fill(-20);
  const downLogits = new Float32Array(nFrames).fill(-20);

  const step = CHUNK - OVERLAP;
  const starts: number[] = [];
  for (let s = 0; s < nFrames; s += step) {
    starts.push(s);
    if (s + CHUNK >= nFrames) break;
  }

  for (let c = 0; c < starts.length; c++) {
    const s = starts[c];
    const len = Math.min(CHUNK, nFrames - s);
    const chunk = data.subarray(s * 128, (s + len) * 128);
    const tensor = new ort.Tensor('float32', chunk, [1, len, 128]);
    const result = await session.run({ [inputName]: tensor });

    const beat = result[beatName ?? session.outputNames[0]].data as Float32Array;
    const down = result[downName ?? session.outputNames[1]].data as Float32Array;
    // Keep interior frames only (half the overlap on each stitched side).
    const keepFrom = c === 0 ? 0 : OVERLAP / 2;
    const keepTo = c === starts.length - 1 ? len : len - OVERLAP / 2;
    for (let i = keepFrom; i < keepTo; i++) {
      beatLogits[s + i] = beat[i];
      downLogits[s + i] = down[i];
    }
    onProgress('infer', (c + 1) / starts.length);
  }

  const beats = pickPeaks(beatLogits, 0.35, 0.18);
  const downbeats = pickPeaks(downLogits, 0.35, 0.6);
  if (beats.length < 8) throw new Error(`too few beats detected (${beats.length})`);

  // Tempo from the median inter-beat interval; confidence from mean prob.
  const intervals = beats.slice(1).map((t, i) => t - beats[i]).sort((a, b) => a - b);
  const median = intervals[intervals.length >> 1];
  const bpm = Math.round((60 / median) * 10) / 10;
  let probSum = 0;
  for (const t of beats) {
    const i = Math.round(t * MEL_FPS);
    probSum += 1 / (1 + Math.exp(-beatLogits[i]));
  }
  return { beats, downbeats, bpm, confidence: probSum / beats.length };
}
