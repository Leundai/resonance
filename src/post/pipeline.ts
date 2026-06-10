import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { afterImage } from 'three/addons/tsl/display/AfterImageNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type { FrameFeatures } from '../audio/features';

/**
 * TSL post chain (WebGPU-native; EffectComposer doesn't exist here):
 * scene → afterimage trails → bloom. Bloom strength rides the beat,
 * trail length stretches in quiet passages.
 */
export class PostStack {
  private post: THREE.RenderPipeline;
  private bloomNode: ReturnType<typeof bloom>;
  private afterNode: ReturnType<typeof afterImage>;
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
    this.post.outputNode = this.afterNode;
  }

  update(f: FrameFeatures, dt: number): void {
    if (f.onset) this.pulse = 1;
    else this.pulse *= Math.exp(-dt * 6);

    setUniform(this.bloomNode.strength, 0.2 + f.level * 0.3 + this.pulse * 0.25);
    // Quiet music smears longer; loud music stays crisp.
    setUniform(this.afterNode.damp, 0.42 + (1 - Math.min(f.level * 2, 1)) * 0.18);
  }

  render(): void {
    this.post.render();
  }
}

/** Display-node uniforms are loosely typed; assign through a narrow cast. */
function setUniform(node: unknown, value: number): void {
  (node as { value: number }).value = value;
}
