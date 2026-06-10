import * as THREE from 'three/webgpu';
import {
  color,
  float,
  mix,
  mx_noise_float,
  positionLocal,
  positionView,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import type { FrameFeatures } from '../audio/features';
import type { Palette } from '../types/song-analysis';
import type { ParamSpec, SceneContext, VisualScene } from './scene';

const SIZE = 90;
const SEGMENTS = 320;

/**
 * FBM-displaced plane, domain-scrolled toward the camera — the direct
 * descendant of both predecessors' terrains. Bass roughens the relief,
 * centroid adds fine detail, the beat grid drives the scroll.
 */
export class Terrain implements VisualScene {
  readonly name = 'terrain';

  readonly params: Record<string, ParamSpec> = {
    amplitude: { default: 2.2, min: 0.2, max: 6 },
    detail: { default: 0.3, min: 0, max: 1 },
    scrollSpeed: { default: 2.5, min: 0, max: 12 },
    glow: { default: 0.7, min: 0, max: 2.5 },
    fade: { default: 1, min: 0, max: 1 },
    inhale: { default: 0, min: 0, max: 1 },
    burst: { default: 0, min: 0, max: 1 },
  };

  private uAmplitude = uniform(this.params.amplitude.default);
  private uDetail = uniform(this.params.detail.default);
  private uGlow = uniform(this.params.glow.default);
  private uFade = uniform(1);
  private uInhale = uniform(0);
  private uBurst = uniform(0);
  private uScroll = uniform(0);
  private uLow = uniform(color('#1a1240'));
  private uHigh = uniform(color('#ff7edb'));
  private uPeak = uniform(color('#fff7d6'));

  private scrollSpeed = this.params.scrollSpeed.default;
  private mesh: THREE.Mesh | null = null;
  private ctx: SceneContext | null = null;

  private paramValues: Record<string, number> = {};

  getParam(name: string): number {
    return this.paramValues[name] ?? this.params[name]?.default ?? 0;
  }

  setParam(name: string, value: number): void {
    this.paramValues[name] = value;
    switch (name) {
      case 'amplitude':
        this.uAmplitude.value = value;
        break;
      case 'detail':
        this.uDetail.value = value;
        break;
      case 'scrollSpeed':
        this.scrollSpeed = value;
        break;
      case 'glow':
        this.uGlow.value = value;
        break;
      case 'fade':
        this.uFade.value = value;
        break;
      case 'inhale':
        this.uInhale.value = value;
        break;
      case 'burst':
        this.uBurst.value = value;
        break;
    }
  }

  init(ctx: SceneContext): void {
    this.ctx = ctx;

    const p = vec3(
      positionLocal.x.mul(0.045),
      positionLocal.y.mul(0.045).add(this.uScroll),
      0,
    );
    const base = mx_noise_float(p);
    const mid = mx_noise_float(p.mul(2.7)).mul(0.45);
    const fine = mx_noise_float(p.mul(7.1)).mul(0.22).mul(this.uDetail);
    // Ridge the base octave for valley/crest contrast.
    const ridged = float(1).sub(base.abs().mul(1.6));
    // Inhale flattens the world; the drop slams it back up.
    const dropShape = float(1).sub(this.uInhale.mul(0.6)).add(this.uBurst.mul(0.9));
    const h = ridged.mul(0.6).add(mid).add(fine).mul(this.uAmplitude).mul(dropShape);

    const material = new THREE.MeshBasicNodeMaterial();
    material.positionNode = vec3(positionLocal.x, positionLocal.y, h);

    const hN = h.div(this.uAmplitude.max(0.001)); // -1..1-ish
    const slope = smoothstep(0.1, 1.05, hN);
    let c = mix(this.uLow, this.uHigh, slope);
    c = mix(c, this.uPeak, smoothstep(0.8, 1.05, hN).mul(this.uGlow.add(this.uBurst.mul(1.2))));
    // Topographic contour lines — the heightfield's native articulation.
    // Glow rides the beat; drops flood the map with lines.
    const contour = smoothstep(0.08, 0.02, hN.mul(7).fract().sub(0.5).abs());
    c = c.add(
      this.uPeak.mul(contour).mul(slope.mul(0.6).add(0.15)).mul(this.uGlow.mul(0.35).add(this.uBurst.mul(0.5))),
    );
    // Distance haze toward background.
    const depth = positionView.z.negate();
    const haze = smoothstep(14, 55, depth);
    c = mix(c, color('#050510'), haze);
    material.colorNode = c.mul(this.uFade);

    const geometry = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -4;
    mesh.frustumCulled = false;
    this.mesh = mesh;
    ctx.scene.add(mesh);
  }

  setVisible(v: boolean): void {
    if (this.mesh) this.mesh.visible = v;
  }

  update(_f: FrameFeatures, dt: number): void {
    this.uScroll.value += dt * this.scrollSpeed * 0.045;
  }

  /** Terrain frames its own camera: low flight over the relief. */
  updateCamera(camera: THREE.PerspectiveCamera, t: number): void {
    camera.position.set(Math.sin(t * 0.1) * 6, 4.5 + Math.sin(t * 0.23) * 1.2, 26);
    camera.lookAt(0, -1, -10);
  }

  setPalette(low: string, high: string, peak?: string): void {
    (this.uLow.value as THREE.Color).set(low);
    (this.uHigh.value as THREE.Color).set(high);
    if (peak) (this.uPeak.value as THREE.Color).set(peak);
  }

  applyPalette(p: Palette): void {
    this.setPalette(p.background, p.primary, p.accent);
  }

  dispose(): void {
    if (this.mesh && this.ctx) {
      this.ctx.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
  }
}
