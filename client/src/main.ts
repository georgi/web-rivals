// M3 boot. Wires the shared sim (movement + Rapier trace + shared projectile
// ballistics) to the Three render shell, pointer-lock mouselook, and the
// fixed-timestep loop, and adds NETWORKING on top of the M2 sandbox.
//
// Two modes (PRD §3.1, §6, §19):
//   OFFLINE — no server reachable within a short timeout: the M2 single-player
//     combat sandbox runs unchanged (dummy + fully local combat). This path is
//     the fallback and MUST keep working.
//   ONLINE  — connected to an authoritative server:
//     * local movement stays LOCAL (zero added latency); Input is sent at 30Hz.
//     * the opponent is an interpolated capsule sampled from the SnapshotBuffer
//       at serverTimeEstimate - interpDelayMs (freeze, never rubber-band).
//     * combat is server-authoritative: firing sends Shoot + immediate COSMETIC
//       feedback (tracer / predicted projectile); hp comes from server Damage.
//       Rocket-jump SELF-knockback stays predicted+instant; opponent knockback
//       is applied from the server detonate impulse.

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
  EventFlag,
  v3,
  set,
  copy,
  clamp,
  lerp,
  lerpScalar,
} from '@rivals/shared';
import type { Vec3, Vec3Tuple, WeaponSlot } from '@rivals/shared';

import { createScene } from './render/scene';
import { buildMapMesh } from './render/map-mesh';
import { PointerLockCamera } from './camera';
import { Input } from './input';
import { createDebugPanel } from './debug';
import { createLoop } from './loop';

import { Weapons } from './weapons/weapon-state';
import { Viewmodel } from './weapons/viewmodel';
import { hitscan, applyBloom } from './combat/hitscan';
import { Particles } from './render/particles';
import { LocalProjectiles } from './combat/local-projectiles';
import type { ProjectileHooks } from './combat/local-projectiles';
import { Dummy } from './entities/dummy';
import { RemotePlayer } from './entities/remote-player';
import { Hud } from './ui/hud';

import { WebSocketTransport, DelayedTransport } from './net/transport';
import { NetClient } from './net/connection';

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

// The PRD §19 latency gate: ALL networked testing runs through DelayedTransport
// at 100ms / 2% loss. Exposed so the F3 panel can show it.
const NET = {
  delayMs: 100,
  jitterMs: 0,
  dropRate: 0.02,
  connectTimeoutMs: 2500,
};

// Map a weapon slot to its TUNING key for the HUD name.
const SLOT_KEY = { 1: 'ar', 2: 'rocket', 3: 'knife', 4: 'grenade' } as const;
function weaponName(slot: WeaponSlot): string {
  return TUNING[SLOT_KEY[slot]].name;
}

/**
 * Attempt to reach the server within NET.connectTimeoutMs. Returns a connected
 * NetClient or null (offline). The transport is always wrapped in the
 * DelayedTransport latency gate so dev/test mirrors production conditions.
 */
async function tryConnect(name: string): Promise<NetClient | null> {
  let transport: WebSocketTransport;
  try {
    transport = new WebSocketTransport(__WS_URL__);
  } catch {
    return null; // bad URL / WebSocket unavailable
  }
  const delayed = new DelayedTransport(transport, {
    delayMs: NET.delayMs,
    jitterMs: NET.jitterMs,
    dropRate: NET.dropRate,
  });
  const net = new NetClient(delayed);
  try {
    await net.connect(name, undefined, NET.connectTimeoutMs);
    return net;
  } catch {
    net.close();
    return null;
  }
}

async function boot(): Promise<void> {
  const world = await RapierTraceWorld.create(CRATE_MAP.solids);

  // Try the server first (offline fallback if it isn't reachable).
  showPrompt('Connecting…');
  const net = await tryConnect('Player');
  const online = net !== null;

  showPrompt('Click to play');

  // ---- render shell + static map ----
  const { scene, camera, renderer } = createScene(canvas!);
  scene.add(buildMapMesh(CRATE_MAP));

  const m = TUNING.movement;
  const LOCAL_ID = net ? net.playerId : 0;

  // ---- target dummy (solo-wait; hidden once a real opponent is present) ----
  const dummy = new Dummy(1, { x: 0, y: 3.9, z: 0 });
  scene.add(dummy.object);

  // ---- networked opponent capsule (online only; added always, shown on join) ----
  const remote = new RemotePlayer();
  scene.add(remote.object);

  // ---- combat FX pools ----
  const particles = new Particles();
  scene.add(particles.object);

  // ---- viewmodel ----
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
    if (net) net.setHp(localHp);
  };

  // ---- projectile sim ----
  // OFFLINE: rockets/grenades simulate + resolve damage/knockback locally.
  // ONLINE: the SAME class renders a COSMETIC predicted copy; we route its
  // damage hooks to a no-op (server owns damage) but keep the SELF-knockback so
  // rocket-jump stays instant on the shooter. The server's own detonate for our
  // rocket is deduped (see net.onDetonate) so we don't double-apply.
  const hooks: ProjectileHooks = {
    localPlayerId: LOCAL_ID,
    targets: () =>
      online
        ? [
            // Online: only the local player is a valid self-knockback target;
            // opponent damage/knockback is server-authoritative.
            { id: LOCAL_ID, center: state.pos, radius: m.radius, halfHeight: state.capsuleHalf },
          ]
        : [
            dummy.capsuleTarget(),
            { id: LOCAL_ID, center: state.pos, radius: m.radius, halfHeight: state.capsuleHalf },
          ],
    onDamage: (id, amt) => {
      if (online) return; // server-authoritative damage online
      if (id === dummy.id) {
        dummy.applyDamage(amt);
      } else if (id === LOCAL_ID) {
        localHp -= amt;
        if (localHp <= 0) respawn();
      }
    },
    onImpulse: (id, imp) => {
      // Self-knockback (rocket-jump) is predicted + instant in BOTH modes.
      if (id === LOCAL_ID) applyImpulse(state, imp.x, imp.y, imp.z);
    },
  };
  const projectiles = new LocalProjectiles(world, particles, hooks);
  scene.add(projectiles.object);

  // ---- HUD ----
  const hud = new Hud(hudRoot!);

  // ---- network event wiring (online only) ----
  let opponentPresent = false;
  if (net) {
    net.onOpponent = (o) => {
      if (o.present) {
        opponentPresent = true;
        remote.show(o.id);
        dummy.object.visible = false; // hide solo-wait dummy
      } else {
        opponentPresent = false;
        remote.hide();
        dummy.object.visible = true; // back to solo-wait
      }
    };

    net.onDamage = (d) => {
      if (d.victim === LOCAL_ID) {
        localHp = d.newHp;
        if (localHp <= 0) respawn();
      } else {
        // We damaged the opponent -> hitmarker feedback.
        hud.hitmarker();
      }
    };

    // Server-authoritative explosions: apply opponent-inflicted knockback to ME,
    // EXCEPT my own rocket's self-impulse which I already applied on the local
    // predicted detonation. The Detonate carries no owner, so we dedupe by a short
    // guard window opened on every local predicted rocket/grenade launch: a server
    // impulse on us during that window is the echo of our own shot (already
    // applied) and is skipped; outside it, it is opponent-inflicted and applied.
    net.onDetonate = (det) => {
      if (!det.impulses) return;
      for (const imp of det.impulses) {
        if (imp.id !== LOCAL_ID) continue;
        if (selfDetonationGuard > 0) continue; // echo of our own predicted launch
        applyImpulse(state, imp.impulse[0], imp.impulse[1], imp.impulse[2]);
      }
    };

    // Cosmetic reconciliation: render the server's authoritative projectiles for
    // shots we did NOT fire (the opponent's). Our own are already predicted.
    net.onSpawnProj = (sp) => {
      if (sp.owner === LOCAL_ID) return; // ours is locally predicted
      const dir: Vec3 = { x: sp.vel[0], y: sp.vel[1], z: sp.vel[2] };
      const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
      dir.x /= len;
      dir.y /= len;
      dir.z /= len;
      const origin: Vec3 = { x: sp.pos[0], y: sp.pos[1], z: sp.pos[2] };
      projectiles.spawn(sp.kind, origin, dir, sp.owner);
    };

    net.onCorrection = (c) => {
      // Authoritative snap-back of our movement state.
      set(state.pos, c.pos[0], c.pos[1], c.pos[2]);
      set(state.vel, c.vel[0], c.vel[1], c.vel[2]);
    };

    net.onClose = () => {
      // Lost the server mid-session: surface it; the sandbox keeps running with
      // local movement (no further net traffic).
      opponentPresent = false;
      remote.hide();
      dummy.object.visible = true;
    };
  }

  // Brief window after a local predicted rocket detonation where we ignore the
  // server's self-impulse echo (prevents a double rocket-jump). Counted down in
  // sim ticks (~ a few hundred ms covers the 100ms-each-way round trip + jitter).
  let selfDetonationGuard = 0;

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
  // Reusable tuples for outgoing Input/Shoot (avoid per-tick alloc).
  const _posT: Vec3Tuple = [0, 0, 0];
  const _velT: Vec3Tuple = [0, 0, 0];
  const _originT: Vec3Tuple = [0, 0, 0];
  const _dirT: Vec3Tuple = [0, 0, 0];

  let bloom = TUNING.ar.bloomMin;
  let shotSeq = 0;

  const viewForward = (yaw: number, pitch: number, out: Vec3): void => {
    const cp = Math.cos(pitch);
    set(out, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  };

  const MUZZLE_OFFSET = 0.4;

  let lastRenderMs = performance.now();
  const MAX_RENDER_DT = 0.1;

  eyePosition(state, prevEye);
  prevFov = state.fov;

  // Input decimation: the sim runs at simHz (60); send Input at inputHz (30).
  const INPUT_EVERY = Math.max(1, Math.round(TUNING.world.simHz / TUNING.world.inputHz));
  let inputTickCounter = 0;

  const fireWeapon = (slot: WeaponSlot, yaw: number, pitch: number): void => {
    eyePosition(state, _eye);
    viewForward(yaw, pitch, _fwd);
    set(
      _muzzle,
      _eye.x + _fwd.x * MUZZLE_OFFSET,
      _eye.y + _fwd.y * MUZZLE_OFFSET,
      _eye.z + _fwd.z * MUZZLE_OFFSET,
    );

    // ONLINE: every shot reports to the server (server owns hit/damage). We send
    // origin=eye, dir=view (the AR's seeded bloom direction is resolved
    // server-side from the same seq cadence; for M3 we send the view dir and the
    // server applies its own spread/lag-comp). Cosmetic feedback is immediate.
    if (online && net) {
      _originT[0] = _eye.x; _originT[1] = _eye.y; _originT[2] = _eye.z;
      _dirT[0] = _fwd.x; _dirT[1] = _fwd.y; _dirT[2] = _fwd.z;
      net.sendShoot(slot, _originT, _dirT);
    }

    if (slot === 1) {
      const spread = clamp(bloom, TUNING.ar.bloomMin, TUNING.ar.bloomMax);
      applyBloom(_dir, _fwd, spread, shotSeq++);
      if (online) {
        // Cosmetic tracer only; damage is server-side. Trace against the world
        // (and the remote capsule, for a satisfying local tracer endpoint).
        const targets = opponentPresent
          ? [{ id: remote.id, center: remoteCenter(), radius: m.radius, halfHeight: standHalf() }]
          : [];
        const res = hitscan(_eye, _dir, TUNING.ar.range, world, targets);
        particles.tracer(_muzzle, res.point);
        if (res.kind === 'world') particles.impact(res.point, res.normal);
      } else {
        const res = hitscan(_eye, _dir, TUNING.ar.range, world, [dummy.capsuleTarget()]);
        particles.tracer(_muzzle, res.point);
        if (res.kind === 'entity' && res.entityId === dummy.id) {
          dummy.applyDamage(TUNING.ar.damage);
          hud.hitmarker();
        } else if (res.kind === 'world') {
          particles.impact(res.point, res.normal);
        }
      }
      bloom = Math.min(TUNING.ar.bloomMax, bloom + TUNING.ar.bloomPerShot);
      viewmodel.onFire(1);
    } else if (slot === 2) {
      // Predicted cosmetic rocket (+ instant self-knockback via the impulse hook).
      projectiles.spawn('rocket', _muzzle, _fwd, LOCAL_ID);
      if (online) selfDetonationGuard = SELF_GUARD_TICKS;
      viewmodel.onFire(2);
    } else if (slot === 3) {
      // Knife: melee is local-feedback only online (M3 server has no melee path);
      // offline it resolves against the dummy.
      if (!online) {
        const k = TUNING.knife;
        const c = dummy.capsuleTarget().center;
        set(_toDummy, c.x - _eye.x, c.y - _eye.y, c.z - _eye.z);
        const along = _toDummy.x * _fwd.x + _toDummy.y * _fwd.y + _toDummy.z * _fwd.z;
        if (along > 0 && along <= k.range) {
          const px = _toDummy.x - _fwd.x * along;
          const py = _toDummy.y - _fwd.y * along;
          const pz = _toDummy.z - _fwd.z * along;
          const lateral = Math.hypot(px, py, pz);
          if (lateral <= k.hitboxHalfWidth + dummy.radius) {
            set(_dummyFwd, -Math.sin(dummy.facingYaw), 0, -Math.cos(dummy.facingYaw));
            const backDot = _dummyFwd.x * _fwd.x + _dummyFwd.z * _fwd.z;
            const backstab = backDot > k.backstabDotThreshold;
            dummy.applyDamage(backstab ? k.backstabDamage : k.damage);
            hud.hitmarker();
          }
        }
      }
      viewmodel.onFire(3);
    } else if (slot === 4) {
      projectiles.spawn('grenade', _muzzle, _fwd, LOCAL_ID);
      if (online) selfDetonationGuard = SELF_GUARD_TICKS;
      viewmodel.onFire(4);
    }
  };

  // Remote capsule center for the cosmetic AR tracer endpoint (last sampled pose).
  const _remoteCenter: Vec3 = v3();
  const remoteCenter = (): Vec3 => _remoteCenter;

  // ~350ms of guard, in sim ticks, covers a 100ms-each-way RTT + jitter.
  const SELF_GUARD_TICKS = Math.round(0.35 * TUNING.world.simHz);

  const step = (): void => {
    eyePosition(state, prevEye);
    prevFov = state.fov;

    const locked = plc.locked;
    state.knifeOut = weapons.knifeOut;

    const frame = input.buildFrame(plc.yaw, plc.pitch);
    state.yaw = frame.yaw;
    state.pitch = frame.pitch;
    stepMovement(state, frame, world, SIM_DT, events);
    if (events.jumped) input.consumeJump();

    if (state.pos.y < CRATE_MAP.killY) respawn();

    // ---- weapon select ----
    if (locked) {
      const sel = input.selectedWeapon as WeaponSlot;
      if (sel !== weapons.current) {
        weapons.select(sel);
        viewmodel.setWeapon(sel);
      }
      if ((input.buttons & Button.Reload) !== 0) weapons.startReload();
    }

    // ---- firing ----
    const triggerHeld = locked && (input.buttons & Button.Fire) !== 0;
    if (weapons.tryFire(triggerHeld)) {
      fireWeapon(weapons.current, state.yaw, state.pitch);
    }

    weapons.update(SIM_DT);
    projectiles.update(SIM_DT);
    if (selfDetonationGuard > 0) selfDetonationGuard--;

    bloom = Math.max(TUNING.ar.bloomMin, bloom - TUNING.ar.bloomRecover * SIM_DT);

    // ---- send Input at inputHz (decimated from simHz) ----
    if (net) {
      inputTickCounter++;
      if (inputTickCounter >= INPUT_EVERY) {
        inputTickCounter = 0;
        _posT[0] = state.pos.x; _posT[1] = state.pos.y; _posT[2] = state.pos.z;
        _velT[0] = state.vel.x; _velT[1] = state.vel.y; _velT[2] = state.vel.z;
        let evFlags = 0;
        if (events.jumped) evFlags |= EventFlag.Jumped;
        if (events.slideStarted) evFlags |= EventFlag.SlideStart;
        if (events.landed) evFlags |= EventFlag.Landed;
        net.sendInput({
          pos: _posT,
          vel: _velT,
          yaw: state.yaw,
          pitch: state.pitch,
          buttons: input.buttons,
          events: evFlags,
        });
      }
    }

    // ---- HUD ----
    const a = weapons.ammo();
    hud.update({
      hp: net ? net.hp : localHp,
      weaponName: weaponName(weapons.current),
      clip: a.clip,
      reserve: a.reserve,
    });
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

    // ---- sample + drive the remote opponent (online) ----
    // Presence is derived from the SNAPSHOT (continuous, authoritative) rather
    // than the one-shot `opponent` event — that event can arrive before the
    // handler is wired (during async Rapier init for the second joiner) or be
    // lost to the 2% packet drop. sample() freezes at the latest snapshot, so a
    // single missed packet never flickers presence.
    if (net) {
      const renderTime = net.serverTime(nowMs) - TUNING.world.interpDelayMs;
      const sampled = net.snapshots.sample(renderTime);
      const opp = sampled.players.find((pl) => pl.id !== net.playerId);
      if (opp) {
        if (!opponentPresent) {
          opponentPresent = true;
          remote.show(opp.id);
          dummy.object.visible = false;
        }
        set(_remoteCenter, opp.pos[0], opp.pos[1], opp.pos[2]);
        remote.setPose(opp.pos[0], opp.pos[1], opp.pos[2], opp.yaw);
        remote.setHp(opp.hp);
      } else if (opponentPresent) {
        opponentPresent = false;
        remote.hide();
        dummy.object.visible = true;
      }
    }

    particles.update(dt);
    dummy.update(dt, camera);
    viewmodel.update(dt, horizontalSpeed(state), state.grounded);

    renderer.render(scene, camera);
  };

  // ---- F3 debug panel (now with a network graph-lite readout) ----
  createDebugPanel(() => ({
    speed: horizontalSpeed(state),
    state: state.moveState,
    grounded: state.grounded,
    fov: state.fov,
    pos: state.pos,
    net: net
      ? {
          mode: opponentPresent ? 'online (1v1)' : 'online (solo-wait)',
          rttMs: Math.round(net.clock.rttMs),
          snapAgeMs: Math.round(net.snapshotAgeMs(performance.now())),
          delayMs: NET.delayMs,
          dropRate: NET.dropRate,
        }
      : { mode: 'offline (sandbox)', rttMs: 0, snapAgeMs: 0, delayMs: 0, dropRate: 0 },
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
