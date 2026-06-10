import * as THREE from 'three/webgpu';
import type { FrameFeatures } from '../audio/features';
import type { Palette } from '../types/song-analysis';
import { Conductor } from '../conductor/conductor';
import { DEFAULT_CONFIGS } from '../conductor/configs';
import type { DirectorPlan, SceneSpec } from '../conductor/director';
import type { SceneContext, VisualScene } from './scene';

const FADE_CALM = 1.1;
const FADE_DROP = 0.22;

// ---- OKLab (Björn Ottosson) — perceptual lerp without muddy-gray midpoints.
// THREE.Color stores linear-sRGB under color management: no transfer needed.
function rgbToOklab(c: THREE.Color): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  const m = Math.cbrt(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  const sV = Math.cbrt(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * sV,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * sV,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * sV,
  ];
}

function oklabToRgb(L: number, a: number, b: number, out: THREE.Color): void {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sV = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const cl = (x: number): number => Math.min(1, Math.max(0, x));
  out.setRGB(
    cl(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * sV),
    cl(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * sV),
    cl(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * sV),
  );
}

/**
 * Owns all scenes (kept initialized; visibility-toggled), the active
 * conductor wiring, fade transitions, and section-driven auto-switching.
 */
export class SceneManager {
  private scenes: VisualScene[] = [];
  private activeIndex = 0;
  private pendingIndex: number | null = null;
  private fade = 1; // 1 = fully visible, dips to 0 mid-transition
  private fadeSec = FADE_CALM;
  private conductor: Conductor | null = null;
  /** Energy of the section we last switched on. */
  private lastSwitchEnergy = -1;
  private directorPlan: DirectorPlan | null = null;
  private arousal = 0.5;
  /** When false (set by a manual scene switch), section boundaries stop
   *  changing scenes — the conductor keeps directing within the scene. */
  autoRotate = true;
  onAutoRotateChanged: ((on: boolean) => void) | null = null;

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
    // Jump to the plan's opening scene if it differs — unless the user
    // manually locked a scene while the plan was in flight; they win.
    if (!this.autoRotate) return;
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

  /** Absolute song intensity (emotion.arousal) → conductor temperament. */
  setIntensity(arousal: number): void {
    this.arousal = arousal;
    if (this.conductor) this.conductor.intensity = arousal;
  }

  /** Fires after a scene switch completes (for UI rebinding). */
  onSceneChanged: ((scene: VisualScene) => void) | null = null;

  get sceneNames(): string[] {
    return this.scenes.map((s) => s.name);
  }

  applyPalette(palette: Palette): void {
    for (const s of this.scenes) s.applyPalette?.(palette);
  }

  // ---- Living palette: per-section hue/sat variance, smoothly lerped ----
  private basePalette: Palette | null = null;
  private colNames = ['background', 'primary', 'secondary', 'accent'] as const;
  private currentCols = {
    background: new THREE.Color(),
    primary: new THREE.Color(),
    secondary: new THREE.Color(),
    accent: new THREE.Color(),
  };
  private targetCols = {
    background: new THREE.Color(),
    primary: new THREE.Color(),
    secondary: new THREE.Color(),
    accent: new THREE.Color(),
  };
  private paletteDirty = false;
  private paletteAccum = 0;

  /** The lerped background color — main copies this onto scene.background. */
  get paletteBackground(): THREE.Color | null {
    return this.basePalette ? this.currentCols.background : null;
  }

  setBasePalette(p: Palette): void {
    this.basePalette = p;
    for (const k of this.colNames) {
      this.currentCols[k].set(p[k]);
      this.targetCols[k].set(p[k]);
    }
    this.applyPalette(p);
  }

  /** Rotate the base palette for a section: energy warms/brightens it,
   *  a per-section wobble keeps repeats from looking identical. */
  private retargetPalette(startSec: number, energy: number): void {
    const p = this.basePalette;
    if (!p) return;
    const wobble = Math.abs((Math.sin(startSec * 12.9898) * 43758.5453) % 1);
    // Real hue travel: up to ±90° per section, energy pushes warmer.
    const dh = (energy - 0.5) * 0.2 + (wobble - 0.5) * 0.3;
    // Every other-ish section, rotate which hue plays which role —
    // primary/accent/secondary swap families instead of staying fixed.
    const rotateRoles = wobble > 0.55;
    const src: Record<string, string> = rotateRoles
      ? { background: p.background, primary: p.accent, secondary: p.primary, accent: p.secondary }
      : { background: p.background, primary: p.primary, secondary: p.secondary, accent: p.accent };
    const hsl = { h: 0, s: 0, l: 0 };
    for (const k of this.colNames) {
      const col = this.targetCols[k].set(src[k]);
      col.getHSL(hsl);
      const shift = k === 'background' ? dh * 0.5 : dh;
      col.setHSL(
        (hsl.h + shift + 1) % 1,
        Math.min(1, hsl.s * (0.88 + energy * 0.3)),
        Math.min(k === 'background' ? 0.12 : 0.85, hsl.l * (0.92 + energy * 0.22)),
      );
    }
    this.paletteDirty = true;
  }

  private updatePalette(dt: number): void {
    if (!this.basePalette || !this.paletteDirty) return;
    const k = 1 - Math.exp(-dt / 0.8);
    let maxDelta = 0;
    for (const name of this.colNames) {
      const c = this.currentCols[name];
      const t = this.targetCols[name];
      // Lerp in OKLab: hue paths stay vivid instead of sagging to gray.
      const [cl, ca, cb] = rgbToOklab(c);
      const [tl, ta, tb] = rgbToOklab(t);
      oklabToRgb(cl + (tl - cl) * k, ca + (ta - ca) * k, cb + (tb - cb) * k, c);
      maxDelta = Math.max(
        maxDelta,
        Math.abs(c.r - t.r) + Math.abs(c.g - t.g) + Math.abs(c.b - t.b),
      );
    }
    // Push to scenes at ~10 Hz while transitioning.
    this.paletteAccum += dt;
    if (this.paletteAccum > 0.1) {
      this.paletteAccum = 0;
      const hex = (c: THREE.Color): string => `#${c.getHexString()}`;
      this.applyPalette({
        ...this.basePalette,
        background: hex(this.currentCols.background),
        primary: hex(this.currentCols.primary),
        secondary: hex(this.currentCols.secondary),
        accent: hex(this.currentCols.accent),
      });
      if (maxDelta < 0.01) this.paletteDirty = false;
    }
  }

  switchTo(index: number, opts?: { manual?: boolean }): void {
    if (opts?.manual && this.autoRotate) {
      this.autoRotate = false;
      this.onAutoRotateChanged?.(false);
    }
    if (index === this.activeIndex || index < 0 || index >= this.scenes.length) return;
    this.pendingIndex = index;
    // Drops cut hard; calm switches dissolve.
    const drop = this.conductor?.signals.drop ?? 0;
    this.fadeSec = drop > 0.4 ? FADE_DROP : FADE_CALM;
  }

  setAutoRotate(on: boolean): void {
    this.autoRotate = on;
  }

  /**
   * Section-boundary hook: big energy shifts move to the scene whose
   * temperament matches — terrain for quiet, particles for mid,
   * boids for high-energy sections.
   */
  private onSection(startSec: number, energy: number): void {
    // Palette breathes with every section regardless of scene lock.
    this.retargetPalette(startSec, energy);
    // Manual scene choice wins until the user hands control back.
    if (!this.autoRotate) return;
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
    // Song-relative energy alone can't see absolute intensity: a flat-loud
    // breakcore track would idle in the mid band forever. Blend in arousal.
    const effective = energy * 0.6 + this.arousal * 0.4;
    // Two candidates per energy band; prefer whichever isn't already up.
    const band =
      effective > 0.5
        ? ['boids', 'blackhole', 'kifs', 'fractal', 'attractor']
        : effective > 0.28
          ? ['particles', 'attractor', 'blackhole', 'physarum']
          : ['terrain', 'physarum', 'kifs'];
    const pick = band.find((n) => n !== this.active.name) ?? band[0];
    const target = this.scenes.findIndex((s) => s.name === pick);
    if (target >= 0) this.switchTo(target);
  }

  update(features: FrameFeatures, dt: number): void {
    // Fade out toward a pending switch, then flip visibility and fade in.
    if (this.pendingIndex !== null) {
      this.fade = Math.max(0, this.fade - dt / this.fadeSec);
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
      this.fade = Math.min(1, this.fade + dt / this.fadeSec);
    }

    this.conductor?.update(features, dt);
    this.updatePalette(dt);
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
