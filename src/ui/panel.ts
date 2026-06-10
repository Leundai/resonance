import { Pane } from 'tweakpane';
import type { FolderApi } from 'tweakpane';
import type { SceneManager } from '../scenes/manager';
import type { VisualScene } from '../scenes/scene';
import type { SongAnalysis } from '../types/song-analysis';

/**
 * Tweakpane dev panel (toggle with backtick). Conductor tuning IS the
 * development workflow: disable the conductor, drag scene params live,
 * then bake good values back into DEFAULT_CONFIGS.
 */
export class DevPanel {
  private pane: Pane;
  private monitor = { fps: 0, pulse: 0, inhale: 0, drop: 0 };
  private info = { track: '—', bpm: 0, sections: 0, key: '—', feel: '—' };
  private settings = { conductor: true, scene: 0, autoScenes: true };
  private sceneFolder: FolderApi | null = null;
  /** Tweakpane's refresh() emits change events — guard programmatic syncs
   *  so they don't masquerade as user actions (e.g. tripping scene lock). */
  private syncing = false;

  /** LLM director settings — key persists in localStorage. */
  readonly director = {
    apiKey: localStorage.getItem('resonance.anthropicKey') ?? '',
    enabled: localStorage.getItem('resonance.directorEnabled') === 'true',
    model: localStorage.getItem('resonance.directorModel') ?? 'claude-haiku-4-5-20251001',
    status: 'idle',
    rationale: '—',
  };

  constructor(manager: SceneManager) {
    this.pane = new Pane({ title: 'resonance' });
    this.pane.hidden = true;

    this.pane.addBinding(this.monitor, 'fps', {
      readonly: true,
      view: 'graph',
      min: 0,
      max: 130,
      interval: 100,
    });
    for (const sig of ['pulse', 'inhale', 'drop'] as const) {
      this.pane.addBinding(this.monitor, sig, {
        readonly: true,
        view: 'graph',
        min: 0,
        max: 1,
        interval: 50,
      });
    }

    const song = this.pane.addFolder({ title: 'song' });
    song.addBinding(this.info, 'track', { readonly: true });
    song.addBinding(this.info, 'bpm', { readonly: true, format: (v) => v.toFixed(1) });
    song.addBinding(this.info, 'sections', { readonly: true, format: (v) => v.toFixed(0) });
    song.addBinding(this.info, 'key', { readonly: true });
    song.addBinding(this.info, 'feel', { readonly: true });

    this.pane
      .addBinding(this.settings, 'scene', {
        options: Object.fromEntries(manager.sceneNames.map((n, i) => [n, i])),
      })
      .on('change', (e) => {
        if (this.syncing) return;
        manager.switchTo(e.value, { manual: true });
      });
    this.pane
      .addBinding(this.settings, 'conductor', { label: 'conductor drives' })
      .on('change', (e) => {
        if (this.syncing) return;
        manager.setConductorEnabled(e.value);
        this.setSlidersDisabled(e.value);
      });
    this.pane
      .addBinding(this.settings, 'autoScenes', { label: 'auto scene changes' })
      .on('change', (e) => {
        if (this.syncing) return;
        manager.setAutoRotate(e.value);
      });
    manager.onAutoRotateChanged = (on) => {
      this.syncing = true;
      this.settings.autoScenes = on;
      this.pane.refresh();
      this.syncing = false;
    };

    const director = this.pane.addFolder({ title: 'director (LLM)', expanded: false });
    director
      .addBinding(this.director, 'apiKey', { label: 'anthropic key' })
      .on('change', (e) => localStorage.setItem('resonance.anthropicKey', e.value));
    director
      .addBinding(this.director, 'enabled')
      .on('change', (e) => localStorage.setItem('resonance.directorEnabled', String(e.value)));
    director
      .addBinding(this.director, 'model', {
        options: {
          'haiku 4.5': 'claude-haiku-4-5-20251001',
          'sonnet 4.6': 'claude-sonnet-4-6',
        },
      })
      .on('change', (e) => localStorage.setItem('resonance.directorModel', e.value));
    director.addBinding(this.director, 'status', { readonly: true });
    director.addBinding(this.director, 'rationale', {
      readonly: true,
      multiline: true,
      rows: 4,
    });

    this.rebindScene(manager.active);
    manager.onSceneChanged = (scene) => {
      this.syncing = true;
      this.settings.scene = manager.activeIndexValue;
      this.rebindScene(scene);
      this.pane.refresh();
      this.syncing = false;
    };

    window.addEventListener('keydown', (e) => {
      if (e.key === '`') this.pane.hidden = !this.pane.hidden;
    });
  }

  private sceneBindings: { obj: Record<string, number>; name: string; api: { disabled: boolean } }[] = [];
  private boundScene: VisualScene | null = null;

  /** Conductor-driven sliders are visible and moving but not editable —
   *  editing them while the conductor overwrites every frame is a lie. */
  private setSlidersDisabled(disabled: boolean): void {
    for (const b of this.sceneBindings) b.api.disabled = disabled;
  }

  private rebindScene(scene: VisualScene): void {
    this.sceneFolder?.dispose();
    this.sceneFolder = this.pane.addFolder({ title: `scene: ${scene.name}` });
    this.sceneBindings = [];
    this.boundScene = scene;
    for (const [name, spec] of Object.entries(scene.params)) {
      const obj = { [name]: scene.getParam(name) };
      const api = this.sceneFolder
        .addBinding(obj, name, { min: spec.min, max: spec.max })
        .on('change', (e) => {
          if (this.syncing) return;
          if (!this.settings.conductor) scene.setParam(name, e.value as number);
        });
      this.sceneBindings.push({ obj, name, api: api as unknown as { disabled: boolean } });
    }
    this.setSlidersDisabled(this.settings.conductor);
  }

  setAnalysis(track: string, analysis: SongAnalysis): void {
    this.info.track = track;
    this.info.bpm = analysis.tempo.bpm;
    this.info.sections = analysis.sections.length;
    const e = analysis.emotion;
    this.info.key = e ? `${e.key} ${e.mode}` : '—';
    this.info.feel = e
      ? `valence ${e.valence.toFixed(2)} · arousal ${e.arousal.toFixed(2)}`
      : '—';
  }

  setDirectorStatus(status: string): void {
    this.director.status = status;
    this.pane.refresh();
  }

  /** Surface the director's reasoning: rationale in the panel, the full
   *  scene-by-scene plan (with 'why' notes) in the console. */
  setDirectorPlan(plan: {
    mood: string;
    rationale: string;
    scenePlan: { startSec: number; scene: string; why?: string }[];
  }): void {
    this.director.rationale = plan.rationale || plan.mood;
    console.info(
      `[director] ${plan.mood} — ${plan.rationale}\n` +
        plan.scenePlan
          .map((e) => `  ${e.startSec.toFixed(0).padStart(4)}s → ${e.scene}${e.why ? ` (${e.why})` : ''}`)
          .join('\n'),
    );
    this.pane.refresh();
  }

  private readbackAccum = 0;

  update(fps: number, signals: { pulse: number; inhale: number; drop: number }, dt = 0.016): void {
    this.monitor.fps = fps;
    this.monitor.pulse = signals.pulse;
    this.monitor.inhale = signals.inhale;
    this.monitor.drop = signals.drop;

    if (this.pane.hidden) return;
    // Read conductor-driven values back into the sliders (~12 Hz) so the
    // panel dances with the music instead of sitting frozen.
    this.readbackAccum += dt;
    if (this.readbackAccum > 0.08 && this.settings.conductor) {
      this.readbackAccum = 0;
      const scene = this.boundScene;
      if (scene) {
        this.syncing = true;
        for (const b of this.sceneBindings) b.obj[b.name] = scene.getParam(b.name);
        this.sceneFolder?.refresh();
        this.syncing = false;
      }
    }
  }
}
