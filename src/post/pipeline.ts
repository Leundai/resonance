import * as THREE from 'three/webgpu';
import { pass, uniform, vec2 } from 'three/tsl';
import { afterImage } from 'three/addons/tsl/display/AfterImageNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import type { FrameFeatures } from '../audio/features';

export interface ConductorSignals {
  pulse: number;
  downbeat: number;
  inhale: number;
  drop: number;
}

/**
 * TSL post chain (WebGPU-native; EffectComposer doesn't exist here):
 * scene → afterimage trails → bloom. Bloom strength rides the beat,
 * trail length stretches in quiet passages.
 */
export class PostStack {
  private post: THREE.RenderPipeline;
  private bloomNode: ReturnType<typeof bloom>;
  private afterNode: ReturnType<typeof afterImage>;
  private uCA = uniform(0);
  private pulse = 0;

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) {
    const scenePass = pass(scene, camera);
    // Bloom the crisp scene; trails apply to the composite so the
    // feedback loop never re-blooms its own accumulation.
    this.bloomNode = bloom(scenePass, 0.4, 0.4, 0.3);
    // .add is installed at runtime via addMethodChaining; display-node .d.ts lags.
    const composite = (
      scenePass as unknown as { add: (n: unknown) => THREE.Node }
    ).add(this.bloomNode);
    this.afterNode = afterImage(composite, 0.6);
    this.post = new THREE.RenderPipeline(renderer);
    // Chromatic aberration last — it kicks only on drops/transients.
    this.post.outputNode = chromaticAberration(
      this.afterNode,
      this.uCA,
      vec2(0.5, 0.5),
      uniform(1.04),
    );
  }

  update(f: FrameFeatures, dt: number, signals?: ConductorSignals): void {
    if (f.onset) this.pulse = 1;
    else this.pulse *= Math.exp(-dt * 6);

    const drop = signals?.drop ?? 0;
    const inhale = signals?.inhale ?? 0;
    const downbeat = signals?.downbeat ?? 0;
    setUniform(
      this.bloomNode.strength,
      (0.2 + f.level * 0.3 + this.pulse * 0.25 + downbeat * 0.22 + drop * 0.7) *
        (1 - inhale * 0.5),
    );
    // Quiet music smears longer; loud music stays crisp.
    setUniform(this.afterNode.damp, 0.42 + (1 - Math.min(f.level * 2, 1)) * 0.18);
    this.uCA.value = drop * 1.6 + this.pulse * 0.12;
  }

  render(): void {
    this.post.render();
  }
}

/** Display-node uniforms are loosely typed; assign through a narrow cast. */
function setUniform(node: unknown, value: number): void {
  (node as { value: number }).value = value;
}
