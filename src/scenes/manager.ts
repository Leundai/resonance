import type * as THREE from 'three/webgpu';
import type { FrameFeatures } from '../audio/features';
import type { Palette } from '../types/song-analysis';
import { Conductor } from '../conductor/conductor';
import { DEFAULT_CONFIGS } from '../conductor/configs';
import type { DirectorPlan, SceneSpec } from '../conductor/director';
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
  private directorPlan: DirectorPlan | null = null;

  async init(ctx: SceneContext, scenes: VisualScene[]): Promise<void> {
    this.scenes = scenes;
    for (const s of scenes) await s.init(ctx);
    scenes.forEach((s, i) => s.setVisible(i === this.activeIndex));

    this.conductor = new Conductor(
      scenes[this.activeIndex],
      this.configFor(scenes[this.activeIndex].name),
    );
    this.conductor.onSectionChange = (start, energy) => this.onSection(start, energy);
  }

  private configFor(name: string) {
    return this.directorPlan?.configs[name] ?? DEFAULT_CONFIGS[name] ?? { mappings: [] };
  }

  get sceneSpecs(): SceneSpec[] {
    return this.scenes.map((s) => ({ name: s.name, params: s.params }));
  }

  applyDirectorPlan(plan: DirectorPlan): void {
    this.directorPlan = plan;
    this.conductor?.setConfig(this.configFor(this.active.name));
    // Jump to the plan's opening scene if it differs.
    const opening = plan.scenePlan[0];
    if (opening && opening.scene !== this.active.name) {
      this.switchTo(this.scenes.findIndex((s) => s.name === opening.scene));
    }
  }

  clearDirectorPlan(): void {
    this.directorPlan = null;
    this.conductor?.setConfig(this.configFor(this.active.name));
  }

  get active(): VisualScene {
    return this.scenes[this.activeIndex];
  }

  get signals(): { pulse: number; downbeat: number; inhale: number; drop: number } {
    return this.conductor?.signals ?? { pulse: 0, downbeat: 0, inhale: 0, drop: 0 };
  }

  get activeIndexValue(): number {
    return this.activeIndex;
  }

  setConductorEnabled(on: boolean): void {
    if (this.conductor) this.conductor.enabled = on;
  }

  /** Fires after a scene switch completes (for UI rebinding). */
  onSceneChanged: ((scene: VisualScene) => void) | null = null;

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
  private onSection(startSec: number, energy: number): void {
    // Director plan takes precedence over the energy-band heuristic.
    if (this.directorPlan) {
      const entry = this.directorPlan.scenePlan.find((e) => Math.abs(e.startSec - startSec) < 2);
      if (entry) {
        const target = this.scenes.findIndex((s) => s.name === entry.scene);
        if (target >= 0) this.switchTo(target);
        return;
      }
    }
    if (this.lastSwitchEnergy >= 0 && Math.abs(energy - this.lastSwitchEnergy) < 0.18) return;
    this.lastSwitchEnergy = energy;
    // Two candidates per energy band; prefer whichever isn't already up.
    const band =
      energy > 0.5
        ? ['boids', 'kifs', 'fractal', 'attractor']
        : energy > 0.28
          ? ['particles', 'attractor', 'physarum']
          : ['terrain', 'physarum', 'kifs'];
    const pick = band.find((n) => n !== this.active.name) ?? band[0];
    const target = this.scenes.findIndex((s) => s.name === pick);
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
        this.conductor?.setConfig(this.configFor(this.active.name));
        this.onSceneChanged?.(this.active);
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
