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
  private settings = { conductor: true, scene: 0 };
  private sceneFolder: FolderApi | null = null;

  /** LLM director settings — key persists in localStorage. */
  readonly director = {
    apiKey: localStorage.getItem('resonance.anthropicKey') ?? '',
    enabled: localStorage.getItem('resonance.directorEnabled') === 'true',
    model: localStorage.getItem('resonance.directorModel') ?? 'claude-haiku-4-5-20251001',
    status: 'idle',
  };

  constructor(manager: SceneManager) {
    this.pane = new Pane({ title: 'resonance' });
    this.pane.hidden = true;

    this.pane.addBinding(this.monitor, 'fps', { readonly: true, format: (v) => v.toFixed(0) });
    this.pane.addBinding(this.monitor, 'pulse', { readonly: true, min: 0, max: 1 });
    this.pane.addBinding(this.monitor, 'inhale', { readonly: true, min: 0, max: 1 });
    this.pane.addBinding(this.monitor, 'drop', { readonly: true, min: 0, max: 1 });

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
      .on('change', (e) => manager.switchTo(e.value));
    this.pane
      .addBinding(this.settings, 'conductor', { label: 'conductor drives' })
      .on('change', (e) => manager.setConductorEnabled(e.value));

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

    this.rebindScene(manager.active);
    manager.onSceneChanged = (scene) => {
      this.settings.scene = manager.activeIndexValue;
      this.rebindScene(scene);
      this.pane.refresh();
    };

    window.addEventListener('keydown', (e) => {
      if (e.key === '`') this.pane.hidden = !this.pane.hidden;
    });
  }

  private rebindScene(scene: VisualScene): void {
    this.sceneFolder?.dispose();
    this.sceneFolder = this.pane.addFolder({ title: `scene: ${scene.name}` });
    for (const [name, spec] of Object.entries(scene.params)) {
      const obj = { [name]: spec.default };
      this.sceneFolder
        .addBinding(obj, name, { min: spec.min, max: spec.max })
        .on('change', (e) => scene.setParam(name, e.value as number));
    }
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

  update(fps: number, signals: { pulse: number; inhale: number; drop: number }): void {
    if (this.pane.hidden) return;
    this.monitor.fps = fps;
    this.monitor.pulse = signals.pulse;
    this.monitor.inhale = signals.inhale;
    this.monitor.drop = signals.drop;
  }
}
