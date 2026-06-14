// Roster bookkeeping for the multi-opponent manager. Three.js object creation
// works headless (no WebGLRenderer needed); we only assert the id<->entry map.
import { describe, it, expect } from 'vitest';
import { RemotePlayers } from './remote-players';

describe('RemotePlayers', () => {
  it('shows and hides opponents by id', () => {
    const rp = new RemotePlayers();
    rp.setPresent(2, 'Bob');
    rp.setPresent(3, 'Cara');
    expect(rp.activeIds().sort()).toEqual([2, 3]);

    rp.setAbsent(2);
    expect(rp.activeIds()).toEqual([3]);
  });

  it('pose updates only affect present opponents', () => {
    const rp = new RemotePlayers();
    rp.setPresent(5, 'Eve');
    rp.setPose(5, 1, 2, 3, 0.5);
    rp.setPose(9, 0, 0, 0, 0); // absent id -> ignored, no throw
    expect(rp.activeIds()).toEqual([5]);
  });

  it('liveTargets returns a capsule per present opponent', () => {
    const rp = new RemotePlayers();
    rp.setPresent(2, 'Bob');
    rp.setPose(2, 4, 5, 6, 0);
    const targets = rp.liveTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe(2);
    expect(targets[0].center.x).toBeCloseTo(4);
  });
});
