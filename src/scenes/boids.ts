import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  atan,
  min as tslMin,
  atomicAdd,
  atomicLoad,
  atomicStore,
  cameraViewMatrix,
  color,
  float,
  hash,
  instanceIndex,
  instancedArray,
  mix,
  smoothstep,
  uint,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { FrameFeatures } from '../audio/features';
import type { Palette } from '../types/song-analysis';
import type { ParamSpec, SceneContext, VisualScene } from './scene';

const COUNT = 32_768;
const BOUNDS = 14;
// Uniform grid sized to the perception radius: one cell ≈ one neighborhood.
const PERCEPTION = 2.2;
const SEP_RADIUS = 0.9;
const GRID_MIN = -18;
const GRID_SIZE = 36;
const DIM = Math.ceil(GRID_SIZE / PERCEPTION); // 17
const CELLS = DIM * DIM * DIM;

/**
 * GPU murmuration at 65k agents via counting-sort spatial grid
 * (clear → count → scan → scatter → simulate, all TSL compute).
 * Musical tension lives in the cohesion/scatter axis.
 */
export class Boids implements VisualScene {
  readonly name = 'boids';

  readonly params: Record<string, ParamSpec> = {
    cohesion: { default: 0.8, min: 0, max: 2 },
    separation: { default: 0.9, min: 0, max: 2.5 },
    alignment: { default: 1.0, min: 0, max: 2 },
    speed: { default: 1.0, min: 0.2, max: 2.5 },
    scatter: { default: 0, min: 0, max: 1 },
    brightness: { default: 0.8, min: 0, max: 2.5 },
    fade: { default: 1, min: 0, max: 1 },
    inhale: { default: 0, min: 0, max: 1 },
    burst: { default: 0, min: 0, max: 1 },
  };

  private uCohesion = uniform(this.params.cohesion.default);
  private uSeparation = uniform(this.params.separation.default);
  private uAlignment = uniform(this.params.alignment.default);
  private uSpeed = uniform(this.params.speed.default);
  private uScatter = uniform(0);
  private uBrightness = uniform(this.params.brightness.default);
  private uFade = uniform(1);
  private uInhale = uniform(0);
  private uBurst = uniform(0);
  private uDelta = uniform(0.016);
  private uColorA = uniform(color('#7ad9ff'));
  private uColorB = uniform(color('#ffd166'));

  private mesh: THREE.InstancedMesh | null = null;
  private passes: unknown[] = [];
  private ctx: SceneContext | null = null;

  private paramValues: Record<string, number> = {};

  getParam(name: string): number {
    return this.paramValues[name] ?? this.params[name]?.default ?? 0;
  }

  setParam(name: string, value: number): void {
    this.paramValues[name] = value;
    const u = {
      cohesion: this.uCohesion,
      separation: this.uSeparation,
      alignment: this.uAlignment,
      speed: this.uSpeed,
      scatter: this.uScatter,
      brightness: this.uBrightness,
      fade: this.uFade,
      inhale: this.uInhale,
      burst: this.uBurst,
    }[name];
    if (u) u.value = value;
  }

  async init(ctx: SceneContext): Promise<void> {
    this.ctx = ctx;

    const positions = instancedArray(COUNT, 'vec3');
    const velocities = instancedArray(COUNT, 'vec3');
    const sorted = instancedArray(COUNT, 'uint');
    const counts = instancedArray(CELLS, 'uint').toAtomic();
    const fills = instancedArray(CELLS, 'uint').toAtomic();
    const countsPlain = instancedArray(CELLS, 'uint');
    const starts = instancedArray(CELLS, 'uint');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cellOf = (p: any) => {
      const gx = p.x.sub(GRID_MIN).div(PERCEPTION).floor().clamp(0, DIM - 1);
      const gy = p.y.sub(GRID_MIN).div(PERCEPTION).floor().clamp(0, DIM - 1);
      const gz = p.z.sub(GRID_MIN).div(PERCEPTION).floor().clamp(0, DIM - 1);
      return gx.add(gy.mul(DIM)).add(gz.mul(DIM * DIM)).toUint();
    };

    const initCompute = Fn(() => {
      const s1 = hash(instanceIndex);
      const s2 = hash(instanceIndex.add(1337));
      const s3 = hash(instanceIndex.add(7331));
      positions
        .element(instanceIndex)
        .assign(vec3(s1.sub(0.5), s2.sub(0.5), s3.sub(0.5)).mul(BOUNDS));
      velocities
        .element(instanceIndex)
        .assign(
          vec3(
            hash(instanceIndex.add(11)).sub(0.5),
            hash(instanceIndex.add(22)).sub(0.5),
            hash(instanceIndex.add(33)).sub(0.5),
          ).mul(2),
        );
    })().compute(COUNT);

    const clearPass = Fn(() => {
      atomicStore(counts.element(instanceIndex), uint(0));
      atomicStore(fills.element(instanceIndex), uint(0));
    })().compute(CELLS);

    const countPass = Fn(() => {
      const cell = cellOf(positions.element(instanceIndex));
      atomicAdd(counts.element(cell), uint(1));
    })().compute(COUNT);

    const copyPass = Fn(() => {
      const loaded = atomicLoad(counts.element(instanceIndex)) as unknown as ReturnType<typeof uint>;
      countsPlain.element(instanceIndex).assign(loaded);
    })().compute(CELLS);

    // Naive O(cells²) exclusive scan — 17³ cells makes this trivial.
    const scanPass = Fn(() => {
      const total = uint(0).toVar();
      Loop({ start: uint(0), end: instanceIndex.toUint(), type: 'uint' }, ({ i }) => {
        total.addAssign(countsPlain.element(i));
      });
      starts.element(instanceIndex).assign(total);
    })().compute(CELLS);

    const scatterPass = Fn(() => {
      const cell = cellOf(positions.element(instanceIndex));
      const slot = atomicAdd(fills.element(cell), uint(1)) as unknown as ReturnType<typeof uint>;
      sorted.element(starts.element(cell).add(slot)).assign(instanceIndex);
    })().compute(COUNT);

    const simPass = Fn(() => {
      const pos = positions.element(instanceIndex);
      const vel = velocities.element(instanceIndex);

      const cohSum = vec3(0).toVar();
      const aliSum = vec3(0).toVar();
      const sepSum = vec3(0).toVar();
      const count = float(0).toVar();

      const gx = pos.x.sub(GRID_MIN).div(PERCEPTION).floor();
      const gy = pos.y.sub(GRID_MIN).div(PERCEPTION).floor();
      const gz = pos.z.sub(GRID_MIN).div(PERCEPTION).floor();

      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const cx = gx.add(float(dx)).clamp(0, DIM - 1);
            const cy = gy.add(float(dy)).clamp(0, DIM - 1);
            const cz = gz.add(float(dz)).clamp(0, DIM - 1);
            const cell = cx.add(cy.mul(DIM)).add(cz.mul(DIM * DIM)).toUint();
            const start = starts.element(cell);
            // Cap per-cell samples: dense clusters would otherwise go
            // quadratic exactly when cohesion makes the flock clump.
            // tslMin's .d.ts is float-only; WGSL min(u32,u32) is valid.
            const n = (tslMin as unknown as (a: unknown, b: unknown) => ReturnType<typeof uint>)(
              countsPlain.element(cell),
              uint(14),
            );
            Loop({ start: uint(0), end: n, type: 'uint' }, ({ i }) => {
              const other = sorted.element(start.add(i));
              If(other.notEqual(instanceIndex), () => {
                const otherPos = positions.element(other);
                const diff = pos.sub(otherPos);
                const d = diff.length();
                If(d.lessThan(PERCEPTION), () => {
                  cohSum.addAssign(otherPos);
                  aliSum.addAssign(velocities.element(other));
                  count.addAssign(1);
                  If(d.lessThan(SEP_RADIUS), () => {
                    sepSum.addAssign(diff.div(d.mul(d).max(0.01)));
                  });
                });
              });
            });
          }
        }
      }

      If(count.greaterThan(0), () => {
        const cohesionForce = cohSum.div(count).sub(pos).normalize();
        const alignForce = aliSum.div(count).normalize();
        // Inhale pulls the flock tight; scatter/burst blow it apart.
        const scatterTotal = this.uScatter.add(this.uBurst).min(1.2);
        const cohStrength = this.uCohesion.mul(float(1).add(this.uInhale.mul(2)));
        const cohSign = float(1).sub(scatterTotal.mul(2.2));
        vel.addAssign(cohesionForce.mul(cohStrength).mul(cohSign).mul(this.uDelta.mul(8)));
        vel.addAssign(alignForce.mul(this.uAlignment).mul(this.uDelta.mul(6)));
        vel.addAssign(
          sepSum.mul(this.uSeparation.add(scatterTotal.mul(1.5))).mul(this.uDelta.mul(10)),
        );
      });

      // Soft spherical containment.
      const dist = pos.length();
      If(dist.greaterThan(BOUNDS), () => {
        vel.subAssign(pos.div(dist).mul(this.uDelta.mul(dist.sub(BOUNDS)).mul(4)));
      });

      // Clamp speed band so the flock never stalls or explodes.
      const speed = vel.length().max(0.001);
      const maxSpeed = float(5.5)
        .mul(this.uSpeed)
        .mul(float(1).sub(this.uInhale.mul(0.55)))
        .add(this.uScatter.add(this.uBurst).mul(4));
      const minSpeed = float(1.2).mul(this.uSpeed);
      vel.assign(vel.div(speed).mul(speed.clamp(minSpeed, maxSpeed)));

      pos.addAssign(vel.mul(this.uDelta));
    })().compute(COUNT);

    this.passes = [clearPass, countPass, copyPass, scanPass, scatterPass, simPass];

    const material = new THREE.SpriteNodeMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    material.positionNode = positions.toAttribute();

    // Stretch each sprite along its screen-space velocity direction.
    const velAttr = velocities.toAttribute();
    const viewVel = cameraViewMatrix.mul(vec4(velAttr.x, velAttr.y, velAttr.z, 0)).xyz;
    material.rotationNode = atan(viewVel.y, viewVel.x);
    const speedT = smoothstep(1, 8, velAttr.length());
    material.scaleNode = vec2(float(0.18).add(speedT.mul(0.3)), float(0.05));

    material.colorNode = mix(this.uColorA, this.uColorB, speedT).mul(
      this.uBrightness.mul(this.uFade),
    );
    const d = uv().distance(0.5);
    material.opacityNode = smoothstep(0.5, 0.1, d).mul(this.uFade).mul(0.55);

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
    this.uDelta.value = Math.min(dt, 1 / 30);
    for (const pass of this.passes) {
      this.ctx.renderer.compute(pass as Parameters<THREE.WebGPURenderer['compute']>[0]);
    }
  }

  setPalette(a: string, b: string): void {
    (this.uColorA.value as THREE.Color).set(a);
    (this.uColorB.value as THREE.Color).set(b);
  }

  applyPalette(p: Palette): void {
    this.setPalette(p.secondary, p.accent);
  }

  dispose(): void {
    if (this.mesh && this.ctx) {
      this.ctx.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
  }
}
