import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
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
  vec3,
} from 'three/tsl';
import type { FrameFeatures } from '../audio/features';
import type { SceneContext, VisualScene } from './scene';

const COUNT = 100_000;

/**
 * Curl-ish noise flow-field particles on GPU compute. Bass drives pulse
 * scale, treble drives turbulence, level drives brightness.
 */
export class ParticleField implements VisualScene {
  readonly name = 'particles';

  private uTime = uniform(0);
  private uDelta = uniform(0.016);
  private uBass = uniform(0);
  private uTreble = uniform(0);
  private uLevel = uniform(0);
  private uPulse = uniform(0);
  private uColorA = uniform(color('#4a7cff'));
  private uColorB = uniform(color('#ff5ec4'));

  private mesh: THREE.InstancedMesh | null = null;
  private updateCompute: unknown = null;
  private ctx: SceneContext | null = null;

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

      const turbulence = float(0.6).add(this.uTreble.mul(3.5));
      const noiseScale = float(0.12);
      const flow = mx_noise_vec3(
        pos.mul(noiseScale).add(vec3(0, this.uTime.mul(0.05), this.uTime.mul(0.02))),
      );

      vel.addAssign(flow.mul(turbulence).mul(this.uDelta));
      // Spring toward a per-particle shell radius; bass breathes it outward.
      const len = pos.length().max(0.001);
      const dir = pos.div(len);
      const targetR = seed.mul(5).add(5).mul(float(1).add(this.uBass.mul(0.8)));
      vel.addAssign(dir.mul(targetR.sub(len)).mul(0.6).mul(this.uDelta));
      vel.mulAssign(float(0.985));

      pos.addAssign(vel.mul(this.uDelta).mul(float(1).add(this.uBass.mul(2.5))));

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
    const speed = velocities.toAttribute().length();
    const mixT = smoothstep(0.0, 1.5, speed).add(seedAttr.mul(0.25)).clamp(0, 1);
    const brightness = float(0.35).add(this.uLevel.mul(1.4)).add(this.uPulse.mul(0.7));
    material.colorNode = mix(this.uColorA, this.uColorB, mixT).mul(brightness);

    const d = uv().distance(0.5);
    material.opacityNode = smoothstep(0.5, 0.05, d).mul(float(0.25).add(this.uLevel.mul(0.6)));
    material.scaleNode = float(0.08)
      .add(seedAttr.mul(0.06))
      .mul(float(1).add(this.uBass.mul(1.2)).add(this.uPulse.mul(0.4)));

    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, COUNT);
    mesh.frustumCulled = false;
    this.mesh = mesh;
    ctx.scene.add(mesh);

    await ctx.renderer.computeAsync(initCompute);
  }

  update(f: FrameFeatures, dt: number): void {
    if (!this.ctx) return;
    this.uTime.value += dt;
    this.uDelta.value = Math.min(dt, 1 / 30);
    this.uBass.value = f.bass;
    this.uTreble.value = f.treble;
    this.uLevel.value = f.level;
    // Beat-grid pulse: instant attack, exponential release.
    if (f.onset) this.uPulse.value = 1;
    else this.uPulse.value *= Math.exp(-dt * 5);
    this.ctx.renderer.compute(this.updateCompute as Parameters<THREE.WebGPURenderer['compute']>[0]);
  }

  setPalette(a: string, b: string): void {
    (this.uColorA.value as THREE.Color).set(a);
    (this.uColorB.value as THREE.Color).set(b);
  }

  dispose(): void {
    if (this.mesh && this.ctx) {
      this.ctx.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
  }
}
