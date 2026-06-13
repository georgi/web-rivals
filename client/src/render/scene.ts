// Render shell: the THREE scene, camera, renderer + lights (PRD §10, MVP).
// No shadows, no textures — flat low-poly lit by one hemisphere + one
// directional light. Owns its own window 'resize' wiring.

import * as THREE from 'three';
import { TUNING } from '@rivals/shared';

export interface SceneCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  resize(): void;
}

const NEAR = 0.05;
const FAR = 500;
const MAX_DPR = 2;

export function createScene(canvas: HTMLCanvasElement): SceneCtx {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14171c); // dark slate

  const camera = new THREE.PerspectiveCamera(
    TUNING.movement.fovBase,
    window.innerWidth / window.innerHeight,
    NEAR,
    FAR,
  );

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });

  // Hemisphere fill (sky / ground) gives flat geometry readable shading.
  const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x404038, 1.0);
  hemi.position.set(0, 50, 0);
  scene.add(hemi);

  // Single key directional light, no shadows (MVP §10).
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(8, 20, 6);
  scene.add(dir);

  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
    renderer.setSize(w, h, false);
  };

  resize();
  window.addEventListener('resize', resize);

  return { scene, camera, renderer, resize };
}
