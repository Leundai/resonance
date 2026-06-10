import * as THREE from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  color,
  float,
  mix,
  normalize,
  screenUV,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { FrameFeatures } from '../audio/features';
import type { Palette } from '../types/song-analysis';
import type { ParamSpec, SceneContext, VisualScene } from './scene';

// Fixed half-res target; bloom hides the upscale.
const RT_W = 960;
const RT_H = 540;
const FOLD_ITERS = 7;
const MARCH_STEPS = 70;

/**
 * Raymarched kaleidoscopic IFS (Knighty-style sierpinski fold with a
 * music-driven rotation inside the loop). The fold angle is the
 * instrument: tiny changes rebuild the entire cathedral.
 */
export class Kifs implements VisualScene {
  readonly name = 'kifs';

  readonly params: Record<string, ParamSpec> = {
    foldDrift: { default: 0.02, min: 0, max: 0.2 },
    scale: { default: 2.0, min: 1.9, max: 2.45 },
    twist: { default: 0, min: 0, max: 1 },
    brightness: { default: 0.9, min: 0, max: 2.5 },
    fade: { default: 1, min: 0, max: 1 },
    inhale: { default: 0, min: 0, max: 1 },
    burst: { default: 0, min: 0, max: 1 },
  };

  private uAngle = uniform(0.35);
  private uScale = uniform(this.params.scale.default);
  private uCamPos = uniform(new THREE.Vector3(0, 0.6, 2.8));
  private uBrightness = uniform(this.params.brightness.default);
  private uFade = uniform(1);
  private uLow = uniform(color('#1a0f33'));
  private uHigh = uniform(color('#b388ff'));
  private uPeak = uniform(color('#fff1e0'));

  private foldDrift = this.params.foldDrift.default;
  private twist = 0;
  private inhale = 0;
  private burst = 0;
  private time = 0;

  private rt: THREE.RenderTarget;
  private fboScene = new THREE.Scene();
  private fboCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private marchQuad: THREE.Mesh | null = null;
  private displayMesh: THREE.Mesh | null = null;
  private displayRead = texture(new THREE.Texture());
  private ctx: SceneContext | null = null;

  constructor() {
    this.rt = new THREE.RenderTarget(RT_W, RT_H, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
  }

  private paramValues: Record<string, number> = {};

  getParam(name: string): number {
    return this.paramValues[name] ?? this.params[name]?.default ?? 0;
  }

  setParam(name: string, value: number): void {
    this.paramValues[name] = value;
    switch (name) {
      case 'foldDrift':
        this.foldDrift = value;
        break;
      case 'scale':
        this.uScale.value = value;
        break;
      case 'twist':
        this.twist = value;
        break;
      case 'brightness':
        this.uBrightness.value = value;
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
      // Virtual camera ray from the fbo quad's uv.
      const ndc = uv().mul(2).sub(vec2(1, 1)).mul(vec2(RT_W / RT_H, 1));
      const ro = vec3(this.uCamPos.x, this.uCamPos.y, this.uCamPos.z);
      const fwd = normalize(ro.negate());
      const right = normalize(vec3(fwd.z, 0, fwd.x.negate()));
      const up = right.cross(fwd);
      const rd = normalize(fwd.add(right.mul(ndc.x.mul(0.8))).add(up.mul(ndc.y.mul(0.8))));

      const cosA = this.uAngle.cos();
      const sinA = this.uAngle.sin();
      const scaleM1 = this.uScale.sub(1);

      // Sierpinski-style KIFS distance estimator with orbit trap.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = (pIn: any) => {
        const p = pIn.toVar();
        const trap = float(1e9).toVar();
        for (let i = 0; i < FOLD_ITERS; i++) {
          p.assign(p.abs());
          // Sort components descending via whole-vector assigns —
          // component-swizzle writes don't take inside If closures.
          If(p.x.lessThan(p.y), () => {
            p.assign(p.yxz);
          });
          If(p.x.lessThan(p.z), () => {
            p.assign(p.zyx);
          });
          If(p.y.lessThan(p.z), () => {
            p.assign(p.xzy);
          });
          // Music-driven rotation in the xy plane.
          const rx = p.x.mul(cosA).sub(p.y.mul(sinA));
          const ry = p.x.mul(sinA).add(p.y.mul(cosA));
          p.assign(vec3(rx, ry, p.z));
          p.assign(p.mul(this.uScale).sub(vec3(1, 1, 0.5).mul(scaleM1)));
          trap.assign(trap.min(p.length()));
        }
        // Box DE keeps the set solid enough to actually hit at half-res.
        const q = p.abs().sub(vec3(1, 1, 1));
        const boxDist = q.x.max(q.y).max(q.z);
        const dist = boxDist.mul(this.uScale.pow(-FOLD_ITERS));
        return { dist, trap };
      };

      const t = float(0).toVar();
      const steps = float(0).toVar();
      const trapOut = float(0).toVar();
      const hit = float(0).toVar();
      Loop({ start: 0, end: MARCH_STEPS, type: 'int' }, () => {
        const pos = ro.add(rd.mul(t));
        const m = map(pos);
        trapOut.assign(m.trap);
        If(m.dist.lessThan(0.002), () => {
          hit.assign(1);
          Break();
        });
        If(t.greaterThan(8), () => {
          Break();
        });
        t.addAssign(m.dist.mul(0.85));
        steps.addAssign(1);
      });

      // Iteration-count glow doubles as cheap AO at the surface.
      const edge = steps.div(MARCH_STEPS);
      const trapT = smoothstep(0.0, 2.2, trapOut);
      const surface = mix(this.uLow, this.uHigh, trapT);
      const lit = mix(surface.mul(0.15), surface, float(1).sub(edge).pow(2));
      const glow = this.uPeak.mul(edge.pow(3)).mul(0.45);
      const fog = smoothstep(3, 9, t);
      let c = mix(lit.add(glow.mul(0.25)), this.uLow.mul(0.04), fog);
      c = mix(this.uLow.mul(0.03).add(glow), c, hit);
      return vec4(c.mul(this.uBrightness), 1);
    })();

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.position.z = -1;
    this.marchQuad = quad;
    this.fboScene.add(quad);

    const displayMat = new THREE.MeshBasicNodeMaterial();
    this.displayRead.value = this.rt.texture;
    displayMat.colorNode = Fn(() => {
      return this.displayRead.sample(screenUV).rgb.mul(this.uFade);
    })();
    const displayMesh = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), displayMat);
    displayMesh.frustumCulled = false;
    this.displayMesh = displayMesh;
    ctx.scene.add(displayMesh);
  }

  setVisible(v: boolean): void {
    if (this.displayMesh) this.displayMesh.visible = v;
  }

  update(_f: FrameFeatures, dt: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.displayMesh?.visible || !this.marchQuad) return;
    this.time += dt;

    // Fold angle: slow drift + twist bias + drop kick. Inhale freezes.
    const drift = this.foldDrift * (1 - this.inhale * 0.9);
    this.uAngle.value =
      (this.uAngle.value as number) + dt * (drift + this.burst * 0.5) + 0;
    const targetScale =
      (this.params.scale.default + this.twist * 0.3) * (1 + this.burst * 0.06);
    this.uScale.value += (targetScale - (this.uScale.value as number)) * Math.min(dt * 6, 1);

    const orbT = this.time * 0.06;
    (this.uCamPos.value as THREE.Vector3).set(
      Math.sin(orbT) * 2.8,
      0.6 + Math.sin(this.time * 0.043) * 0.5,
      Math.cos(orbT) * 2.8,
    );

    const prev = ctx.renderer.getRenderTarget();
    ctx.renderer.setRenderTarget(this.rt);
    ctx.renderer.render(this.fboScene, this.fboCamera);
    ctx.renderer.setRenderTarget(prev);
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
    if (this.displayMesh && this.ctx) {
      this.ctx.scene.remove(this.displayMesh);
      this.displayMesh.geometry.dispose();
      (this.displayMesh.material as THREE.Material).dispose();
    }
    this.rt.dispose();
  }
}
