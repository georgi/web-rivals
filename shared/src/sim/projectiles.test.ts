// Unit tests for projectile stepping + explosion resolution (PRD §24.3, §4, §5)
// against the backend-agnostic MockTraceWorld. No WASM, no Three.js.

import { describe, it, expect } from 'vitest';
import { v3, horizontalLength, length } from '../math';
import type { Solid } from '../geometry';
import { TUNING } from '../tuning';
import { MockTraceWorld } from './mock-traceworld';
import {
  makeProjectile,
  stepProjectile,
  computeExplosion,
  type ProjectileStep,
  type PlayerCapsule,
} from './projectiles';

// 20x1x20 floor slab, top surface at y=0.5.
const FLOOR: Solid = { type: 'box', pos: [0, 0, 0], size: [20, 1, 20] };
// Wall slab: x in [4.5, 5.5], faces -x, spans z in [-5,5], y in [0,4].
const WALL: Solid = { type: 'box', pos: [5, 2, 0], size: [1, 4, 10] };

function freshStep(): ProjectileStep {
  return { detonated: false, point: v3() };
}

describe('stepProjectile — rocket', () => {
  it('detonates on the first step that sweeps into a wall', () => {
    const world = new MockTraceWorld([FLOOR, WALL]);
    // Fired from x=0 at the wall (toward +x), fast enough to reach it in one step.
    const rocket = makeProjectile(1, 'rocket', v3(0, 2, 0), v3(TUNING.rocket.projSpeed, 0, 0), 0, 0);
    const out = freshStep();

    // Step until detonation or runaway.
    let detonated = false;
    for (let i = 0; i < 60 && !detonated; i++) {
      stepProjectile(rocket, world, 1 / 60, out);
      detonated = out.detonated;
    }

    expect(detonated).toBe(true);
    expect(rocket.alive).toBe(false);
    // Wall face (expanded by PROJ_RADIUS) is at x = 4.5 - 0.15 = 4.35.
    expect(out.point.x).toBeCloseTo(4.35, 2);
  });

  it('flies freely (no detonation) over open floor and advances along velocity', () => {
    const world = new MockTraceWorld([FLOOR]);
    const rocket = makeProjectile(1, 'rocket', v3(0, 3, 0), v3(TUNING.rocket.projSpeed, 0, 0), 0, 0);
    const out = freshStep();
    stepProjectile(rocket, world, 1 / 60, out);
    expect(out.detonated).toBe(false);
    expect(rocket.alive).toBe(true);
    expect(rocket.pos.x).toBeCloseTo(TUNING.rocket.projSpeed / 60, 4);
    // Slight gravity pulled velocity down.
    expect(rocket.vel.y).toBeLessThan(0);
  });
});

describe('stepProjectile — grenade', () => {
  it('bounces off a wall: velocity reflects and horizontal speed is reduced', () => {
    const world = new MockTraceWorld([FLOOR, WALL]);
    // Thrown horizontally at the wall (+x), no initial gravity contribution yet.
    const speed = 14;
    const grenade = makeProjectile(2, 'grenade', v3(0, 2, 0), v3(speed, 0, 0), 0, TUNING.grenade.fuse);
    const out = freshStep();

    const beforeVx = grenade.vel.x;
    // Step until it makes contact (vel.x flips sign) without detonating.
    let bounced = false;
    for (let i = 0; i < 60 && !bounced; i++) {
      stepProjectile(grenade, world, 1 / 60, out);
      if (grenade.vel.x < 0) bounced = true;
      expect(out.detonated).toBe(false); // far from fuse expiry, no contact detonation
    }

    expect(bounced).toBe(true);
    // Reflected: now travelling -x.
    expect(grenade.vel.x).toBeLessThan(0);
    // Restitution bled speed: post-bounce horizontal speed below the incoming speed.
    expect(Math.abs(grenade.vel.x)).toBeLessThan(Math.abs(beforeVx));
    expect(Math.abs(grenade.vel.x)).toBeCloseTo(Math.abs(beforeVx) * TUNING.grenade.restitution, 1);
  });

  it('detonates in place when the fuse expires', () => {
    const world = new MockTraceWorld([FLOOR]);
    const dt = 0.02;
    const grenade = makeProjectile(2, 'grenade', v3(0, 5, 0), v3(0, 0, 0), 0, 0.05);
    const out = freshStep();

    let detonated = false;
    let steps = 0;
    while (!detonated && steps < 30) {
      stepProjectile(grenade, world, dt, out);
      steps++;
      detonated = out.detonated;
    }
    expect(detonated).toBe(true);
    expect(grenade.alive).toBe(false);
    // 0.05s fuse at dt=0.02: fuse hits 0.01, then -0.01 on the 3rd step.
    expect(steps).toBe(3);
  });

  it('settles flat: tiny horizontal residual after a bounce is zeroed', () => {
    const world = new MockTraceWorld([FLOOR]);
    // Drop nearly straight down with a sliver of horizontal speed onto the floor.
    const grenade = makeProjectile(2, 'grenade', v3(0, 1.2, 0), v3(0.2, -3, 0), 0, TUNING.grenade.fuse);
    const out = freshStep();
    for (let i = 0; i < 10; i++) {
      stepProjectile(grenade, world, 1 / 60, out);
      if (grenade.vel.y >= 0) break; // bounced upward off the floor
    }
    // After the floor bounce reflected vy upward, horizontal residual (<0.5) is killed.
    expect(horizontalLength(grenade.vel)).toBe(0);
  });
});

describe('computeExplosion — falloff', () => {
  const NO_GEO = new MockTraceWorld([]); // open space: LOS always clear

  it('a closer player takes more splash damage than a farther one', () => {
    const center = v3(0, 1, 0);
    const near: PlayerCapsule = { id: 10, center: v3(1, 1, 0), radius: 0.4, halfHeight: 0.9 };
    const far: PlayerCapsule = { id: 11, center: v3(2.5, 1, 0), radius: 0.4, halfHeight: 0.9 };
    const hits = computeExplosion('rocket', center, 99, [near, far], NO_GEO);

    const nearHit = hits.find((h) => h.id === 10)!;
    const farHit = hits.find((h) => h.id === 11)!;
    expect(nearHit).toBeTruthy();
    expect(farHit).toBeTruthy();
    expect(nearHit.damage).toBeGreaterThan(farHit.damage);
    // And closer => bigger knockback magnitude.
    expect(length(nearHit.impulse)).toBeGreaterThan(length(farHit.impulse));
  });

  it('a player outside the splash radius is not in the result', () => {
    const center = v3(0, 1, 0);
    const outside: PlayerCapsule = {
      id: 12,
      center: v3(TUNING.rocket.splashRadius + 2, 1, 0),
      radius: 0.4,
      halfHeight: 0.9,
    };
    const hits = computeExplosion('rocket', center, 99, [outside], NO_GEO);
    expect(hits.find((h) => h.id === 12)).toBeUndefined();
  });

  it('rocket direct hit adds directDamage on top of splash', () => {
    const center = v3(0, 1, 0);
    const victim: PlayerCapsule = { id: 10, center: v3(1, 1, 0), radius: 0.4, halfHeight: 0.9 };
    const withDirect = computeExplosion('rocket', center, 99, [victim], NO_GEO, 10);
    const splashOnly = computeExplosion('rocket', center, 99, [victim], NO_GEO);
    expect(withDirect[0].damage - splashOnly[0].damage).toBeCloseTo(TUNING.rocket.directDamage, 0);
  });
});

describe('computeExplosion — self damage vs knockback', () => {
  const NO_GEO = new MockTraceWorld([]);

  it('owner takes selfDamageScale damage but the same knockback as a non-owner at equal distance', () => {
    const center = v3(0, 1, 0);
    // Owner and a stranger at mirror-image positions => equal distance from center.
    const owner: PlayerCapsule = { id: 7, center: v3(1, 1, 0), radius: 0.4, halfHeight: 0.9 };
    const stranger: PlayerCapsule = { id: 8, center: v3(-1, 1, 0), radius: 0.4, halfHeight: 0.9 };
    const hits = computeExplosion('rocket', center, 7, [owner, stranger], NO_GEO);

    const ownerHit = hits.find((h) => h.id === 7)!;
    const strangerHit = hits.find((h) => h.id === 8)!;

    // Same magnitude knockback (selfKnockbackScale is 1.0).
    expect(length(ownerHit.impulse)).toBeCloseTo(length(strangerHit.impulse), 5);
    // Owner damage is the scaled fraction of the stranger's.
    expect(ownerHit.damage).toBeCloseTo(
      Math.round(strangerHit.damage * TUNING.rocket.selfDamageScale),
      0,
    );
    expect(ownerHit.damage).toBeLessThan(strangerHit.damage);
  });
});

describe('computeExplosion — line of sight', () => {
  it('a wall between blast and player blocks damage but knockback still applies', () => {
    // Blast on the -x side of the wall; player on the +x side, within splash radius.
    const world = new MockTraceWorld([WALL]); // wall spans x in [4.5,5.5]
    const center = v3(4.0, 2, 0);
    const shielded: PlayerCapsule = { id: 20, center: v3(6.0, 2, 0), radius: 0.4, halfHeight: 0.9 };

    const hits = computeExplosion('rocket', center, 99, [shielded], world);
    const hit = hits.find((h) => h.id === 20);
    expect(hit).toBeTruthy();
    // Damage nulled by the wall...
    expect(hit!.damage).toBe(0);
    // ...but the player is still pushed (boost tech stays forgiving, §24.3).
    expect(length(hit!.impulse)).toBeGreaterThan(0);
  });

  it('with clear LOS the same geometry-free blast deals damage', () => {
    const world = new MockTraceWorld([]); // no wall
    const center = v3(4.0, 2, 0);
    const player: PlayerCapsule = { id: 20, center: v3(6.0, 2, 0), radius: 0.4, halfHeight: 0.9 };
    const hits = computeExplosion('rocket', center, 99, [player], world);
    expect(hits[0].damage).toBeGreaterThan(0);
  });
});
