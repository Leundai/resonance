import * as THREE from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  atan,
  color,
  float,
  mix,
  mx_noise_float,
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

const RT_W = 1920;
const RT_H = 1080;
const STEPS = 130;
const HORIZON = 1.0;
const DISK_IN = 2.3;
const DISK_OUT = 9.5;

/**
 * Gravitationally-lensed black hole with a music-driven accretion disk.
 * Rays bend with the classic Newtonian-photon approximation
 * (a = -G·pos/r³ per step); captured rays form the event horizon, the
 * tracked minimum approach paints the photon ring, and drops surge the
 * gravity itself so the whole sky warps on impact.
 */
export class BlackHole implements VisualScene {
  readonly name = 'blackhole';

  readonly params: Record<string, ParamSpec> = {
    gravity: { default: 1.35, min: 0.8, max: 2.4 },
    diskBrightness: { default: 1.0, min: 0, max: 2.5 },
    turbulence: { default: 0.5, min: 0, max: 1 },
    spin: { default: 1.0, min: 0.2, max: 2.5 },
    flare: { default: 0, min: 0, max: 1 },
    fade: { default: 1, min: 0, max: 1 },
    inhale: { default: 0, min: 0, max: 1 },
    burst: { default: 0, min: 0, max: 1 },
  };

  private uGravity = uniform(this.params.gravity.default);
  private uDiskBright = uniform(this.params.diskBrightness.default);
  private uTurb = uniform(this.params.turbulence.default);
  private uFlare = uniform(0);
  private uFade = uniform(1);
  private uTime = uniform(0);
  private uFlareTheta = uniform(0);
  private uCamPos = uniform(new THREE.Vector3(0, 2.4, 14));
  private uLow = uniform(color('#1a0f33'));
  private uHigh = uniform(color('#ff9d5c'));
  private uPeak = uniform(color('#fff3e0'));

  private spin = this.params.spin.default;
  private inhale = 0;
  private burst = 0;
  private diskPhase = 0;
  private time = 0;

  private rt: THREE.RenderTarget;
  private fboScene = new THREE.Scene();
  private fboCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
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
      case 'gravity':
        this.uGravity.value = value;
        break;
      case 'diskBrightness':
        this.uDiskBright.value = value;
        break;
      case 'turbulence':
        this.uTurb.value = value;
        break;
      case 'spin':
        this.spin = value;
        break;
      case 'flare':
        this.uFlare.value = value;
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
      const ndc = uv().mul(2).sub(vec2(1, 1)).mul(vec2(RT_W / RT_H, 1));
      const ro = vec3(this.uCamPos.x, this.uCamPos.y, this.uCamPos.z);
      const fwd = normalize(ro.negate());
      const right = normalize(vec3(fwd.z, 0, fwd.x.negate()));
      const up = right.cross(fwd);
      const rd = normalize(
        fwd.add(right.mul(ndc.x.mul(0.62))).add(up.mul(ndc.y.mul(0.62))),
      ).toVar();

      const pos = ro.toVar();
      const col = vec3(0).toVar();
      const trans = float(1).toVar(); // transmittance through disk crossings
      const minR = float(1e3).toVar();
      const captured = float(0).toVar();
      const prevY = pos.y.toVar();

      const gravity = this.uGravity; // drop surge applied CPU-side
      const dt = float(0.3);

      Loop({ start: 0, end: STEPS, type: 'int' }, () => {
        const r = pos.length().max(0.001);
        minR.assign(minR.min(r));

        If(r.lessThan(HORIZON), () => {
          captured.assign(1);
          Break();
        });
        If(r.greaterThan(34), () => {
          Break();
        });

        // Newtonian-photon bend toward the singularity.
        const bend = pos.div(r.mul(r).mul(r)).mul(gravity).mul(dt);
        rd.assign(normalize(rd.sub(bend)));

        prevY.assign(pos.y);
        pos.assign(pos.add(rd.mul(dt)));

        // Disk-plane crossing (y = 0) inside the annulus → emit.
        If(prevY.mul(pos.y).lessThan(0), () => {
          // Interpolate back along the step to the y=0 crossing point.
          const t = prevY.div(prevY.sub(pos.y));
          const back = float(1).sub(t);
          const hit = vec3(
            pos.x.sub(rd.x.mul(dt).mul(back)),
            0,
            pos.z.sub(rd.z.mul(dt).mul(back)),
          );
          const rXZ = hit.length();
          If(rXZ.greaterThan(DISK_IN).and(rXZ.lessThan(DISK_OUT)), () => {
            const rN = rXZ.sub(DISK_IN).div(DISK_OUT - DISK_IN);
            const theta = atan(hit.z, hit.x);
            // Differential rotation: inner disk laps the outer.
            const rot = this.uTime.mul(8).mul(rXZ.pow(-1.5));
            const n1 = mx_noise_float(
              vec3(theta.mul(3).sub(rot), rXZ.mul(1.3), this.uTime.mul(0.13)),
            )
              .mul(0.5)
              .add(0.5);
            const n2 = mx_noise_float(vec3(theta.mul(9).sub(rot.mul(1.6)), rXZ.mul(3.5), 1.7))
              .mul(0.5)
              .add(0.5);
            const streaks = mix(float(1), n1.mul(n2.mul(0.6).add(0.7)), this.uTurb.add(0.35));

            // Doppler beaming: the approaching side burns brighter.
            const vDir = normalize(vec3(hit.z.negate(), 0, hit.x));
            const dop = float(1).add(vDir.dot(rd.negate()).mul(0.65)).clamp(0.3, 1.9).pow(2);

            // Orbiting hot flare on beats.
            const dTheta = theta.sub(this.uFlareTheta).sin().abs();
            const flare = smoothstep(0.35, 0.0, dTheta).mul(this.uFlare).mul(2);

            const base = float(1).sub(rN).pow(1.7).mul(float(2.4).div(rXZ)).mul(streaks);
            const heat = float(1).sub(rN).mul(n1.mul(0.4).add(0.6));
            const diskCol = mix(this.uHigh, this.uPeak, heat.mul(heat)).add(
              this.uPeak.mul(flare),
            );
            col.addAssign(diskCol.mul(base).mul(dop).mul(this.uDiskBright).mul(trans));
            trans.mulAssign(0.5);
          });
        });
      });

      // Photon ring: tracked minimum approach grazing the photon sphere.
      const ring = smoothstep(0.5, 0.02, minR.sub(1.5).abs()).mul(0.85);
      col.addAssign(this.uPeak.mul(ring));

      // Faint starfield + palette haze for escaped rays.
      const stars = mx_noise_float(rd.mul(38)).max(0).pow(10).mul(0.5);
      const haze = smoothstep(6, 1.6, minR).mul(0.12);
      col.addAssign(
        vec3(stars).add(this.uLow.mul(haze)).mul(float(1).sub(captured)).mul(trans),
      );

      return vec4(col.mul(this.uFade), 1);
    })();

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.position.z = -1;
    this.fboScene.add(quad);

    const displayMat = new THREE.MeshBasicNodeMaterial();
    this.displayRead.value = this.rt.texture;
    displayMat.colorNode = Fn(() => this.displayRead.sample(screenUV).rgb)();
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
    if (!ctx || !this.displayMesh?.visible) return;
    this.time += dt;

    // Disk rotation: spin slows on inhale; beats advance the flare orbit.
    const spinNow = this.spin * (1 - this.inhale * 0.8);
    this.diskPhase += dt * spinNow;
    this.uTime.value = this.diskPhase;
    this.uFlareTheta.value =
      ((this.uFlareTheta.value as number) + dt * spinNow * 1.6) % (Math.PI * 2);

    // Drop = gravity surge: spacetime itself lurches.
    this.uGravity.value = this.getParam('gravity') * (1 + this.burst * 0.55);

    const orbT = this.time * 0.05;
    (this.uCamPos.value as THREE.Vector3).set(
      Math.sin(orbT) * 14,
      2.4 + Math.sin(this.time * 0.031) * 1.1,
      Math.cos(orbT) * 14,
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
