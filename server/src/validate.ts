// Server-side movement sanity check (PRD §3.1, §6). Movement is CLIENT-authoritative:
// the client simulates its own player and reports pos+vel each tick. The server does
// NOT re-simulate — it only validates that a report is physically plausible and, when
// it isn't, snaps the offender back to the last accepted state via a Correction.
//
// Two cheap rejections per the PRD:
//   1. Displacement too large for one tick (teleport / speed hack), with a widened
//      allowance briefly after a known explosion impulse (rocket-jump launch).
//   2. The reported position is buried inside static geometry.
//
// NO Three.js, NO DOM. Talks to the world ONLY through the TraceWorld interface, so
// it runs against MockTraceWorld in tests and RapierTraceWorld in production.

import type { Vec3, TraceWorld } from '@rivals/shared';
import { TUNING } from '@rivals/shared';

export interface MoveReport {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
}

export interface ValidationResult {
  ok: boolean;
  correctedPos: Vec3;
  correctedVel: Vec3;
}

// Per-player accepted state plus the last time we were told a launch impulse fired.
interface PlayerRecord {
  pos: Vec3;
  vel: Vec3;
  lastImpulseTime: number; // -Infinity until the first noteImpulse
}

// --- allowance tuning (all derived from TUNING so the cap tracks gameplay values) ---

// The fastest the player can plausibly be moving horizontally under normal play.
const MAX_SPEED = TUNING.movement.sprintSpeed + TUNING.movement.slideBoost;
// Slack factor on the per-tick budget — covers tick-time jitter and the input/sim
// rate mismatch (client sims at 60Hz, reports less often) without letting a teleport
// slip through.
const DISPLACEMENT_SLACK = 1.5;
// Window after a launch impulse during which the allowance is widened.
const IMPULSE_WINDOW_SEC = 0.6;
// Multiplier on the displacement allowance inside the impulse window (explosion launch).
const IMPULSE_ALLOWANCE_MULT = 4;
// Skin depth for the static-penetration test. We probe a short downward capsule sweep
// that STARTS this far above the reported position. A capsule resting on (or grazing
// just into) the surface then reports a small positive sweep fraction and is NOT
// flagged; only a capsule buried deeper than the skin reports fraction 0. This keeps a
// legitimately grounded player from being falsely corrected on float-boundary jitter.
const PENETRATION_SKIN = 0.06;

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

const cloneVec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

export class MovementValidator {
  private readonly world: TraceWorld;
  private readonly records = new Map<number, PlayerRecord>();

  constructor(world: TraceWorld) {
    this.world = world;
  }

  /** Spawn / respawn: trust this position as the new accepted baseline. */
  reset(playerId: number, pos: Vec3): void {
    this.records.set(playerId, {
      pos: cloneVec(pos),
      vel: { x: 0, y: 0, z: 0 },
      lastImpulseTime: -Infinity,
    });
  }

  /** A known launch impulse (e.g. explosion knockback) fired for this player at `now`. */
  noteImpulse(playerId: number, now: number): void {
    const rec = this.records.get(playerId);
    if (rec) rec.lastImpulseTime = now;
    else this.records.set(playerId, { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, lastImpulseTime: now });
  }

  /**
   * Validate one client movement report. On accept, store it as the new baseline and
   * echo it back. On reject, leave the baseline untouched and return the last accepted
   * pos with a zeroed velocity so the caller can snap the client back (Correction).
   */
  accept(playerId: number, report: MoveReport, dtSec: number, now: number): ValidationResult {
    let rec = this.records.get(playerId);
    if (!rec) {
      // First time we see this player: trust the report as the baseline (the join /
      // spawn path should call reset(), but never crash if it didn't).
      rec = { pos: cloneVec(report.pos), vel: cloneVec(report.vel), lastImpulseTime: -Infinity };
      this.records.set(playerId, rec);
      return { ok: true, correctedPos: cloneVec(report.pos), correctedVel: cloneVec(report.vel) };
    }

    const launching = now - rec.lastImpulseTime <= IMPULSE_WINDOW_SEC;

    // 1) Horizontal displacement budget for this tick.
    const dx = report.pos.x - rec.pos.x;
    const dz = report.pos.z - rec.pos.z;
    const horizDist = Math.hypot(dx, dz);
    let horizBudget = MAX_SPEED * Math.max(dtSec, 0) * DISPLACEMENT_SLACK;
    if (launching) horizBudget *= IMPULSE_ALLOWANCE_MULT;

    if (horizDist > horizBudget) {
      return this.reject(rec);
    }

    // 2) Static penetration: is the reported capsule buried in the world?
    if (this.penetratesStatic(report.pos)) {
      return this.reject(rec);
    }

    // Accept: this report becomes the new baseline.
    rec.pos.x = report.pos.x;
    rec.pos.y = report.pos.y;
    rec.pos.z = report.pos.z;
    rec.vel.x = report.vel.x;
    rec.vel.y = report.vel.y;
    rec.vel.z = report.vel.z;
    return { ok: true, correctedPos: cloneVec(report.pos), correctedVel: cloneVec(report.vel) };
  }

  private reject(rec: PlayerRecord): ValidationResult {
    return { ok: false, correctedPos: cloneVec(rec.pos), correctedVel: cloneVec(ZERO) };
  }

  /**
   * True if the player capsule centred at `pos` is buried in static geometry. We sweep a
   * short downward capsule probe that STARTS `PENETRATION_SKIN` above `pos`. A swept-point
   * against a Minkowski-expanded collider returns fraction 0 only when the start point is
   * already inside the expanded box. By starting the probe a skin above the reported
   * centre, a capsule resting on the surface reads a small positive fraction (NOT flagged),
   * while a capsule sunk deeper than the skin reads fraction 0 (flagged).
   */
  private penetratesStatic(pos: Vec3): boolean {
    const m = TUNING.movement;
    const halfHeight = (m.standHeight - 2 * m.radius) / 2; // capsule core half-length
    const from = { x: pos.x, y: pos.y + PENETRATION_SKIN, z: pos.z };
    const delta = { x: 0, y: -2 * PENETRATION_SKIN, z: 0 };
    const hit = this.world.castCapsule(from, halfHeight, m.radius, delta);
    return hit !== null && hit.fraction <= 0;
  }
}
