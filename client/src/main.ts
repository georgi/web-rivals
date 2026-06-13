// M1 movement sandbox boot. Wires the shared sim (movement + Rapier trace) to
// the Three render shell, pointer-lock mouselook, and the fixed-timestep loop.
// Single local player, one stationary target dummy, F3 debug panel. No net.

import * as THREE from 'three';
import {
  TUNING,
  SIM_DT,
  CRATE_MAP,
  RapierTraceWorld,
  createMoveState,
  stepMovement,
  eyePosition,
  horizontalSpeed,
  standHalf,
  newEvents,
  v3,
  copy,
  lerp,
  lerpScalar,
} from '@rivals/shared';
import type { Vec3 } from '@rivals/shared';

import { createScene } from './render/scene';
import { buildMapMesh } from './render/map-mesh';
import { PointerLockCamera } from './camera';
import { Input } from './input';
import { createDebugPanel } from './debug';
import { createLoop } from './loop';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
const overlay = document.getElementById('overlay') as HTMLElement | null;
if (!canvas) throw new Error('#game canvas missing');
if (!overlay) throw new Error('#overlay element missing');

// ---- centered overlay prompt (the #overlay layer is pointer-events:none) ----
const prompt = document.createElement('div');
prompt.style.cssText = [
  'position:fixed',
  'inset:0',
  'display:flex',
  'align-items:center',
  'justify-content:center',
  'font:600 22px system-ui,-apple-system,sans-serif',
  'color:#f5f7fa',
  'letter-spacing:0.02em',
  'text-shadow:0 2px 8px rgba(0,0,0,0.6)',
  'pointer-events:none',
].join(';');
overlay.appendChild(prompt);
const showPrompt = (text: string): void => {
  prompt.textContent = text;
  prompt.style.display = 'flex';
};
const hidePrompt = (): void => {
  prompt.style.display = 'none';
};

showPrompt('Loading…');

async function boot(): Promise<void> {
  const world = await RapierTraceWorld.create(CRATE_MAP.solids);
  showPrompt('Click to play');

  // ---- render shell + static map ----
  const { scene, camera, renderer } = createScene(canvas!);
  scene.add(buildMapMesh(CRATE_MAP));

  // Stationary target dummy on the center high-ground (movement tutorial space,
  // §6) — visual only, enemy-red. A capsule sat so its feet rest on the crate.
  const m = TUNING.movement;
  const dummyMat = new THREE.MeshStandardMaterial({
    color: 0xff5a5a,
    roughness: 0.85,
    metalness: 0.0,
    flatShading: true,
  });
  const dummyHeight = m.standHeight - 2 * m.radius; // cylinder segment length
  const dummyGeo = new THREE.CapsuleGeometry(m.radius, dummyHeight, 6, 12);
  const dummy = new THREE.Mesh(dummyGeo, dummyMat);
  // Crate top is y=3 (box pos[0,1.5,0] size 3 -> top 3); center the capsule so
  // its feet sit on top: center.y = 3 + standHeight/2.
  dummy.position.set(0, 3 + m.standHeight / 2, 0);
  scene.add(dummy);

  // ---- local player ----
  const spawn = CRATE_MAP.spawns[0];
  const centerY = spawn.pos[1] + m.radius + standHalf(); // feet -> capsule center
  const state = createMoveState(
    { x: spawn.pos[0], y: centerY, z: spawn.pos[2] },
    spawn.yaw,
  );

  const input = new Input(canvas!);
  const plc = new PointerLockCamera(canvas!);
  plc.yaw = state.yaw;

  // Click to lock; the lock callback drives input-enable and the resume prompt.
  // PointerLock has a ~1s browser-imposed re-lock cooldown after an unlock; we
  // just surface the prompt and let the user click again.
  canvas!.addEventListener('click', () => plc.requestLock());
  plc.onLockChange((locked) => {
    input.setEnabled(locked);
    if (locked) hidePrompt();
    else showPrompt('Click to resume');
  });

  // ---- respawn helper ----
  const spawnCenter: Vec3 = { x: spawn.pos[0], y: centerY, z: spawn.pos[2] };
  const respawn = (): void => {
    copy(state.pos, spawnCenter);
    state.vel.x = 0;
    state.vel.y = 0;
    state.vel.z = 0;
    state.grounded = false;
    state.moveState = 'air';
    state.capsuleHalf = standHalf();
  };

  // ---- step / render plumbing ----
  const events = newEvents();
  const eyeScratch: Vec3 = v3();
  const prevEye: Vec3 = v3();
  let prevFov = state.fov;
  const interpEye: Vec3 = v3();

  // Seed prev snapshot so the very first render interpolates from a sane place.
  eyePosition(state, prevEye);
  prevFov = state.fov;

  const step = (): void => {
    // Snapshot current eye + fov as the "previous" for next render interpolation.
    eyePosition(state, prevEye);
    prevFov = state.fov;

    const frame = input.buildFrame(plc.yaw, plc.pitch);
    state.yaw = frame.yaw;
    state.pitch = frame.pitch;
    stepMovement(state, frame, world, SIM_DT, events);
    if (events.jumped) input.consumeJump();

    if (state.pos.y < CRATE_MAP.killY) respawn();
  };

  const render = (alpha: number): void => {
    eyePosition(state, eyeScratch);
    lerp(interpEye, prevEye, eyeScratch, alpha);
    const interpFov = lerpScalar(prevFov, state.fov, alpha);
    plc.applyTo(camera, interpEye, interpFov);
    renderer.render(scene, camera);
  };

  // ---- F3 debug panel (starts hidden) ----
  createDebugPanel(() => ({
    speed: horizontalSpeed(state),
    state: state.moveState,
    grounded: state.grounded,
    fov: state.fov,
    pos: state.pos,
  }));

  const loop = createLoop({
    dt: SIM_DT,
    maxCatchupMs: TUNING.world.maxCatchupMs,
    step,
    render,
  });
  loop.start();
}

void boot();
