import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  atan,
  cameraViewMatrix,
  color,
  float,
  hash,
  instanceIndex,
  instancedArray,
  mix,
  mx_noise_vec3,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { FrameFeatures } from '../audio/features';
import type { Palette } from '../types/song-analysis';
import type { ParamSpec, SceneContext, VisualScene } from './scene';

const COUNT = 160_000;

/**
 * Curl-ish noise flow-field particles on GPU compute. All reactivity
 * arrives through conductor-driven params.
 */
export class ParticleField implements VisualScene {
  readonly name = 'particles';

  readonly params: Record<string, ParamSpec> = {
    turbulence: { default: 0.8, min: 0, max: 5 },
    breathe: { default: 0, min: 0, max: 1 },
    brightness: { default: 0.5, min: 0, max: 2.5 },
    pulse: { default: 0, min: 0, max: 1 },
    drift: { default: 0.5, min: 0, max: 2 },
    fade: { default: 1, min: 0, max: 1 },
    inhale: { default: 0, min: 0, max: 1 },
    burst: { default: 0, min: 0, max: 1 },
  };

  private uTime = uniform(0);
  private uDelta = uniform(0.016);
  private uTurbulence = uniform(this.params.turbulence.default);
  private uBreathe = uniform(this.params.breathe.default);
  private uBrightness = uniform(this.params.brightness.default);
  private uPulse = uniform(this.params.pulse.default);
  private uDrift = uniform(this.params.drift.default);
  private uFade = uniform(1);
  private uInhale = uniform(0);
  private uBurst = uniform(0);
  private uColorA = uniform(color('#4a7cff'));
  private uColorB = uniform(color('#ff5ec4'));

  private mesh: THREE.InstancedMesh | null = null;
  private updateCompute: unknown = null;
  private ctx: SceneContext | null = null;

  private paramValues: Record<string, number> = {};

  getParam(name: string): number {
    return this.paramValues[name] ?? this.params[name]?.default ?? 0;
  }

  setParam(name: string, value: number): void {
    this.paramValues[name] = value;
    switch (name) {
      case 'turbulence':
        this.uTurbulence.value = value;
        break;
      case 'breathe':
        this.uBreathe.value = value;
        break;
      case 'brightness':
        this.uBrightness.value = value;
        break;
      case 'pulse':
        this.uPulse.value = value;
        break;
      case 'drift':
        this.uDrift.value = value;
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

  async init(ctx: SceneContext): Promise<void> {
    this.ctx = ctx;

    const positions = instancedArray(COUNT, 'vec3');
    const velocities = instancedArray(COUNT, 'vec3');
    const seeds = instancedArray(COUNT, 'float');

    const initCompute = Fn(() => {
      const seed = hash(instanceIndex);
      const seed2 = hash(instanceIndex.add(91827));
      const seed3 = hash(instanceIndex.add(481516));

      // Random point in a shell between r=4 and r=11.
      const theta = seed.mul(Math.PI * 2);
      const phi = seed2.mul(2).sub(1).acos();
      const r = seed3.mul(7).add(4);
      const pos = vec3(
        r.mul(phi.sin()).mul(theta.cos()),
        r.mul(phi.sin()).mul(theta.sin()),
        r.mul(phi.cos()),
      );

      positions.element(instanceIndex).assign(pos);
      velocities.element(instanceIndex).assign(vec3(0));
      seeds.element(instanceIndex).assign(seed);
    })().compute(COUNT);

    const update = Fn(() => {
      const pos = positions.element(instanceIndex);
      const vel = velocities.element(instanceIndex);
      const seed = seeds.element(instanceIndex);

      const noiseScale = float(0.12);
      const flow = mx_noise_vec3(
        pos
          .mul(noiseScale)
          .add(vec3(0, this.uTime.mul(this.uDrift.mul(0.1)), this.uTime.mul(0.02))),
      );

      // Inhale stills the turbulence; burst whips it.
      const turb = this.uTurbulence
        .mul(float(1).sub(this.uInhale.mul(0.7)))
        .add(this.uBurst.mul(3));
      vel.addAssign(flow.mul(turb).mul(this.uDelta));
      // Spring toward a per-particle shell radius; breathe expands it,
      // inhale contracts it, burst blows it open.
      const len = pos.length().max(0.001);
      const dir = pos.div(len);
      const targetR = seed
        .mul(5)
        .add(5)
        .mul(
          float(1)
            .add(this.uBreathe.mul(0.8))
            .sub(this.uInhale.mul(0.55))
            .add(this.uBurst.mul(1.4)),
        );
      vel.addAssign(dir.mul(targetR.sub(len)).mul(0.6).mul(this.uDelta));
      // Orbital swirl: the cloud turns like a nebula instead of sitting
      // still as a ball; calm near the poles, drops spin it up.
      const tangent = vec3(0, 1, 0).cross(dir);
      vel.addAssign(
        tangent.mul(this.uDrift.mul(1.6).add(this.uBurst.mul(4))).mul(this.uDelta),
      );
      // Gentle pull toward the equatorial plane flattens it disc-ward.
      vel.addAssign(vec3(0, pos.y.negate().mul(0.05), 0).mul(this.uDelta));
      vel.mulAssign(float(0.985));

      pos.addAssign(vel.mul(this.uDelta).mul(float(1).add(this.uBreathe.mul(2.5))));

      // Recycle far-flung particles back into the shell.
      If(pos.length().greaterThan(30), () => {
        pos.assign(pos.normalize().mul(seed.mul(7).add(4)));
        vel.assign(vec3(0));
      });
    })().compute(COUNT);
    this.updateCompute = update;

    const material = new THREE.SpriteNodeMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    material.positionNode = positions.toAttribute();

    const seedAttr = seeds.toAttribute();
    const velAttr = velocities.toAttribute();
    const speed = velAttr.length();
    const mixT = smoothstep(0.0, 1.5, speed).add(seedAttr.mul(0.25)).clamp(0, 1);
    const brightness = this.uBrightness
      .add(this.uPulse.mul(0.4))
      .add(this.uBurst.mul(0.65))
      .mul(float(1).sub(this.uInhale.mul(0.45)))
      .mul(this.uFade);
    material.colorNode = mix(this.uColorA, this.uColorB, mixT).mul(brightness).mul(0.8);

    // The nebula collapse concentrates sprites into dense streams —
    // additive stacking blows out fast, so each sprite stays faint.
    const d = uv().distance(0.5);
    material.opacityNode = smoothstep(0.5, 0.05, d)
      .mul(float(0.045).add(this.uBrightness.mul(0.08)))
      .mul(this.uFade);
    // Stretch fast particles along their screen-space velocity — slow
    // ones stay soft dots, movers become silky streamlines.
    const viewVel = cameraViewMatrix.mul(vec4(velAttr.x, velAttr.y, velAttr.z, 0)).xyz;
    material.rotationNode = atan(viewVel.y, viewVel.x);
    const stretch = smoothstep(0.3, 2.8, speed);
    const baseScale = float(0.08)
      .add(seedAttr.mul(0.06))
      .mul(float(1).add(this.uBreathe.mul(1.2)).add(this.uPulse.mul(0.4)));
    material.scaleNode = vec2(
      baseScale.mul(float(1).add(stretch.mul(2.6))),
      baseScale.mul(float(1).sub(stretch.mul(0.55))),
    );

    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, COUNT);
    mesh.frustumCulled = false;
    this.mesh = mesh;
    ctx.scene.add(mesh);

    await ctx.renderer.computeAsync(initCompute);
  }

  setVisible(v: boolean): void {
    if (this.mesh) this.mesh.visible = v;
  }

  update(_f: FrameFeatures, dt: number): void {
    if (!this.ctx || !this.mesh?.visible) return;
    this.uTime.value += dt;
    this.uDelta.value = Math.min(dt, 1 / 30);
    this.ctx.renderer.compute(this.updateCompute as Parameters<THREE.WebGPURenderer['compute']>[0]);
  }

  setPalette(a: string, b: string): void {
    (this.uColorA.value as THREE.Color).set(a);
    (this.uColorB.value as THREE.Color).set(b);
  }

  applyPalette(p: Palette): void {
    this.setPalette(p.primary, p.accent);
  }

  dispose(): void {
    if (this.mesh && this.ctx) {
      this.ctx.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
  }
}
