import * as THREE from 'three/webgpu';
import {
  Fn,
  atan,
  color,
  float,
  hash,
  mix,
  mx_noise_float,
  normalView,
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
const SEGMENTS = 448;

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
  private uTime = uniform(0);
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
    // Distance haze toward the palette's deep tone — matches the dome's
    // horizon band so terrain and sky meet without a seam.
    const depth = positionView.z.negate();
    const haze = smoothstep(14, 55, depth);
    c = mix(c, mix(color('#050510'), this.uLow, 0.55), haze);
    material.colorNode = c.mul(this.uFade);

    const geometry = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -4;
    mesh.frustumCulled = false;
    this.mesh = mesh;
    ctx.scene.add(mesh);

    // ---- Sky dome: hash-grid starfield bent around a lensed black hole.
    // A backside sphere covers every aspect ratio — no edges to cut off.
    const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
    skyMat.colorNode = Fn(() => {
      const dir = positionLocal.normalize();

      // Tangent frame around the hole, up-left of the flight path.
      const bh = vec3(0.4, 0.33, -0.85).normalize();
      const right = bh.cross(vec3(0, 1, 0)).normalize();
      const up = right.cross(bh).normalize();
      const q = vec2(dir.dot(right), dir.dot(up));
      const r = q.length().max(1e-4);

      // Gravitational lensing: star sampling bends toward the mass, so the
      // field visibly smears into arcs as it nears the photon sphere.
      const pull = float(0.0016).div(r.mul(r).add(0.0008)).min(1.2);
      const warped = dir
        .sub(right.mul(q.x.mul(pull)))
        .sub(up.mul(q.y.mul(pull)))
        .normalize();

      // 3D grid stars: each cell the sphere crosses may hold one pinprick.
      const starLayer = (density: number, seed: number, gate: number) => {
        const g = warped.mul(density);
        const cell = g.floor();
        const id = cell.x
          .add(density + 2)
          .add(cell.y.add(density + 2).mul(257))
          .add(cell.z.add(density + 2).mul(66049))
          .add(seed);
        const h1 = hash(id);
        const h2 = hash(id.add(1013904));
        const h3 = hash(id.add(2027808));
        const h4 = hash(id.add(3041712));
        const p = cell.add(
          vec3(h1.mul(0.7).add(0.15), h2.mul(0.7).add(0.15), h3.mul(0.7).add(0.15)),
        );
        const dStar = g.sub(p).length();
        const tw = this.uTime
          .mul(h1.mul(1.6).add(0.4))
          .add(h2.mul(6.28))
          .sin()
          .mul(0.3)
          .add(0.7);
        return smoothstep(0.3, 0.0, dStar).pow(3).mul(smoothstep(gate, 1, h4)).mul(tw);
      };
      const stars = vec3(starLayer(38, 11, 0.5).add(starLayer(88, 37, 0.45).mul(0.55)));

      // Event-horizon shadow and the thin photon ring hugging it.
      const core = smoothstep(0.035, 0.029, r);
      const photon = smoothstep(0.004, 0.0008, r.sub(0.039).abs());

      // Accretion disk: squashed ellipse, noise streaks, doppler beaming.
      const e = vec2(q.x, q.y.mul(3.6));
      const er = e.length().max(1e-4);
      const angle = atan(e.y, e.x);
      const band = smoothstep(0.032, 0.055, er).mul(smoothstep(0.21, 0.085, er));
      const streak = mx_noise_float(
        vec3(angle.mul(2), er.mul(30).sub(this.uTime.mul(0.7)), 4.2),
      )
        .mul(0.45)
        .add(0.8);
      const dop = float(1).sub(e.x.div(er).mul(0.75));
      const heat = smoothstep(0.18, 0.045, er);
      const diskCol = mix(this.uHigh, this.uPeak, heat);
      // Lower half of the disk passes in front of the shadow; the upper
      // half hides behind it — its light reappears as the arc on top.
      const front = smoothstep(0.012, -0.012, q.y);
      const occl = mix(float(1).sub(core), float(1), front);
      const disk = band.mul(streak).mul(dop).mul(occl);
      const arc = smoothstep(0.0045, 0.001, r.sub(0.044).abs())
        .mul(smoothstep(-0.01, 0.025, q.y))
        .mul(0.7);
      const halo = smoothstep(0.17, 0.035, r).mul(0.12);
      const boost = float(1).add(this.uBurst.mul(0.9));

      // Faint band of palette light at the horizon ties dome to haze.
      const horizon = smoothstep(0.3, 0.0, dir.y.abs()).mul(0.45);

      const out = stars
        .mul(float(1).sub(core))
        .add(diskCol.mul(disk).mul(0.85).mul(boost))
        .add(this.uPeak.mul(photon.add(arc)).mul(0.9).mul(boost))
        .add(this.uHigh.mul(halo))
        .add(this.uLow.mul(horizon));
      return out.mul(this.uSkyFade).mul(this.uFade);
    })();
    const sky = new THREE.Mesh(new THREE.SphereGeometry(160, 48, 32), skyMat);
    sky.frustumCulled = false;
    this.sky = sky;
    ctx.scene.add(sky);

    // ---- Ship: faceted dart banking over the relief ----
    // Hand-authored delta hull — nose at -z, swept wingtips, raised spine.
    const ship = new THREE.Group();
    const N = [0, 0, -2.4];
    const T = [0, 0.35, 0.55]; // spine rear
    const B = [0, -0.28, 0.55]; // belly rear
    const L = [-2.0, 0, 1.3]; // wingtips
    const R = [2.0, 0, 1.3];
    // prettier-ignore
    const hullVerts = new Float32Array([
      ...N, ...L, ...T, // upper left
      ...N, ...T, ...R, // upper right
      ...N, ...B, ...L, // lower left
      ...N, ...R, ...B, // lower right
      ...L, ...B, ...T, // back left
      ...R, ...T, ...B, // back right
    ]);
    const hullGeo = new THREE.BufferGeometry();
    hullGeo.setAttribute('position', new THREE.BufferAttribute(hullVerts, 3));
    hullGeo.computeVertexNormals(); // non-indexed soup → true flat facets

    const hullMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    hullMat.colorNode = Fn(() => {
      // Faceted shading in view space so banks and rolls catch the light.
      const diff = normalView.normalize().dot(vec3(0.35, 0.55, 0.85).normalize());
      const shade = diff.mul(0.45).add(0.62);
      // Peak-colored leading edge running up to the nose.
      const noseGlow = smoothstep(0.2, -2.2, positionLocal.z).mul(0.4);
      return this.uShipHull.mul(shade).add(this.uPeak.mul(noseGlow));
    })();
    ship.add(new THREE.Mesh(hullGeo, hullMat));

    // Blade tail fin.
    // prettier-ignore
    const finVerts = new Float32Array([
      0, 0.3, 0.35,
      0, 0.95, 1.15,
      0, 0.3, 1.25,
    ]);
    const finGeo = new THREE.BufferGeometry();
    finGeo.setAttribute('position', new THREE.BufferAttribute(finVerts, 3));
    finGeo.computeVertexNormals();
    ship.add(new THREE.Mesh(finGeo, hullMat));

    // Twin engine glows at the wing roots; bloom + afterimage do the trail.
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
    for (const ex of [-0.5, 0.5]) {
      const engine = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), engineMat);
      engine.position.set(ex, 0.02, 1.1);
      ship.add(engine);
    }

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
    this.uTime.value = this.time;
    const ship = this.ship;
    if (!ship || !ship.visible) return;

    // Weave over the terrain; bank into the turns.
    const t = this.time;
    const x = Math.sin(t * 0.42) * 4.2;
    const xVel = Math.cos(t * 0.42) * 0.42 * 4.2;
    const y = 3.2 + Math.sin(t * 0.9) * 0.55 + Math.sin(t * 2.3) * 0.12;
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
    // Nose follows the climb/dive — sells the flight far more than yaw alone.
    const yVel = Math.cos(t * 0.9) * 0.405 + Math.cos(t * 2.3) * 0.276;
    ship.rotation.x = -yVel * 0.3;

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
