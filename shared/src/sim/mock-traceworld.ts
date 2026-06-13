// Hand-coded TraceWorld over axis-aligned boxes + ramps, for fast unit tests
// with no WASM. Backend-agnostic test suite (PRD §24.1, §24.5) runs against this
// AND against RapierTraceWorld and must agree within tolerance.
//
// Method: Minkowski-expanded swept-point. For axis-aligned boxes, sweeping a
// capsule (or sphere) is exactly equivalent to ray-marching the capsule/sphere
// CENTER against the box expanded by the shape's extent (radius on X/Z, and
// radius+halfHeight on Y for the capsule). This is conservative-exact for the
// axis-aligned faces we care about; corner rounding is intentionally omitted
// (tests target axis-aligned cases per PRD §24.5). Ramps add a single slope
// plane (offset outward by the shape radius) clipped to the ramp footprint.

import type { Vec3 } from '../math';
import { v3, set, copy, dot, addScaled, rayAabb, EPSILON, type Aabb } from '../math';
import type { Solid, SolidBox, SolidRamp, RampDir } from '../geometry';
import { rampNormal } from '../geometry';
import type { TraceWorld, TraceHit, EntityId } from './traceworld';

export interface MockEntity {
  id: EntityId;
  center: Vec3;
  radius: number;
  halfHeight: number;
}

// A box collider expressed as a world-space AABB.
interface BoxCollider {
  min: Vec3;
  max: Vec3;
}

// A ramp collider: its bounding AABB (for the box-like faces) plus the slope
// plane (a point on the slope + its outward unit normal). The horizontal extent
// of the AABB doubles as the footprint used to clip the plane test.
interface RampCollider {
  min: Vec3; // bounding AABB min
  max: Vec3; // bounding AABB max
  planePoint: Vec3; // a point on the un-offset slope plane (the toe-bottom edge)
  planeNormal: Vec3; // outward unit normal of the slope surface
  dir: RampDir;
}

// ---- module-level scratch (zero-alloc hot paths) ----
const _scratchNormal = v3();
const _scratchExpMin = v3();
const _scratchExpMax = v3();
const _scratchAabb: Aabb = { min: _scratchExpMin, max: _scratchExpMax };
const _scratchOffsetPoint = v3();
const _scratchHitPoint = v3();
const _scratchRayDir = v3();
const _bestNormal = v3();
const _planeDiff = v3();
const _capClosest = v3();

export class MockTraceWorld implements TraceWorld {
  private readonly boxes: BoxCollider[] = [];
  private readonly ramps: RampCollider[] = [];
  private readonly entities = new Map<EntityId, MockEntity>();

  constructor(solids: Solid[]) {
    for (const s of solids) {
      if (s.type === 'box') this.boxes.push(buildBox(s));
      else this.ramps.push(buildRamp(s));
    }
  }

  registerEntity(e: MockEntity): void {
    this.entities.set(e.id, {
      id: e.id,
      center: { x: e.center.x, y: e.center.y, z: e.center.z },
      radius: e.radius,
      halfHeight: e.halfHeight,
    });
  }

  clearEntities(): void {
    this.entities.clear();
  }

  castCapsule(from: Vec3, halfHeight: number, radius: number, delta: Vec3): TraceHit | null {
    // Capsule vs box: Minkowski expand box by `radius` on X/Z and by
    // `radius + halfHeight` on Y, then sweep the center point.
    return this.sweep(from, delta, radius, radius + halfHeight, radius, radius);
  }

  castSphere(from: Vec3, radius: number, delta: Vec3): TraceHit | null {
    // Sphere vs box: expand by `radius` on all axes.
    return this.sweep(from, delta, radius, radius, radius, radius);
  }

  /**
   * Sweep a point from `from` along `delta` against boxes expanded by
   * (expX, expY, expZ) and ramps whose slope plane is offset outward by
   * `planeOffset`. Returns the nearest hit with fraction in [0,1].
   */
  private sweep(
    from: Vec3,
    delta: Vec3,
    expX: number,
    expY: number,
    expZ: number,
    planeOffset: number,
  ): TraceHit | null {
    const dist = Math.hypot(delta.x, delta.y, delta.z);
    if (dist < EPSILON) return null;
    const invDist = 1 / dist;
    set(_scratchRayDir, delta.x * invDist, delta.y * invDist, delta.z * invDist);

    let bestT = dist; // entry distance along the (normalized) ray, in metres
    let hit = false;

    // Boxes: ray vs expanded AABB.
    for (const b of this.boxes) {
      set(_scratchExpMin, b.min.x - expX, b.min.y - expY, b.min.z - expZ);
      set(_scratchExpMax, b.max.x + expX, b.max.y + expY, b.max.z + expZ);
      const t = rayAabb(from, _scratchRayDir, _scratchAabb, bestT, _scratchNormal);
      if (t !== null && t >= 0 && t <= bestT) {
        bestT = t;
        copy(_bestNormal, _scratchNormal);
        hit = true;
      }
    }

    // Ramps: box-like bounding faces (expanded) AND the slope plane.
    for (const r of this.ramps) {
      // Bounding-box faces (conservative). The bounding box of a ramp includes
      // empty space above the slope, so only trust a bounding-face hit on a
      // genuine box face of the ramp (back wall / bottom / sides) — never the
      // top, which is air. normal.y > 0.5 means a top face: reject it; the
      // slope plane below handles the diagonal surface.
      set(_scratchExpMin, r.min.x - expX, r.min.y - expY, r.min.z - expZ);
      set(_scratchExpMax, r.max.x + expX, r.max.y + expY, r.max.z + expZ);
      const tb = rayAabb(from, _scratchRayDir, _scratchAabb, bestT, _scratchNormal);
      if (tb !== null && tb >= 0 && tb <= bestT && _scratchNormal.y <= 0.5) {
        bestT = tb;
        copy(_bestNormal, _scratchNormal);
        hit = true;
      }

      // Slope plane, offset outward by `planeOffset` along its normal.
      addScaled(_scratchOffsetPoint, r.planePoint, r.planeNormal, planeOffset);
      const tp = rayPlaneClamped(from, _scratchRayDir, _scratchOffsetPoint, r.planeNormal, bestT);
      if (tp !== null && tp >= 0 && tp <= bestT) {
        // Clip to the ramp footprint (horizontal extent of its bounding box,
        // grown by the shape extent so a capsule resting on the edge counts).
        addScaled(_scratchHitPoint, from, _scratchRayDir, tp);
        if (
          _scratchHitPoint.x >= r.min.x - expX - EPSILON &&
          _scratchHitPoint.x <= r.max.x + expX + EPSILON &&
          _scratchHitPoint.z >= r.min.z - expZ - EPSILON &&
          _scratchHitPoint.z <= r.max.z + expZ + EPSILON
        ) {
          bestT = tp;
          copy(_bestNormal, r.planeNormal);
          hit = true;
        }
      }
    }

    if (!hit) return null;

    const fraction = bestT * invDist; // back to 0..1 along delta
    const point = v3();
    addScaled(point, from, _scratchRayDir, bestT);
    return {
      fraction,
      point,
      normal: { x: _bestNormal.x, y: _bestNormal.y, z: _bestNormal.z },
    };
  }

  raycast(origin: Vec3, dir: Vec3, maxDist: number): TraceHit | null {
    let bestT = maxDist;
    let hit = false;

    // Boxes: no expansion.
    for (const b of this.boxes) {
      copy(_scratchExpMin, b.min);
      copy(_scratchExpMax, b.max);
      const t = rayAabb(origin, dir, _scratchAabb, bestT, _scratchNormal);
      if (t !== null && t >= 0 && t <= bestT) {
        bestT = t;
        copy(_bestNormal, _scratchNormal);
        hit = true;
      }
    }

    // Ramps: bounding box faces (excluding the airy top) + slope plane.
    for (const r of this.ramps) {
      copy(_scratchExpMin, r.min);
      copy(_scratchExpMax, r.max);
      const tb = rayAabb(origin, dir, _scratchAabb, bestT, _scratchNormal);
      if (tb !== null && tb >= 0 && tb <= bestT && _scratchNormal.y <= 0.5) {
        bestT = tb;
        copy(_bestNormal, _scratchNormal);
        hit = true;
      }

      const tp = rayPlaneClamped(origin, dir, r.planePoint, r.planeNormal, bestT);
      if (tp !== null && tp >= 0 && tp <= bestT) {
        addScaled(_scratchHitPoint, origin, dir, tp);
        if (
          _scratchHitPoint.x >= r.min.x - EPSILON &&
          _scratchHitPoint.x <= r.max.x + EPSILON &&
          _scratchHitPoint.z >= r.min.z - EPSILON &&
          _scratchHitPoint.z <= r.max.z + EPSILON &&
          _scratchHitPoint.y >= r.min.y - EPSILON &&
          _scratchHitPoint.y <= r.max.y + EPSILON
        ) {
          bestT = tp;
          copy(_bestNormal, r.planeNormal);
          hit = true;
        }
      }
    }

    if (!hit) return null;
    const point = v3();
    addScaled(point, origin, dir, bestT);
    return {
      fraction: maxDist > 0 ? bestT / maxDist : 0,
      point,
      normal: { x: _bestNormal.x, y: _bestNormal.y, z: _bestNormal.z },
    };
  }

  overlapSphere(center: Vec3, radius: number): EntityId[] {
    const out: EntityId[] = [];
    for (const e of this.entities.values()) {
      if (sphereVsCapsule(center, radius, e)) out.push(e.id);
    }
    return out;
  }
}

// ---- builders ----

function buildBox(s: SolidBox): BoxCollider {
  const [cx, cy, cz] = s.pos;
  const [sx, sy, sz] = s.size;
  return {
    min: v3(cx - sx / 2, cy - sy / 2, cz - sz / 2),
    max: v3(cx + sx / 2, cy + sy / 2, cz + sz / 2),
  };
}

function buildRamp(s: SolidRamp): RampCollider {
  const [cx, cy, cz] = s.pos;
  const [sx, sy, sz] = s.size;
  const hx = sx / 2,
    hy = sy / 2,
    hz = sz / 2;
  const by = cy - hy; // bottom
  const normal = rampNormal(s);

  // A point on the slope plane: the toe-bottom edge (floor level, on the -dir
  // side). The toe is the low end opposite the ascent direction.
  let toeX = cx;
  let toeZ = cz;
  switch (s.dir) {
    case '+x':
      toeX = cx - hx; // ascends toward +x, toe at -x
      break;
    case '-x':
      toeX = cx + hx;
      break;
    case '+z':
      toeZ = cz - hz;
      break;
    case '-z':
      toeZ = cz + hz;
      break;
  }

  return {
    min: v3(cx - hx, by, cz - hz),
    max: v3(cx + hx, cy + hy, cz + hz),
    planePoint: v3(toeX, by, toeZ),
    planeNormal: normal,
    dir: s.dir,
  };
}

// ---- geometry helpers ----

/**
 * Ray (origin + dir*t, dir normalized) vs plane (point, unit normal). Returns
 * entry distance t in [0, maxT] for a front-facing hit (ray approaching the
 * plane from the outward-normal side), or null. Back-face and parallel rays miss.
 */
function rayPlaneClamped(
  origin: Vec3,
  dir: Vec3,
  point: Vec3,
  normal: Vec3,
  maxT: number,
): number | null {
  const denom = dot(dir, normal);
  if (denom >= -EPSILON) return null; // parallel or moving along the normal (no front hit)
  _planeDiff.x = point.x - origin.x;
  _planeDiff.y = point.y - origin.y;
  _planeDiff.z = point.z - origin.z;
  const t = dot(_planeDiff, normal) / denom;
  if (t < 0 || t > maxT) return null;
  return t;
}

/**
 * Sphere (center, radius) vs vertical capsule entity. The capsule core is a
 * vertical segment of half-length `halfHeight` centred at the entity center.
 * True when their surfaces touch or overlap.
 */
function sphereVsCapsule(center: Vec3, radius: number, e: MockEntity): boolean {
  // Closest point on the capsule's vertical core segment to `center`.
  const segBottom = e.center.y - e.halfHeight;
  const segTop = e.center.y + e.halfHeight;
  const cy = center.y < segBottom ? segBottom : center.y > segTop ? segTop : center.y;
  set(_capClosest, e.center.x, cy, e.center.z);
  const dx = center.x - _capClosest.x;
  const dy = center.y - _capClosest.y;
  const dz = center.z - _capClosest.z;
  const distSq = dx * dx + dy * dy + dz * dz;
  const r = radius + e.radius;
  return distSq <= r * r;
}
