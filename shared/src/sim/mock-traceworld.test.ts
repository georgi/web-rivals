// Unit tests for the hand-coded MockTraceWorld (PRD §24.5). Correctness for
// axis-aligned cases is what matters here; the Minkowski-expanded swept-point
// approach is exact for those faces.

import { describe, it, expect } from 'vitest';
import { v3, normalize } from '../math';
import type { Solid } from '../geometry';
import { MockTraceWorld } from './mock-traceworld';

// A 20x1x20 floor slab centred at the origin, top surface at y=0.5.
const FLOOR: Solid = { type: 'box', pos: [0, 0, 0], size: [20, 1, 20] };

// A wall: thin slab spanning x in [4.5, 5.5], tall, facing -x.
const WALL: Solid = { type: 'box', pos: [5, 2, 0], size: [1, 4, 10] };

function downDir() {
  const d = v3();
  normalize(d, v3(0, -1, 0));
  return d;
}

describe('MockTraceWorld.raycast', () => {
  it('ray straight down hits a floor box with normal.y ~ 1', () => {
    const world = new MockTraceWorld([FLOOR]);
    const hit = world.raycast(v3(0, 5, 0), downDir(), 100);
    expect(hit).not.toBeNull();
    // top of the slab is at y = 0.5; ray from y=5 travels 4.5m.
    expect(hit!.point.y).toBeCloseTo(0.5, 5);
    expect(hit!.normal.y).toBeCloseTo(1, 5);
    expect(hit!.fraction).toBeCloseTo(4.5 / 100, 5);
  });

  it('returns null when the ray points away from everything', () => {
    const world = new MockTraceWorld([FLOOR]);
    const up = v3();
    normalize(up, v3(0, 1, 0));
    const hit = world.raycast(v3(0, 5, 0), up, 100);
    expect(hit).toBeNull();
  });
});

describe('MockTraceWorld.castCapsule', () => {
  const radius = 0.4;
  const halfHeight = 0.9; // standHeight 1.8 -> half 0.9

  it('capsule swept down onto a floor box stops at the surface (fraction<1, normal.y~1)', () => {
    const world = new MockTraceWorld([FLOOR]);
    // Capsule centre starts at y=3, sweeps down 5m. Floor top is y=0.5, so the
    // capsule bottom (centre - halfHeight) rests when centre = 0.5 + halfHeight.
    const from = v3(0, 3, 0);
    const delta = v3(0, -5, 0);
    const hit = world.castCapsule(from, halfHeight, radius, delta);
    expect(hit).not.toBeNull();
    expect(hit!.fraction).toBeGreaterThan(0);
    expect(hit!.fraction).toBeLessThan(1);
    expect(hit!.normal.y).toBeCloseTo(1, 5);
    // Centre should stop at floorTop + halfHeight (+ radius for the capsule cap).
    const expectedCentreY = 0.5 + halfHeight + radius;
    expect(hit!.point.y).toBeCloseTo(expectedCentreY, 4);
  });

  it('capsule swept horizontally into a wall box stops with a horizontal normal', () => {
    const world = new MockTraceWorld([WALL]);
    // Approach the wall (face at x=4.5) from x=0 at capsule centre height.
    const from = v3(0, 2, 0);
    const delta = v3(10, 0, 0);
    const hit = world.castCapsule(from, halfHeight, radius, delta);
    expect(hit).not.toBeNull();
    expect(hit!.fraction).toBeGreaterThan(0);
    expect(hit!.fraction).toBeLessThan(1);
    // Wall -x face at x=4.5, expanded by radius -> contact centre at x=4.1.
    expect(hit!.point.x).toBeCloseTo(4.5 - radius, 4);
    expect(Math.abs(hit!.normal.x)).toBeCloseTo(1, 5);
    expect(hit!.normal.y).toBeCloseTo(0, 5);
    expect(hit!.normal.x).toBeLessThan(0); // pointing back toward the capsule (-x)
  });

  it('capsule resting just above ground still registers a hit when delta crosses the surface', () => {
    const world = new MockTraceWorld([FLOOR]);
    // Centre rests exactly on the surface; a small downward probe should hit
    // near-immediately (fraction ~ 0) because the surface is right there.
    const restY = 0.5 + halfHeight + radius;
    const from = v3(0, restY + 0.01, 0);
    const delta = v3(0, -0.1, 0);
    const hit = world.castCapsule(from, halfHeight, radius, delta);
    expect(hit).not.toBeNull();
    expect(hit!.normal.y).toBeCloseTo(1, 5);
    expect(hit!.fraction).toBeGreaterThanOrEqual(0);
    expect(hit!.fraction).toBeLessThan(1);
  });

  it('returns null when no obstacle lies within delta', () => {
    const world = new MockTraceWorld([FLOOR]);
    // Floor top is y=0.5; capsule contact happens at centre y=1.8. Start at y=5
    // and only probe down 1m -> never reaches contact.
    const from = v3(0, 5, 0);
    const delta = v3(0, -1, 0);
    const hit = world.castCapsule(from, halfHeight, radius, delta);
    expect(hit).toBeNull();
  });
});

describe('MockTraceWorld.castCapsule on a ramp', () => {
  const radius = 0.4;
  const halfHeight = 0.9;

  it('lands on the ramp slope with the ramp normal', () => {
    // Ramp ascends toward +x, footprint x in [0,4], z in [-2,2], height 0..2.
    const ramp: Solid = { type: 'ramp', pos: [2, 1, 0], size: [4, 2, 4], dir: '+x' };
    const world = new MockTraceWorld([ramp]);
    // Drop straight down onto the middle of the slope.
    const from = v3(2, 5, 0);
    const delta = v3(0, -6, 0);
    const hit = world.castCapsule(from, halfHeight, radius, delta);
    expect(hit).not.toBeNull();
    // Slope normal points up and toward -x (the toe side).
    expect(hit!.normal.y).toBeGreaterThan(0.5);
    expect(hit!.normal.x).toBeLessThan(0);
    expect(hit!.fraction).toBeGreaterThan(0);
    expect(hit!.fraction).toBeLessThan(1);
  });
});

describe('MockTraceWorld.overlapSphere', () => {
  it('returns an entity within radius and not one outside', () => {
    const world = new MockTraceWorld([]);
    world.registerEntity({ id: 1, center: v3(0, 1, 0), radius: 0.4, halfHeight: 0.9 });
    world.registerEntity({ id: 2, center: v3(10, 1, 0), radius: 0.4, halfHeight: 0.9 });

    // Explosion at the origin with radius 2 reaches entity 1 (centre 0.4m away
    // surface) but not entity 2 (9.6m away surface).
    const ids = world.overlapSphere(v3(0, 1, 0), 2);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
  });

  it('respects the capsule vertical extent (hits above/below the centre)', () => {
    const world = new MockTraceWorld([]);
    // Tall capsule: centre y=2, halfHeight 1.5 -> core spans y in [0.5, 3.5].
    world.registerEntity({ id: 7, center: v3(0, 2, 0), radius: 0.4, halfHeight: 1.5 });
    // Sphere near the top of the capsule core.
    const ids = world.overlapSphere(v3(0.5, 3.4, 0), 0.3);
    expect(ids).toContain(7);
  });

  it('clearEntities removes all registered entities', () => {
    const world = new MockTraceWorld([]);
    world.registerEntity({ id: 1, center: v3(0, 1, 0), radius: 0.4, halfHeight: 0.9 });
    world.clearEntities();
    expect(world.overlapSphere(v3(0, 1, 0), 5)).toHaveLength(0);
  });
});

describe('MockTraceWorld.castSphere', () => {
  it('sphere swept down onto a floor box stops at floorTop + radius', () => {
    const world = new MockTraceWorld([FLOOR]);
    const radius = 0.3;
    const from = v3(0, 5, 0);
    const delta = v3(0, -10, 0);
    const hit = world.castSphere(from, radius, delta);
    expect(hit).not.toBeNull();
    expect(hit!.point.y).toBeCloseTo(0.5 + radius, 4);
    expect(hit!.normal.y).toBeCloseTo(1, 5);
  });
});
