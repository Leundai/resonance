import type * as THREE from 'three/webgpu';
import type { FrameFeatures } from '../audio/features';

export interface SceneContext {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export interface VisualScene {
  readonly name: string;
  init(ctx: SceneContext): Promise<void> | void;
  /** Called once per render frame with the current feature bus frame. */
  update(features: FrameFeatures, dt: number): void;
  dispose(): void;
}
