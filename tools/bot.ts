// Headless protocol client for soak-testing rooms (PRD §11, §19.6). Connects via
// `ws`, sends Hello, then runs a scripted ~30Hz loop: a patrol (lerp between two
// points + strafe + occasional jump) reported as client-authoritative movement,
// plus periodic AR Shoot at the arena center. It logs received Snapshot counts,
// Damage, Kill, Correction. No rendering, no Three.js — pure protocol.
//
// Env knobs (PRD §19.6):
//   WS_URL        ws endpoint                 (default ws://localhost:8080)
//   BOT_NAME      display name                (default Bot)
//   BOT_DURATION  run seconds then exit clean (default 12)
//   BOT_CHEAT     "1" -> teleport-cheater: periodically reports a huge pos jump to
//                 exercise the server movement sanity clamp (expects Correction)
//   BOT_SHOOT     "1" -> fire the AR at the arena center periodically (default 1)
//   BOT_PATROL    "a" | "b" -> which patrol leg to start on (spreads two bots out)
//   BOT_ROOM      optional private room code (forces two bots into one room)
//   BOT_AIM_AT    "x,y,z" -> aim shots at this world point instead of arena center
//
// Exit code is 0 on a clean timed shutdown.

import { WebSocket } from 'ws';
import {
  encode,
  decode,
  Button,
  TUNING,
  normalize,
  type Vec3,
  type Vec3Tuple,
  type ServerMessage,
} from '@rivals/shared';

const URL = process.env.WS_URL ?? 'ws://localhost:8080';
const NAME = process.env.BOT_NAME ?? 'Bot';
const DURATION_SEC = Number(process.env.BOT_DURATION ?? 12);
const CHEAT = process.env.BOT_CHEAT === '1';
const SHOOT = (process.env.BOT_SHOOT ?? '1') === '1';
const PATROL_LEG = (process.env.BOT_PATROL ?? 'a').toLowerCase() === 'b' ? 1 : 0;
const ROOM = process.env.BOT_ROOM || undefined;
// HOLD: stand still at spawn instead of patrolling (used as the stationary victim
// in a duel so the shooter's lag-comp rewind has a fixed target).
const HOLD = process.env.BOT_HOLD === '1';

// Fixed-shot mode: fire a precise hitscan from an explicit origin/dir every shoot
// tick. The crate map's diagonal spawns + central crate mean two patrolling bots
// never share line-of-sight, so to prove the server-authoritative DAMAGE path
// end-to-end we let one bot send the exact known-hitting shot over the wire (the
// server resolves shoot(origin,dir) against the victim's lag-comp position
// regardless of the shooter's own avatar location). Format: "x,y,z".
function parseVec(envName: string): Vec3 | null {
  const raw = process.env[envName];
  if (!raw) return null;
  const [x, y, z] = raw.split(',').map(Number);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}
const SHOOT_ORIGIN = parseVec('BOT_SHOOT_ORIGIN');
const SHOOT_DIR = parseVec('BOT_SHOOT_DIR');
// Tracking-shot mode: fire a point-blank shot at the opponent's last snapshot pos
// every shoot tick (robust across the per-round spawn alternation). Used to make a
// stationary HOLD victim die each round so a full best-of-5 actually completes.
const TRACK_SHOOT = process.env.BOT_TRACK_SHOOT === '1';

const TICK_MS = Math.round(1000 / TUNING.world.inputHz); // ~33ms, 30Hz input
const EYE = TUNING.movement.eyeHeightStand; // camera offset above feet
const CAP_HALF = TUNING.movement.standHeight / 2; // center -> feet distance
const PATROL_SPEED = 5; // m/s — well under the validator's per-tick budget
const WAYPOINT_REACH = 0.2; // advance to next waypoint within this radius (matches verification)

// Per-tick displacement budget the server allows (validate.ts): MAX_SPEED * dt *
// 1.5. We move incrementally from our accepted pos and CAP each step under this so
// legitimate movement is never flagged. PATROL_SPEED * dt is already well inside.
const MAX_STEP =
  (TUNING.movement.sprintSpeed + TUNING.movement.slideBoost) * (TICK_MS / 1000) * 1.4;

// Patrol routes: a small closed loop of waypoints per spawn quadrant, ping-ponged.
// Each spawn on the crate map sits in an L-cover pocket; the open escape corridor
// out to the field is narrower than this bot's step+threshold can thread without
// occasionally clipping a wall, which the server's static-penetration check would
// (correctly) reject. So instead each bot patrols a verified-open ~3m box right
// around its own spawn. These exact waypoints were validated by simulating THIS
// bot's stepping (capped steps + reach threshold) against the SAME server-side
// MovementValidator the room runs for 1000 ticks -> 0 rejections, so legitimate
// movement never trips a Correction (that is reserved for the cheater path). The
// bot does NOT teleport to the first waypoint; it adopts its authoritative spawn
// from the first snapshot and walks the loop in capped steps.
const PATROL_Y = 1; // capsule-center height on the flat floor (spawn y)
function wp(pairs: [number, number][]): Vec3[] {
  return pairs.map(([x, z]) => ({ x, y: PATROL_Y, z }));
}
const ROUTES: Vec3[][] = [
  wp([
    [-12, -12], [-13.8, -13.8], [-13.8, -10.6], [-10.6, -10.6], [-10.6, -13.8], [-12, -12],
  ]),
  wp([
    [12, 12], [13.8, 13.8], [13.8, 10.6], [10.6, 10.6], [10.6, 13.8], [12, 12],
  ]),
];

const AIM_AT: Vec3 = (() => {
  const raw = process.env.BOT_AIM_AT;
  if (raw) {
    const [x, y, z] = raw.split(',').map(Number);
    if ([x, y, z].every((n) => Number.isFinite(n))) return { x, y, z };
  }
  // Arena center high-ground crate top (~y=3) is roughly eye height across the map.
  return { x: 0, y: 1.6, z: 0 };
})();

// ---- mutable bot state ----
let ws: WebSocket | null = null;
let joined = false;
let playerId = -1;
let roomId = '';
let seq = 1;
let elapsedTicks = 0;
// Default to the BOT_PATROL hint, but auto-correct to the route whose start is
// nearest our ACTUAL spawn once we learn it (join order / env can't desync us).
let route = ROUTES[PATROL_LEG];
let waypoint = 0; // index of the waypoint we're walking toward
// pos starts unset; we adopt the server's authoritative spawn from the first
// snapshot of our own player, then walk in capped steps. Until then we report the
// spawn we learn, so the very first reports never exceed the displacement budget.
let pos: Vec3 | null = null;
let vel: Vec3 = { x: 0, y: 0, z: 0 };
let yaw = 0;

// ---- counters for the final report ----
const counts = {
  snapshots: 0,
  damageDealt: 0,
  damageTaken: 0,
  kills: 0,
  corrections: 0,
  spawnProj: 0,
  detonate: 0,
  shotsSent: 0,
};

let opponentId = -1;
let lastOppPos: Vec3 | null = null;
let lastRoundKey = ''; // last logged round_state key (dedup the heartbeat)

let loopTimer: ReturnType<typeof setInterval> | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

function log(...args: unknown[]): void {
  console.log(`[${NAME}]`, ...args);
}

function send(msg: object): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(encode(msg as never));
}

// ---- movement: advance the patrol one tick from the CURRENT accepted pos ----
// Incremental + capped: each tick we step at most min(PATROL_SPEED*dt, MAX_STEP)
// toward the active waypoint, so a report is never a teleport. When pos is null we
// haven't learned our spawn yet (no snapshot), so we hold still.
function stepPatrol(dtSec: number): void {
  if (!pos) {
    vel = { x: 0, y: 0, z: 0 };
    return;
  }
  if (HOLD) {
    // Stand at the adopted spawn (stationary victim). Re-reporting the same pos
    // keeps the validator baseline + lag-comp samples fixed at this position.
    vel = { x: 0, y: 0, z: 0 };
    return;
  }
  const target = route[waypoint];
  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < WAYPOINT_REACH) {
    waypoint = (waypoint + 1) % route.length;
    return;
  }
  let step = Math.min(PATROL_SPEED * dtSec, MAX_STEP);
  if (step > dist) step = dist;
  const nx = (dx / dist) * step;
  const nz = (dz / dist) * step;
  pos.x += nx;
  pos.z += nz;
  pos.y = 1;
  vel = { x: nx / dtSec, y: 0, z: nz / dtSec };
  yaw = Math.atan2(dx, dz);
}

function buttonsForTick(): { buttons: number; events: number } {
  let buttons = Button.Forward | Button.Sprint;
  let events = 0;
  // Occasional jump (every ~2s) to exercise air anim + event flags.
  if (elapsedTicks % 60 === 0 && elapsedTicks > 0) {
    buttons |= Button.Jump;
    events |= 1 << 0; // EventFlag.Jumped
  }
  return { buttons, events };
}

function sendInput(): void {
  if (!pos) return; // haven't learned our spawn yet; nothing valid to report
  const { buttons, events } = buttonsForTick();
  let reportPos = pos;

  // Cheater: every ~1s, report a huge teleport that blows past the per-tick
  // displacement budget so the server must clamp it (Correction).
  if (CHEAT && elapsedTicks > 30 && elapsedTicks % 30 === 0) {
    reportPos = { x: pos.x + 60, y: pos.y, z: pos.z + 60 };
    log(`CHEAT teleport report -> [${reportPos.x.toFixed(1)}, ${reportPos.z.toFixed(1)}]`);
  }

  send({
    t: 'input',
    seq: seq++,
    clientTime: Date.now(),
    pos: [reportPos.x, reportPos.y, reportPos.z] as Vec3Tuple,
    vel: [vel.x, vel.y, vel.z] as Vec3Tuple,
    yaw,
    pitch: 0,
    buttons,
    events,
  });
}

function sendShoot(): void {
  let origin: Vec3;
  let dir: Vec3 = { x: 0, y: 0, z: 0 };

  if (TRACK_SHOOT) {
    // Tracking point-blank shot at the (stationary) opponent's last-known snapshot
    // center. Spawns alternate corners each round, so a single fixed origin can't
    // hit every round; instead we fire from 1.5m toward map-center (the clear side,
    // away from each spawn's L-cover) straight back at the holder. Lag-comp resolves
    // shoot(origin,dir) against the victim regardless of OUR avatar location, and a
    // 1.5m point-blank ray has no static between origin and victim. Sign points the
    // offset toward the origin (0,0): a holder at a -corner is offset +toward 0.
    if (!lastOppPos) return;
    const t = lastOppPos;
    const off = 1.5;
    const sx = t.x >= 0 ? -1 : 1;
    const sz = t.z >= 0 ? -1 : 1;
    origin = { x: t.x + sx * off, y: t.y, z: t.z + sz * off };
    normalize(dir, { x: t.x - origin.x, y: t.y - origin.y, z: t.z - origin.z });
  } else if (SHOOT_ORIGIN && SHOOT_DIR) {
    // Explicit fixed shot (duel/damage-path proof): exact origin + dir over the wire.
    origin = SHOOT_ORIGIN;
    normalize(dir, SHOOT_DIR);
  } else {
    if (!pos) return;
    // Aim from this bot's eye toward the opponent (if known) or the configured point.
    origin = { x: pos.x, y: pos.y - CAP_HALF + EYE, z: pos.z };
    const target = lastOppPos ?? AIM_AT;
    normalize(dir, { x: target.x - origin.x, y: target.y - origin.y, z: target.z - origin.z });
  }

  send({
    t: 'shoot',
    seq: seq++,
    weapon: 1, // AR (hitscan)
    origin: [origin.x, origin.y, origin.z] as Vec3Tuple,
    dir: [dir.x, dir.y, dir.z] as Vec3Tuple,
    clientTime: Date.now(),
  });
  counts.shotsSent++;
}

function onServerMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case 'joined':
      joined = true;
      playerId = msg.playerId;
      roomId = msg.roomId;
      log(`JOINED room=${roomId} playerId=${playerId} ready=${msg.youAreReady}`);
      break;
    case 'opponent':
      if (msg.present) {
        opponentId = msg.id;
        log(`OPPONENT present name=${msg.name} id=${msg.id}`);
      } else {
        log(`OPPONENT left id=${msg.id}`);
        opponentId = -1;
        lastOppPos = null;
      }
      break;
    case 'snapshot': {
      counts.snapshots++;
      for (const p of msg.players) {
        if (p.id === playerId) {
          // Adopt the authoritative spawn the first time we see ourselves, so the
          // patrol starts exactly where the server placed us (no first-tick jump),
          // and pick the patrol route whose start is nearest THIS spawn — so the
          // bot is correct regardless of join order or the BOT_PATROL hint.
          if (!pos) {
            pos = { x: p.pos[0], y: p.pos[1], z: p.pos[2] };
            let best = 0;
            let bestD = Infinity;
            for (let r = 0; r < ROUTES.length; r++) {
              const s = ROUTES[r][0];
              const d = Math.hypot(s.x - pos.x, s.z - pos.z);
              if (d < bestD) {
                bestD = d;
                best = r;
              }
            }
            route = ROUTES[best];
            waypoint = 0;
            log(`adopted spawn [${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}] -> route ${best}`);
          }
        } else if (p.id === opponentId) {
          // Track the opponent's last-known position for aiming.
          lastOppPos = { x: p.pos[0], y: p.pos[1], z: p.pos[2] };
        }
      }
      if (counts.snapshots === 1 || counts.snapshots % 60 === 0) {
        log(`snapshot #${counts.snapshots} tick=${msg.tick} players=${msg.players.length}`);
      }
      break;
    }
    case 'correction':
      counts.corrections++;
      log(`CORRECTION #${counts.corrections} -> snap to [${msg.pos[0].toFixed(1)}, ${msg.pos[2].toFixed(1)}] (seq ${msg.seq})`);
      // Honor the snap-back so we don't keep accumulating an offset (a real client
      // would reconcile here). For the cheater we still re-teleport next window.
      pos = { x: msg.pos[0], y: msg.pos[1], z: msg.pos[2] };
      break;
    case 'damage':
      if (msg.source === playerId) {
        counts.damageDealt++;
        log(`DAMAGE dealt ${msg.amount} to #${msg.victim} (victim hp now ${msg.newHp})`);
      }
      if (msg.victim === playerId) {
        counts.damageTaken++;
        log(`DAMAGE taken ${msg.amount} from #${msg.source} (hp now ${msg.newHp})`);
      }
      break;
    case 'kill':
      counts.kills++;
      log(`KILL killer=#${msg.killer} victim=#${msg.victim} weapon=${msg.weapon}`);
      break;
    case 'spawn_proj':
      counts.spawnProj++;
      break;
    case 'detonate':
      counts.detonate++;
      break;
    case 'round_state': {
      // Log only on a real transition (phase/score/round change) so the bot logs
      // read as the round-state timeline, not the ~1Hz heartbeat churn.
      const key = `${msg.phase}|${msg.score[0]}-${msg.score[1]}|r${msg.round}`;
      if (key !== lastRoundKey) {
        lastRoundKey = key;
        log(`ROUNDSTATE phase=${msg.phase} score=${msg.score[0]}-${msg.score[1]} round=${msg.round} timer=${msg.timer}`);
      }
      break;
    }
    case 'pong':
      break;
  }
}

function tick(): void {
  if (!joined) return;
  stepPatrol(TICK_MS / 1000);
  sendInput();

  // Fire the AR a few times a second once we have an opponent (or always if no
  // opponent and shooting is on — exercises ammo/cooldown gating regardless).
  // Tracking-shot mode fires faster (every 6 ticks ≈ 5/s, still above AR's 0.1s
  // cooldown) so a stationary holder dies in ~1.4s and a full bo5 fits a short run.
  const shootEvery = TRACK_SHOOT ? 6 : 15;
  if (SHOOT && elapsedTicks % shootEvery === 0 && elapsedTicks > shootEvery) {
    sendShoot();
  }

  // Occasional ping so the server's pong path is exercised.
  if (elapsedTicks % 30 === 0) send({ t: 'ping', clientTime: Date.now() });

  elapsedTicks++;
}

function shutdown(code: number): void {
  if (loopTimer) clearInterval(loopTimer);
  if (stopTimer) clearTimeout(stopTimer);
  loopTimer = null;
  stopTimer = null;
  log(
    `SUMMARY snapshots=${counts.snapshots} damageDealt=${counts.damageDealt} ` +
      `damageTaken=${counts.damageTaken} kills=${counts.kills} corrections=${counts.corrections} ` +
      `spawnProj=${counts.spawnProj} detonate=${counts.detonate} shotsSent=${counts.shotsSent}`,
  );
  try {
    ws?.close();
  } catch {
    /* already closing */
  }
  // Give the close frame a beat, then exit.
  setTimeout(() => process.exit(code), 150);
}

function main(): void {
  log(`connecting to ${URL} (cheat=${CHEAT} shoot=${SHOOT} room=${ROOM ?? 'quickmatch'} duration=${DURATION_SEC}s)`);
  ws = new WebSocket(URL);

  ws.on('open', () => {
    log(`connected, sending hello`);
    send({ t: 'hello', name: NAME, roomCode: ROOM });
    loopTimer = setInterval(tick, TICK_MS);
    stopTimer = setTimeout(() => shutdown(0), DURATION_SEC * 1000);
  });

  ws.on('message', (raw: Buffer) => {
    let msg: ServerMessage;
    try {
      msg = decode<ServerMessage>(raw.toString());
    } catch {
      return;
    }
    onServerMessage(msg);
  });

  ws.on('close', () => {
    log('socket closed');
    if (loopTimer) {
      // Server closed on us before our timer fired — wrap up.
      shutdown(0);
    }
  });

  ws.on('error', (e: Error) => {
    log('socket error', e.message);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main();
