// Authoritative 1v1 game room (PRD §3.1, §6). One Room == one match. The room
// owns the authoritative state for damage (HP), ammo, fire cooldowns, and the
// server-side projectiles; movement stays CLIENT-authoritative and the room only
// sanity-checks it (MovementValidator) and snaps offenders back (Correction).
//
// Everything the room sends/receives is JSON via the shared protocol codec, so
// the ws transport here can be swapped for WebRTC later without touching this.
// NO Three.js, NO DOM — the room reuses the shared sim (stepProjectile,
// computeExplosion) and the shared TraceWorld (RapierTraceWorld) for traces.

import type { WebSocket } from 'ws';
import {
  TUNING,
  encode,
  fromTuple,
  toTuple,
  getMap,
  normalize,
  makeProjectile,
  stepProjectile,
  computeExplosion,
  RapierTraceWorld,
  type Vec3,
  type Vec3Tuple,
  type MapData,
  type AnimState,
  type WeaponSlot,
  type ProjKind,
  type Projectile,
  type ProjectileStep,
  type PlayerCapsule,
  type ServerMessage,
  type InputMsg,
  type ShootMsg,
  type PingMsg,
  type PlayerSnap,
  type ProjSnap,
} from '@rivals/shared';
import { MovementValidator } from './validate.js';
import { LagComp } from './lagcomp.js';

const SERVER_DT = 1 / TUNING.world.serverHz; // 1/30s authoritative step
// Snapshot every Nth tick. 30Hz tick / 20Hz snapshots isn't an integer ratio;
// PRD calls this "every other-ish tick". We emit on a 2/1/2/1 cadence (≈20Hz).
const TICKS_PER_SNAPSHOT_PATTERN = [2, 1]; // alternating gap -> avg 1.5 -> 20Hz

const MAX_PLAYERS = 2;

// Per-weapon authoritative config the room needs (ammo/cadence). The full
// weapon-state machine lives client-side; the server only enforces the gates
// that matter for cheating: ammo present + fire cooldown elapsed.
interface WeaponConfig {
  fireInterval: number; // seconds between shots
  usesClip: boolean;
  magSize: number; // clip capacity (clip-fed weapons)
  reserve: number;
}

function weaponConfigs(): Record<WeaponSlot, WeaponConfig> {
  return {
    1: { fireInterval: TUNING.ar.fireInterval, usesClip: true, magSize: TUNING.ar.magSize, reserve: TUNING.ar.reserveAmmo },
    2: { fireInterval: TUNING.rocket.fireInterval, usesClip: true, magSize: TUNING.rocket.magSize, reserve: TUNING.rocket.reserveAmmo },
    3: { fireInterval: TUNING.knife.swingTime, usesClip: false, magSize: 0, reserve: 0 },
    4: { fireInterval: 0, usesClip: false, magSize: TUNING.grenade.count, reserve: 0 },
  };
}

interface PlayerAmmo {
  clip: number;
  reserve: number;
}

export interface RoomPlayer {
  id: number;
  ws: WebSocket;
  name: string;
  pos: Vec3; // capsule center (authoritative-accepted)
  vel: Vec3;
  yaw: number;
  pitch: number;
  buttons: number;
  anim: AnimState;
  hp: number;
  weapon: WeaponSlot;
  ammo: Record<WeaponSlot, PlayerAmmo>;
  // Seconds remaining on each weapon's fire cooldown (server-enforced cadence).
  cooldowns: Record<WeaponSlot, number>;
  alive: boolean;
  lastSeq: number;
}

// Player capsule geometry (shared with movement). center.y is the capsule
// center; halfHeight is the cylinder half-length (matches LagComp / explosion).
const CAP_RADIUS = TUNING.movement.radius;
const CAP_HALF = TUNING.movement.standHeight / 2 - TUNING.movement.radius;

export class Room {
  readonly id: string;
  readonly mapId: string;

  private readonly map: MapData;
  private readonly world: RapierTraceWorld;
  private readonly validator: MovementValidator;
  private readonly lagcomp: LagComp;
  private readonly cfg = weaponConfigs();

  private readonly players = new Map<number, RoomPlayer>();
  private readonly projectiles: Projectile[] = [];
  private nextProjId = 1;

  private tick = 0;
  private snapAccum = 0; // index into the snapshot cadence pattern
  private snapCountdown = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private phase: 'waiting' | 'live' = 'waiting';

  // Scratch reused by the tick so the 30Hz loop allocates nothing per-tick.
  private readonly stepOut: ProjectileStep = { detonated: false, point: { x: 0, y: 0, z: 0 } };
  private readonly capsScratch: PlayerCapsule[] = [];

  // The room clock (ms). The server timestamps everything off this so a single
  // monotonic source drives lag-comp, ping/pong, and snapshots.
  private now(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }

  private constructor(id: string, mapId: string, world: RapierTraceWorld, map: MapData) {
    this.id = id;
    this.mapId = mapId;
    this.world = world;
    this.map = map;
    this.validator = new MovementValidator(world);
    this.lagcomp = new LagComp();
  }

  /** Build a room: load the map and the (async) Rapier trace world for it. */
  static async create(id: string, mapId: string): Promise<Room> {
    const map = getMap(mapId);
    const world = await RapierTraceWorld.create(map.solids);
    return new Room(id, mapId, world, map);
  }

  get playerCount(): number {
    return this.players.size;
  }

  get isFull(): boolean {
    return this.players.size >= MAX_PLAYERS;
  }

  get isEmpty(): boolean {
    return this.players.size === 0;
  }

  hasPlayer(id: number): boolean {
    return this.players.has(id);
  }

  /** Index of the player in join order (0 or 1) — used for score arrays. */
  private slotIndex(id: number): number {
    let i = 0;
    for (const pid of this.players.keys()) {
      if (pid === id) return i;
      i++;
    }
    return -1;
  }

  // ---- membership ----

  /** Add a player up to MAX_PLAYERS. Returns the spawned player or null if full. */
  addPlayer(ws: WebSocket, id: number, name: string): RoomPlayer | null {
    if (this.isFull) return null;
    const spawnIdx = this.players.size % this.map.spawns.length;
    const spawn = this.map.spawns[spawnIdx];
    const pos = fromTuple(spawn.pos);

    const player: RoomPlayer = {
      id,
      ws,
      name,
      pos,
      vel: { x: 0, y: 0, z: 0 },
      yaw: (spawn.yaw * Math.PI) / 180,
      pitch: 0,
      buttons: 0,
      anim: 'idle',
      hp: TUNING.combat.spawnHealth,
      weapon: 1,
      ammo: this.freshAmmo(),
      cooldowns: { 1: 0, 2: 0, 3: 0, 4: 0 },
      alive: true,
      lastSeq: 0,
    };
    this.players.set(id, player);

    this.validator.reset(id, pos);
    this.lagcomp.record(id, this.center(pos), CAP_RADIUS, CAP_HALF, this.now());

    // Round stub (full machine is M4): go live as soon as 2 players are present.
    if (this.players.size >= MAX_PLAYERS) this.phase = 'live';

    // Tell the newcomer about any existing opponent, and existing players about
    // the newcomer.
    for (const other of this.players.values()) {
      if (other.id === id) continue;
      this.sendTo(player, { t: 'opponent', present: true, name: other.name, id: other.id });
      this.sendTo(other, { t: 'opponent', present: true, name: player.name, id: player.id });
    }

    this.broadcastRoundState();
    return player;
  }

  removePlayer(id: number): void {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);
    this.validator.reset(id, { x: 0, y: 0, z: 0 });
    this.lagcomp.remove(id);
    this.world.removeEntity(id);

    // Notify the remaining player the opponent left.
    for (const other of this.players.values()) {
      this.sendTo(other, { t: 'opponent', present: false, name: player.name, id });
    }
    if (this.players.size < MAX_PLAYERS) this.phase = 'waiting';
    this.broadcastRoundState();
  }

  private freshAmmo(): Record<WeaponSlot, PlayerAmmo> {
    return {
      1: { clip: this.cfg[1].magSize, reserve: this.cfg[1].reserve },
      2: { clip: this.cfg[2].magSize, reserve: this.cfg[2].reserve },
      3: { clip: 0, reserve: 0 },
      4: { clip: this.cfg[4].magSize, reserve: 0 },
    };
  }

  // ---- message ingest (called by index.ts on each client message) ----

  ingestInput(id: number, msg: InputMsg): void {
    const player = this.players.get(id);
    if (!player) return;
    if (msg.seq <= player.lastSeq) return; // stale / duplicate
    const dt = SERVER_DT; // displacement budget is per server tick
    const now = this.now();

    const report = {
      pos: fromTuple(msg.pos),
      vel: fromTuple(msg.vel),
      yaw: msg.yaw,
      pitch: msg.pitch,
    };
    const result = this.validator.accept(id, report, dt, now);

    if (result.ok) {
      player.pos = result.correctedPos;
      player.vel = result.correctedVel;
    } else {
      // Reject: keep the last accepted state and snap the client back.
      player.pos = result.correctedPos;
      player.vel = result.correctedVel;
      this.sendTo(player, {
        t: 'correction',
        pos: toTuple(result.correctedPos),
        vel: toTuple(result.correctedVel),
        seq: msg.seq,
      });
    }

    player.yaw = msg.yaw;
    player.pitch = msg.pitch;
    player.buttons = msg.buttons;
    player.lastSeq = msg.seq;
    player.anim = animFromVel(player.vel, msg.buttons);

    // A reported launch/impulse edge widens the displacement allowance briefly.
    // EventFlag has no launch bit today; honor a future additive one if present.
    const LAUNCH_BIT = (1 << 3); // reserved; ignored unless a client sets it
    if ((msg.events & LAUNCH_BIT) !== 0) this.validator.noteImpulse(id, now);
  }

  ingestShoot(id: number, msg: ShootMsg): void {
    const shooter = this.players.get(id);
    if (!shooter || !shooter.alive) return;

    const weapon = msg.weapon;
    const cfg = this.cfg[weapon];
    if (!cfg) return;

    // Cooldown gate (server-authoritative cadence). Drop silently on violation.
    if (shooter.cooldowns[weapon] > 1e-4) return;

    // Ammo gate.
    const ammo = shooter.ammo[weapon];
    if (cfg.usesClip) {
      if (ammo.clip <= 0) return;
    } else if (weapon === 4) {
      if (ammo.clip <= 0) return;
    }

    // Commit: consume ammo + set cooldown BEFORE resolving the shot.
    if (cfg.usesClip || weapon === 4) ammo.clip -= 1;
    shooter.cooldowns[weapon] = cfg.fireInterval;

    const origin = fromTuple(msg.origin);
    const dir = { x: 0, y: 0, z: 0 };
    normalize(dir, fromTuple(msg.dir));

    if (weapon === 1) {
      this.resolveHitscan(shooter, origin, dir, msg.clientTime);
    } else if (weapon === 2) {
      this.spawnProjectile('rocket', shooter, origin, dir, TUNING.rocket.projSpeed, 0);
    } else if (weapon === 4) {
      this.spawnProjectile('grenade', shooter, origin, dir, TUNING.grenade.projSpeed, TUNING.grenade.fuse);
    }
    // Knife (slot 3) is melee — not wired in M3 (no projectile/hitscan path).
  }

  ingestPing(id: number, msg: PingMsg): void {
    const player = this.players.get(id);
    if (!player) return;
    this.sendTo(player, { t: 'pong', clientTime: msg.clientTime, serverTime: this.now() });
  }

  // ---- shot resolution ----

  private resolveHitscan(shooter: RoomPlayer, origin: Vec3, dir: Vec3, clientTime: number): void {
    const range = TUNING.ar.range;

    // Rewind victims to when the shooter fired. clientTime is in the shooter's
    // clock; LagComp samples are in the server clock. The shooter's input/clock
    // is offset by ~RTT/2, but our buffer is keyed in server time, so rewind to
    // "now - (now - the time we'd expect this shot for)". For M3 we approximate:
    // the report's clientTime maps to server time via the freshest sample window,
    // so we rewind to min(now, max(oldest, clientTime)). Because LagComp clamps
    // out-of-range t to its endpoints, passing the server `now` minus the comp
    // window is safe; we use clientTime directly (clients send a server-clock
    // estimate via ClockSync) and rely on LagComp's clamp for safety.
    const t = clientTime;

    const hit = this.lagcomp.rewindRay(shooter.id, origin, dir, range, t);
    if (!hit) return;

    // Static occlusion: a wall between origin and the victim nulls the shot.
    const occ = this.world.raycast(origin, dir, hit.distance);
    if (occ !== null && occ.fraction < 1) {
      // Wall hit closer than the player -> shot blocked.
      const wallDist = occ.fraction * hit.distance;
      if (wallDist < hit.distance - 1e-3) return;
    }

    const victim = this.players.get(hit.id);
    if (!victim || !victim.alive) return;

    this.applyDamage(victim, TUNING.ar.damage, shooter.id, 1);
  }

  private spawnProjectile(
    kind: ProjKind,
    owner: RoomPlayer,
    origin: Vec3,
    dir: Vec3,
    speed: number,
    fuse: number,
  ): void {
    const vel: Vec3 = { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed };
    const id = this.nextProjId++;
    const proj = makeProjectile(id, kind, origin, vel, owner.id, fuse);
    this.projectiles.push(proj);
    this.broadcast({
      t: 'spawn_proj',
      id,
      kind,
      owner: owner.id,
      pos: toTuple(origin),
      vel: toTuple(vel),
    });
  }

  // ---- damage / death ----

  private applyDamage(victim: RoomPlayer, amount: number, source: number, weapon: WeaponSlot | 0): void {
    if (amount <= 0 || !victim.alive) return;
    victim.hp -= amount;
    if (victim.hp < 0) victim.hp = 0;

    const attacker = source >= 0 ? this.players.get(source) : undefined;
    const dirToSource = attacker
      ? this.dirBetween(victim.pos, attacker.pos)
      : undefined;

    this.broadcast({
      t: 'damage',
      victim: victim.id,
      amount,
      newHp: victim.hp,
      source,
      weapon,
      dirToSource,
    });

    if (victim.hp <= 0) {
      victim.alive = false;
      this.broadcast({
        t: 'kill',
        killer: source,
        victim: victim.id,
        weapon,
        fall: source === -1,
      });
    }
  }

  private dirBetween(from: Vec3, to: Vec3): Vec3Tuple {
    const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    normalize(d, d);
    return toTuple(d);
  }

  // ---- the authoritative loops ----

  /** Start the 30Hz tick. Wrapped so a throw destroys ONLY this room (PRD §6). */
  start(): void {
    if (this.timer || this.destroyed) return;
    this.timer = setInterval(() => this.safeTick(), Math.round(1000 * SERVER_DT));
  }

  private safeTick(): void {
    try {
      this.tickOnce();
    } catch (err) {
      console.error(`[room ${this.id}] tick crashed — destroying room:`, err);
      this.destroy();
    }
  }

  /**
   * One authoritative tick: cool weapons, step server projectiles (resolving
   * explosions -> damage + knockback), record lag-comp samples, and emit a
   * snapshot on the 20Hz cadence. Exposed for tests (drive manually without a
   * real timer).
   */
  tickOnce(): void {
    if (this.destroyed) return;
    const dt = SERVER_DT;
    const now = this.now();
    this.tick++;

    // Weapon cooldowns (server-side cadence enforcement).
    for (const p of this.players.values()) {
      for (const slot of [1, 2, 3, 4] as WeaponSlot[]) {
        if (p.cooldowns[slot] > 0) {
          p.cooldowns[slot] -= dt;
          if (p.cooldowns[slot] < 0) p.cooldowns[slot] = 0;
        }
      }
    }

    // Step server projectiles; resolve detonations against current capsules.
    this.stepProjectiles(dt, now);

    // Record current capsule centers into lag-comp (rewind buffer).
    for (const p of this.players.values()) {
      this.lagcomp.record(p.id, this.center(p.pos), CAP_RADIUS, CAP_HALF, now);
    }

    // Fall-out-of-world kill (killY): server-auth, source = world.
    for (const p of this.players.values()) {
      if (p.alive && p.pos.y < this.map.killY) {
        this.applyDamage(p, p.hp, -1, 0);
      }
    }

    // Snapshot cadence (~20Hz): emit when the per-tick countdown reaches 0.
    if (this.snapCountdown <= 0) {
      this.sendSnapshot(now);
      this.snapCountdown = TICKS_PER_SNAPSHOT_PATTERN[this.snapAccum % TICKS_PER_SNAPSHOT_PATTERN.length];
      this.snapAccum++;
    }
    this.snapCountdown--;
  }

  private stepProjectiles(dt: number, now: number): void {
    if (this.projectiles.length === 0) return;
    const caps = this.buildCapsules();

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i];
      stepProjectile(proj, this.world, dt, this.stepOut);
      if (!this.stepOut.detonated) continue;

      const center = { x: this.stepOut.point.x, y: this.stepOut.point.y, z: this.stepOut.point.z };
      const hits = computeExplosion(proj.kind, center, proj.ownerId, caps, this.world);

      const impulses: Array<{ id: number; impulse: Vec3Tuple }> = [];
      for (const hit of hits) {
        const target = this.players.get(hit.id);
        if (!target) continue;
        if (hit.damage > 0 && target.alive) {
          const weapon: WeaponSlot = proj.kind === 'rocket' ? 2 : 4;
          this.applyDamage(target, hit.damage, proj.ownerId, weapon);
        }
        if (hit.impulse.x !== 0 || hit.impulse.y !== 0 || hit.impulse.z !== 0) {
          impulses.push({ id: hit.id, impulse: toTuple(hit.impulse) });
          // Widen this player's movement allowance — they're about to be launched.
          this.validator.noteImpulse(hit.id, now);
        }
      }

      this.broadcast({
        t: 'detonate',
        id: proj.id,
        pos: toTuple(center),
        kind: proj.kind,
        impulses,
      });

      this.projectiles.splice(i, 1);
    }
  }

  private buildCapsules(): PlayerCapsule[] {
    this.capsScratch.length = 0;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      this.capsScratch.push({ id: p.id, center: this.center(p.pos), radius: CAP_RADIUS, halfHeight: CAP_HALF });
    }
    return this.capsScratch;
  }

  /** The capsule center used for hit/explosion math == the reported pos center. */
  private center(pos: Vec3): Vec3 {
    return { x: pos.x, y: pos.y, z: pos.z };
  }

  private sendSnapshot(now: number): void {
    const players: PlayerSnap[] = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        pos: toTuple(p.pos),
        vel: toTuple(p.vel),
        yaw: p.yaw,
        pitch: p.pitch,
        anim: p.anim,
        hp: p.hp,
        weapon: p.weapon,
      });
    }
    const projectiles: ProjSnap[] = this.projectiles.map((proj) => ({
      id: proj.id,
      kind: proj.kind,
      pos: toTuple(proj.pos),
      vel: toTuple(proj.vel),
    }));

    this.broadcast({ t: 'snapshot', tick: this.tick, serverTime: now, players, projectiles });
  }

  private broadcastRoundState(): void {
    this.broadcast({
      t: 'round_state',
      phase: this.phase === 'live' ? 'live' : 'waiting',
      score: [0, 0],
      timer: 0,
      round: 1,
    });
  }

  // ---- transport ----

  private broadcast(msg: ServerMessage): void {
    const data = encode(msg);
    for (const p of this.players.values()) {
      this.rawSend(p, data);
    }
  }

  private sendTo(player: RoomPlayer, msg: ServerMessage): void {
    this.rawSend(player, encode(msg));
  }

  private rawSend(player: RoomPlayer, data: string): void {
    try {
      player.ws.send(data);
    } catch {
      // A dead socket here just means the next close handler will evict them.
    }
  }

  // ---- teardown ----

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.players.clear();
    this.projectiles.length = 0;
    // Drop the trace world's entity colliders (the World itself is GC'd with us).
    // RapierTraceWorld holds no process-global handles we must free explicitly.
  }
}

/** Cheap server-side anim pick from velocity + buttons (no full state machine). */
function animFromVel(vel: Vec3, buttons: number): AnimState {
  const SLIDE = 1 << 6; // Button.Crouch
  if ((buttons & SLIDE) !== 0) return 'slide';
  const grounded = Math.abs(vel.y) < 0.5;
  if (!grounded) return 'air';
  const speed = Math.hypot(vel.x, vel.z);
  return speed > 0.5 ? 'run' : 'idle';
}
