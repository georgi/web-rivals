// Exercises the REAL Rapier WASM backend (rapier3d-compat runs in Node). Kept
// tolerant: WASM contact points/normals carry small numerical error, so we
// assert directions and rough magnitudes, not exact equality.

import { describe, it, expect } from 'vitest';
import { RapierTraceWorld } from './rapier-traceworld';
import { CRATE_MAP } from '../maps';
import type { TraceWorld } from './traceworld';

// The center platform is box pos [0,1.5,0] size [8,3,8] -> top face at y = 3.
const PLATFORM_TOP_Y = 3;

describe('RapierTraceWorld', () => {
  it('raycast straight down hits the center platform top with an up normal', async () => {
    const world: TraceWorld = await RapierTraceWorld.create(CRATE_MAP.solids);

    const hit = world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 10);
    expect(hit).not.toBeNull();
    if (!hit) return;

    // fraction is (distance travelled)/maxDist; 5 -> 3 over a 10m ray => ~0.2.
    expect(hit.fraction).toBeGreaterThan(0);
    expect(hit.fraction).toBeLessThan(1);
    expect(hit.point.y).toBeCloseTo(PLATFORM_TOP_Y, 1);
    expect(hit.normal.y).toBeGreaterThan(0.9); // pointing up out of the floor
  });

  it('castCapsule sweeping down into the platform returns a hit with fraction < 1', async () => {
    const world: TraceWorld = await RapierTraceWorld.create(CRATE_MAP.solids);

    const hit = world.castCapsule(
      { x: 0, y: 5, z: 0 },
      0.5, // halfHeight
      0.4, // radius
      { x: 0, y: -3, z: 0 }, // delta
    );
    expect(hit).not.toBeNull();
    if (!hit) return;

    expect(hit.fraction).toBeGreaterThanOrEqual(0);
    expect(hit.fraction).toBeLessThan(1);
    // Capsule bottom (center.y - halfHeight - radius) should rest near the top.
    expect(hit.normal.y).toBeGreaterThan(0.5);
  });

  it('castSphere down the void above the floor misses nothing unexpected and a short delta misses', async () => {
    const world: TraceWorld = await RapierTraceWorld.create(CRATE_MAP.solids);

    // From high up, a tiny downward delta should NOT reach the platform.
    const miss = world.castSphere({ x: 0, y: 10, z: 0 }, 0.3, { x: 0, y: -1, z: 0 });
    expect(miss).toBeNull();

    // A long delta should hit.
    const hit = world.castSphere({ x: 0, y: 10, z: 0 }, 0.3, { x: 0, y: -8, z: 0 });
    expect(hit).not.toBeNull();
  });

  it('overlapSphere returns registered entity ids inside the radius and excludes those outside', async () => {
    const world = await RapierTraceWorld.create(CRATE_MAP.solids);

    // Two players standing on the platform top.
    world.registerEntity(1, { x: 0, y: 4, z: 0 }, 0.4, 0.5);
    world.registerEntity(2, { x: 6, y: 4, z: 0 }, 0.4, 0.5);

    const near = world.overlapSphere({ x: 0, y: 4, z: 0 }, 1.0);
    expect(near).toContain(1);
    expect(near).not.toContain(2);

    // Wide radius catches both.
    const wide = world.overlapSphere({ x: 3, y: 4, z: 0 }, 5.0);
    expect(wide).toContain(1);
    expect(wide).toContain(2);

    // After moving entity 2 next to entity 1, both fall inside the small sphere.
    world.updateEntity(2, { x: 0.2, y: 4, z: 0 });
    const afterMove = world.overlapSphere({ x: 0, y: 4, z: 0 }, 1.0);
    expect(afterMove).toContain(1);
    expect(afterMove).toContain(2);

    // overlapSphere must not return static map solids (no fixed-collider ids).
    world.removeEntity(1);
    world.removeEntity(2);
    const empty = world.overlapSphere({ x: 0, y: 4, z: 0 }, 5.0);
    expect(empty).toHaveLength(0);
  });
});
