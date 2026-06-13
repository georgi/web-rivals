// Regression for "cannot walk up ramps" (sprint deadlock on slope contact).
// MUST use the real Rapier backend: the deadlock comes from castShape reporting
// time_of_impact 0 for motion tangent to a surface the capsule already rests on.
// MockTraceWorld returns null for tangent sweeps, so it cannot reproduce this.
import { describe, it, expect } from 'vitest';
import { RapierTraceWorld } from './rapier-traceworld';
import { CRATE_MAP } from '../maps';
import {
  createMoveState,
  stepMovement,
  newEvents,
  standHalf,
  type PlayerMoveState,
} from './movement';
import { TUNING, SIM_DT } from '../tuning';
import { Button } from '../protocol';

const r = TUNING.movement.radius;
const feet = (s: PlayerMoveState) => s.pos.y - (s.capsuleHalf + r);

describe('ramp climbing vs the real Rapier colliders', () => {
  it('sprints up each cardinal ramp onto the y=3 high ground', async () => {
    const world = await RapierTraceWorld.create(CRATE_MAP.solids);
    const fy = r + standHalf();
    const cases = [
      { name: '-z', start: { x: 0, y: fy, z: 9 }, yawDeg: 0 },
      { name: '+z', start: { x: 0, y: fy, z: -9 }, yawDeg: 180 },
      { name: '-x', start: { x: 8.9, y: fy, z: 0 }, yawDeg: 90 },
      { name: '+x', start: { x: -8.9, y: fy, z: 0 }, yawDeg: -90 },
    ];
    for (const c of cases) {
      const s = createMoveState(c.start, c.yawDeg);
      const ev = newEvents();
      const yaw = (c.yawDeg * Math.PI) / 180;
      // settle onto the floor
      for (let i = 0; i < 40; i++)
        stepMovement(s, { buttons: 0, yaw, pitch: 0, jump: false }, world, SIM_DT, ev);
      // sprint forward into and up the ramp; track the PEAK height reached (a
      // fast approach climbs then launches off the top, so final pos is low).
      const buttons = Button.Forward | Button.Sprint;
      let peak = feet(s);
      for (let i = 0; i < 150; i++) {
        stepMovement(s, { buttons, yaw, pitch: 0, jump: false }, world, SIM_DT, ev);
        peak = Math.max(peak, feet(s));
      }
      // Should have climbed near the platform top (y=3), not stalled on the slope.
      expect(peak, `ramp ${c.name} peak feet height`).toBeGreaterThan(2.5);
    }
  });

  it('still walks up a ramp (no regression at walk speed)', async () => {
    const world = await RapierTraceWorld.create(CRATE_MAP.solids);
    const s = createMoveState({ x: 0, y: r + standHalf(), z: 9 }, 0);
    const ev = newEvents();
    for (let i = 0; i < 40; i++)
      stepMovement(s, { buttons: 0, yaw: 0, pitch: 0, jump: false }, world, SIM_DT, ev);
    let peak = feet(s);
    for (let i = 0; i < 180; i++) {
      stepMovement(s, { buttons: Button.Forward, yaw: 0, pitch: 0, jump: false }, world, SIM_DT, ev);
      peak = Math.max(peak, feet(s));
    }
    expect(peak).toBeGreaterThan(2.5);
  });
});
