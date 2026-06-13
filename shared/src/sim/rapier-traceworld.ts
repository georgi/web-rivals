// Production TraceWorld backed by Rapier (PRD §23.7). Rapier is used ONLY as the
// trace layer: static colliders from the map JSON (boxes -> Cuboid, ramps ->
// ConvexHull/Trimesh from geometry.solidVertices) + shape-casts, raycasts,
// sphere overlaps. NO dynamics, NO character controller velocity ownership —
// all integration stays in movement.ts. Runs in browser AND Node (rapier3d-compat).
//
// Rapier init is async: call `await RapierTraceWorld.create(solids)`.

import type RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3 } from '../math';
import type { Solid } from '../geometry';
import { solidVertices, solidMeshArrays } from '../geometry';
import type { TraceWorld, TraceHit, EntityId } from './traceworld';

let rapierReady: Promise<typeof RAPIER> | null = null;

/** Idempotent Rapier WASM init. Hides behind the lobby screen (PRD §23.4). */
export async function initRapier(): Promise<typeof RAPIER> {
  if (!rapierReady) {
    rapierReady = import('@dimforge/rapier3d-compat').then(async (mod) => {
      await mod.init();
      return mod;
    });
  }
  return rapierReady;
}

export interface RapierTraceWorldOptions {
  // dynamic entity (player) colliders for overlapSphere, keyed by EntityId
}

// Identity quaternion reused for every query (Rapier's Rotation = {x,y,z,w}).
const IDENTITY_ROT: RAPIER.Rotation = { x: 0, y: 0, z: 0, w: 1 };

// Module-level scratch returned by the trace methods. Callers consume the hit
// synchronously (movement.ts / projectiles.ts copy out before the next cast),
// so a single reused TraceHit avoids per-tick allocation on the hot path.
const SCRATCH_HIT: TraceHit = {
  fraction: 0,
  point: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 0 },
};

// Scratch Vector reused as the shape-cast velocity / ray origin argument.
const SCRATCH_VEC: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Build a fixed (dynamics-free, gravity 0) Rapier World with static colliders
 * from `solids`, plus a registry of kinematic capsule colliders for dynamic
 * entities (players) used by overlapSphere. Implements the four TraceWorld
 * query methods via Rapier shape-casts / ray casts / intersection queries.
 */
export class RapierTraceWorld implements TraceWorld {
  private readonly rapier: typeof RAPIER;
  private readonly world: RAPIER.World;

  // entity id -> its kinematic capsule collider (for overlapSphere)
  private readonly entityColliders = new Map<EntityId, RAPIER.Collider>();
  // entity id -> backing kinematic body (kept so we can clean it up)
  private readonly entityBodies = new Map<EntityId, RAPIER.RigidBody>();
  // collider handle -> entity id (reverse lookup in the overlap callback)
  private readonly handleToEntity = new Map<number, EntityId>();

  // Reusable shape instances (allocated once, mutated never — Rapier reads them).
  private readonly capsuleShapeCache = new Map<string, RAPIER.Capsule>();
  private readonly ballShapeCache = new Map<number, RAPIER.Ball>();

  // overlapSphere result buffer (cleared + refilled each call, never reallocated).
  private readonly overlapResult: EntityId[] = [];

  private constructor(rapier: typeof RAPIER, solids: Solid[]) {
    this.rapier = rapier;
    // Gravity 0: Rapier never integrates anything; it is a pure query backend.
    this.world = new rapier.World({ x: 0, y: 0, z: 0 });

    for (const solid of solids) {
      this.addStaticSolid(solid);
    }

    // Make the freshly-created static colliders visible to scene queries
    // without stepping the simulation.
    this.world.updateSceneQueries();
  }

  static async create(solids: Solid[]): Promise<RapierTraceWorld> {
    const rapier = await initRapier();
    return new RapierTraceWorld(rapier, solids);
  }

  // ---- static world construction ----

  private addStaticSolid(solid: Solid): void {
    const R = this.rapier;
    if (solid.type === 'box') {
      const [cx, cy, cz] = solid.pos;
      const [sx, sy, sz] = solid.size;
      const desc = R.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2).setTranslation(
        cx,
        cy,
        cz,
      );
      this.world.createCollider(desc);
      return;
    }

    // Ramp: solidVertices() already returns WORLD-space corners, so build the
    // collider at the origin (translation 0) so it lands exactly where the
    // client render mesh is. Prefer a convex hull; fall back to a trimesh if
    // the hull degenerates (returns null).
    const verts = solidVertices(solid);
    const points = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
      points[i * 3] = verts[i].x;
      points[i * 3 + 1] = verts[i].y;
      points[i * 3 + 2] = verts[i].z;
    }

    let desc = R.ColliderDesc.convexHull(points);
    if (desc === null) {
      const { vertices, indices } = solidMeshArrays(solid);
      desc = R.ColliderDesc.trimesh(vertices, indices);
    }
    // Verts are world-space already -> translation stays (0,0,0).
    this.world.createCollider(desc);
  }

  // ---- dynamic entity registry (overlapSphere) ----

  /** Register a player capsule for explosion overlap queries. */
  registerEntity(id: EntityId, center: Vec3, radius: number, halfHeight: number): void {
    const R = this.rapier;
    // Remove any stale entry first so re-registering an id is well-defined.
    this.removeEntity(id);

    const bodyDesc = R.RigidBodyDesc.kinematicPositionBased().setTranslation(
      center.x,
      center.y,
      center.z,
    );
    const body = this.world.createRigidBody(bodyDesc);

    const colDesc = R.ColliderDesc.capsule(halfHeight, radius);
    const collider = this.world.createCollider(colDesc, body);

    this.entityBodies.set(id, body);
    this.entityColliders.set(id, collider);
    this.handleToEntity.set(collider.handle, id);
    this.world.updateSceneQueries();
  }

  /** Move a registered entity's capsule to a new center. */
  updateEntity(id: EntityId, center: Vec3): void {
    const body = this.entityBodies.get(id);
    if (!body) return;
    // Move the parent body (the collider follows it). We never step the
    // simulation, so set the translation immediately instead of via
    // setNextKinematicTranslation (which only applies on the next step), then
    // push the body position onto its collider and refresh scene queries.
    SCRATCH_VEC.x = center.x;
    SCRATCH_VEC.y = center.y;
    SCRATCH_VEC.z = center.z;
    body.setTranslation(SCRATCH_VEC, false);
    this.world.propagateModifiedBodyPositionsToColliders();
    this.world.updateSceneQueries();
  }

  /** Drop an entity's capsule (death / disconnect). */
  removeEntity(id: EntityId): void {
    const collider = this.entityColliders.get(id);
    if (collider) {
      this.handleToEntity.delete(collider.handle);
      this.world.removeCollider(collider, false);
      this.entityColliders.delete(id);
    }
    const body = this.entityBodies.get(id);
    if (body) {
      this.world.removeRigidBody(body);
      this.entityBodies.delete(id);
    }
  }

  // ---- TraceWorld queries ----

  castCapsule(from: Vec3, halfHeight: number, radius: number, delta: Vec3): TraceHit | null {
    const shape = this.getCapsule(halfHeight, radius);
    return this.castShape(from, delta, shape);
  }

  castSphere(from: Vec3, radius: number, delta: Vec3): TraceHit | null {
    const shape = this.getBall(radius);
    return this.castShape(from, delta, shape);
  }

  raycast(origin: Vec3, dir: Vec3, maxDist: number): TraceHit | null {
    const ray = new this.rapier.Ray(origin, dir);
    // solid=true so a ray starting inside a collider reports an immediate hit.
    // EXCLUDE_KINEMATIC keeps hitscan/world casts off the dynamic player capsules.
    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDist,
      true,
      this.rapier.QueryFilterFlags.EXCLUDE_KINEMATIC,
    );
    if (!hit) return null;

    const toi = hit.timeOfImpact;
    SCRATCH_HIT.fraction = maxDist > 0 ? toi / maxDist : 0;
    SCRATCH_HIT.point.x = origin.x + dir.x * toi;
    SCRATCH_HIT.point.y = origin.y + dir.y * toi;
    SCRATCH_HIT.point.z = origin.z + dir.z * toi;
    SCRATCH_HIT.normal.x = hit.normal.x;
    SCRATCH_HIT.normal.y = hit.normal.y;
    SCRATCH_HIT.normal.z = hit.normal.z;
    return SCRATCH_HIT;
  }

  overlapSphere(center: Vec3, radius: number): EntityId[] {
    this.overlapResult.length = 0;
    const ball = this.getBall(radius);
    // Only dynamic entity capsules are kinematic; static solids are fixed, so
    // EXCLUDE_FIXED drops the map geometry and leaves player capsules.
    this.world.intersectionsWithShape(
      center,
      IDENTITY_ROT,
      ball,
      (collider) => {
        const id = this.handleToEntity.get(collider.handle);
        if (id !== undefined) this.overlapResult.push(id);
        return true; // keep collecting
      },
      this.rapier.QueryFilterFlags.EXCLUDE_FIXED,
    );
    return this.overlapResult;
  }

  // ---- internals ----

  /**
   * Shared shape-cast. With velocity = delta and maxToi = 1, the returned
   * time_of_impact IS the 0..1 fraction along delta (PRD §23.7), matching the
   * TraceHit contract.
   */
  private castShape(from: Vec3, delta: Vec3, shape: RAPIER.Shape): TraceHit | null {
    const hit = this.world.castShape(
      from,
      IDENTITY_ROT,
      delta, // shapeVel: full delta -> toi is the fraction
      shape,
      0, // targetDistance
      1, // maxToi -> fraction space
      true, // stopAtPenetration: report contact even if already touching
      this.rapier.QueryFilterFlags.EXCLUDE_KINEMATIC, // world geometry only
    );
    if (!hit) return null;

    const frac = hit.time_of_impact;
    SCRATCH_HIT.fraction = frac;
    // Contact point on the world collider (witness1). It is already world-space
    // here because all static colliders are placed in world coordinates.
    SCRATCH_HIT.point.x = hit.witness1.x;
    SCRATCH_HIT.point.y = hit.witness1.y;
    SCRATCH_HIT.point.z = hit.witness1.z;
    // normal1 = outward normal of the world collider at the contact.
    SCRATCH_HIT.normal.x = hit.normal1.x;
    SCRATCH_HIT.normal.y = hit.normal1.y;
    SCRATCH_HIT.normal.z = hit.normal1.z;
    return SCRATCH_HIT;
  }

  private getCapsule(halfHeight: number, radius: number): RAPIER.Capsule {
    const key = `${halfHeight}:${radius}`;
    let shape = this.capsuleShapeCache.get(key);
    if (!shape) {
      shape = new this.rapier.Capsule(halfHeight, radius);
      this.capsuleShapeCache.set(key, shape);
    }
    return shape;
  }

  private getBall(radius: number): RAPIER.Ball {
    let shape = this.ballShapeCache.get(radius);
    if (!shape) {
      shape = new this.rapier.Ball(radius);
      this.ballShapeCache.set(radius, shape);
    }
    return shape;
  }
}
