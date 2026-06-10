import type * as THREE from 'three/webgpu';
import type { FrameFeatures } from '../audio/features';
import type { Palette } from '../types/song-analysis';
import { Conductor } from '../conductor/conductor';
import { DEFAULT_CONFIGS } from '../conductor/configs';
import type { SceneContext, VisualScene } from './scene';

const FADE_SEC = 0.7;

/**
 * Owns all scenes (kept initialized; visibility-toggled), the active
 * conductor wiring, fade transitions, and section-driven auto-switching.
 */
export class SceneManager {
  private scenes: VisualScene[] = [];
  private activeIndex = 0;
  private pendingIndex: number | null = null;
  private fade = 1; // 1 = fully visible, dips to 0 mid-transition
  private conductor: Conductor | null = null;
  /** Energy of the section we last switched on. */
  private lastSwitchEnergy = -1;

  async init(ctx: SceneContext, scenes: VisualScene[]): Promise<void> {
    this.scenes = scenes;
    for (const s of scenes) await s.init(ctx);
    scenes.forEach((s, i) => s.setVisible(i === this.activeIndex));

    this.conductor = new Conductor(
      scenes[this.activeIndex],
      DEFAULT_CONFIGS[scenes[this.activeIndex].name] ?? { mappings: [] },
    );
    this.conductor.onSectionChange = (_start, energy) => this.onSection(energy);
  }

  get active(): VisualScene {
    return this.scenes[this.activeIndex];
  }

  get sceneNames(): string[] {
    return this.scenes.map((s) => s.name);
  }

  applyPalette(palette: Palette): void {
    for (const s of this.scenes) s.applyPalette?.(palette);
  }

  switchTo(index: number): void {
    if (index === this.activeIndex || index < 0 || index >= this.scenes.length) return;
    this.pendingIndex = index;
  }

  /**
   * Section-boundary hook: big energy shifts move to the scene whose
   * temperament matches — terrain for quiet, particles for mid,
   * boids for high-energy sections.
   */
  private onSection(energy: number): void {
    if (this.lastSwitchEnergy >= 0 && Math.abs(energy - this.lastSwitchEnergy) < 0.18) return;
    this.lastSwitchEnergy = energy;
    const byName = (n: string): number => this.scenes.findIndex((s) => s.name === n);
    const target = energy > 0.5 ? byName('boids') : energy > 0.28 ? byName('particles') : byName('terrain');
    if (target >= 0) this.switchTo(target);
  }

  update(features: FrameFeatures, dt: number): void {
    // Fade out toward a pending switch, then flip visibility and fade in.
    if (this.pendingIndex !== null) {
      this.fade = Math.max(0, this.fade - dt / FADE_SEC);
      if (this.fade === 0) {
        this.active.setVisible(false);
        this.activeIndex = this.pendingIndex;
        this.pendingIndex = null;
        this.active.setVisible(true);
        this.conductor?.setScene(this.active);
        this.conductor?.setConfig(DEFAULT_CONFIGS[this.active.name] ?? { mappings: [] });
      }
    } else if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / FADE_SEC);
    }

    this.conductor?.update(features, dt);
    this.active.setParam('fade', this.fade);
    this.active.update(features, dt);
  }

  updateCamera(camera: THREE.PerspectiveCamera, t: number, features: FrameFeatures): boolean {
    if (this.active.updateCamera) {
      this.active.updateCamera(camera, t, features);
      return true;
    }
    return false;
  }
}
