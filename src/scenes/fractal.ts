import * as THREE from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  color,
  float,
  mix,
  screenSize,
  screenUV,
  smoothstep,
  uniform,
  vec2,
} from 'three/tsl';
import type { FrameFeatures } from '../audio/features';
import type { Palette } from '../types/song-analysis';
import type { ParamSpec, SceneContext, VisualScene } from './scene';

const MAX_ITER = 150;

/** Curated Mandelbrot dive targets — rich structure at every depth. */
const DIVE_POINTS: [number, number][] = [
  [-0.745428, 0.113009], // seahorse valley spiral
  [-0.77568377, 0.13646737], // Misiurewicz point
  [-0.10109636, 0.95628651], // top-bulb spiral
  [0.28693186, 0.01428683], // elephant valley
];

/**
 * Animated Julia set, full-screen. The c parameter orbits the classic
 * r≈0.7885 circle (every angle is a different creature); beats pulse
 * the zoom, drops slam it and flip the gradient.
 */
export class Fractal implements VisualScene {
  readonly name = 'fractal';

  readonly params: Record<string, ParamSpec> = {
    speed: { default: 0.06, min: 0, max: 0.4 },
    warp: { default: 0.7885, min: 0.68, max: 0.92 },
    zoomRate: { default: 0.16, min: 0.02, max: 0.6 },
    brightness: { default: 0.8, min: 0, max: 2 },
    pulse: { default: 0, min: 0, max: 1 },
    fade: { default: 1, min: 0, max: 1 },
    inhale: { default: 0, min: 0, max: 1 },
    burst: { default: 0, min: 0, max: 1 },
  };

  private uC = uniform(new THREE.Vector2(0.7885, 0));
  private uZoom = uniform(1.7);
  private uCenter = uniform(new THREE.Vector2(0, 0));
  /** Cyclic band phase — beats push color waves along the filaments. */
  private uPhase = uniform(0);
  /** 0 = Julia overview (c orbits), 1 = Mandelbrot dive. */
  private uMode = uniform(0);
  private uBrightness = uniform(this.params.brightness.default);
  private uFade = uniform(1);
  private uFlip = uniform(0); // 0/1 gradient inversion, toggled on drops
  private uLow = uniform(color('#120a2e'));
  private uHigh = uniform(color('#7a5cff'));
  private uPeak = uniform(color('#ffe9f0'));

  private theta = 2.1; // start angle chosen for a pretty first frame
  private speed = this.params.speed.default;
  private zoomRate = this.params.zoomRate.default;
  private zoom = 1.7;
  private resetPending = false;
  private diving = false;
  private diveIndex = 0;
  private overviewTimer = 0;
  private warp = this.params.warp.default;
  private pulse = 0;
  private inhale = 0;
  private burst = 0;

  private mesh: THREE.Mesh | null = null;
  private ctx: SceneContext | null = null;

  private paramValues: Record<string, number> = {};

  getParam(name: string): number {
    return this.paramValues[name] ?? this.params[name]?.default ?? 0;
  }

  setParam(name: string, value: number): void {
    this.paramValues[name] = value;
    switch (name) {
      case 'speed':
        this.speed = value;
        break;
      case 'warp':
        this.warp = value;
        break;
      case 'zoomRate':
        this.zoomRate = value;
        break;
      case 'brightness':
        this.uBrightness.value = value;
        break;
      case 'pulse':
        this.pulse = value;
        break;
      case 'fade':
        this.uFade.value = value;
        break;
      case 'inhale':
        this.inhale = value;
        break;
      case 'burst':
        this.burst = value;
        break;
    }
  }

  init(ctx: SceneContext): void {
    this.ctx = ctx;

    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = Fn(() => {
      const aspect = screenSize.x.div(screenSize.y);
      const p = screenUV
        .sub(vec2(0.5, 0.5))
        .mul(vec2(aspect, 1))
        .mul(this.uZoom)
        .add(vec2(this.uCenter.x, this.uCenter.y));

      // Julia: z₀=p, c fixed. Mandelbrot: z₀=0, c=p. One mix flips modes.
      const z = mix(p, vec2(0, 0), this.uMode).toVar();
      const cc = mix(vec2(this.uC.x, this.uC.y), p, this.uMode);
      const iter = float(0).toVar();
      const escaped = float(0).toVar();
      Loop({ start: 0, end: MAX_ITER, type: 'int' }, () => {
        z.assign(
          vec2(z.x.mul(z.x).sub(z.y.mul(z.y)), z.x.mul(z.y).mul(2)).add(cc),
        );
        If(z.dot(z).greaterThan(6), () => {
          escaped.assign(1);
          Break();
        });
        iter.addAssign(1);
      });

      // Smooth (continuous) escape-time coloring.
      const m = z.dot(z).max(1.000001);
      const nu = m.log2().mul(0.5).log2();
      const smoothIter = iter.add(float(1).sub(nu));
      // Cyclic escape-time banding: depth-invariant by construction —
      // the classic infinite-zoom look. Beats advance the phase so
      // color waves flow along the filaments.
      let cyc = smoothIter.div(7).add(this.uPhase).fract();
      cyc = mix(cyc, float(1).sub(cyc), this.uFlip);
      const tri = cyc.mul(2).sub(1).abs();
      const vis = smoothstep(2, 8, smoothIter);
      // Thin glowing contour lines over a dim gradient — the classic
      // deep-zoom look; bloom does the rest.
      const line = float(1).sub(tri).pow(6);
      const base = mix(this.uLow.mul(0.3), this.uHigh.mul(0.5), cyc);
      const escapedColor = base.add(this.uPeak.mul(line).mul(0.85)).mul(vis).mul(0.55);
      // Interior of the set stays near-black for contrast.
      const c = mix(this.uLow.mul(0.1), escapedColor, escaped);
      return c.mul(this.uBrightness).mul(this.uFade);
    })();

    const geometry = new THREE.PlaneGeometry(60, 60);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    this.mesh = mesh;
    ctx.scene.add(mesh);
  }

  setVisible(v: boolean): void {
    if (this.mesh) this.mesh.visible = v;
  }

  update(f: FrameFeatures, dt: number): void {
    if (!this.mesh?.visible) return;
    const center = this.uCenter.value as THREE.Vector2;

    if (!this.diving) {
      // Julia overview: the whole set breathing, c orbiting.
      this.theta += dt * this.speed * (1 - this.inhale * 0.85);
      (this.uC.value as THREE.Vector2).set(
        this.warp * Math.cos(this.theta),
        this.warp * Math.sin(this.theta),
      );
      center.lerp(new THREE.Vector2(0, 0), Math.min(dt * 4, 1));
      this.zoom += (1.7 - this.zoom) * Math.min(dt * 3, 1);
      this.uMode.value = 0;

      // Dive on the next drop, or after ~14s of overview.
      this.overviewTimer += dt;
      if (this.burst > 0.7 || this.overviewTimer > 14) {
        this.diving = true;
        this.overviewTimer = 0;
        this.diveIndex = (this.diveIndex + 1) % DIVE_POINTS.length;
        this.zoom = 3.0;
        this.uFlip.value = 1 - (this.uFlip.value as number);
      }
    } else {
      // Mandelbrot dive: curated points are rich at every depth and
      // stay centered — the true infinite-zoom feel.
      this.uMode.value = 1;
      const [tx, ty] = DIVE_POINTS[this.diveIndex];
      center.lerp(new THREE.Vector2(tx, ty), Math.min(dt * 6, 1));
      const rate =
        (this.zoomRate * 1.6 + this.pulse * 0.3 + this.burst * 0.9) *
        (1 - this.inhale * 0.95);
      this.zoom *= Math.exp(-dt * rate);

      // f32 precision floor: surface on the next beat (musical cut).
      if (this.zoom < 1.2e-4) this.resetPending = true;
      if (this.resetPending && (f.onset || this.zoom < 5e-5)) {
        this.diving = false;
        this.resetPending = false;
        this.zoom = 1.7;
        this.uFlip.value = 1 - (this.uFlip.value as number);
      }
    }
    this.uZoom.value = this.zoom;

    // Phase drift + beat pushes: bands crawl, beats shove them.
    this.uPhase.value =
      ((this.uPhase.value as number) + dt * (0.02 + this.pulse * 0.12)) % 1;
  }

  /** Fullscreen scene: pin the camera. */
  updateCamera(camera: THREE.PerspectiveCamera): void {
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
  }

  applyPalette(p: Palette): void {
    (this.uLow.value as THREE.Color).set(p.background);
    (this.uHigh.value as THREE.Color).set(p.primary);
    (this.uPeak.value as THREE.Color).set(p.accent);
  }

  dispose(): void {
    if (this.mesh && this.ctx) {
      this.ctx.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
  }
}
