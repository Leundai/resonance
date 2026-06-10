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
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import type { FrameFeatures } from '../audio/features';
import type { Palette } from '../types/song-analysis';
import type { ParamSpec, SceneContext, VisualScene } from './scene';

const COUNT = 150_000;
const ATTRACTORS = 4; // lorenz, thomas, aizawa, halvorsen
const MORPH_SEC = 2.5;

/**
 * Particles advected through strange-attractor velocity fields.
 * Each section boundary morphs to the next attractor — the song's
 * structure literally reshapes the phase space.
 */
export class Attractor implements VisualScene {
  readonly name = 'attractor';

  readonly params: Record<string, ParamSpec> = {
    speed: { default: 1, min: 0.1, max: 3 },
    brightness: { default: 0.7, min: 0, max: 2.5 },
    pulse: { default: 0, min: 0, max: 1 },
    fade: { default: 1, min: 0, max: 1 },
    inhale: { default: 0, min: 0, max: 1 },
    burst: { default: 0, min: 0, max: 1 },
  };

  private uSpeed = uniform(this.params.speed.default);
  private uBrightness = uniform(this.params.brightness.default);
  private uPulse = uniform(0);
  private uFade = uniform(1);
  private uInhale = uniform(0);
  private uBurst = uniform(0);
  private uDelta = uniform(0.016);
  private uTypeA = uniform(0);
  private uTypeB = uniform(1);
  private uMorph = uniform(0);
  private uColorA = uniform(color('#3ec5ff'));
  private uColorB = uniform(color('#ff9d5c'));

  private typeA = 0;
  private typeB = 1;
  private morphing = false;
  private lastSectionStart = -1;
  private lastBurst = 0;

  private mesh: THREE.InstancedMesh | null = null;
  private updateCompute: unknown = null;
  private ctx: SceneContext | null = null;

  private paramValues: Record<string, number> = {};

  getParam(name: string): number {
    return this.paramValues[name] ?? this.params[name]?.default ?? 0;
  }

  setParam(name: string, value: number): void {
    this.paramValues[name] = value;
    const u = {
      speed: this.uSpeed,
      brightness: this.uBrightness,
      pulse: this.uPulse,
      fade: this.uFade,
      inhale: this.uInhale,
      burst: this.uBurst,
    }[name];
    if (u) u.value = value;
  }

  async init(ctx: SceneContext): Promise<void> {
    this.ctx = ctx;

    const positions = instancedArray(COUNT, 'vec3');
    const seeds = instancedArray(COUNT, 'float');

    const respawn = (seedOffset: number) => {
      const a = hash(instanceIndex.add(seedOffset)).mul(Math.PI * 2);
      const ph = hash(instanceIndex.add(seedOffset + 77)).mul(2).sub(1).acos();
      const r = hash(instanceIndex.add(seedOffset + 154)).pow(0.33).mul(6);
      return vec3(
        r.mul(ph.sin()).mul(a.cos()),
        r.mul(ph.sin()).mul(a.sin()),
        r.mul(ph.cos()),
      );
    };

    const initCompute = Fn(() => {
      positions.element(instanceIndex).assign(respawn(0));
      seeds.element(instanceIndex).assign(hash(instanceIndex));
    })().compute(COUNT);

    // Each field as a builder; evaluated only inside its uniform branch
    // (computing all four then selecting wasted ~4x the math).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fieldExprs = (p: any): any[] => {
      // Lorenz (σ=10 ρ=28 β=8/3), world ±8 → attractor ±28, z centered 25.
      const lA = p.mul(3.5).add(vec3(0, 0, 25));
      const lorenz = vec3(
        lA.y.sub(lA.x).mul(10),
        lA.x.mul(float(28).sub(lA.z)).sub(lA.y),
        lA.x.mul(lA.y).sub(lA.z.mul(8 / 3)),
      )
        .div(3.5)
        .mul(0.11);

      // Thomas (b=0.19), world ±8 → ±4. Gentle — boosted.
      const tA = p.mul(0.5);
      const thomas = vec3(
        tA.y.sin().sub(tA.x.mul(0.19)),
        tA.z.sin().sub(tA.y.mul(0.19)),
        tA.x.sin().sub(tA.z.mul(0.19)),
      )
        .div(0.5)
        .mul(3.2);

      // Aizawa (a=.95 b=.7 c=.6 d=3.5 e=.25 f=.1), world ±8 → ±1.6.
      const zA = p.mul(0.2);
      const aizX = zA.z.sub(0.7).mul(zA.x).sub(zA.y.mul(3.5));
      const aizY = zA.x.mul(3.5).add(zA.z.sub(0.7).mul(zA.y));
      const aizZ = float(0.6)
        .add(zA.z.mul(0.95))
        .sub(zA.z.mul(zA.z).mul(zA.z).div(3))
        .sub(zA.x.mul(zA.x).add(zA.y.mul(zA.y)).mul(float(1).add(zA.z.mul(0.25))))
        .add(zA.z.mul(zA.x.mul(zA.x).mul(zA.x)).mul(0.1));
      const aizawa = vec3(aizX, aizY, aizZ).div(0.2).mul(0.6);

      // Halvorsen (a=1.89), world ±8 → ±11.
      const hA = p.mul(1.4);
      const halvorsen = vec3(
        hA.x.mul(-1.89).sub(hA.y.mul(4)).sub(hA.z.mul(4)).sub(hA.y.mul(hA.y)),
        hA.y.mul(-1.89).sub(hA.z.mul(4)).sub(hA.x.mul(4)).sub(hA.z.mul(hA.z)),
        hA.z.mul(-1.89).sub(hA.x.mul(4)).sub(hA.y.mul(4)).sub(hA.x.mul(hA.x)),
      )
        .div(1.4)
        .mul(0.28);

      return [lorenz, thomas, aizawa, halvorsen];
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const field = (p: any, type: any): any => {
      const out = vec3(0).toVar();
      const exprs = fieldExprs(p);
      If(type.equal(0), () => {
        out.assign(exprs[0]);
      })
        .ElseIf(type.equal(1), () => {
          out.assign(exprs[1]);
        })
        .ElseIf(type.equal(2), () => {
          out.assign(exprs[2]);
        })
        .Else(() => {
          out.assign(exprs[3]);
        });
      return out;
    };

    const update = Fn(() => {
      const pos = positions.element(instanceIndex);
      const seed = seeds.element(instanceIndex);

      const vA = field(pos, this.uTypeA);
      const vB = field(pos, this.uTypeB);
      const v = mix(vA, vB, this.uMorph);

      const speed = this.uSpeed
        .mul(float(1).sub(this.uInhale.mul(0.85)))
        .mul(seed.mul(0.4).add(0.8));
      pos.addAssign(v.mul(this.uDelta).mul(speed));

      // Drop: radial shove outward.
      const len = pos.length().max(0.001);
      pos.addAssign(pos.div(len).mul(this.uBurst).mul(this.uDelta).mul(26));

      // Recycle escapees and stuck points near the origin.
      If(len.greaterThan(45).or(len.lessThan(0.05)), () => {
        pos.assign(respawn(311));
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
    const radial = positions.toAttribute().length().div(14);
    const mixT = radial.add(seedAttr.mul(0.3)).clamp(0, 1);
    const brightness = this.uBrightness.add(this.uPulse.mul(0.5)).add(this.uBurst.mul(0.8));
    material.colorNode = mix(this.uColorA, this.uColorB, mixT).mul(brightness).mul(this.uFade);
    const d = uv().distance(0.5);
    material.opacityNode = smoothstep(0.5, 0.08, d)
      .mul(float(0.04).add(this.uBrightness.mul(0.06)))
      .mul(this.uFade);
    material.scaleNode = float(0.035).add(seedAttr.mul(0.03));

    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, COUNT);
    mesh.frustumCulled = false;
    this.mesh = mesh;
    ctx.scene.add(mesh);

    await ctx.renderer.computeAsync(initCompute);
  }

  setVisible(v: boolean): void {
    if (this.mesh) this.mesh.visible = v;
  }

  private nextAttractor(): void {
    if (this.morphing) {
      // Mid-morph: land on B, then immediately start toward the next.
      this.typeA = this.typeB;
    }
    this.typeB = (this.typeB + 1) % ATTRACTORS;
    this.uTypeA.value = this.typeA;
    this.uTypeB.value = this.typeB;
    this.uMorph.value = 0;
    this.morphing = true;
  }

  update(f: FrameFeatures, dt: number): void {
    if (!this.ctx || !this.mesh?.visible) return;

    // Section boundaries (and hard drops) reshape the phase space.
    if (f.section && f.section.startSec !== this.lastSectionStart) {
      if (this.lastSectionStart >= 0) this.nextAttractor();
      this.lastSectionStart = f.section.startSec;
    }
    const burst = this.uBurst.value as number;
    if (burst > 0.7 && this.lastBurst <= 0.7 && !this.morphing) this.nextAttractor();
    this.lastBurst = burst;

    if (this.morphing) {
      this.uMorph.value = Math.min(1, (this.uMorph.value as number) + dt / MORPH_SEC);
      if ((this.uMorph.value as number) >= 1) {
        this.typeA = this.typeB;
        this.uTypeA.value = this.typeA;
        this.uMorph.value = 0;
        this.morphing = false;
      }
    }

    this.uDelta.value = Math.min(dt, 1 / 30);
    this.ctx.renderer.compute(this.updateCompute as Parameters<THREE.WebGPURenderer['compute']>[0]);
  }

  applyPalette(p: Palette): void {
    (this.uColorA.value as THREE.Color).set(p.primary);
    (this.uColorB.value as THREE.Color).set(p.accent);
  }

  dispose(): void {
    if (this.mesh && this.ctx) {
      this.ctx.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
  }
}
