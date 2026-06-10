import type * as THREE from 'three/webgpu';
import type { FrameFeatures } from '../audio/features';

export interface SceneContext {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export interface ParamSpec {
  default: number;
  min: number;
  max: number;
}

/**
 * A visual scene declares tunable parameters; the conductor (or the
 * Tweakpane dev panel) drives them. Scenes still receive FrameFeatures
 * for non-scalar data (spectrum bins), but scalar reactivity flows
 * through params so mappings stay data, not code.
 */
export interface VisualScene {
  readonly name: string;
  readonly params: Record<string, ParamSpec>;
  setParam(name: string, value: number): void;
  init(ctx: SceneContext): Promise<void> | void;
  update(features: FrameFeatures, dt: number): void;
  setVisible(visible: boolean): void;
  /** Scenes that want their own framing override the default orbit. */
  updateCamera?(camera: THREE.PerspectiveCamera, t: number, features: FrameFeatures): void;
  dispose(): void;
}
