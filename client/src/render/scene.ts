// Render shell: the THREE scene, camera, renderer + a post-processing pipeline
// (PRD §10 relaxed — the brief is now "looks like a professional 3D game").
//
// Optics stack, in order of visual impact:
//   * graded sky + distance fog so the world has atmosphere, not a black void
//   * soft PCF shadow maps from a sun key light — grounds every object
//   * RoomEnvironment IBL for soft, directional ambient on flat low-poly faces
//   * GTAO (ground-truth ambient occlusion) for contact darkening in crevices
//   * subtle UnrealBloom on highlights, a vignette, and ACES tone mapping
//
// createScene owns the EffectComposer and returns a render() closure; main.ts
// calls that instead of renderer.render so the whole pipeline stays here.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { TUNING } from '@rivals/shared';

/** Graphics quality presets (PRD §8 / §10). Each tier scales the per-frame GPU
 * cost: the post-processing stack, the shadow map, and the render resolution.
 * `low` is built to clear comfortable framerates on integrated GPUs; `high` is
 * the full cinematic stack. */
export type QualityLevel = 'low' | 'medium' | 'high';

interface QualityConfig {
  /** Hard cap on devicePixelRatio — the single biggest lever (cost ∝ pixels²). */
  dprCap: number;
  /** Shadow map resolution (square). 0 disables shadows entirely. */
  shadowMapSize: number;
  /** Ground-truth AO pass — the heaviest single effect; High only. */
  gtao: boolean;
  /** UnrealBloom on bright highlights (muzzle flashes, tracers). */
  bloom: boolean;
  /** SMAA edge antialiasing on the final image. */
  smaa: boolean;
}

export const QUALITY: Record<QualityLevel, QualityConfig> = {
  // Integrated-GPU target: native res, smaller shadows, no screen-space effects
  // except SMAA (cheap and essential on the high-contrast white-box edges).
  low: { dprCap: 1, shadowMapSize: 1024, gtao: false, bloom: false, smaa: true },
  // Mid: capped retina, bloom for combat readability, still no GTAO.
  medium: { dprCap: 1.5, shadowMapSize: 1536, gtao: false, bloom: true, smaa: true },
  // The full stack (prior default).
  high: { dprCap: 2, shadowMapSize: 2048, gtao: true, bloom: true, smaa: true },
};

export interface SceneCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Render one frame through the full post-processing pipeline. */
  render(): void;
  /** Mark every Mesh under a root so it casts/receives shadows. */
  registerShadows(root: THREE.Object3D): void;
  /** Swap the graphics quality tier at runtime (rebuilds the post stack). */
  setQuality(q: QualityLevel): void;
  resize(): void;
}

const NEAR = 0.05;
const FAR = 500;

// Atmosphere palette — bright, high-key "clean arena" look (Roblox Rivals): a
// light blue zenith fading to near-white at the horizon, where the white-box
// geometry dissolves into a pale haze.
const SKY_TOP = '#5ba6e8'; // bright sky blue zenith
const SKY_HORIZON = '#eaf2fa'; // near-white at the eyeline
const FOG_COLOR = 0xe6eef7; // pale, just shy of the horizon white

// A vertical gradient drawn fullscreen behind the scene — cheap, stable, and far
// more legible than a flat clear colour.
function makeSkyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, SKY_TOP);
  grad.addColorStop(0.45, '#9cc8ee');
  grad.addColorStop(1, SKY_HORIZON);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export function createScene(canvas: HTMLCanvasElement, quality: QualityLevel = 'high'): SceneCtx {
  let q = QUALITY[quality];
  const scene = new THREE.Scene();
  scene.background = makeSkyTexture();
  // Light, distant haze — just enough to melt far geometry into the bright sky.
  scene.fog = new THREE.Fog(FOG_COLOR, 120, 460);

  const camera = new THREE.PerspectiveCamera(
    TUNING.movement.fovBase,
    window.innerWidth / window.innerHeight,
    NEAR,
    FAR,
  );

  // With the EffectComposer owning AA (SMAA) and colour output, the default
  // framebuffer needs no MSAA and no stencil — dropping them frees bandwidth.
  // high-performance asks the browser for the discrete GPU on dual-GPU machines.
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  // Neutral (Khronos PBR) tone map keeps the bright white surfaces clean and
  // un-tinted where ACES would crush and desaturate them — the high-key arena
  // look needs whites to read as white, not grey.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Soft, LIGHT shadows: present for grounding, but the strong ambient fills
  // them so they read as the pale contact shadows of the reference, not black.
  renderer.shadowMap.enabled = q.shadowMapSize > 0;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // ---- image-based ambient: RoomEnvironment gives soft directional irradiance.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.7;

  // ---- light rig: bright sky-dome ambient does most of the work; a soft
  // overhead sun adds just enough directionality + light contact shadows. This
  // is a HIGH-KEY rig — fill-dominant, so nothing crushes to black.
  const hemi = new THREE.HemisphereLight(0xeaf4ff, 0xc4cbd4, 2.0);
  hemi.position.set(0, 50, 0);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff7ec, 1.7);
  // High and only slightly raked: short, soft shadows like the reference's clean
  // overhead studio light — not the long dramatic shadows of a low sun.
  key.position.set(24, 56, 16);
  key.castShadow = true;
  key.shadow.mapSize.set(q.shadowMapSize || 2048, q.shadowMapSize || 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 200;
  const S = 70; // ortho half-extent: must cover the arena footprint
  key.shadow.camera.left = -S;
  key.shadow.camera.right = S;
  key.shadow.camera.top = S;
  key.shadow.camera.bottom = -S;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.04;
  // Lift shadow darkness toward the reference's barely-there contact shade.
  key.shadow.intensity = 0.6;
  scene.add(key);
  scene.add(key.target);

  // ================= post-processing pipeline =================
  // The pass stack is (re)built from the active quality tier so changing quality
  // at runtime adds/removes the heavy screen-space effects rather than just
  // toggling them. EffectComposer + every pass own GPU render targets, so the
  // old composer is disposed before a rebuild to avoid leaking VRAM.
  let composer!: EffectComposer;
  const buildComposer = (): void => {
    if (composer) {
      // EffectComposer.dispose() frees only its own ping-pong buffers; the
      // passes (GTAO/bloom/SMAA) each own render targets, so dispose them too or
      // repeated quality switches leak VRAM.
      for (const pass of composer.passes) {
        (pass as { dispose?: () => void }).dispose?.();
      }
      composer.dispose();
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    // Ground-truth AO: contact darkening where geometry meets, plus crevice
    // depth. The heaviest pass (sampled + denoised at full res) — High only.
    if (q.gtao) {
      const gtao = new GTAOPass(scene, camera, w, h);
      gtao.output = GTAOPass.OUTPUT.Default;
      // Tuned for a metre-scale arena: a ~0.5m sampling radius reads as contact
      // AO without haloing across the open floor.
      gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.0, scale: 1.2, thickness: 1.0 });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 16 });
      composer.addPass(gtao);
    }

    // Bloom only on the genuinely bright bits (muzzle flashes, tracers, glints)
    // — a high threshold keeps the bright-but-not-hot white walls from blooming
    // and washing the frame out.
    if (q.bloom) {
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.22, 0.5, 0.92));
    }

    // Tone map + sRGB encode (reads renderer.toneMapping); last colour pass. No
    // vignette — the reference is bright edge-to-edge.
    composer.addPass(new OutputPass());

    // SMAA anti-aliasing on the final image (cheaper than MSAA with the
    // composer). Kept on every tier — the white-box edges alias badly without it.
    if (q.smaa) composer.addPass(new SMAAPass(w, h));

    const dpr = Math.min(window.devicePixelRatio, q.dprCap);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
  };
  buildComposer();

  // ---- shadow registration: set per-Mesh cast/receive (Groups don't inherit) ----
  const registerShadows = (root: THREE.Object3D): void => {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
  };

  const render = (): void => {
    composer.render();
  };

  const resize = (): void => {
    const ww = window.innerWidth;
    const hh = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, q.dprCap);
    camera.aspect = ww / hh;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(dpr);
    renderer.setSize(ww, hh, false);
    composer.setPixelRatio(dpr);
    composer.setSize(ww, hh);
  };

  // Swap quality at runtime: re-point the active config, then apply each lever —
  // shadow map (dispose so it regenerates at the new size), DPR (via resize),
  // and the post stack (rebuild). Cheap enough for the live Settings slider.
  const setQuality = (level: QualityLevel): void => {
    q = QUALITY[level];
    renderer.shadowMap.enabled = q.shadowMapSize > 0;
    if (q.shadowMapSize > 0) {
      key.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      // Drop the cached shadow target so THREE re-allocates it at the new size.
      key.shadow.map?.dispose();
      key.shadow.map = null as unknown as THREE.WebGLRenderTarget;
      key.shadow.needsUpdate = true;
    }
    buildComposer();
    resize();
  };

  resize();
  window.addEventListener('resize', resize);

  return { scene, camera, renderer, render, registerShadows, setQuality, resize };
}
