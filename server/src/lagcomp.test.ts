import { describe, it, expect } from 'vitest';
import type { Vec3 } from '@rivals/shared';
import { LagComp } from './lagcomp';

// Player capsule used throughout: radius 0.4, total height 1.8 -> halfHeight 0.9.
const RADIUS = 0.4;
const HALF = 0.9;

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

describe('LagComp', () => {
  it('rewinds to a past position: hits where the player WAS, misses where they ARE', () => {
    const lc = new LagComp();
    const victim = 2;

    // Victim walks along +x. center.y = 1.0 (feet at ~0.1, head ~1.9).
    // t=0ms   -> x=0
    // t=50ms  -> x=2
    // t=100ms -> x=4
    lc.record(victim, v(0, 1, 0), RADIUS, HALF, 0);
    lc.record(victim, v(2, 1, 0), RADIUS, HALF, 50);
    lc.record(victim, v(4, 1, 0), RADIUS, HALF, 100);

    // Shooter at z=-10 looking straight down +z. The ray sits on the x=0 line,
    // so it only intersects the capsule while the victim is near x=0.
    const origin = v(0, 1, -10);
    const dir = v(0, 0, 1);
    const maxDist = 50;
    const shooter = 1;

    // Rewound to t=0 the victim was at x=0 -> HIT, ~10m away.
    const past = lc.rewindRay(shooter, origin, dir, maxDist, 0);
    expect(past).not.toBeNull();
    expect(past!.id).toBe(victim);
    expect(past!.distance).toBeCloseTo(10 - RADIUS, 1);

    // At "now" (t=100) the victim is at x=4, far off the x=0 ray -> MISS.
    const present = lc.rewindRay(shooter, origin, dir, maxDist, 100);
    expect(present).toBeNull();
  });

  it('interpolates between bracketing samples', () => {
    const lc = new LagComp();
    const victim = 7;
    lc.record(victim, v(0, 1, 0), RADIUS, HALF, 0);
    lc.record(victim, v(4, 1, 0), RADIUS, HALF, 100);

    // At t=50 the victim is interpolated to x=2 -> a ray on x=2 hits.
    const onPath = lc.rewindRay(victim + 1, v(2, 1, -10), v(0, 0, 1), 50, 50);
    expect(onPath).not.toBeNull();
    expect(onPath!.id).toBe(victim);

    // A ray on x=0 at t=50 should MISS (player is now at x=2, capsule r=0.4).
    const offPath = lc.rewindRay(victim + 1, v(0, 1, -10), v(0, 0, 1), 50, 50);
    expect(offPath).toBeNull();
  });

  it('clamps to the nearest sample when t is outside the buffer', () => {
    const lc = new LagComp();
    const victim = 3;
    lc.record(victim, v(0, 1, 0), RADIUS, HALF, 100);
    lc.record(victim, v(4, 1, 0), RADIUS, HALF, 200);

    // t far in the past -> clamp to oldest (x=0): ray on x=0 hits.
    const old = lc.rewindRay(victim + 1, v(0, 1, -10), v(0, 0, 1), 50, -1000);
    expect(old).not.toBeNull();
    expect(old!.id).toBe(victim);

    // t far in the future -> clamp to newest (x=4): ray on x=4 hits, x=0 misses.
    const future = lc.rewindRay(victim + 1, v(4, 1, -10), v(0, 0, 1), 50, 99999);
    expect(future).not.toBeNull();
    const futureMiss = lc.rewindRay(victim + 1, v(0, 1, -10), v(0, 0, 1), 50, 99999);
    expect(futureMiss).toBeNull();
  });

  it('excludes the shooter from its own ray', () => {
    const lc = new LagComp();
    const shooter = 5;
    // Shooter records itself sitting at x=0. A ray straight through x=0 would hit
    // a capsule there, but the shooter must be excluded from its own rewind.
    lc.record(shooter, v(0, 1, 0), RADIUS, HALF, 0);
    lc.record(shooter, v(0, 1, 0), RADIUS, HALF, 50);

    const selfHit = lc.rewindRay(shooter, v(0, 1, -10), v(0, 0, 1), 50, 25);
    expect(selfHit).toBeNull();
  });

  it('returns the nearest player when the ray passes through several', () => {
    const lc = new LagComp();
    // Two victims on the x=0 line at different z, both static across the window.
    const near = 10;
    const far = 11;
    lc.record(near, v(0, 1, 0), RADIUS, HALF, 0);
    lc.record(near, v(0, 1, 0), RADIUS, HALF, 100);
    lc.record(far, v(0, 1, 5), RADIUS, HALF, 0);
    lc.record(far, v(0, 1, 5), RADIUS, HALF, 100);

    // Ray from z=-10 down +z passes through `near` (z=0) before `far` (z=5).
    const hit = lc.rewindRay(1, v(0, 1, -10), v(0, 0, 1), 50, 50);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe(near);
    expect(hit!.distance).toBeCloseTo(10 - RADIUS, 1);
  });

  it('evicts samples older than the history window', () => {
    const lc = new LagComp();
    const victim = 9;
    // Feed samples at a realistic ~33ms (30Hz) cadence. The victim sits at x=0
    // early in the window, then jumps to x=4 once the buffer has scrolled past it.
    // 0..200ms at x=0, 233..500ms at x=4. With a 250ms window, by now=500 the
    // last surviving x=0 sample is no longer reachable for a t=0 query.
    for (let now = 0; now <= 200; now += 33) {
      lc.record(victim, v(0, 1, 0), RADIUS, HALF, now);
    }
    for (let now = 233; now <= 500; now += 33) {
      lc.record(victim, v(4, 1, 0), RADIUS, HALF, now);
    }

    // Rewinding to the long-evicted t=0 clamps to the OLDEST *surviving* sample
    // (x=4 by now), so a ray on the old x=0 line misses.
    const stale = lc.rewindRay(1, v(0, 1, -10), v(0, 0, 1), 50, 0);
    expect(stale).toBeNull();

    // And the current x=4 position still hits.
    const live = lc.rewindRay(1, v(4, 1, -10), v(0, 0, 1), 50, 500);
    expect(live).not.toBeNull();
    expect(live!.id).toBe(victim);
  });

  it('drops a removed player', () => {
    const lc = new LagComp();
    const victim = 4;
    lc.record(victim, v(0, 1, 0), RADIUS, HALF, 0);
    lc.record(victim, v(0, 1, 0), RADIUS, HALF, 50);

    expect(lc.rewindRay(1, v(0, 1, -10), v(0, 0, 1), 50, 25)).not.toBeNull();
    lc.remove(victim);
    expect(lc.rewindRay(1, v(0, 1, -10), v(0, 0, 1), 50, 25)).toBeNull();
  });
});
