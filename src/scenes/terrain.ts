import * as THREE from 'three/webgpu';
import {
  Fn,
  color,
  float,
  mix,
  mx_noise_float,
  positionLocal,
  positionView,
  smoothstep,
  uniform,
  uv,
  vec2,
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
  private sky: THREE.Mesh | null = null;
  private ship: THREE.Group | null = null;
  private uEngine = uniform(0.6);
  private uSkyFade = uniform(1);
  private uShipHull = uniform(color('#4a6a8a'));
  private rollPhase = 0;
  private lastBurst = 0;
  private time = 0;
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

    // ---- Sky: tiny stars + a stylized black hole on the horizon ----
    const skyMat = new THREE.MeshBasicNodeMaterial();
    skyMat.colorNode = Fn(() => {
      const u = uv();
      // Star dust — two octaves of pinprick noise.
      const s1 = mx_noise_float(vec3(u.x.mul(180), u.y.mul(70), 1.3)).max(0).pow(9).mul(0.9);
      const s2 = mx_noise_float(vec3(u.x.mul(420), u.y.mul(160), 7.7)).max(0).pow(12).mul(0.6);
      const stars = vec3(s1.add(s2));
      // Black hole emblem: dark core, photon ring, lensed disk streak.
      const bhUV = u.sub(vec2(0.64, 0.62)).mul(vec2(2.5, 1));
      const d = bhUV.length();
      const core = smoothstep(0.052, 0.045, d);
      const ring = smoothstep(0.016, 0.002, d.sub(0.055).abs());
      const diskBand = smoothstep(0.03, 0.0, bhUV.y.abs().sub(d.mul(0.10)));
      const disk = diskBand.mul(smoothstep(0.2, 0.06, d)).mul(smoothstep(0.04, 0.07, d));
      const halo = smoothstep(0.18, 0.05, d).mul(0.12);
      const out = stars
        .mul(float(1).sub(core))
        .add(this.uPeak.mul(ring).mul(0.9))
        .add(this.uHigh.mul(disk).mul(0.7))
        .add(this.uHigh.mul(halo));
      return out.mul(this.uSkyFade).mul(this.uFade);
    })();
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(760, 320), skyMat);
    sky.position.set(0, 30, -150);
    sky.frustumCulled = false;
    this.sky = sky;
    ctx.scene.add(sky);

    // ---- Ship: low-poly craft banking over the relief ----
    const ship = new THREE.Group();
    const hullMat = new THREE.MeshBasicNodeMaterial();
    hullMat.colorNode = Fn(() => {
      // Cheap top-light gradient on the local Y; peak rim near the nose.
      const shade = positionLocal.y.mul(0.35).add(0.75);
      return vec3(this.uShipHull.r, this.uShipHull.g, this.uShipHull.b).mul(shade);
    })();
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.1, 4), hullMat);
    body.rotation.x = -Math.PI / 2; // nose toward -z
    body.rotation.z = Math.PI / 4;
    ship.add(body);
    const wingGeo = new THREE.BoxGeometry(2.6, 0.06, 0.7);
    const wings = new THREE.Mesh(wingGeo, hullMat);
    wings.position.set(0, -0.1, 0.55);
    ship.add(wings);

    // Engine glow: additive sprite at the tail; bloom + afterimage do the trail.
    const engineMat = new THREE.SpriteNodeMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    engineMat.colorNode = Fn(() => {
      const dd = uv().distance(0.5);
      const g = smoothstep(0.5, 0.05, dd);
      return vec3(this.uPeak.r, this.uPeak.g, this.uPeak.b).mul(g).mul(this.uEngine);
    })();
    engineMat.opacityNode = Fn(() => smoothstep(0.5, 0.1, uv().distance(0.5)).mul(this.uFade))();
    const engine = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), engineMat);
    engine.position.set(0, -0.05, 1.3);
    ship.add(engine);

    ship.position.set(0, 2.4, 12);
    this.ship = ship;
    ctx.scene.add(ship);
  }

  setVisible(v: boolean): void {
    if (this.mesh) this.mesh.visible = v;
    if (this.sky) this.sky.visible = v;
    if (this.ship) this.ship.visible = v;
  }

  update(f: FrameFeatures, dt: number): void {
    this.uScroll.value += dt * this.scrollSpeed * 0.045;
    this.time += dt;
    const ship = this.ship;
    if (!ship || !ship.visible) return;

    // Weave over the terrain; bank into the turns.
    const t = this.time;
    const x = Math.sin(t * 0.42) * 4.2;
    const xVel = Math.cos(t * 0.42) * 0.42 * 4.2;
    const y = 2.6 + Math.sin(t * 0.9) * 0.45 + Math.sin(t * 2.3) * 0.12;
    ship.position.set(x, y, 12 + Math.sin(t * 0.31) * 1.5);
    ship.rotation.y = -xVel * 0.12;

    // Barrel roll on drops; banking otherwise.
    const burst = this.getParam('burst');
    if (burst > 0.7 && this.lastBurst <= 0.7) this.rollPhase = 1e-4;
    this.lastBurst = burst;
    if (this.rollPhase > 0) {
      this.rollPhase = Math.min(Math.PI * 2, this.rollPhase + dt * 9);
      ship.rotation.z = this.rollPhase;
      if (this.rollPhase >= Math.PI * 2) this.rollPhase = 0;
    } else {
      ship.rotation.z = -xVel * 0.35;
    }

    // Engine answers the music: beats flare it, inhale throttles down.
    const pulse = f.onset ? 1 : 0;
    const target = 0.5 + pulse * 1.4 + burst * 1.8 - this.getParam('inhale') * 0.35;
    this.uEngine.value += (target - (this.uEngine.value as number)) * Math.min(dt * 10, 1);
    this.uSkyFade.value = 1 - this.getParam('inhale') * 0.4;
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
    (this.uShipHull.value as THREE.Color).set(p.secondary);
  }

  dispose(): void {
    if (this.ctx) {
      for (const obj of [this.mesh, this.sky, this.ship]) {
        if (obj) this.ctx.scene.remove(obj);
      }
      this.mesh?.geometry.dispose();
      (this.mesh?.material as THREE.Material | undefined)?.dispose();
    }
  }
}
