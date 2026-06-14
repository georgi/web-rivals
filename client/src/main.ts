// M4 boot. Wires the shared sim (movement + Rapier trace + shared projectile
// ballistics) to the Three render shell, pointer-lock mouselook, and the
// fixed-timestep loop, fronted by the LOBBY and driven by the server round
// machine (RoundState/Kill/Damage) in ONLINE play.
//
// Lifecycle (PRD §6, §8, §20.2):
//   boot -> build scene/world/loop ONCE, start the render loop, show the Lobby
//   over the arena (arena renders behind it; movement is gated on pointer-lock).
//   The player commits a LobbyChoice (quick match / private code). We try to
//   connect; on success we enter ONLINE play and drive the round HUD from the
//   server; on a match end we return to the Lobby and connect again. If the
//   server is unreachable we fall back to the OFFLINE practice sandbox.
//
// Two modes (PRD §3.1, §6, §19):
//   OFFLINE — no server reachable: the single-player combat sandbox runs
//     unchanged (dummy + fully local combat, simple HUD, no rounds). Fallback.
//   ONLINE  — connected to an authoritative server:
//     * local movement stays LOCAL (zero added latency); Input is sent at 30Hz.
//     * the opponent is an interpolated capsule sampled from the SnapshotBuffer.
//     * combat is server-authoritative: hp/kills/rounds come from the server.
//     * during countdown/roundEnd/matchEnd the player is FROZEN (input locked +
//       local velocity zeroed) so the freeze is honoured client-side.

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
import type { Vec3, Vec3Tuple, WeaponSlot, MatchPhase } from '@rivals/shared';

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
import { RemotePlayers } from './entities/remote-players';
import { Hud } from './ui/hud';
import { Lobby } from './ui/lobby';
import type { LobbyChoice } from './ui/lobby';
import { SettingsPanel, loadSettings } from './ui/settings';

import { AudioManager } from './audio';

import { WebSocketTransport, DelayedTransport } from './net/transport';
import { NetClient } from './net/connection';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
const overlay = document.getElementById('overlay') as HTMLElement | null;
const hudRoot = document.getElementById('hud') as HTMLElement | null;
if (!canvas) throw new Error('#game canvas missing');
if (!overlay) throw new Error('#overlay element missing');
if (!hudRoot) throw new Error('#hud element missing');

// The lobby owns its own full-screen interactive root (the #hud / #overlay
// layers are pointer-events:none). Create it once and reuse across matches.
const lobbyRoot = document.createElement('div');
document.body.appendChild(lobbyRoot);

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
 * Attempt to reach the server within NET.connectTimeoutMs, joining a quick match
 * or the given private room code. Returns a connected NetClient or null
 * (offline). The transport is always wrapped in the DelayedTransport latency
 * gate so dev/test mirrors production conditions.
 */
async function tryConnect(name: string, roomCode?: string): Promise<NetClient | null> {
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
    await net.connect(name, roomCode, NET.connectTimeoutMs);
    return net;
  } catch {
    net.close();
    return null;
  }
}

async function boot(): Promise<void> {
  showPrompt('Loading…');
  const world = await RapierTraceWorld.create(CRATE_MAP.solids);

  // ---- audio + settings (PRD §8, §9) -----------------------------------------
  // Audio is non-critical; the AudioManager is internally guarded so it is a safe
  // no-op if Web Audio is missing. Settings persist to localStorage. Apply the
  // loaded settings to the live systems BEFORE the move state reads fovBase.
  const audio = new AudioManager();
  const settings = loadSettings();
  audio.setMasterVolume(settings.masterVolume);

  // ---- render shell + static map (built ONCE) ----
  const { scene, camera, renderer, render: renderFrame, registerShadows, setQuality } = createScene(
    canvas!,
    settings.quality,
  );
  const mapMesh = buildMapMesh(CRATE_MAP);
  scene.add(mapMesh);
  registerShadows(mapMesh);

  const m = TUNING.movement;
  // The FOV speed cue lerps up from fovBase, so the base follows the setting.
  m.fovBase = settings.fov;

  // ---- target dummy (solo-wait / offline; hidden once a real opponent joins) ----
  const dummy = new Dummy(1, { x: 0, y: 3.9, z: 0 });
  scene.add(dummy.object);
  registerShadows(dummy.object);

  // ---- networked opponents (online only; up to maxPlayers-1, shown on join) ----
  const remotes = new RemotePlayers();
  scene.add(remotes.object);

  // ---- combat FX pools ----
  const particles = new Particles();
  scene.add(particles.object);

  // ---- viewmodel ----
  const weapons = new Weapons();
  const viewmodel = new Viewmodel();
  camera.add(viewmodel.object);
  // Dedicated view-space light rig so the weapon reads crisply regardless of
  // where the player faces (the world sun would leave it in near-black). A warm
  // key from upper-right + a dim cool fill, both children of the camera. Both
  // live on layer 1 ONLY so they illuminate the viewmodel (also on layer 1) and
  // never spill onto the world geometry (layer 0).
  const VIEWMODEL_LAYER = 1;
  const vmKey = new THREE.PointLight(0xfff0dc, 6, 4, 2);
  vmKey.position.set(0.5, 0.2, 0.2);
  vmKey.layers.set(VIEWMODEL_LAYER);
  camera.add(vmKey);
  const vmFill = new THREE.PointLight(0x6f86b0, 2.5, 4, 2);
  vmFill.position.set(-0.4, -0.1, 0.3);
  vmFill.layers.set(VIEWMODEL_LAYER);
  camera.add(vmFill);
  // Put the weapon meshes on layer 1 too (keeping layer 0 so the camera still
  // renders them) — that's what couples them to the view-space lights above.
  viewmodel.object.traverse((o) => o.layers.enable(VIEWMODEL_LAYER));
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
  plc.sensitivity = settings.sensitivity;

  // ================= SESSION STATE (reset per match) =================
  // Everything that depends on "which connection are we in" lives here so the
  // scene/loop above can be built once and re-pointed each time the player
  // enters online play (or the offline sandbox).
  let net: NetClient | null = null;
  let online = false;
  let localId = 0;
  // Frozen during the match-end scoreboard: input locked + velocity zeroed.
  let frozen = false;
  // True while the local player is dead awaiting a server respawn. Input is
  // gated off until the `respawn` message lands (movement is client-auth, so we
  // must not send a stale pose between death and the authoritative respawn).
  let localDead = false;
  // Per-id display names for the kill feed / scoreboard.
  const names = new Map<number, string>();
  let myName = 'Player';
  // The last RoundState phase (to detect transitions for banners).
  let lastPhase: MatchPhase | null = null;
  // De-dupe the per-second countdown banner.
  let lastCountdownSec = -1;
  // When set, the loop should tear down the session and return to the lobby.
  let returnToLobby = false;

  const opponentName = (): string => {
    for (const [id, n] of names) if (id !== localId) return n;
    return 'Opponent';
  };

  // Score is [player0Wins, player1Wins]; "I" am localId. I'm ahead/winning when
  // my own component is the larger of the two (used for round/match banners).
  const didIWin = (score: [number, number]): boolean => score[localId] > score[1 - localId];

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

  canvas!.addEventListener('click', () => {
    // First user gesture: satisfy the autoplay policy (the suspended context
    // resumes here; idempotent and guarded internally).
    audio.resume();
    // Only grab the pointer once we're actually in a match (lobby hidden).
    if (online || offlineActive) plc.requestLock();
  });
  plc.onLockChange((locked) => {
    // While frozen, the sim ignores input regardless; reflect lock for FX.
    input.setEnabled(locked && !frozen);
    if (locked) {
      hidePrompt();
    } else if (online || offlineActive) {
      showPrompt('Click to resume');
    }
  });

  // ---- projectile sim ----
  // OFFLINE: rockets/grenades simulate + resolve damage/knockback locally.
  // ONLINE: the SAME class renders a COSMETIC predicted copy; damage hooks route
  // to a no-op (server owns damage) but SELF-knockback stays for rocket-jump.
  const hooks: ProjectileHooks = {
    get localPlayerId() {
      return localId;
    },
    targets: () =>
      online
        ? [
            // Online: only the local player is a valid self-knockback target;
            // opponent damage/knockback is server-authoritative.
            { id: localId, center: state.pos, radius: m.radius, halfHeight: state.capsuleHalf },
          ]
        : [
            dummy.capsuleTarget(),
            { id: localId, center: state.pos, radius: m.radius, halfHeight: state.capsuleHalf },
          ],
    onDamage: (id, amt) => {
      if (online) return; // server-authoritative damage online
      if (id === dummy.id) {
        dummy.applyDamage(amt);
      } else if (id === localId) {
        localHp -= amt;
        if (localHp <= 0) respawn();
      }
    },
    onImpulse: (id, imp) => {
      // Self-knockback (rocket-jump) is predicted + instant in BOTH modes.
      if (id === localId) applyImpulse(state, imp.x, imp.y, imp.z);
    },
    // Spatial explosion cue for every predicted detonation (own rocket/grenade
    // in both modes + cosmetic opponent projectiles online). The server's
    // authoritative Detonate event drives knockback, not audio, so this is the
    // single, immediate source of explosion SFX.
    onDetonate: (pos) => audio.explosionAt(pos),
  };
  const projectiles = new LocalProjectiles(world, particles, hooks);
  scene.add(projectiles.object);

  // ---- HUD + Lobby ----
  const hud = new Hud(hudRoot!);
  const lobby = new Lobby(lobbyRoot);

  // ---- Settings overlay (PRD §8) --------------------------------------------
  // A hidden full-screen panel reachable from a corner gear button. onChange
  // fires LIVE as the sliders move, so sensitivity / FOV / volume preview
  // instantly; the panel persists itself to localStorage. The panel root sits
  // above the lobby; a DONE button and Esc dismiss it.
  const settingsRoot = document.createElement('div');
  document.body.appendChild(settingsRoot);
  // The settings panel fires onChange continuously while a slider drags; only
  // the (discrete, click-driven) quality change needs the expensive post-stack
  // rebuild, so gate it on an actual change to keep slider drags cheap.
  let lastQuality = settings.quality;
  const settingsPanel = new SettingsPanel(settingsRoot, settings, (s) => {
    plc.sensitivity = s.sensitivity;
    m.fovBase = s.fov; // the FOV speed cue lerps up from fovBase
    audio.setMasterVolume(s.masterVolume);
    if (s.quality !== lastQuality) {
      lastQuality = s.quality;
      setQuality(s.quality); // rebuilds the post stack + shadow/DPR levers
    }
  });

  // A DONE button inside the settings panel and Esc both close it.
  const settingsDone = document.createElement('button');
  settingsDone.type = 'button';
  settingsDone.className = 'wr-btn wr-btn-primary wr-settings-done';
  settingsDone.textContent = 'DONE';
  const settingsPanelEl = settingsRoot.querySelector('.wr-settings');
  if (settingsPanelEl) settingsPanelEl.appendChild(settingsDone);

  let settingsOpen = false;
  const openSettings = (): void => {
    settingsOpen = true;
    settingsPanel.show();
  };
  const closeSettings = (): void => {
    settingsOpen = false;
    settingsPanel.hide();
  };
  settingsDone.addEventListener('click', closeSettings);

  // Corner gear button — visible while the lobby is up (hidden in a match, where
  // pointer-lock owns the cursor). Clicking opens the settings overlay.
  const gearBtn = document.createElement('button');
  gearBtn.type = 'button';
  gearBtn.className = 'wr-gear';
  gearBtn.title = 'Settings';
  gearBtn.setAttribute('aria-label', 'Settings');
  gearBtn.textContent = '⚙';
  document.body.appendChild(gearBtn);
  gearBtn.addEventListener('click', openSettings);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsOpen) closeSettings();
  });

  // Show the gear only when the lobby is interactive (not during a match).
  const showGear = (visible: boolean): void => {
    gearBtn.style.display = visible ? 'flex' : 'none';
  };

  // Whether the offline practice sandbox is the active mode (drives pointer-lock
  // gating + prompts independently of the network session).
  let offlineActive = false;

  // Brief window after a local predicted rocket detonation where we ignore the
  // server's self-impulse echo (prevents a double rocket-jump).
  let selfDetonationGuard = 0;

  // ================= NETWORK WIRING =================
  // (Re)bind a fresh NetClient's event hooks to this session. Cleared on teardown
  // by pointing `net` away; we also reset hooks to noop on the old client there.
  function wireNet(nc: NetClient): void {
    nc.onOpponent = (o) => {
      if (o.id >= 0) names.set(o.id, o.name);
      if (o.present) {
        remotes.setPresent(o.id, o.name);
        dummy.object.visible = false; // no practice dummy online
      } else {
        remotes.setAbsent(o.id);
        names.delete(o.id);
      }
    };

    nc.onMatchState = (ms) => {
      // Live frag table + leader progress; the HUD ranks the entries itself.
      hud.setFrags(ms.scores, localId, names, ms.fragLimit);
      // Show the match clock only while live; hidden otherwise.
      hud.setRoundTimer(ms.phase === 'live' ? ms.timer : 0);

      // Freeze only on the match-end scoreboard.
      frozen = ms.phase === 'matchEnd';
      if (frozen) {
        state.vel.x = 0;
        state.vel.y = 0;
        state.vel.z = 0;
        input.setEnabled(false);
      } else if (plc.locked && !localDead) {
        input.setEnabled(true);
      }

      const phaseChanged = ms.phase !== lastPhase;
      if (phaseChanged) {
        if (ms.phase === 'live') {
          hud.hideScoreboard();
          hud.showBanner('FIGHT', '');
        } else if (ms.phase === 'matchEnd') {
          hud.showScoreboardFFA(ms.scores, names, localId, myName, ms.winner);
          hud.hideBanner();
          audio.roundEnd(ms.winner === localId);
        }
      }
      lastPhase = ms.phase;
    };

    nc.onRespawn = (r) => {
      if (r.id !== localId) return; // opponents respawn via snapshots
      set(state.pos, r.pos[0], r.pos[1], r.pos[2]);
      state.vel.x = 0;
      state.vel.y = 0;
      state.vel.z = 0;
      state.grounded = false;
      state.moveState = 'air';
      state.capsuleHalf = standHalf();
      state.yaw = r.yaw;
      plc.yaw = r.yaw;
      localHp = TUNING.combat.spawnHealth;
      if (net) net.setHp(localHp);
      localDead = false;
      hidePrompt();
      if (plc.locked && !frozen) input.setEnabled(true);
    };

    nc.onKill = (k) => {
      const killer = names.get(k.killer) ?? (k.killer === localId ? myName : 'Player');
      const victim = names.get(k.victim) ?? (k.victim === localId ? myName : 'Player');
      hud.addKill(killer, victim, k.weapon, k.fall);
      if (k.killer === localId && k.victim !== localId) audio.kill();
      // My own death: enter the dead state and freeze input until the server's
      // respawn message arrives (server owns respawn position + timing in FFA).
      if (k.victim === localId) {
        localDead = true;
        state.vel.x = 0;
        state.vel.y = 0;
        state.vel.z = 0;
        input.setEnabled(false);
        showPrompt('Respawning…');
      }
    };

    nc.onDamage = (d) => {
      if (d.victim === localId) {
        localHp = d.newHp;
        // Directional red flash toward the source (view-relative).
        if (d.dirToSource) {
          const worldDir: Vec3 = { x: d.dirToSource[0], y: d.dirToSource[1], z: d.dirToSource[2] };
          viewRelative(worldDir, state.yaw, _viewDir);
          hud.damageFrom(_viewDir);
        } else {
          hud.damageFrom(FRONT_DIR);
        }
        // Death + respawn are server-driven in FFA (kill + respawn messages); do
        // not client-predict a respawn here.
      } else {
        // We damaged someone -> hitmarker feedback.
        hud.hitmarker();
        audio.hitmarker();
      }
    };

    // Server-authoritative explosions: apply opponent-inflicted knockback to ME,
    // EXCEPT my own rocket's self-impulse (already applied on local detonation).
    nc.onDetonate = (det) => {
      if (!det.impulses) return;
      for (const imp of det.impulses) {
        if (imp.id !== localId) continue;
        if (selfDetonationGuard > 0) continue; // echo of our own predicted launch
        applyImpulse(state, imp.impulse[0], imp.impulse[1], imp.impulse[2]);
      }
    };

    // Cosmetic reconciliation: render the server's projectiles for the opponent's
    // shots (ours are already predicted).
    nc.onSpawnProj = (sp) => {
      if (sp.owner === localId) return;
      const dir: Vec3 = { x: sp.vel[0], y: sp.vel[1], z: sp.vel[2] };
      const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
      dir.x /= len;
      dir.y /= len;
      dir.z /= len;
      const origin: Vec3 = { x: sp.pos[0], y: sp.pos[1], z: sp.pos[2] };
      projectiles.spawn(sp.kind, origin, dir, sp.owner);
    };

    nc.onCorrection = (c) => {
      set(state.pos, c.pos[0], c.pos[1], c.pos[2]);
      set(state.vel, c.vel[0], c.vel[1], c.vel[2]);
    };

    nc.onClose = () => {
      // Lost the server mid-session: surface it and return to the lobby.
      remotes.hideAll();
      dummy.object.visible = true;
      frozen = false;
      localDead = false;
      returnToLobby = true;
    };
  }

  // Tear down the active session: silence + close the old NetClient and reset
  // per-match HUD/world state so the next match (or the lobby) starts clean.
  function teardownSession(): void {
    if (net) {
      net.onOpponent = NOOP;
      net.onMatchState = NOOP;
      net.onRespawn = NOOP;
      net.onKill = NOOP;
      net.onDamage = NOOP;
      net.onDetonate = NOOP;
      net.onSpawnProj = NOOP;
      net.onCorrection = NOOP;
      net.onClose = NOOP;
      net.close();
    }
    net = null;
    online = false;
    offlineActive = false;
    frozen = false;
    returnToLobby = false;
    lastPhase = null;
    lastCountdownSec = -1;
    names.clear();
    remotes.hideAll();
    dummy.object.visible = true;
    localDead = false;
    hud.hideBanner();
    projectiles.clear();
    respawn();
  }

  // Enter ONLINE play with a freshly-connected client.
  function enterOnline(nc: NetClient, choice: LobbyChoice): void {
    net = nc;
    online = true;
    offlineActive = false;
    localId = nc.playerId;
    myName = choice.name;
    names.set(localId, myName);
    nc.setHp(TUNING.combat.spawnHealth);
    localHp = TUNING.combat.spawnHealth;
    wireNet(nc);
    plc.yaw = state.yaw;
  }

  // Enter the OFFLINE practice sandbox (dummy + fully local combat, no rounds).
  function enterOffline(): void {
    net = null;
    online = false;
    offlineActive = true;
    localId = 0;
    frozen = false;
    dummy.object.visible = true;
    remotes.hideAll();
  }

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
  const _viewDir: Vec3 = v3(); // view-relative damage direction
  const FRONT_DIR: Vec3 = { x: 0, y: 0, z: -1 }; // camera-space "in front" fallback
  // Reusable tuples for outgoing Input/Shoot (avoid per-tick alloc).
  const _posT: Vec3Tuple = [0, 0, 0];
  const _velT: Vec3Tuple = [0, 0, 0];
  const _originT: Vec3Tuple = [0, 0, 0];
  const _dirT: Vec3Tuple = [0, 0, 0];

  let bloom = TUNING.ar.bloomMin;
  let shotSeq = 0;
  // Reload SFX edge: fire audio.reload() only on the false->true transition so a
  // held reload key (or repeated startReload calls) doesn't retrigger the click.
  let prevReloading = false;
  const viewForward = (yaw: number, pitch: number, out: Vec3): void => {
    const cp = Math.cos(pitch);
    set(out, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  };

  // Rotate a WORLD-space direction into the player's view frame (camera looks
  // down -z, +x right) so the HUD's quadrant logic is yaw-relative. Pitch is
  // ignored — the directional indicator is horizontal only.
  const viewRelative = (worldDir: Vec3, yaw: number, out: Vec3): void => {
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    // Inverse of viewForward's yaw basis: right = (cy,0,-sy), fwd = (-sy,0,-cy).
    const right = worldDir.x * cy - worldDir.z * sy;
    const fwd = -worldDir.x * sy - worldDir.z * cy; // +fwd = in front
    set(out, right, worldDir.y, -fwd); // out.z follows camera convention (-z front)
  };

  const MUZZLE_OFFSET = 0.4;
  // ~350ms of guard, in sim ticks, covers a 100ms-each-way RTT + jitter.
  const SELF_GUARD_TICKS = Math.round(0.35 * TUNING.world.simHz);
  // After the match-end scoreboard appears, wait before returning to the lobby
  // (let the 5s overlay read). Slightly shorter so the lobby is back promptly.
  const MATCH_END_RETURN_MS = 4500;
  const NOOP = (): void => {};

  let lastRenderMs = performance.now();
  const MAX_RENDER_DT = 0.1;

  eyePosition(state, prevEye);
  prevFov = state.fov;

  // Input decimation: the sim runs at simHz (60); send Input at inputHz (30).
  const INPUT_EVERY = Math.max(1, Math.round(TUNING.world.simHz / TUNING.world.inputHz));
  let inputTickCounter = 0;

  // Audio listener scratch (camera forward/up for positional panning).
  const _listenFwd: Vec3 = v3();
  const _listenUp: Vec3 = { x: 0, y: 1, z: 0 };

  const fireWeapon = (slot: WeaponSlot, yaw: number, pitch: number): void => {
    // Own weapon report is 2D (centered) — real, immediate feedback (PRD §9).
    audio.shoot(slot);

    eyePosition(state, _eye);
    viewForward(yaw, pitch, _fwd);
    set(
      _muzzle,
      _eye.x + _fwd.x * MUZZLE_OFFSET,
      _eye.y + _fwd.y * MUZZLE_OFFSET,
      _eye.z + _fwd.z * MUZZLE_OFFSET,
    );

    if (online && net) {
      _originT[0] = _eye.x; _originT[1] = _eye.y; _originT[2] = _eye.z;
      _dirT[0] = _fwd.x; _dirT[1] = _fwd.y; _dirT[2] = _fwd.z;
      net.sendShoot(slot, _originT, _dirT);
    }

    if (slot === 1) {
      const spread = clamp(bloom, TUNING.ar.bloomMin, TUNING.ar.bloomMax);
      applyBloom(_dir, _fwd, spread, shotSeq++);
      if (online) {
        const targets = remotes.liveTargets();
        const res = hitscan(_eye, _dir, TUNING.ar.range, world, targets);
        particles.tracer(_muzzle, res.point);
        if (res.kind === 'world') particles.impact(res.point, res.normal);
      } else {
        const res = hitscan(_eye, _dir, TUNING.ar.range, world, [dummy.capsuleTarget()]);
        particles.tracer(_muzzle, res.point);
        if (res.kind === 'entity' && res.entityId === dummy.id) {
          dummy.applyDamage(TUNING.ar.damage);
          hud.hitmarker();
          audio.hitmarker();
        } else if (res.kind === 'world') {
          particles.impact(res.point, res.normal);
        }
      }
      bloom = Math.min(TUNING.ar.bloomMax, bloom + TUNING.ar.bloomPerShot);
      viewmodel.onFire(1);
    } else if (slot === 2) {
      projectiles.spawn('rocket', _muzzle, _fwd, localId);
      if (online) selfDetonationGuard = SELF_GUARD_TICKS;
      viewmodel.onFire(2);
    } else if (slot === 3) {
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
            audio.hitmarker();
          }
        }
      }
      viewmodel.onFire(3);
    } else if (slot === 4) {
      projectiles.spawn('grenade', _muzzle, _fwd, localId);
      if (online) selfDetonationGuard = SELF_GUARD_TICKS;
      viewmodel.onFire(4);
    }
  };

  // Dev-only frozen camera pose for screenshot framing (stripped from prod).
  let devPose: { pos: Vec3; yaw: number; pitch: number } | null = null;
  if (import.meta.env.DEV) {
    (window as unknown as { __dev?: unknown }).__dev = {
      setView(px: number, py: number, pz: number, yaw: number, pitch: number): void {
        devPose = { pos: { x: px, y: py, z: pz }, yaw, pitch };
      },
      clearView(): void {
        devPose = null;
      },
      // Renderer draw-call / resource counters for performance QA.
      stats(): Record<string, number> {
        return {
          calls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
          geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures,
          programs: renderer.info.programs?.length ?? 0,
        };
      },
    };
  }

  const step = (): void => {
    eyePosition(state, prevEye);
    prevFov = state.fov;

    // Dev pose pin: override the sim so an elevated/static framing holds against
    // gravity for visual QA. No-op in production (devPose stays null).
    if (devPose) {
      copy(state.pos, devPose.pos);
      state.vel.x = 0;
      state.vel.y = 0;
      state.vel.z = 0;
      plc.yaw = devPose.yaw;
      plc.pitch = devPose.pitch;
      state.yaw = devPose.yaw;
      state.pitch = devPose.pitch;
      weapons.update(SIM_DT);
      return;
    }

    const locked = plc.locked;
    // During a freeze, ignore movement/firing entirely and keep velocity zeroed.
    const active = locked && !frozen && !localDead;
    state.knifeOut = weapons.knifeOut;

    if (frozen) {
      state.vel.x = 0;
      state.vel.y = 0;
      state.vel.z = 0;
    }

    const frame = input.buildFrame(plc.yaw, plc.pitch);
    state.yaw = frame.yaw;
    state.pitch = frame.pitch;
    stepMovement(state, frame, world, SIM_DT, events);
    if (events.jumped) input.consumeJump();

    // ---- local movement SFX (2D, own player) ----
    if (events.jumped) audio.jump();
    if (events.landed) audio.land();
    if (events.slideStarted) audio.slideStart();

    // Offline: client owns fall-respawn. Online: keep falling + reporting so the
    // server detects killY and drives the authoritative kill + respawn.
    if (!online && state.pos.y < CRATE_MAP.killY) respawn();

    // ---- weapon select ----
    if (active) {
      const sel = input.selectedWeapon as WeaponSlot;
      if (sel !== weapons.current) {
        weapons.select(sel);
        viewmodel.setWeapon(sel);
      }
      if ((input.buttons & Button.Reload) !== 0) weapons.startReload();
    }

    // ---- firing ----
    const triggerHeld = active && (input.buttons & Button.Fire) !== 0;
    if (weapons.tryFire(triggerHeld)) {
      fireWeapon(weapons.current, state.yaw, state.pitch);
    }

    weapons.update(SIM_DT);
    // Reload SFX on the start edge (2D, own action).
    const reloadingNow = weapons.reloading;
    if (reloadingNow && !prevReloading) audio.reload();
    prevReloading = reloadingNow;

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

    // ---- HUD (combat sub-set; round HUD is driven from RoundState) ----
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

    // ---- audio listener: track the camera so positional events pan correctly ----
    viewForward(plc.yaw, plc.pitch, _listenFwd);
    audio.updateListener(interpEye, _listenFwd, _listenUp);

    // ---- sample + drive ALL remote opponents (online) ----
    if (net) {
      const renderTime = net.serverTime(nowMs) - TUNING.world.interpDelayMs;
      const sampled = net.snapshots.sample(renderTime);
      for (const opp of sampled.players) {
        if (opp.id === localId) continue;
        remotes.setPresent(opp.id, names.get(opp.id) ?? 'Player');
        remotes.setPose(opp.id, opp.pos[0], opp.pos[1], opp.pos[2], opp.yaw);
        remotes.setHp(opp.id, opp.hp);
      }
      remotes.update(dt);
    }

    particles.update(dt);
    dummy.update(dt, camera);
    viewmodel.update(dt, horizontalSpeed(state), state.grounded);

    renderFrame();
  };

  // ---- F3 debug panel (with a network graph-lite readout) ----
  createDebugPanel(() => ({
    speed: horizontalSpeed(state),
    state: state.moveState,
    grounded: state.grounded,
    fov: state.fov,
    pos: state.pos,
    net: net
      ? {
          mode: `online (FFA ${remotes.activeIds().length + 1}p)`,
          rttMs: Math.round(net.clock.rttMs),
          snapAgeMs: Math.round(net.snapshotAgeMs(performance.now())),
          delayMs: NET.delayMs,
          dropRate: NET.dropRate,
        }
      : {
          mode: offlineActive ? 'offline (sandbox)' : 'lobby',
          rttMs: 0,
          snapAgeMs: 0,
          delayMs: 0,
          dropRate: 0,
        },
  }));

  // Start the loop NOW so the arena renders behind the lobby. Movement is gated
  // on pointer-lock (only obtainable once a match is active), so the player
  // can't move until in a match.
  const loop = createLoop({
    dt: SIM_DT,
    maxCatchupMs: TUNING.world.maxCatchupMs,
    step,
    render,
  });
  loop.start();

  // ================= LOBBY -> MATCH -> LOBBY =================
  // Each pass: show the lobby, await a choice, connect, play, and (on match end /
  // disconnect) loop back. Offline practice is an in-place fallback that returns
  // to the lobby when the player re-opens it (Esc -> click lobby isn't wired; the
  // offline sandbox simply runs until reload, matching prior M2/M3 behavior).
  // The match loop:
  for (;;) {
    hidePrompt();
    hud.hideBanner();
    hud.hideScoreboard();
    showGear(true); // settings reachable from the lobby

    const choice = await lobby.show();
    lobby.setStatus('Connecting…');

    const nc = await tryConnect(choice.name, choice.roomCode);
    // Entering a match: hide the gear and dismiss any open settings overlay so
    // it can't intercept the pointer-lock click.
    showGear(false);
    closeSettings();
    if (nc) {
      // ONLINE.
      enterOnline(nc, choice);
      lobby.setStatus('Waiting for opponent…');
      lobby.hide();
      showPrompt('Click to play');

      // Run until the session asks to return to the lobby (matchEnd / disconnect).
      await waitFor(() => returnToLobby);
      teardownSession();
      // Loop back to lobby.show().
    } else {
      // OFFLINE practice — no rounds, simple HUD. This is a terminal sandbox for
      // this page session (no server to return from); keep it running.
      lobby.setStatus('Server unreachable — playing offline practice');
      enterOffline();
      lobby.hide();
      showPrompt('Click to play');
      // Park here: the sandbox runs via the loop; never returns to the lobby.
      await new Promise<never>(() => {});
    }
  }
}

// Poll a predicate without busy-spinning the main thread (checked ~10Hz). Used
// to await an event-driven session end (matchEnd / disconnect) from the loop.
function waitFor(pred: () => boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const tick = (): void => {
      if (pred()) resolve();
      else window.setTimeout(tick, 100);
    };
    tick();
  });
}

void boot();
