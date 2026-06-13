// The trace-layer boundary (PRD §23.7, §24.1). The feel layer (movement.ts) and
// projectiles.ts talk ONLY to this four-method interface, so the collision
// backend (Rapier in production, a hand-coded mock in tests) is swappable and
// the unit tests are backend-agnostic. NO Three.js, NO DOM here.

import type { Vec3 } from '../math';

export type EntityId = number;

export interface TraceHit {
  fraction: number; // 0..1 along the swept delta where contact happens
  point: Vec3; // world-space contact point
  normal: Vec3; // surface normal at contact (unit, pointing out of the solid)
}

export interface TraceWorld {
  /** Sweep the player capsule from `from` along `delta`; first static hit or null. */
  castCapsule(
    from: Vec3,
    halfHeight: number,
    radius: number,
    delta: Vec3,
  ): TraceHit | null;

  /** Sweep a sphere (projectiles) from `from` along `delta`; first static hit or null. */
  castSphere(from: Vec3, radius: number, delta: Vec3): TraceHit | null;

  /** Hitscan ray vs static world. `dir` must be normalized. */
  raycast(origin: Vec3, dir: Vec3, maxDist: number): TraceHit | null;

  /** Dynamic entity ids whose registered collider overlaps the sphere (explosions). */
  overlapSphere(center: Vec3, radius: number): EntityId[];
}
