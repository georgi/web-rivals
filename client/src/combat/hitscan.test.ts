import { describe, it, expect } from 'vitest';
import { MockTraceWorld, v3, normalize, length, type Solid, type Vec3 } from '@rivals/shared';
import { hitscan, applyBloom, type CapsuleTarget } from './hitscan';

// Open arena: a floor far below and a wall at x=5. The shooter stands at the
// origin's eye height and fires horizontally down +x.
const FLOOR: Solid = { type: 'box', pos: [0, 0, 0], size: [40, 1, 40] };
const WALL: Solid = { type: 'box', pos: [5, 2, 0], size: [1, 4, 10] };

const EYE: Vec3 = { x: 0, y: 1.6, z: 0 };
const FORWARD_X: Vec3 = { x: 1, y: 0, z: 0 };
const MAX = 200;

function target(id: number, at: Vec3): CapsuleTarget {
  return { id, center: at, radius: 0.4, halfHeight: 0.9 };
}

describe('hitscan', () => {
  it('returns kind:entity when a target sits in the open arena along the ray', () => {
    // Floor only (no wall), target dummy at x=3 directly ahead.
    const world = new MockTraceWorld([FLOOR]);
    const dummy = target(1, { x: 3, y: 1.6, z: 0 });
    const res = hitscan(EYE, FORWARD_X, MAX, world, [dummy]);

    expect(res.kind).toBe('entity');
    expect(res.entityId).toBe(1);
    // Contact is on the near face of the capsule (~x=3 - radius=2.6).
    expect(res.distance).toBeGreaterThan(2.4);
    expect(res.distance).toBeLessThan(2.7);
    // Normal points back toward the shooter (-x) and is unit length.
    expect(res.normal.x).toBeLessThan(0);
    expect(length(res.normal)).toBeCloseTo(1, 6);
    // Point lies on the ray.
    expect(res.point.x).toBeCloseTo(EYE.x + FORWARD_X.x * res.distance, 6);
  });

  it('returns kind:world when the ray hits a wall (no target in the way)', () => {
    const world = new MockTraceWorld([FLOOR, WALL]);
    const res = hitscan(EYE, FORWARD_X, MAX, world, []);

    expect(res.kind).toBe('world');
    expect(res.entityId).toBe(-1);
    // Wall's near face is at x = 5 - 0.5 = 4.5.
    expect(res.point.x).toBeCloseTo(4.5, 4);
    expect(res.normal.x).toBeLessThan(0); // facing the shooter
  });

  it('prefers the nearer of world vs entity', () => {
    // Wall at x=4.5 (face), target behind it at x=10 -> world wins.
    const world = new MockTraceWorld([FLOOR, WALL]);
    const behind = target(2, { x: 10, y: 1.6, z: 0 });
    const res = hitscan(EYE, FORWARD_X, MAX, world, [behind]);
    expect(res.kind).toBe('world');

    // Target in front of the wall at x=3 -> entity wins.
    const front = target(3, { x: 3, y: 1.6, z: 0 });
    const res2 = hitscan(EYE, FORWARD_X, MAX, world, [front]);
    expect(res2.kind).toBe('entity');
    expect(res2.entityId).toBe(3);
  });

  it('returns kind:miss into empty space', () => {
    const world = new MockTraceWorld([]); // nothing to hit
    const res = hitscan(EYE, FORWARD_X, MAX, world, []);
    expect(res.kind).toBe('miss');
    expect(res.entityId).toBe(-1);
    expect(res.distance).toBe(MAX);
    expect(res.point.x).toBeCloseTo(MAX, 4);
    expect(res.normal.y).toBe(1);
  });
});

describe('applyBloom', () => {
  it('seq=0, spread=0 returns baseDir exactly', () => {
    const out = v3();
    applyBloom(out, FORWARD_X, 0, 0);
    expect(out.x).toBe(FORWARD_X.x);
    expect(out.y).toBe(FORWARD_X.y);
    expect(out.z).toBe(FORWARD_X.z);
  });

  it('zero spread always returns baseDir regardless of seq', () => {
    const out = v3();
    applyBloom(out, FORWARD_X, 0, 12345);
    expect(out.x).toBe(1);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });

  it('with spread>0 returns a unit vector inside the cone', () => {
    const spread = 0.05; // ~2.9deg, AR sustained bloom
    const out = v3();
    for (let seq = 1; seq <= 64; seq++) {
      applyBloom(out, FORWARD_X, spread, seq);
      // Unit length.
      expect(length(out)).toBeCloseTo(1, 6);
      // Angle from baseDir within the cone half-angle.
      const cosAngle = out.x; // dot(out, FORWARD_X) with FORWARD_X = +x unit
      const angle = Math.acos(Math.min(1, Math.max(-1, cosAngle)));
      expect(angle).toBeLessThanOrEqual(spread + 1e-9);
    }
  });

  it('is deterministic: same seq -> same dir', () => {
    const a = v3();
    const b = v3();
    applyBloom(a, FORWARD_X, 0.03, 42);
    applyBloom(b, FORWARD_X, 0.03, 42);
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(a.z).toBe(b.z);
  });

  it('works for a non-axis-aligned baseDir', () => {
    const base = v3();
    normalize(base, v3(1, 1, 0));
    const out = v3();
    applyBloom(out, base, 0.04, 7);
    expect(length(out)).toBeCloseTo(1, 6);
    const cosAngle = out.x * base.x + out.y * base.y + out.z * base.z;
    const angle = Math.acos(Math.min(1, Math.max(-1, cosAngle)));
    expect(angle).toBeLessThanOrEqual(0.04 + 1e-9);
  });
});
