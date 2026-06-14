// Authoritative FFA game room (PRD §3.1, §6). One Room == one match. The room
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
  projectilePlayerHit,
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
import { initMatch, stepMatch, type MatchState, type MatchTickCtx } from './match.js';

const SERVER_DT = 1 / TUNING.world.serverHz; // 1/30s authoritative step
// Snapshot every Nth tick. 30Hz tick / 20Hz snapshots isn't an integer ratio;
// PRD calls this "every other-ish tick". We emit on a 2/1/2/1 cadence (≈20Hz).
const TICKS_PER_SNAPSHOT_PATTERN = [2, 1]; // alternating gap -> avg 1.5 -> 20Hz

const MAX_PLAYERS = TUNING.world.maxPlayers;

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
  // FFA bookkeeping. `frags` is this player's kill count for the current match
  // (zeroed at matchEnd->reset). `respawnTimer` counts down while dead; at <=0
  // the tick respawns the player. There are no slots and no disconnect grace in
  // FFA — a departure is just a departure.
  frags: number;
  respawnTimer: number;
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

  // The pure FFA match state machine (server/src/match.ts). The room owns the
  // MatchState, builds a per-tick aggregate MatchTickCtx, and acts on the events.
  private readonly match: MatchState = initMatch();
  // While frozen (matchEnd scoreboard only) the room ignores shoots and reports
  // zero velocity in snapshots so everyone renders still on the scoreboard.
  private frozen = false;
  // The last match-state we sent, so we only re-broadcast on change or ~1Hz.
  private lastSentPhase: MatchState['phase'] | null = null;
  private matchStateAccum = 0; // counts ticks toward the ~1Hz heartbeat

  // Scratch reused by the tick so the 30Hz loop allocates nothing per-tick.
  private readonly stepOut: ProjectileStep = { detonated: false, point: { x: 0, y: 0, z: 0 } };
  private readonly capsScratch: PlayerCapsule[] = [];

  // The room clock (ms). The server timestamps everything off this so a single
  // monotonic source drives lag-comp, ping/pong, and snapshots. Injectable so
  // tests can drive a deterministic clock (lag-comp rewind is time-sensitive).
  private readonly clock: () => number;
  private now(): number {
    return this.clock();
  }

  private constructor(
    id: string,
    mapId: string,
    world: RapierTraceWorld,
    map: MapData,
    clock?: () => number,
  ) {
    this.id = id;
    this.mapId = mapId;
    this.world = world;
    this.map = map;
    this.validator = new MovementValidator(world);
    this.lagcomp = new LagComp();
    this.clock = clock ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  }

  /** Build a room: load the map and the (async) Rapier trace world for it.
   *  `clock` overrides the wall clock (ms) — tests inject a controllable one. */
  static async create(id: string, mapId: string, clock?: () => number): Promise<Room> {
    const map = getMap(mapId);
    const world = await RapierTraceWorld.create(map.solids);
    return new Room(id, mapId, world, map, clock);
  }

  /** Number of players in the room (FFA has no grace seats). */
  get playerCount(): number {
    return this.players.size;
  }

  get isFull(): boolean {
    return this.players.size >= MAX_PLAYERS;
  }

  get isEmpty(): boolean {
    return this.players.size === 0;
  }

  /** FFA rooms auto-rematch forever; they only end by emptying out. The lobby
   * reaper destroys empty rooms, so a room is never "finished" while populated. */
  get isFinished(): boolean {
    return false;
  }

  /** Read-only match snapshot (phase/score/round/timer) — for tests + telemetry. */
  get matchState(): Readonly<MatchState> {
    return this.match;
  }

  hasPlayer(id: number): boolean {
    return this.players.has(id);
  }

  // ---- membership ----

  /** Add a player up to MAX_PLAYERS. Returns the spawned player or null if full. */
  addPlayer(ws: WebSocket, id: number, name: string): RoomPlayer | null {
    if (this.isFull) return null;

    const spawn = this.pickSpawn();
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
      frags: 0,
      respawnTimer: 0,
    };
    this.players.set(id, player);

    this.validator.reset(id, pos);
    this.lagcomp.record(id, this.center(pos), CAP_RADIUS, CAP_HALF, this.now());

    // Tell every existing player about the newcomer now (their onOpponent is
    // already wired). The REVERSE — telling the newcomer about existing players
    // — must wait until after the lobby has sent `joined`, because the client
    // only wires its onOpponent handler once connect() resolves on `joined`.
    // Sending the roster here would race ahead of `joined` and be dropped, so it
    // is deferred to sendRosterTo() (called by the lobby after `joined`).
    for (const other of this.players.values()) {
      if (other.id === id) continue;
      this.sendTo(other, { t: 'opponent', present: true, name: player.name, id: player.id });
    }

    this.broadcastMatchState();
    return player;
  }

  /**
   * Send a freshly-joined player the roster of existing OTHER players. The lobby
   * calls this AFTER it sends `joined`, so the client has wired its onOpponent
   * handler by the time these arrive (otherwise the roster races `joined` and is
   * dropped, leaving the newcomer without opponent names — see addPlayer).
   */
  sendRosterTo(id: number): void {
    const player = this.players.get(id);
    if (!player) return;
    for (const other of this.players.values()) {
      if (other.id === id) continue;
      this.sendTo(player, { t: 'opponent', present: true, name: other.name, id: other.id });
    }
  }

  /**
   * The socket closed. In FFA there is no grace window — a departure is just a
   * departure. Drop the player, announce it to everyone, and let the match
   * reducer fall back to warmup if the room drops below warmupMinPlayers.
   */
  removePlayer(id: number): void {
    const player = this.players.get(id);
    if (!player) return;

    for (const other of this.players.values()) {
      if (other.id === id) continue;
      this.sendTo(other, { t: 'opponent', present: false, name: player.name, id });
    }

    this.players.delete(id);
    this.validator.reset(id, { x: 0, y: 0, z: 0 });
    this.lagcomp.remove(id);
    this.world.removeEntity(id);
    this.broadcastMatchState();
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
    // No shooting while the round is frozen (countdown / roundEnd / matchEnd).
    if (this.frozen) return;
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
    // window is safe; clients send a server-clock estimate via ClockSync.
    //
    // CRUCIAL: the client renders opponents `interpDelayMs` in the PAST (snapshot
    // interpolation, client/main.ts), so the shooter aimed at where the victim was
    // a frame-window ago — not where they are at fire time. Rewind by that same
    // delay or every shot at a moving target whiffs (the rewound capsule sits
    // ahead of the crosshair). Stationary victims are unaffected (past == now).
    const t = clientTime - TUNING.world.interpDelayMs;

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

  private applyDamage(
    victim: RoomPlayer,
    amount: number,
    source: number,
    weapon: WeaponSlot | 0,
    fall = false,
  ): void {
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
      victim.respawnTimer = TUNING.world.respawnDelaySec;
      // Frag credit: a real kill by ANOTHER player. Suicide (fall / own rocket,
      // source === victim or -1) scores nothing for anyone.
      if (source >= 0 && source !== victim.id) {
        const killer = this.players.get(source);
        if (killer) killer.frags += 1;
      }
      this.broadcast({ t: 'kill', killer: source, victim: victim.id, weapon, fall });
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

    // Weapon cooldowns (server-side cadence enforcement). Frozen or not, cooling
    // down is harmless and keeps cadence honest across phase boundaries.
    for (const p of this.players.values()) {
      for (const slot of [1, 2, 3, 4] as WeaponSlot[]) {
        if (p.cooldowns[slot] > 0) {
          p.cooldowns[slot] -= dt;
          if (p.cooldowns[slot] < 0) p.cooldowns[slot] = 0;
        }
      }
    }

    // Damage-producing sim only runs when not frozen. On the match-end
    // scoreboard we neither advance projectiles nor apply fall kills, so nothing
    // changes HP while the match is paused.
    if (!this.frozen) {
      // Step server projectiles; resolve detonations against current capsules.
      this.stepProjectiles(dt, now);

      // Fall-out-of-world kill (killY): server-auth suicide (no frag credit).
      for (const p of this.players.values()) {
        if (p.alive && p.pos.y < this.map.killY) {
          this.applyDamage(p, p.hp, -1, 0, true);
        }
      }

      // Respawn dead players whose delay has elapsed.
      for (const p of this.players.values()) {
        if (p.alive) continue;
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0) this.respawnPlayer(p);
      }
    }

    // Record current capsule centers into lag-comp (rewind buffer) every tick —
    // rewind must work the instant the round goes live.
    for (const p of this.players.values()) {
      this.lagcomp.record(p.id, this.center(p.pos), CAP_RADIUS, CAP_HALF, now);
    }

    // Drive the pure match/round machine, then act on its events.
    this.stepMatchMachine(dt);

    // Match-state broadcast: on phase change, else a ~1Hz heartbeat.
    this.maybeBroadcastMatchState();

    // Snapshot cadence (~20Hz): emit when the per-tick countdown reaches 0.
    if (this.snapCountdown <= 0) {
      this.sendSnapshot(now);
      this.snapCountdown = TICKS_PER_SNAPSHOT_PATTERN[this.snapAccum % TICKS_PER_SNAPSHOT_PATTERN.length];
      this.snapAccum++;
    }
    this.snapCountdown--;
  }

  /**
   * Build this tick's aggregate MatchTickCtx, advance the pure reducer, and act
   * on its events. Frags live on the players; the reducer only reads the top
   * fragger + connected count.
   */
  private stepMatchMachine(dt: number): void {
    let topFrags = 0;
    let topFragsPlayer = -1;
    for (const p of this.players.values()) {
      // Lowest id wins frag ties (deterministic scoreboard winner).
      if (p.frags > topFrags || (p.frags === topFrags && topFragsPlayer >= 0 && p.id < topFragsPlayer)) {
        if (p.frags > topFrags) {
          topFrags = p.frags;
          topFragsPlayer = p.id;
        } else if (p.frags === topFrags && p.frags > 0) {
          topFragsPlayer = Math.min(topFragsPlayer, p.id);
        }
      } else if (topFragsPlayer < 0 && p.frags > 0) {
        topFrags = p.frags;
        topFragsPlayer = p.id;
      }
    }

    const ctx: MatchTickCtx = {
      connectedCount: this.players.size,
      topFrags,
      topFragsPlayer,
    };

    const events = stepMatch(this.match, ctx, dt);
    for (const ev of events) {
      switch (ev.type) {
        case 'matchStart':
          this.frozen = false;
          break;
        case 'matchEnd':
          this.frozen = true;
          break;
        case 'reset':
          // New match: zero every player's frags and respawn them fresh.
          for (const p of this.players.values()) {
            p.frags = 0;
            this.respawnPlayer(p);
          }
          this.frozen = false;
          break;
      }
    }
  }

  /** Respawn a player at the spawn farthest from any living player; full hp/ammo. */
  private respawnPlayer(p: RoomPlayer): void {
    const spawn = this.pickSpawn();
    const pos = fromTuple(spawn.pos);
    p.pos = pos;
    p.vel = { x: 0, y: 0, z: 0 };
    p.yaw = (spawn.yaw * Math.PI) / 180;
    p.pitch = 0;
    p.hp = TUNING.combat.spawnHealth;
    p.alive = true;
    p.respawnTimer = 0;
    p.weapon = 1;
    p.ammo = this.freshAmmo();
    p.cooldowns = { 1: 0, 2: 0, 3: 0, 4: 0 };
    p.anim = 'idle';
    this.validator.reset(p.id, pos);
    this.lagcomp.record(p.id, this.center(pos), CAP_RADIUS, CAP_HALF, this.now());
    // Tell the client (movement is client-auth) to snap to the new spawn.
    this.sendTo(p, { t: 'respawn', id: p.id, pos: toTuple(pos), yaw: p.yaw });
  }

  /** Pick the spawn point farthest from the nearest living player (anti-camp). */
  private pickSpawn(): { pos: Vec3Tuple; yaw: number } {
    const spawns = this.map.spawns;
    let best = spawns[0];
    let bestScore = -Infinity;
    for (const s of spawns) {
      let nearest = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const dx = p.pos.x - s.pos[0];
        const dz = p.pos.z - s.pos[2];
        const d2 = dx * dx + dz * dz;
        if (d2 < nearest) nearest = d2;
      }
      // No living players -> all spawns score equally; the first wins.
      if (nearest > bestScore) {
        bestScore = nearest;
        best = s;
      }
    }
    return best;
  }

  private stepProjectiles(dt: number, now: number): void {
    if (this.projectiles.length === 0) return;
    const caps = this.buildCapsules();

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i];
      // Segment the projectile sweeps this tick: stepProjectile mutates proj.pos,
      // so capture the start first to test it against players afterward.
      const segStart = { x: proj.pos.x, y: proj.pos.y, z: proj.pos.z };
      stepProjectile(proj, this.world, dt, this.stepOut);

      // The swept segment ends at the world-contact point if it detonated on
      // geometry this step, else at the projectile's new position.
      const segEnd = this.stepOut.detonated ? this.stepOut.point : proj.pos;

      // Direct player contact (rockets only — grenades bounce/roll until fuse).
      // A rocket that crosses a player capsule detonates ON them, closer than any
      // wall behind; without this the rocket flies straight through (the bug).
      let directHitId: number | undefined;
      let center: Vec3 | null = null;
      if (proj.kind === 'rocket') {
        const ph = projectilePlayerHit(segStart, segEnd, caps, proj.ownerId);
        if (ph) {
          directHitId = ph.id;
          center = ph.point;
        }
      }

      // Nothing to resolve unless we hit a player or detonated on geometry/fuse.
      if (center === null && !this.stepOut.detonated) continue;
      if (center === null) center = { x: this.stepOut.point.x, y: this.stepOut.point.y, z: this.stepOut.point.z };

      const hits = computeExplosion(proj.kind, center, proj.ownerId, caps, this.world, directHitId);

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
      // While frozen the match is paused: report zero velocity (and an idle
      // anim) so everyone renders still on the match-end scoreboard, even though
      // movement is otherwise client-authoritative.
      const frozen = this.frozen;
      players.push({
        id: p.id,
        pos: toTuple(p.pos),
        vel: frozen ? [0, 0, 0] : toTuple(p.vel),
        yaw: p.yaw,
        pitch: p.pitch,
        anim: frozen ? 'idle' : p.anim,
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

  /** Send the current match-state unconditionally (membership changes). */
  private broadcastMatchState(): void {
    const m = this.match;
    this.lastSentPhase = m.phase;
    this.matchStateAccum = 0;
    this.broadcast(this.matchStateMsg());
  }

  /** Build the match_state wire message from current room state. */
  private matchStateMsg(): ServerMessage {
    const m = this.match;
    const scores: Array<{ id: number; frags: number }> = [];
    for (const p of this.players.values()) scores.push({ id: p.id, frags: p.frags });
    return {
      t: 'match_state',
      phase: m.phase,
      // live: the match clock; matchEnd: the scoreboard countdown.
      timer: Math.max(0, m.phase === 'matchEnd' ? Math.ceil(m.clock) : Math.floor(m.clock)),
      fragLimit: TUNING.world.fragLimit,
      scores,
      winner: m.matchWinner,
    };
  }

  /**
   * Broadcast match-state when the phase changes, otherwise as a ~1Hz heartbeat
   * (so the client clock + live frag table stay fresh without per-tick churn).
   * Frag changes ride the heartbeat (≤1s lag on the scoreboard is fine; the kill
   * feed is immediate). Called once per tick.
   */
  private maybeBroadcastMatchState(): void {
    const m = this.match;
    const changed = m.phase !== this.lastSentPhase;
    this.matchStateAccum++;
    const heartbeat = this.matchStateAccum >= TUNING.world.serverHz; // ~1Hz
    if (changed || heartbeat) this.broadcastMatchState();
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
    // Close any sockets still attached (e.g. the survivor of a forfeit) so their
    // client learns the match is over rather than hanging on a silent room.
    for (const p of this.players.values()) {
      try {
        p.ws.close();
      } catch {
        /* already closing */
      }
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
