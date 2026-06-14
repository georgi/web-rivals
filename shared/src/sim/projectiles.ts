// Server-authoritative projectile sim + explosion resolution (PRD §24.3).
// Swept-sphere stepping makes tunneling impossible regardless of speed. Pure:
// the server steps these each tick; the client renders cosmetic predicted copies.

import type { Vec3 } from '../math';
import {
  v3,
  set,
  copy,
  addScaled,
  scale,
  reflect,
  normalize,
  clamp,
  lerpScalar,
  horizontalLength,
  rayCapsule,
  EPSILON,
} from '../math';
import { TUNING } from '../tuning';
import type { TraceWorld, EntityId } from './traceworld';

// Swept-sphere radius for projectile-vs-world contact (PRD §24.3). Small so the
// rocket/grenade reads as a point but never tunnels through thin geometry.
const PROJ_RADIUS = 0.15;

// ---- module-level scratch (zero-alloc hot paths) ----
const _delta = v3(); // vel * dt this step
const _toPlayer = v3(); // player.center - center
const _dir = v3(); // normalized blast direction

export type ProjKind = 'rocket' | 'grenade';

export interface Projectile {
  id: number;
  kind: ProjKind;
  pos: Vec3;
  vel: Vec3;
  ownerId: EntityId;
  fuse: number; // seconds remaining (grenade); rockets detonate on contact
  alive: boolean;
}

/** Analytic player hitbox for explosion overlap (own-code, 2 players — no engine). */
export interface PlayerCapsule {
  id: EntityId;
  center: Vec3;
  radius: number;
  halfHeight: number; // cylinder half-height
}

export interface ExplosionHit {
  id: EntityId;
  damage: number;
  impulse: Vec3; // velocity delta to add to that player
}

export interface ProjectileStep {
  detonated: boolean;
  point: Vec3; // detonation/contact point (valid when detonated)
}

export function makeProjectile(
  id: number,
  kind: ProjKind,
  pos: Vec3,
  vel: Vec3,
  ownerId: EntityId,
  fuse: number,
): Projectile {
  return {
    id,
    kind,
    pos: copy(v3(), pos),
    vel: copy(v3(), vel),
    ownerId,
    fuse,
    alive: true,
  };
}

/**
 * Advance one projectile by dt. Rockets: detonate on first static contact.
 * Grenades: bounce (restitution) off static geometry, detonate when fuse <= 0.
 * Returns whether it detonated this step and where.
 *
 * IMPLEMENTED BY: projectiles TDD task.
 */
export function stepProjectile(
  p: Projectile,
  world: TraceWorld,
  dt: number,
  out: ProjectileStep,
): ProjectileStep {
  out.detonated = false;

  if (p.kind === 'rocket') {
    // Slight gravity so long rockets arc.
    p.vel.y -= TUNING.rocket.projGravity * dt;

    // Swept-sphere this step; first static contact detonates.
    scale(_delta, p.vel, dt);
    const hit = world.castSphere(p.pos, PROJ_RADIUS, _delta);
    if (hit) {
      copy(out.point, hit.point);
      copy(p.pos, hit.point);
      out.detonated = true;
      p.alive = false;
      return out;
    }

    addScaled(p.pos, p.pos, p.vel, dt);
    copy(out.point, p.pos);
    return out;
  }

  // Grenade: gravity, bounce off geometry (restitution), detonate on fuse.
  p.vel.y -= TUNING.grenade.projGravity * dt;

  scale(_delta, p.vel, dt);
  const hit = world.castSphere(p.pos, PROJ_RADIUS, _delta);
  if (hit) {
    // Move to the contact point, then reflect+damp the velocity off the surface.
    copy(p.pos, hit.point);
    reflect(p.vel, p.vel, hit.normal);
    scale(p.vel, p.vel, TUNING.grenade.restitution);
    // Kill residual horizontal jitter so a settled grenade sits still.
    if (horizontalLength(p.vel) < 0.5) {
      p.vel.x = 0;
      p.vel.z = 0;
    }
  } else {
    addScaled(p.pos, p.pos, p.vel, dt);
  }

  // Fuse burns regardless of contact; detonate in place when it expires.
  p.fuse -= dt;
  if (p.fuse <= 0) {
    copy(out.point, p.pos);
    out.detonated = true;
    p.alive = false;
    return out;
  }

  copy(out.point, p.pos);
  return out;
}

/**
 * Direct projectile-vs-player contact for the segment the projectile swept this
 * tick (`start` -> `end`). Returns the NEAREST non-owner player whose capsule the
 * swept sphere crosses, plus the contact point, or null. The owner is excluded so
 * a rocket never detonates on the muzzle it just left (rocket-jumps still work via
 * splash). Without this a rocket only detonates on static geometry and sails
 * straight THROUGH players in the open — the "shoot through the player" bug.
 */
export function projectilePlayerHit(
  start: Vec3,
  end: Vec3,
  players: PlayerCapsule[],
  ownerId: EntityId,
): { id: EntityId; point: Vec3 } | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const segLen = Math.hypot(dx, dy, dz);
  if (segLen < EPSILON) return null;
  set(_dir, dx / segLen, dy / segLen, dz / segLen);

  let bestT = Infinity;
  let bestId: EntityId | null = null;
  for (const pl of players) {
    if (pl.id === ownerId) continue;
    // Capsule core base = center bottom; combined radius folds in the proj sphere.
    set(_toPlayer, pl.center.x, pl.center.y - pl.halfHeight, pl.center.z);
    const t = rayCapsule(start, _dir, _toPlayer, pl.halfHeight * 2, pl.radius + PROJ_RADIUS, segLen);
    if (t !== null && t < bestT) {
      bestT = t;
      bestId = pl.id;
    }
  }
  if (bestId === null) return null;
  return {
    id: bestId,
    point: { x: start.x + _dir.x * bestT, y: start.y + _dir.y * bestT, z: start.z + _dir.z * bestT },
  };
}

/**
 * Resolve an explosion: for each player in `players`, analytic sphere-vs-capsule
 * overlap -> damage falloff (linear) and the §4 knockback impulse. Owner takes
 * selfDamageScale damage but full selfKnockbackScale knockback. Damage requires
 * line-of-sight (world.raycast to center); knockback applies regardless (boost
 * tech stays forgiving). `kind` selects rocket vs grenade tuning.
 *
 * IMPLEMENTED BY: projectiles TDD task.
 */
export function computeExplosion(
  kind: ProjKind,
  center: Vec3,
  ownerId: EntityId,
  players: PlayerCapsule[],
  world: TraceWorld,
  directHitId?: EntityId,
): ExplosionHit[] {
  const tuning = kind === 'rocket' ? TUNING.rocket : TUNING.grenade;
  const radius = tuning.splashRadius;
  const out: ExplosionHit[] = [];

  for (const player of players) {
    // Nearest point on the player's vertical core segment to the blast center —
    // fairer than center-to-center (a near-foot blast on a tall capsule still
    // reads as close). Clamp center.y to [segBottom, segTop].
    const segBottom = player.center.y - player.halfHeight;
    const segTop = player.center.y + player.halfHeight;
    const nearestY = center.y < segBottom ? segBottom : center.y > segTop ? segTop : center.y;
    // Vector from blast center to the player's nearest core point; its length is
    // the fairness distance used for falloff and the LOS raycast.
    set(_toPlayer, player.center.x - center.x, nearestY - center.y, player.center.z - center.z);
    const dist = Math.hypot(_toPlayer.x, _toPlayer.y, _toPlayer.z);
    if (dist > radius) continue;

    // Linear falloff: full damage at center, min at the radius edge.
    const t = clamp(dist / radius, 0, 1);
    let damage = lerpScalar(tuning.splashDamageMax, tuning.splashDamageMin, t);
    if (kind === 'rocket' && directHitId !== undefined && player.id === directHitId) {
      damage += TUNING.rocket.directDamage;
    }

    // Blast direction toward the player's nearest core point; straight up if the
    // blast is dead-center (degenerate).
    const len = normalize(_dir, _toPlayer);
    if (len < EPSILON) set(_dir, 0, 1, 0);

    // Line-of-sight gate on damage only: a wall between the blast and the player
    // nulls damage but knockback survives (boost tech stays forgiving, §24.3).
    const blocked = len >= EPSILON && world.raycast(center, _dir, dist) !== null;
    if (blocked) damage = 0;

    let impulseMag = tuning.knockback * (1 - t);

    // Owner: reduced self-damage, but full (scaled) self-knockback regardless of LOS.
    if (player.id === ownerId) {
      damage *= tuning.selfDamageScale;
      impulseMag *= tuning.selfKnockbackScale;
    }

    const rounded = Math.round(damage);
    if (rounded <= 0 && impulseMag < EPSILON) continue;

    const impulse = v3();
    scale(impulse, _dir, impulseMag);
    out.push({ id: player.id, damage: rounded, impulse });
  }

  return out;
}
