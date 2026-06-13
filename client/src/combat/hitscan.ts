// Client-side hitscan resolution and deterministic bloom (PRD §22).
//
// `hitscan` finds the nearest contact among the static world (TraceWorld.raycast)
// and a set of capsule targets (analytic math.rayCapsule). The same routine —
// and the same seeded bloom — will run server-side in M3, so the client tracer
// and the authoritative ray agree.
//
// Client module: may import THREE, but this file deliberately stays Three-free
// (plain Vec3 in/out) so the eventual server can reuse it verbatim.

import type { Vec3, TraceWorld } from '@rivals/shared';
import { v3, set, copy, cross, normalize, rayCapsule, EPSILON } from '@rivals/shared';

export interface CapsuleTarget {
  id: number;
  center: Vec3;
  radius: number;
  halfHeight: number;
}

export interface HitscanResult {
  kind: 'world' | 'entity' | 'miss';
  point: Vec3;
  normal: Vec3;
  entityId: number;
  distance: number;
}

// ---- module-level scratch (zero per-call alloc beyond the returned vectors) ----
const _capBase = v3();
const _basisU = v3();
const _basisV = v3();
const _perturbed = v3();
const _ref = v3();

/**
 * Nearest contact of a ray (origin + dir*t, `dir` MUST be unit) against the
 * static world and every capsule target, within `maxDist`.
 *
 *  - world nearest -> { kind:'world', point, normal (surface), entityId:-1 }
 *  - target nearest -> { kind:'entity', entityId, point=origin+dir*d,
 *                        normal≈toward origin }
 *  - nothing        -> { kind:'miss', entityId:-1, distance=maxDist,
 *                        point=origin+dir*maxDist, normal=+Y }
 */
export function hitscan(
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  world: TraceWorld,
  targets: CapsuleTarget[],
): HitscanResult {
  let bestDist = maxDist;
  let bestEntity = -1;
  // World surface normal is captured here when the world is the current best.
  let worldNx = 0;
  let worldNy = 1;
  let worldNz = 0;
  let worldIsBest = false;

  const worldHit = world.raycast(origin, dir, maxDist);
  if (worldHit !== null) {
    const d = worldHit.fraction * maxDist;
    if (d <= bestDist) {
      bestDist = d;
      worldIsBest = true;
      worldNx = worldHit.normal.x;
      worldNy = worldHit.normal.y;
      worldNz = worldHit.normal.z;
    }
  }

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    set(_capBase, t.center.x, t.center.y - t.halfHeight, t.center.z);
    const d = rayCapsule(origin, dir, _capBase, 2 * t.halfHeight, t.radius, bestDist);
    if (d !== null && d <= bestDist) {
      // Strictly nearer (or ties broken toward the entity — a flush body shot
      // should register as a hit, not as the wall behind it).
      bestDist = d;
      bestEntity = t.id;
      worldIsBest = false;
    }
  }

  if (bestEntity >= 0) {
    const point = v3(
      origin.x + dir.x * bestDist,
      origin.y + dir.y * bestDist,
      origin.z + dir.z * bestDist,
    );
    // Approximate surface normal: point back toward the shooter.
    const normal = v3(-dir.x, -dir.y, -dir.z);
    normalize(normal, normal);
    return { kind: 'entity', point, normal, entityId: bestEntity, distance: bestDist };
  }

  if (worldIsBest) {
    const point = v3(
      origin.x + dir.x * bestDist,
      origin.y + dir.y * bestDist,
      origin.z + dir.z * bestDist,
    );
    return {
      kind: 'world',
      point,
      normal: v3(worldNx, worldNy, worldNz),
      entityId: -1,
      distance: bestDist,
    };
  }

  return {
    kind: 'miss',
    point: v3(
      origin.x + dir.x * maxDist,
      origin.y + dir.y * maxDist,
      origin.z + dir.z * maxDist,
    ),
    normal: v3(0, 1, 0),
    entityId: -1,
    distance: maxDist,
  };
}

// ---- deterministic seeded bloom (PRD §22) ----

/** mulberry32: tiny fast deterministic PRNG. Same `seq` -> same stream. */
function mulberry32(seq: number): number {
  let a = (seq + 0x6d2b79f5) | 0;
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

/**
 * Perturb `baseDir` (assumed unit) by a deterministic offset inside a cone of
 * half-angle `spreadRadians`, derived from the integer `seq` so the client and
 * a would-be server ray agree shot-for-shot (PRD §22). Writes a unit dir to
 * `out`. With `spreadRadians === 0` (or `seq === 0` AND zero spread) the result
 * is exactly `baseDir`.
 */
export function applyBloom(
  out: Vec3,
  baseDir: Vec3,
  spreadRadians: number,
  seq: number,
): void {
  if (spreadRadians <= 0) {
    copy(out, baseDir);
    return;
  }

  // Two independent samples from the seq: a uniformly-distributed angle and a
  // radius with sqrt() weighting for a uniform disc.
  const r1 = mulberry32(seq);
  const r2 = mulberry32(seq ^ 0x9e3779b9);
  const angle = r1 * Math.PI * 2;
  const radius = Math.sqrt(r2) * spreadRadians; // cone half-angle offset

  // Orthonormal basis (basisU, basisV) spanning the plane perpendicular to
  // baseDir. Pick a reference axis not parallel to baseDir to seed the cross.
  if (Math.abs(baseDir.y) < 0.99) {
    set(_ref, 0, 1, 0);
  } else {
    set(_ref, 1, 0, 0);
  }
  cross(_basisU, baseDir, _ref);
  if (normalize(_basisU, _basisU) < EPSILON) {
    // baseDir was (near) parallel to _ref despite the guard — fall back.
    set(_ref, 1, 0, 0);
    cross(_basisU, baseDir, _ref);
    normalize(_basisU, _basisU);
  }
  cross(_basisV, baseDir, _basisU); // already unit (baseDir ⟂ basisU, both unit)

  // Tilt baseDir by `radius` toward (cos*basisU + sin*basisV).
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const tx = ca * _basisU.x + sa * _basisV.x;
  const ty = ca * _basisU.y + sa * _basisV.y;
  const tz = ca * _basisU.z + sa * _basisV.z;

  const cr = Math.cos(radius);
  const sr = Math.sin(radius);
  set(
    _perturbed,
    baseDir.x * cr + tx * sr,
    baseDir.y * cr + ty * sr,
    baseDir.z * cr + tz * sr,
  );
  normalize(out, _perturbed); // unit by construction; normalize guards FP drift
}
