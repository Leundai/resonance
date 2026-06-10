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

const MAX_ITER = 110;

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
    brightness: { default: 0.8, min: 0, max: 2 },
    pulse: { default: 0, min: 0, max: 1 },
    fade: { default: 1, min: 0, max: 1 },
    inhale: { default: 0, min: 0, max: 1 },
    burst: { default: 0, min: 0, max: 1 },
  };

  private uC = uniform(new THREE.Vector2(0.7885, 0));
  private uZoom = uniform(1.7);
  private uBrightness = uniform(this.params.brightness.default);
  private uFade = uniform(1);
  private uFlip = uniform(0); // 0/1 gradient inversion, toggled on drops
  private uLow = uniform(color('#120a2e'));
  private uHigh = uniform(color('#7a5cff'));
  private uPeak = uniform(color('#ffe9f0'));

  private theta = 2.1; // start angle chosen for a pretty first frame
  private speed = this.params.speed.default;
  private warp = this.params.warp.default;
  private pulse = 0;
  private inhale = 0;
  private burst = 0;
  private lastBurst = 0;

  private mesh: THREE.Mesh | null = null;
  private ctx: SceneContext | null = null;

  setParam(name: string, value: number): void {
    switch (name) {
      case 'speed':
        this.speed = value;
        break;
      case 'warp':
        this.warp = value;
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
        .mul(this.uZoom);

      const z = p.toVar();
      const iter = float(0).toVar();
      const escaped = float(0).toVar();
      Loop({ start: 0, end: MAX_ITER, type: 'int' }, () => {
        z.assign(
          vec2(z.x.mul(z.x).sub(z.y.mul(z.y)), z.x.mul(z.y).mul(2)).add(
            vec2(this.uC.x, this.uC.y),
          ),
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
      const smoothIter = iter.add(float(1).sub(nu)).clamp(0, MAX_ITER);
      let t = smoothIter.div(MAX_ITER);
      t = mix(t, float(1).sub(t), this.uFlip);

      // Deep darks away from the set; the boundary burns bright.
      // Escape times cluster at t≈0.1–0.45, so the windows sit there.
      const body = smoothstep(0.02, 0.28, t);
      const gradient = mix(this.uLow.mul(0.25), this.uHigh, body);
      const peak = smoothstep(0.24, 0.6, t);
      const escapedColor = mix(gradient, this.uPeak, peak.mul(0.9));
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

  update(_f: FrameFeatures, dt: number): void {
    if (!this.mesh?.visible) return;

    // c orbits; inhale slows the world, burst kicks it forward.
    const speedNow = this.speed * (1 - this.inhale * 0.85) + this.burst * 0.25;
    this.theta += dt * speedNow;
    const r = this.warp;
    (this.uC.value as THREE.Vector2).set(r * Math.cos(this.theta), r * Math.sin(this.theta));

    // Zoom: beats breathe in, drops slam; inhale pulls back slightly.
    const targetZoom =
      1.7 * (1 - this.pulse * 0.06 - this.burst * 0.35 + this.inhale * 0.12);
    this.uZoom.value += (targetZoom - (this.uZoom.value as number)) * Math.min(dt * 8, 1);

    // Flip the gradient once per drop impact.
    if (this.burst > 0.7 && this.lastBurst <= 0.7) {
      this.uFlip.value = 1 - (this.uFlip.value as number);
    }
    this.lastBurst = this.burst;
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
