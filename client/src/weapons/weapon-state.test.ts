// Weapons state-machine tests (pure logic, node, no THREE). Verifies fire
// discipline (full-auto vs semi), reload economy, switch blocking, grenade
// regen, and the empty-clip gate. All timings derive from TUNING.

import { describe, it, expect } from 'vitest';
import { TUNING } from '@rivals/shared';
import { Weapons } from './weapon-state';

const AR = TUNING.ar;
const ROCKET = TUNING.rocket;
const NADE = TUNING.grenade;
const SWITCH = TUNING.combat.switchTime;

// Advance time in small steps so per-shot cadence is resolved like the real loop.
function advance(w: Weapons, seconds: number, step = 1 / 240): void {
  let t = 0;
  while (t < seconds - 1e-9) {
    const dt = Math.min(step, seconds - t);
    w.update(dt);
    t += dt;
  }
}

describe('Weapons fire discipline', () => {
  it('AR is full-auto: keeps firing while held, respecting fireInterval', () => {
    const w = new Weapons();
    advance(w, SWITCH); // not needed at start (current===1, no switch block) but harmless

    // First shot fires immediately (starts ready).
    expect(w.tryFire(true)).toBe(true);
    // Held within the interval -> no shot yet.
    advance(w, AR.fireInterval * 0.5);
    expect(w.tryFire(true)).toBe(false);
    // After the interval elapses, it fires again on a still-held trigger.
    advance(w, AR.fireInterval * 0.6);
    expect(w.tryFire(true)).toBe(true);

    // Count shots over 1s of continuous hold: ~ 1/fireInterval.
    let shots = 0;
    for (let i = 0; i < 1000; i++) {
      if (w.tryFire(true)) shots++;
      advance(w, 1 / 1000);
    }
    const expected = 1 / AR.fireInterval;
    expect(shots).toBeGreaterThanOrEqual(expected - 2);
    expect(shots).toBeLessThanOrEqual(expected + 2);
  });

  it('rocket is semi: one shot per press, not per hold', () => {
    const w = new Weapons();
    w.select(2);
    advance(w, SWITCH); // clear the switch block

    // Establish a low edge, then a rising edge fires.
    expect(w.tryFire(false)).toBe(false);
    expect(w.tryFire(true)).toBe(true);
    // Still held, even long after cooldown -> no second shot without a release.
    advance(w, ROCKET.fireInterval * 2);
    expect(w.tryFire(true)).toBe(false);
    // Release then press again -> fires.
    expect(w.tryFire(false)).toBe(false);
    expect(w.tryFire(true)).toBe(true);
  });

  it('rocket semi still honours fireInterval between presses', () => {
    const w = new Weapons();
    w.select(2);
    advance(w, SWITCH);

    expect(w.tryFire(false)).toBe(false);
    expect(w.tryFire(true)).toBe(true);
    // Release + press again immediately (rising edge) but cooldown not elapsed.
    expect(w.tryFire(false)).toBe(false);
    expect(w.tryFire(true)).toBe(false);
    // Wait out the interval, press again.
    advance(w, ROCKET.fireInterval);
    expect(w.tryFire(false)).toBe(false);
    expect(w.tryFire(true)).toBe(true);
  });
});

describe('Weapons reload', () => {
  it('refills clip from reserve after reloadTime', () => {
    const w = new Weapons();
    advance(w, SWITCH);

    // Fire a few rounds.
    for (let i = 0; i < 5; i++) {
      expect(w.tryFire(true)).toBe(true);
      advance(w, AR.fireInterval);
    }
    expect(w.ammo(1).clip).toBe(AR.magSize - 5);
    const reserveBefore = w.ammo(1).reserve;

    w.startReload();
    expect(w.reloading).toBe(true);
    // Not done yet just before reloadTime.
    advance(w, AR.reloadTime * 0.9);
    expect(w.reloading).toBe(true);
    expect(w.ammo(1).clip).toBe(AR.magSize - 5);
    // Done after reloadTime.
    advance(w, AR.reloadTime * 0.2);
    expect(w.reloading).toBe(false);
    expect(w.ammo(1).clip).toBe(AR.magSize);
    expect(w.ammo(1).reserve).toBe(reserveBefore - 5);
  });

  it('cannot fire while reloading', () => {
    const w = new Weapons();
    advance(w, SWITCH);
    expect(w.tryFire(true)).toBe(true);
    advance(w, AR.fireInterval);
    w.startReload();
    expect(w.tryFire(true)).toBe(false);
  });

  it('startReload is a no-op on a full clip', () => {
    const w = new Weapons();
    w.startReload();
    expect(w.reloading).toBe(false);
  });
});

describe('Weapons switching', () => {
  it('blocks fire for switchTime after select', () => {
    const w = new Weapons();
    advance(w, SWITCH); // settle slot 1
    expect(w.tryFire(true)).toBe(true);
    expect(w.tryFire(false)).toBe(false);

    w.select(2);
    expect(w.switching).toBe(true);
    // Cannot fire during the switch block.
    expect(w.tryFire(true)).toBe(false);
    advance(w, SWITCH * 0.5);
    expect(w.tryFire(true)).toBe(false);
    // After the block, the (semi) rocket fires on a rising edge.
    advance(w, SWITCH * 0.6);
    expect(w.switching).toBe(false);
    expect(w.tryFire(false)).toBe(false); // establish low edge
    expect(w.tryFire(true)).toBe(true);
  });
});

describe('Weapons grenade', () => {
  it('throws one then regenerates after regenTime', () => {
    const w = new Weapons();
    w.select(4);
    advance(w, SWITCH);

    expect(w.ammo(4).clip).toBe(NADE.count);
    // Throw it (low edge then rising edge).
    expect(w.tryFire(false)).toBe(false);
    expect(w.tryFire(true)).toBe(true);
    expect(w.ammo(4).clip).toBe(NADE.count - 1);
    // Out of grenades: another press does nothing.
    expect(w.tryFire(false)).toBe(false);
    expect(w.tryFire(true)).toBe(false);

    // Not back before regenTime.
    advance(w, NADE.regenTime * 0.9);
    expect(w.ammo(4).clip).toBe(NADE.count - 1);
    // Back after regenTime.
    advance(w, NADE.regenTime * 0.2);
    expect(w.ammo(4).clip).toBe(NADE.count);
    // Can throw again.
    expect(w.tryFire(false)).toBe(false);
    expect(w.tryFire(true)).toBe(true);
  });

  it('grenade reports clip=count, reserve=0', () => {
    const w = new Weapons();
    expect(w.ammo(4)).toEqual({ clip: NADE.count, reserve: 0 });
  });
});

describe('Weapons empty clip', () => {
  it('tryFire is false when the clip is empty', () => {
    const w = new Weapons();
    w.select(2); // rocket: small mag, easy to empty
    advance(w, SWITCH);

    let fired = 0;
    for (let i = 0; i < ROCKET.magSize; i++) {
      expect(w.tryFire(false)).toBe(false); // low edge
      expect(w.tryFire(true)).toBe(true);
      fired++;
      advance(w, ROCKET.fireInterval);
    }
    expect(fired).toBe(ROCKET.magSize);
    expect(w.ammo(2).clip).toBe(0);
    // Clip empty -> no fire even with a fresh rising edge.
    expect(w.tryFire(false)).toBe(false);
    expect(w.tryFire(true)).toBe(false);
  });
});

describe('Weapons knife', () => {
  it('knifeOut reflects current slot 3 and swings on edge after swingTime', () => {
    const w = new Weapons();
    expect(w.knifeOut).toBe(false);
    w.select(3);
    expect(w.knifeOut).toBe(true);
    advance(w, SWITCH);

    // No ammo gate: swings on rising edge.
    expect(w.tryFire(false)).toBe(false);
    expect(w.tryFire(true)).toBe(true);
    // Held -> no auto-swing.
    expect(w.tryFire(true)).toBe(false);
    // Needs swingTime before the next swing.
    expect(w.tryFire(false)).toBe(false);
    expect(w.tryFire(true)).toBe(false);
    advance(w, TUNING.knife.swingTime);
    expect(w.tryFire(false)).toBe(false);
    expect(w.tryFire(true)).toBe(true);
  });
});
