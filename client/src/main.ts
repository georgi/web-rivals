// M2 combat sandbox boot. Wires the shared sim (movement + Rapier trace + the
// shared projectile ballistics) to the Three render shell, pointer-lock
// mouselook, and the fixed-timestep loop. Single local player fights a
// stationary target dummy: AR hitscan, rocket (rocket-jump), knife, grenade.
// All combat is LOCAL-ONLY in M2 (no net); the server takes over damage in M3.

import * as THREE from 'three';
import {
  TUNING,
  SIM_DT,
  CRATE_MAP,
  RapierTraceWorld,
  createMoveState,
  stepMovement,
  applyImpulse,
  eyePosition,
  horizontalSpeed,
  standHalf,
  newEvents,
  Button,
  v3,
  set,
  copy,
  clamp,
  lerp,
  lerpScalar,
} from '@rivals/shared';
import type { Vec3, WeaponSlot, ProjKind } from '@rivals/shared';

import { createScene } from './render/scene';
import { buildMapMesh } from './render/map-mesh';
import { PointerLockCamera } from './camera';
import { Input } from './input';
import { createDebugPanel } from './debug';
import { createLoop } from './loop';

import { Weapons } from './weapons/weapon-state';
import { Viewmodel } from './weapons/viewmodel';
import { hitscan, applyBloom } from './combat/hitscan';
import type { CapsuleTarget } from './combat/hitscan';
import { Particles } from './render/particles';
import { LocalProjectiles } from './combat/local-projectiles';
import type { ProjectileHooks } from './combat/local-projectiles';
import { Dummy } from './entities/dummy';
import { Hud } from './ui/hud';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
const overlay = document.getElementById('overlay') as HTMLElement | null;
const hudRoot = document.getElementById('hud') as HTMLElement | null;
if (!canvas) throw new Error('#game canvas missing');
if (!overlay) throw new Error('#overlay element missing');
if (!hudRoot) throw new Error('#hud element missing');

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

// Map a weapon slot to its TUNING key for the HUD name.
const SLOT_KEY = { 1: 'ar', 2: 'rocket', 3: 'knife', 4: 'grenade' } as const;
function weaponName(slot: WeaponSlot): string {
  return TUNING[SLOT_KEY[slot]].name;
}

async function boot(): Promise<void> {
  const world = await RapierTraceWorld.create(CRATE_MAP.solids);
  showPrompt('Click to play');

  // ---- render shell + static map ----
  const { scene, camera, renderer } = createScene(canvas!);
  scene.add(buildMapMesh(CRATE_MAP));

  const m = TUNING.movement;
  const LOCAL_ID = 0;

  // ---- target dummy (replaces the M1 placeholder capsule) ----
  const dummy = new Dummy(1, { x: 0, y: 3.9, z: 0 });
  scene.add(dummy.object);

  // ---- combat FX pools ----
  const particles = new Particles();
  scene.add(particles.object);

  // ---- viewmodel: parent to the camera, add the camera to the scene so the
  // viewmodel renders. The camera's near plane is 0.05 and the viewmodel rests
  // at z=-0.6, so it sits comfortably in front without clipping the near plane.
  const weapons = new Weapons();
  const viewmodel = new Viewmodel();
  camera.add(viewmodel.object);
  scene.add(camera);

  // ---- local player ----
  const spawn = CRATE_MAP.spawns[0];
  const centerY = spawn.pos[1] + m.radius + standHalf(); // feet -> capsule center
  const state = createMoveState(
    { x: spawn.pos[0], y: centerY, z: spawn.pos[2] },
    spawn.yaw,
  );

  let localHp = TUNING.combat.spawnHealth;

  const input = new Input(canvas!);
  const plc = new PointerLockCamera(canvas!);
  plc.yaw = state.yaw;

  // Click to lock; the lock callback drives input-enable and the resume prompt.
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
    state.pendingImpulse.x = 0;
    state.pendingImpulse.y = 0;
    state.pendingImpulse.z = 0;
    localHp = TUNING.combat.spawnHealth;
  };

  // ---- local-only projectile sim (rockets/grenades) ----
  const hooks: ProjectileHooks = {
    localPlayerId: LOCAL_ID,
    targets: () => [
      dummy.capsuleTarget(),
      {
        id: LOCAL_ID,
        center: state.pos,
        radius: m.radius,
        halfHeight: state.capsuleHalf,
      },
    ],
    onDamage: (id, amt) => {
      if (id === dummy.id) {
        dummy.applyDamage(amt);
      } else if (id === LOCAL_ID) {
        localHp -= amt;
        if (localHp <= 0) respawn();
      }
    },
    onImpulse: (id, imp) => {
      if (id === LOCAL_ID) applyImpulse(state, imp.x, imp.y, imp.z);
    },
  };
  const projectiles = new LocalProjectiles(world, particles, hooks);
  scene.add(projectiles.object);

  // ---- HUD ----
  const hud = new Hud(hudRoot!);

  // ---- step / render plumbing ----
  const events = newEvents();
  const eyeScratch: Vec3 = v3();
  const prevEye: Vec3 = v3();
  let prevFov = state.fov;
  const interpEye: Vec3 = v3();

  // Combat scratch (zero per-frame alloc).
  const _eye: Vec3 = v3();
  const _fwd: Vec3 = v3();
  const _muzzle: Vec3 = v3();
  const _dir: Vec3 = v3();
  const _toDummy: Vec3 = v3();
  const _dummyFwd: Vec3 = v3();

  // Sustained-fire bloom (radians). Grows per AR shot toward bloomMax, recovers
  // over time toward bloomMin. Drives both hitscan spread and the crosshair gap.
  let bloom = TUNING.ar.bloomMin;
  // Per-shot sequence counter for deterministic bloom (PRD §22).
  let shotSeq = 0;

  // Compute the view-forward unit vector from yaw/pitch into `out`. Matches the
  // camera's Euler(pitch, yaw, 0, 'YXZ') orientation exactly so shots,
  // projectiles and the viewmodel all agree with the crosshair.
  const viewForward = (yaw: number, pitch: number, out: Vec3): void => {
    const cp = Math.cos(pitch);
    set(out, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  };

  // Muzzle origin: a touch in front of the eye along the view dir so the tracer
  // doesn't start inside the camera.
  const MUZZLE_OFFSET = 0.4;

  // Real-time clock for cosmetic (render-rate) updates. The loop only hands us
  // `alpha`; particles/dummy/viewmodel want the actual frame dt, so we derive it
  // here. Capped so a tab-out doesn't fast-forward FX by a huge delta.
  let lastRenderMs = performance.now();
  const MAX_RENDER_DT = 0.1;

  // Seed prev snapshot so the very first render interpolates from a sane place.
  eyePosition(state, prevEye);
  prevFov = state.fov;

  const fireWeapon = (slot: WeaponSlot, yaw: number, pitch: number): void => {
    eyePosition(state, _eye);
    viewForward(yaw, pitch, _fwd);
    set(
      _muzzle,
      _eye.x + _fwd.x * MUZZLE_OFFSET,
      _eye.y + _fwd.y * MUZZLE_OFFSET,
      _eye.z + _fwd.z * MUZZLE_OFFSET,
    );

    if (slot === 1) {
      // AR: hitscan with seeded bloom. Spread is the current sustained bloom.
      const spread = clamp(bloom, TUNING.ar.bloomMin, TUNING.ar.bloomMax);
      applyBloom(_dir, _fwd, spread, shotSeq++);
      const res = hitscan(_eye, _dir, TUNING.ar.range, world, [dummy.capsuleTarget()]);
      particles.tracer(_muzzle, res.point);
      if (res.kind === 'entity' && res.entityId === dummy.id) {
        dummy.applyDamage(TUNING.ar.damage);
        hud.hitmarker();
      } else if (res.kind === 'world') {
        particles.impact(res.point, res.normal);
      }
      // Open the crosshair / spread on each shot, capped at bloomMax.
      bloom = Math.min(TUNING.ar.bloomMax, bloom + TUNING.ar.bloomPerShot);
      viewmodel.onFire(1);
    } else if (slot === 2) {
      projectiles.spawn('rocket', _muzzle, _fwd, LOCAL_ID);
      viewmodel.onFire(2);
    } else if (slot === 3) {
      // Knife: a short reach box query in the view direction. Project the dummy
      // center onto the view ray; hit if within range ahead and laterally close.
      const k = TUNING.knife;
      const c = dummy.capsuleTarget().center;
      set(_toDummy, c.x - _eye.x, c.y - _eye.y, c.z - _eye.z);
      const along = _toDummy.x * _fwd.x + _toDummy.y * _fwd.y + _toDummy.z * _fwd.z;
      if (along > 0 && along <= k.range) {
        // Perpendicular distance from the ray.
        const px = _toDummy.x - _fwd.x * along;
        const py = _toDummy.y - _fwd.y * along;
        const pz = _toDummy.z - _fwd.z * along;
        const lateral = Math.hypot(px, py, pz);
        if (lateral <= k.hitboxHalfWidth + dummy.radius) {
          // Backstab when attacking into the dummy's facing direction.
          set(_dummyFwd, -Math.sin(dummy.facingYaw), 0, -Math.cos(dummy.facingYaw));
          const backDot = _dummyFwd.x * _fwd.x + _dummyFwd.z * _fwd.z;
          const backstab = backDot > k.backstabDotThreshold;
          dummy.applyDamage(backstab ? k.backstabDamage : k.damage);
          hud.hitmarker();
        }
      }
      viewmodel.onFire(3);
    } else if (slot === 4) {
      projectiles.spawn('grenade', _muzzle, _fwd, LOCAL_ID);
      viewmodel.onFire(4);
    }
  };

  const step = (): void => {
    // Snapshot current eye + fov as the "previous" for next render interpolation.
    eyePosition(state, prevEye);
    prevFov = state.fov;

    const locked = plc.locked;

    // Tell movement whether the knife is out (applies +knifeSpeedBonus next tick).
    state.knifeOut = weapons.knifeOut;

    const frame = input.buildFrame(plc.yaw, plc.pitch);
    state.yaw = frame.yaw;
    state.pitch = frame.pitch;
    stepMovement(state, frame, world, SIM_DT, events);
    if (events.jumped) input.consumeJump();

    if (state.pos.y < CRATE_MAP.killY) respawn();

    // ---- weapon select (number keys / wheel set input.selectedWeapon) ----
    if (locked) {
      const sel = input.selectedWeapon as WeaponSlot;
      if (sel !== weapons.current) {
        weapons.select(sel);
        viewmodel.setWeapon(sel);
      }
      // Reload edge.
      if ((input.buttons & Button.Reload) !== 0) weapons.startReload();
    }

    // ---- firing ----
    const triggerHeld = locked && (input.buttons & Button.Fire) !== 0;
    if (weapons.tryFire(triggerHeld)) {
      fireWeapon(weapons.current, state.yaw, state.pitch);
    }

    // Advance weapon timers and step ballistics at the fixed dt for determinism.
    weapons.update(SIM_DT);
    projectiles.update(SIM_DT);

    // Bloom recovery toward the floor (independent of fire).
    bloom = Math.max(TUNING.ar.bloomMin, bloom - TUNING.ar.bloomRecover * SIM_DT);

    // ---- HUD (writes only on change) ----
    const a = weapons.ammo();
    hud.update({
      hp: localHp,
      weaponName: weaponName(weapons.current),
      clip: a.clip,
      reserve: a.reserve,
    });
    // Map bloom radians to a crosshair gap in pixels.
    hud.setCrosshairBloom((bloom / TUNING.ar.bloomMax) * 14);
  };

  const render = (alpha: number): void => {
    const nowMs = performance.now();
    let dt = (nowMs - lastRenderMs) / 1000;
    lastRenderMs = nowMs;
    if (dt > MAX_RENDER_DT) dt = MAX_RENDER_DT;

    eyePosition(state, eyeScratch);
    lerp(interpEye, prevEye, eyeScratch, alpha);
    const interpFov = lerpScalar(prevFov, state.fov, alpha);
    plc.applyTo(camera, interpEye, interpFov);

    // Cosmetic updates at the real frame dt.
    particles.update(dt);
    dummy.update(dt, camera);
    viewmodel.update(dt, horizontalSpeed(state), state.grounded);

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
