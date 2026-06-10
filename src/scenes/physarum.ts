import * as THREE from 'three/webgpu';
import {
  Fn,
  color,
  float,
  hash,
  instanceIndex,
  instancedArray,
  mix,
  screenSize,
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

const AGENTS = 120_000;
const RES = 512;

/**
 * Jeff Jones physarum (2010): agents sense a trail field, steer toward
 * deposits, and lay more down; the field diffuses and decays. Deposits
 * happen by rendering agents as additive points into a ping-pong render
 * target — no atomics required. Reads as a living nebula.
 */
export class Physarum implements VisualScene {
  readonly name = 'physarum';

  readonly params: Record<string, ParamSpec> = {
    sensorAngle: { default: 0.5, min: 0.15, max: 1.2 },
    turnSpeed: { default: 3.2, min: 0.5, max: 8 },
    moveSpeed: { default: 0.045, min: 0.005, max: 0.14 },
    decay: { default: 0.965, min: 0.86, max: 0.995 },
    brightness: { default: 0.9, min: 0, max: 2.5 },
    fade: { default: 1, min: 0, max: 1 },
    inhale: { default: 0, min: 0, max: 1 },
    burst: { default: 0, min: 0, max: 1 },
  };

  private uSensorAngle = uniform(this.params.sensorAngle.default);
  private uTurnSpeed = uniform(this.params.turnSpeed.default);
  private uMoveSpeed = uniform(this.params.moveSpeed.default);
  private uDecay = uniform(this.params.decay.default);
  private uBrightness = uniform(this.params.brightness.default);
  private uFade = uniform(1);
  private uInhale = uniform(0);
  private uBurst = uniform(0);
  private uDelta = uniform(0.016);
  private uSeed = uniform(0);
  private uLow = uniform(color('#0b0721'));
  private uHigh = uniform(color('#9a6bff'));
  private uPeak = uniform(color('#ffeede'));

  private rtA: THREE.RenderTarget;
  private rtB: THREE.RenderTarget;
  /** Texture node whose .value is swapped to the current trail each frame. */
  private trailRead = texture(new THREE.Texture());
  private displayRead = texture(new THREE.Texture());

  private agentCompute: unknown = null;
  private fboScene = new THREE.Scene();
  private fboCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private diffuseQuad: THREE.Mesh | null = null;
  private depositMesh: THREE.InstancedMesh | null = null;
  private displayMesh: THREE.Mesh | null = null;
  private ctx: SceneContext | null = null;

  constructor() {
    const opts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
    };
    this.rtA = new THREE.RenderTarget(RES, RES, opts);
    this.rtB = new THREE.RenderTarget(RES, RES, opts);
  }

  private paramValues: Record<string, number> = {};

  getParam(name: string): number {
    return this.paramValues[name] ?? this.params[name]?.default ?? 0;
  }

  setParam(name: string, value: number): void {
    this.paramValues[name] = value;
    const u = {
      sensorAngle: this.uSensorAngle,
      turnSpeed: this.uTurnSpeed,
      moveSpeed: this.uMoveSpeed,
      decay: this.uDecay,
      brightness: this.uBrightness,
      fade: this.uFade,
      inhale: this.uInhale,
      burst: this.uBurst,
    }[name];
    if (u) u.value = value;
  }

  async init(ctx: SceneContext): Promise<void> {
    this.ctx = ctx;

    const positions = instancedArray(AGENTS, 'vec2'); // uv space 0..1
    const headings = instancedArray(AGENTS, 'float');

    const initCompute = Fn(() => {
      const a = hash(instanceIndex).mul(Math.PI * 2);
      const r = hash(instanceIndex.add(917)).sqrt().mul(0.25);
      positions
        .element(instanceIndex)
        .assign(vec2(0.5, 0.5).add(vec2(a.cos(), a.sin()).mul(r)));
      headings.element(instanceIndex).assign(hash(instanceIndex.add(31)).mul(Math.PI * 2));
    })().compute(AGENTS);

    // TSL node params are structurally loose; precise types fight the proxy.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sense = (pos: any, angle: any) => {
      const dir = vec2(angle.cos(), angle.sin());
      const samplePos = pos.add(dir.mul(16 / RES)).fract();
      return this.trailRead.sample(samplePos).r;
    };

    this.agentCompute = Fn(() => {
      const pos = positions.element(instanceIndex);
      const heading = headings.element(instanceIndex);

      const sa = this.uSensorAngle;
      const ahead = sense(pos, heading);
      const left = sense(pos, heading.add(sa));
      const right = sense(pos, heading.sub(sa));

      const turn = this.uTurnSpeed.mul(this.uDelta);
      // Classic steering: follow the strongest neighbor sample.
      const goLeft = left.greaterThan(ahead).and(left.greaterThan(right));
      const goRight = right.greaterThan(ahead).and(right.greaterThan(left));
      heading.addAssign(
        turn.mul(goLeft.select(float(1), goRight.select(float(-1), float(0)))),
      );
      // Constant small jitter prevents total collapse into one blob;
      // bursts shatter the field on drops.
      const jitter = hash(instanceIndex.add(this.uSeed)).sub(0.5);
      heading.addAssign(jitter.mul(this.uBurst.mul(2.5).add(0.16)));

      const speed = this.uMoveSpeed.mul(float(1).sub(this.uInhale.mul(0.85)));
      const dir = vec2(heading.cos(), heading.sin());
      pos.assign(pos.add(dir.mul(speed.mul(this.uDelta))).fract());
    })().compute(AGENTS);

    // Deposit pass: agents as additive points in the FBO scene.
    const depositMat = new THREE.SpriteNodeMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      transparent: true,
    });
    depositMat.positionNode = vec3(
      positions.toAttribute().mul(2).sub(vec2(1, 1)),
      0,
    );
    depositMat.colorNode = vec4(0.2, 0.2, 0.2, 1);
    depositMat.scaleNode = float(2 / RES);
    const depositMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      depositMat,
      AGENTS,
    );
    depositMesh.frustumCulled = false;
    depositMesh.position.z = -1;
    this.depositMesh = depositMesh;

    // Diffuse + decay pass: 3x3 blur of the previous trail.
    const diffuseMat = new THREE.MeshBasicNodeMaterial();
    diffuseMat.colorNode = Fn(() => {
      const center = this.trailRead.sample(uv()).r;
      const sum = float(0).toVar();
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const offset = vec2(dx / RES, dy / RES);
          sum.addAssign(this.trailRead.sample(uv().add(offset).fract()).r);
        }
      }
      const blurred = sum.div(9);
      // Clamp accumulation: converged lanes otherwise grow unbounded
      // and the whole field saturates to white.
      const v = mix(center, blurred, 0.35).mul(this.uDecay).clamp(0, 1.2);
      return vec4(v, v, v, 1);
    })();
    const diffuseQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), diffuseMat);
    diffuseQuad.position.z = -1;
    this.diffuseQuad = diffuseQuad;

    // Display plane in the main scene.
    const displayMat = new THREE.MeshBasicNodeMaterial();
    displayMat.colorNode = Fn(() => {
      const aspect = screenSize.x.div(screenSize.y);
      const p = screenUV.sub(vec2(0.5, 0.5)).mul(vec2(aspect, 1)).mul(0.85).add(vec2(0.5, 0.5));
      const raw = this.displayRead.sample(p.fract()).r;
      // Reinhard tone-map: dense lanes glow, never white-out the field.
      const t = raw.div(raw.mul(0.8).add(1));
      const body = smoothstep(0.04, 0.6, t);
      const c = mix(this.uLow.mul(0.2), this.uHigh, body);
      const hot = smoothstep(0.45, 0.72, t);
      return mix(c, this.uPeak, hot.mul(0.55)).mul(this.uBrightness).mul(this.uFade);
    })();
    const displayMesh = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), displayMat);
    displayMesh.frustumCulled = false;
    this.displayMesh = displayMesh;
    ctx.scene.add(displayMesh);

    await ctx.renderer.computeAsync(initCompute);
  }

  setVisible(v: boolean): void {
    if (this.displayMesh) this.displayMesh.visible = v;
  }

  update(_f: FrameFeatures, dt: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.displayMesh?.visible || !this.diffuseQuad || !this.depositMesh) return;
    this.uDelta.value = Math.min(dt, 1 / 30) * 60; // normalized to ~frame units
    this.uSeed.value = (this.uSeed.value as number + 1) % 100_000;

    // 1. Steer agents against the current trail (rtA).
    this.trailRead.value = this.rtA.texture;
    ctx.renderer.compute(this.agentCompute as Parameters<THREE.WebGPURenderer['compute']>[0]);

    // 2. Diffuse+decay rtA → rtB, then deposit agents into rtB.
    const prevTarget = ctx.renderer.getRenderTarget();
    ctx.renderer.setRenderTarget(this.rtB);
    this.fboScene.clear();
    this.fboScene.add(this.diffuseQuad);
    ctx.renderer.render(this.fboScene, this.fboCamera);
    this.fboScene.clear();
    this.fboScene.add(this.depositMesh);
    const prevAutoClear = ctx.renderer.autoClear;
    ctx.renderer.autoClear = false;
    ctx.renderer.render(this.fboScene, this.fboCamera);
    ctx.renderer.autoClear = prevAutoClear;
    ctx.renderer.setRenderTarget(prevTarget);

    // 3. Swap; display reads the freshly written trail.
    const tmp = this.rtA;
    this.rtA = this.rtB;
    this.rtB = tmp;
    this.displayRead.value = this.rtA.texture;
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
    this.rtA.dispose();
    this.rtB.dispose();
  }
}
