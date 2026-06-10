import type { SongAnalysis } from '../types/song-analysis';
import type { ConductorConfig, FeatureSource, Mapping } from './conductor';
import type { ParamSpec } from '../scenes/scene';

/**
 * LLM-as-director: Claude never draws anything — it reads the song's
 * structure and emits data the conductor already understands: a scene
 * per section and feature→parameter mappings per scene. Invalid output
 * degrades to the defaults; the math stays the art.
 */

export interface DirectorPlan {
  mood: string;
  scenePlan: { startSec: number; scene: string }[];
  configs: Record<string, ConductorConfig>;
}

export interface SceneSpec {
  name: string;
  params: Record<string, ParamSpec>;
}

const FEATURES: FeatureSource[] = [
  'level',
  'bass',
  'mid',
  'treble',
  'centroid',
  'pulse',
  'beatPhase',
  'energyPercentile',
  'inhale',
  'drop',
];

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function buildPrompt(analysis: SongAnalysis, trackName: string, scenes: SceneSpec[]): string {
  const sections = analysis.sections
    .map((s) => `${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)}s energy=${s.energy.toFixed(2)}`)
    .join('\n');
  const energy = Array.from({ length: 32 }, (_, i) => {
    const idx = Math.floor((i / 32) * analysis.curves.energy.length);
    return analysis.curves.energy[idx].toFixed(2);
  }).join(',');
  const sceneSpecs = scenes
    .map(
      (s) =>
        `- ${s.name}: ${Object.entries(s.params)
          .map(([n, p]) => `${n}[${p.min},${p.max}]`)
          .join(' ')}`,
    )
    .join('\n');

  return `You are the visual director for a music visualizer. Choreograph this song.

TRACK: ${trackName}
BPM: ${analysis.tempo.bpm} · duration ${analysis.durationSec.toFixed(0)}s
SECTIONS (energy normalized 0-1 over the song):
${sections}
ENERGY CURVE (32 samples): ${energy}
PALETTE: ${analysis.palette ? analysis.palette.swatches.join(' ') : 'default'}

SCENES and their tunable params [min,max]:
${sceneSpecs}

FEATURES you can map from (all 0-1): ${FEATURES.join(', ')}.
'pulse' fires each beat, 'inhale' ramps before a louder section, 'drop' fires on its impact.

A mapping: {"feature":"bass","param":"breathe","in":[0,1],"out":[0,1],"curve":"linear|pow2|sqrt","attack":seconds,"release":seconds}.
Pick scenes that fit each section's feel (terrain/physarum = calm, particles/attractor = mid, boids/fractal = intense — but trust your read of THIS song over the rule).
Keep 'out' ranges inside each param's [min,max]. Always include inhale→inhale and drop→burst mappings where those params exist.

Respond with ONLY this JSON, no prose:
{"mood":"<3-6 words>","scenePlan":[{"startSec":0,"scene":"<name>"},...one per section...],"configs":{"<scene>":{"pulseDecay":5,"mappings":[...]} for every scene you use}}`;
}

interface DirectorOptions {
  apiKey: string;
  model: string;
}

export async function requestDirectorPlan(
  analysis: SongAnalysis,
  trackName: string,
  scenes: SceneSpec[],
  opts: DirectorOptions,
): Promise<DirectorPlan> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 3000,
      messages: [{ role: 'user', content: buildPrompt(analysis, trackName, scenes) }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`anthropic ${res.status}: ${body.slice(0, 140)}`);
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = data.content.find((c) => c.type === 'text')?.text ?? '';
  const jsonText = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const raw = JSON.parse(jsonText) as DirectorPlan;
  return validatePlan(raw, analysis, scenes);
}

/** Clamp and filter the model's output against the real scene specs. */
function validatePlan(
  raw: DirectorPlan,
  analysis: SongAnalysis,
  scenes: SceneSpec[],
): DirectorPlan {
  const byName = new Map(scenes.map((s) => [s.name, s]));

  const scenePlan = (raw.scenePlan ?? [])
    .filter(
      (e) =>
        byName.has(e.scene) &&
        typeof e.startSec === 'number' &&
        e.startSec < analysis.durationSec,
    )
    .sort((a, b) => a.startSec - b.startSec);
  if (scenePlan.length === 0) throw new Error('director: empty scene plan');

  const configs: Record<string, ConductorConfig> = {};
  for (const [sceneName, config] of Object.entries(raw.configs ?? {})) {
    const spec = byName.get(sceneName);
    if (!spec || !Array.isArray(config.mappings)) continue;
    const mappings: Mapping[] = [];
    for (const m of config.mappings) {
      const param = spec.params[m.param];
      if (!param || !FEATURES.includes(m.feature)) continue;
      const lo = Math.max(param.min, Math.min(param.max, m.out?.[0] ?? param.min));
      const hi = Math.max(param.min, Math.min(param.max, m.out?.[1] ?? param.max));
      mappings.push({
        feature: m.feature,
        param: m.param,
        in: m.in,
        out: [lo, hi],
        curve: m.curve,
        attack: clampNum(m.attack, 0, 2, 0.05),
        release: clampNum(m.release, 0, 3, 0.25),
      });
    }
    if (mappings.length > 0) {
      configs[sceneName] = { pulseDecay: clampNum(config.pulseDecay, 1, 12, 5), mappings };
    }
  }
  if (Object.keys(configs).length === 0) throw new Error('director: no valid configs');

  // Every planned scene needs a config; missing ones fall back later.
  return { mood: String(raw.mood ?? '').slice(0, 80), scenePlan, configs };
}

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
}
