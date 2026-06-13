// Pure math for the shared sim. NO Three.js, NO DOM. Plain {x,y,z} objects.
// Hot-path functions take an `out` target to avoid per-frame allocation.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Vec3Tuple = [number, number, number];

export const EPSILON = 1e-6;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const fromTuple = (t: Vec3Tuple): Vec3 => ({ x: t[0], y: t[1], z: t[2] });
export const toTuple = (v: Vec3): Vec3Tuple => [v.x, v.y, v.z];

export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });

export function add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function scale(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** out = a + b * s */
export function addScaled(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export function mul(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x * b.x;
  out.y = a.y * b.y;
  out.z = a.z * b.z;
  return out;
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ax = a.x,
    ay = a.y,
    az = a.z;
  const bx = b.x,
    by = b.y,
    bz = b.z;
  out.x = ay * bz - az * by;
  out.y = az * bx - ax * bz;
  out.z = ax * by - ay * bx;
  return out;
}

export function lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function distanceSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt(distanceSq(a, b));
}

/** Normalizes a into out and returns the original length (0 if degenerate). */
export function normalize(out: Vec3, a: Vec3): number {
  const len = length(a);
  if (len < EPSILON) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return 0;
  }
  const inv = 1 / len;
  out.x = a.x * inv;
  out.y = a.y * inv;
  out.z = a.z * inv;
  return len;
}

/** out = a + (b - a) * t */
export function lerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/** Reflect v about a unit normal n: out = v - 2*(v·n)*n */
export function reflect(out: Vec3, v: Vec3, n: Vec3): Vec3 {
  const d = dot(v, n);
  out.x = v.x - 2 * d * n.x;
  out.y = v.y - 2 * d * n.y;
  out.z = v.z - 2 * d * n.z;
  return out;
}

/** Remove the component of v along unit normal n (slide projection): out = v - (v·n)*n */
export function projectOntoPlane(out: Vec3, v: Vec3, n: Vec3): Vec3 {
  const d = dot(v, n);
  out.x = v.x - d * n.x;
  out.y = v.y - d * n.y;
  out.z = v.z - d * n.z;
  return out;
}

/** Clamp the magnitude of a into out. */
export function clampLength(out: Vec3, a: Vec3, max: number): Vec3 {
  const lsq = lengthSq(a);
  if (lsq > max * max && lsq > EPSILON) {
    const s = max / Math.sqrt(lsq);
    out.x = a.x * s;
    out.y = a.y * s;
    out.z = a.z * s;
  } else if (out !== a) {
    copy(out, a);
  }
  return out;
}

/** Horizontal (xz) speed, ignoring vertical component. */
export function horizontalLength(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.z * a.z);
}

// ---- scalar helpers ----

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

export const lerpScalar = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Frame-rate-independent exponential smoothing factor for a given half-life-ish rate. */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  lerpScalar(current, target, 1 - Math.exp(-rate * dt));

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

// ---- ray / box intersection (used by MockTraceWorld + lag compensation) ----

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/**
 * Slab-method ray vs AABB. Returns entry `t` in [0, maxDist] and writes the
 * surface normal into `outNormal`, or null on miss. `dir` must be normalized.
 */
export function rayAabb(
  origin: Vec3,
  dir: Vec3,
  box: Aabb,
  maxDist: number,
  outNormal: Vec3,
): number | null {
  let tmin = 0;
  let tmax = maxDist;
  let nx = 0,
    ny = 0,
    nz = 0;

  // X slab
  {
    const inv = 1 / (dir.x || EPSILON);
    let t1 = (box.min.x - origin.x) * inv;
    let t2 = (box.max.x - origin.x) * inv;
    let sign = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      nx = sign;
      ny = 0;
      nz = 0;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Y slab
  {
    const inv = 1 / (dir.y || EPSILON);
    let t1 = (box.min.y - origin.y) * inv;
    let t2 = (box.max.y - origin.y) * inv;
    let sign = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      nx = 0;
      ny = sign;
      nz = 0;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Z slab
  {
    const inv = 1 / (dir.z || EPSILON);
    let t1 = (box.min.z - origin.z) * inv;
    let t2 = (box.max.z - origin.z) * inv;
    let sign = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      nx = 0;
      ny = 0;
      nz = sign;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }

  outNormal.x = nx;
  outNormal.y = ny;
  outNormal.z = nz;
  return tmin;
}

/**
 * Ray vs vertical infinite capsule segment (player hitbox for lag-comp).
 * Segment runs from `base` up by `height` with `radius`. Returns hit distance
 * along `dir` (normalized) within `maxDist`, or null. Cheap analytic test:
 * closest approach of the ray to the capsule's core segment.
 */
export function rayCapsule(
  origin: Vec3,
  dir: Vec3,
  base: Vec3,
  height: number,
  radius: number,
  maxDist: number,
): number | null {
  // Capsule core segment A->B
  const ax = base.x,
    ay = base.y,
    az = base.z;
  const bx = base.x,
    by = base.y + height,
    bz = base.z;
  // Segment direction (unit-ish along Y here, but keep general)
  const sdx = bx - ax,
    sdy = by - ay,
    sdz = bz - az;
  const sLenSq = sdx * sdx + sdy * sdy + sdz * sdz || EPSILON;

  // Solve closest points between ray (origin+dir*t) and segment.
  // Iterative analytic: project a sampling of the ray; for a vertical capsule
  // an exact quadratic over the cylinder + endpoint spheres is used.
  // Cylinder (infinite) intersection in the plane perpendicular to segment dir:
  const rox = origin.x - ax,
    roy = origin.y - ay,
    roz = origin.z - az;

  // component of dir and ro along segment axis
  const segInv = 1 / sLenSq;
  const dDotS = (dir.x * sdx + dir.y * sdy + dir.z * sdz) * segInv;
  const oDotS = (rox * sdx + roy * sdy + roz * sdz) * segInv;

  // perpendicular components
  const pdx = dir.x - sdx * dDotS;
  const pdy = dir.y - sdy * dDotS;
  const pdz = dir.z - sdz * dDotS;
  const pox = rox - sdx * oDotS;
  const poy = roy - sdy * oDotS;
  const poz = roz - sdz * oDotS;

  const A = pdx * pdx + pdy * pdy + pdz * pdz;
  const B = 2 * (pdx * pox + pdy * poy + pdz * poz);
  const C = pox * pox + poy * poy + poz * poz - radius * radius;

  if (A < EPSILON) {
    // Ray parallel to axis: only endpoint spheres can be hit; fall through.
  } else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t = (-B - sq) / (2 * A);
      if (t >= 0 && t <= maxDist) {
        const segParam = oDotS + dDotS * t;
        if (segParam >= 0 && segParam <= 1) return t;
      }
    }
  }
  // Endpoint spheres
  const hitA = raySphere(origin, dir, ax, ay, az, radius, maxDist);
  const hitB = raySphere(origin, dir, bx, by, bz, radius, maxDist);
  if (hitA === null) return hitB;
  if (hitB === null) return hitA;
  return Math.min(hitA, hitB);
}

function raySphere(
  origin: Vec3,
  dir: Vec3,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  maxDist: number,
): number | null {
  const ox = origin.x - cx,
    oy = origin.y - cy,
    oz = origin.z - cz;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t >= 0 && t <= maxDist) return t;
  return null;
}
