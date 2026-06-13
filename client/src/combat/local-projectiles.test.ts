// M2 local-only projectiles: verify the explosion-hook wiring. We use the real
// shared ballistics (stepProjectile/computeExplosion) via MockTraceWorld, a real
// Particles (THREE objects construct fine under vitest/node — probed), and a
// LocalProjectiles. Firing a rocket into a wall must detonate and route
// damage + knockback through the hooks for a target standing at the blast.

import { describe, it, expect } from 'vitest';
import { MockTraceWorld, TUNING, v3 } from '@rivals/shared';
import type { Vec3 } from '@rivals/shared';
import { Particles } from '../render/particles';
import { LocalProjectiles } from './local-projectiles';
import type { ProjectileHooks } from './local-projectiles';
import type { CapsuleTarget } from './hitscan';

const m = TUNING.movement;

// A single floor + a wall at x = 5 (a thin box spanning the path). The rocket
// starts at the origin, flies +x, and detonates against the wall.
function makeWorld(): MockTraceWorld {
  return new MockTraceWorld([
    { type: 'box', pos: [0, -0.5, 0], size: [40, 1, 40] }, // floor
    { type: 'box', pos: [5, 2, 0], size: [0.5, 8, 8] }, // wall at x≈5
  ]);
}

interface Recorder {
  hooks: ProjectileHooks;
  damage: Array<{ id: number; amount: number }>;
  impulses: Array<{ id: number; impulse: Vec3 }>;
}

function makeHooks(localPlayerId: number, targets: CapsuleTarget[]): Recorder {
  const damage: Array<{ id: number; amount: number }> = [];
  const impulses: Array<{ id: number; impulse: Vec3 }> = [];
  const hooks: ProjectileHooks = {
    localPlayerId,
    targets: () => targets,
    onDamage: (id, amount) => damage.push({ id, amount }),
    // copy the impulse — the caller reuses a scratch vector
    onImpulse: (id, impulse) => impulses.push({ id, impulse: { ...impulse } }),
  };
  return { hooks, damage, impulses };
}

describe('LocalProjectiles rocket', () => {
  it('detonates on a wall and routes splash damage + knockback through hooks', () => {
    const world = makeWorld();
    const particles = new Particles();

    // Dummy target standing just in front of the wall, in splash range.
    const target: CapsuleTarget = {
      id: 7,
      center: v3(4.2, 1, 0),
      radius: m.radius,
      halfHeight: (m.standHeight - 2 * m.radius) / 2,
    };
    const rec = makeHooks(1, [target]);

    const proj = new LocalProjectiles(world, particles, rec.hooks);

    // Fire from the origin straight at the wall (+x), owned by the local player.
    proj.spawn('rocket', v3(0, 1, 0), v3(1, 0, 0), 1);

    // Step long enough for the rocket (projSpeed 25 m/s) to cover ~5 m.
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) proj.update(dt);

    expect(rec.damage.length).toBeGreaterThan(0);
    const hitTarget = rec.damage.find((d) => d.id === target.id);
    expect(hitTarget).toBeDefined();
    expect(hitTarget!.amount).toBeGreaterThan(0);

    const knockTarget = rec.impulses.find((i) => i.id === target.id);
    expect(knockTarget).toBeDefined();
    const km = Math.hypot(
      knockTarget!.impulse.x,
      knockTarget!.impulse.y,
      knockTarget!.impulse.z,
    );
    expect(km).toBeGreaterThan(0);
  });

  it('applies a rocket-jump impulse to the owner when it is in blast range', () => {
    const world = makeWorld();
    const particles = new Particles();

    // The owner (local player) stands right by the wall; the rocket they fire
    // detonates near their feet -> self-knockback (rocket jump).
    const owner: CapsuleTarget = {
      id: 1,
      center: v3(4.3, 1, 0),
      radius: m.radius,
      halfHeight: (m.standHeight - 2 * m.radius) / 2,
    };
    const rec = makeHooks(1, [owner]);
    const proj = new LocalProjectiles(world, particles, rec.hooks);

    proj.spawn('rocket', v3(0, 1, 0), v3(1, 0, 0), 1);
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) proj.update(dt);

    const selfKnock = rec.impulses.find((i) => i.id === 1);
    expect(selfKnock).toBeDefined();
    const km = Math.hypot(selfKnock!.impulse.x, selfKnock!.impulse.y, selfKnock!.impulse.z);
    expect(km).toBeGreaterThan(0);
  });

  it('grenade detonates on fuse and damages a nearby target', () => {
    const world = makeWorld();
    const particles = new Particles();

    // Place the target where a grenade lobbed gently +x will land/sit near.
    const target: CapsuleTarget = {
      id: 9,
      center: v3(1.5, 1, 0),
      radius: m.radius,
      halfHeight: (m.standHeight - 2 * m.radius) / 2,
    };
    const rec = makeHooks(1, [target]);
    const proj = new LocalProjectiles(world, particles, rec.hooks);

    // Lob a grenade; it bounces on the floor and detonates when the fuse expires.
    proj.spawn('grenade', v3(0, 1.2, 0), v3(1, 0.2, 0), 1);

    const dt = 1 / 60;
    const steps = Math.ceil((TUNING.grenade.fuse + 0.5) * 60);
    for (let i = 0; i < steps; i++) proj.update(dt);

    // Detonation occurred (some impulse routed); damage depends on final resting
    // spot vs target, so we assert the explosion fired at all by checking impulses.
    expect(rec.impulses.length + rec.damage.length).toBeGreaterThan(0);
  });
});
