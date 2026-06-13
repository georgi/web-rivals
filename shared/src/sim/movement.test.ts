// stepMovement feel tests (PRD §4, §24.2) against MockTraceWorld. The world is a
// single large floor box whose TOP is at y=0; walls/ceilings added per test.

import { describe, it, expect } from 'vitest';
import type { Solid } from '../geometry';
import { TUNING, SIM_DT } from '../tuning';
import { Button } from '../protocol';
import { MockTraceWorld } from './mock-traceworld';
import {
  stepMovement,
  createMoveState,
  newEvents,
  applyImpulse,
  horizontalSpeed,
  standHalf,
  slideHalf,
  type PlayerMoveState,
  type InputFrame,
  type MoveEvents,
} from './movement';

const M = TUNING.movement;

// Floor: a big box 200x10x200 centered so its TOP face sits at y=0.
function floor(): Solid {
  return { type: 'box', pos: [0, -5, 0], size: [200, 10, 200] };
}

// A capsule resting on the floor has its center at feet + (half + radius).
function groundedCenterY(half = standHalf()): number {
  return half + M.radius;
}

function input(partial: Partial<InputFrame> = {}): InputFrame {
  return { buttons: 0, yaw: 0, pitch: 0, jump: false, ...partial };
}

// Run n ticks with a constant input; returns the events of the LAST tick.
function run(
  s: PlayerMoveState,
  world: MockTraceWorld,
  inp: InputFrame,
  n: number,
): MoveEvents {
  const ev = newEvents();
  for (let i = 0; i < n; i++) stepMovement(s, inp, world, SIM_DT, ev);
  return ev;
}

describe('stepMovement', () => {
  it('gravity: a player above the floor falls and becomes grounded with vel.y ~0', () => {
    const world = new MockTraceWorld([floor()]);
    const s = createMoveState({ x: 0, y: 3, z: 0 }, 0);
    expect(s.grounded).toBe(false);

    run(s, world, input(), 120); // 2s — plenty to fall ~3m under g=20

    expect(s.grounded).toBe(true);
    expect(Math.abs(s.vel.y)).toBeLessThan(0.05);
    // Rests with feet near y=0 -> center near half+radius.
    expect(s.pos.y).toBeCloseTo(groundedCenterY(), 1);
  });

  it('sprint reaches ~sprintSpeed on flat ground', () => {
    const world = new MockTraceWorld([floor()]);
    const s = createMoveState({ x: 0, y: groundedCenterY() + 0.01, z: 0 }, 0);
    // settle onto the ground first
    run(s, world, input(), 5);

    const inp = input({ buttons: Button.Forward | Button.Sprint });
    run(s, world, inp, 120); // 2s of holding forward + sprint

    const speed = horizontalSpeed(s);
    expect(speed).toBeGreaterThan(M.sprintSpeed - 0.3);
    expect(speed).toBeLessThan(M.sprintSpeed + 0.3);
  });

  it('slide: starting at sprint speed raises horizontal speed by ~slideBoost then decays', () => {
    const world = new MockTraceWorld([floor()]);
    const s = createMoveState({ x: 0, y: groundedCenterY() + 0.01, z: 0 }, 0);
    run(s, world, input(), 5);
    // get to sprint speed
    run(s, world, input({ buttons: Button.Forward | Button.Sprint }), 120);
    const beforeSlide = horizontalSpeed(s);
    expect(beforeSlide).toBeGreaterThan(M.sprintSpeed - 0.3);

    // one tick with crouch held -> slide starts this tick
    const ev = newEvents();
    const slideInp = input({ buttons: Button.Forward | Button.Sprint | Button.Crouch });
    stepMovement(s, slideInp, world, SIM_DT, ev);

    expect(ev.slideStarted).toBe(true);
    expect(s.moveState).toBe('slide');
    expect(s.capsuleHalf).toBeCloseTo(slideHalf(), 5);
    const justAfterBoost = horizontalSpeed(s);
    // Boosted by ~slideBoost. One tick of slide friction runs on the boosted
    // speed, so allow for that drop (slideFriction * speed * dt).
    const maxFrictionDrop = (beforeSlide + M.slideBoost) * M.slideFriction * SIM_DT;
    expect(justAfterBoost).toBeGreaterThan(beforeSlide + M.slideBoost - maxFrictionDrop - 0.01);

    // continue sliding (crouch held) -> slideFriction decays it
    run(s, world, slideInp, 30); // 0.5s of sliding
    expect(horizontalSpeed(s)).toBeLessThan(justAfterBoost);
  });

  it('slide-jump within slideJumpWindow preserves horizontal speed and adds vertical', () => {
    const world = new MockTraceWorld([floor()]);
    const s = createMoveState({ x: 0, y: groundedCenterY() + 0.01, z: 0 }, 0);
    run(s, world, input(), 5);
    run(s, world, input({ buttons: Button.Forward | Button.Sprint }), 120);

    // start slide
    const ev = newEvents();
    const slideInp = input({ buttons: Button.Forward | Button.Sprint | Button.Crouch });
    stepMovement(s, slideInp, world, SIM_DT, ev);
    expect(s.moveState).toBe('slide');
    const hspeedBeforeJump = horizontalSpeed(s);
    expect(hspeedBeforeJump).toBeGreaterThan(M.sprintSpeed);

    // jump immediately (well within slideJumpWindow)
    const jumpEv = newEvents();
    const jumpInp = input({
      buttons: Button.Forward | Button.Sprint | Button.Crouch,
      jump: true,
    });
    stepMovement(s, jumpInp, world, SIM_DT, jumpEv);

    expect(jumpEv.jumped).toBe(true);
    expect(s.vel.y).toBeCloseTo(M.jumpImpulse, 5); // jump SETS vel.y exactly
    // Horizontal preserved by the slide-jump itself (no clamp/penalty). The jump
    // tick still applies one tick of slide friction, so allow for that drop only.
    const frictionDrop = hspeedBeforeJump * M.slideFriction * SIM_DT;
    expect(horizontalSpeed(s)).toBeGreaterThan(hspeedBeforeJump - frictionDrop - 0.01);
    expect(horizontalSpeed(s)).toBeGreaterThan(M.sprintSpeed); // way above run speed
  });

  it('coyote: jumping shortly after leaving a ledge still registers', () => {
    // Floor ends at x = 5 (a small platform). Player runs off the +x edge.
    const platform: Solid = { type: 'box', pos: [0, -5, 0], size: [10, 10, 10] };
    const world = new MockTraceWorld([platform]);
    // Start grounded near the +x edge moving +x.
    const s = createMoveState({ x: 4, y: groundedCenterY() + 0.01, z: 0 }, 0);
    run(s, world, input(), 5);
    expect(s.grounded).toBe(true);

    // Give it a healthy +x velocity by holding "right" (+x in yaw=0 frame).
    s.vel.x = M.sprintSpeed;

    // Step until it leaves the ground (walks past x=5 platform edge).
    let leftGround = false;
    for (let i = 0; i < 30; i++) {
      const ev = newEvents();
      stepMovement(s, input({ buttons: Button.Right }), world, SIM_DT, ev);
      if (!s.grounded) {
        leftGround = true;
        break;
      }
    }
    expect(leftGround).toBe(true);
    expect(s.coyoteTimer).toBeGreaterThan(0); // within coyote window

    // Now press jump within the coyote window.
    const jumpEv = newEvents();
    stepMovement(s, input({ buttons: Button.Right, jump: true }), world, SIM_DT, jumpEv);
    expect(jumpEv.jumped).toBe(true);
    expect(s.vel.y).toBeGreaterThan(0);
  });

  it('headroom: ending a slide under a low ceiling does NOT un-crouch', () => {
    // Floor + a low ceiling: a SLIDING capsule fits, a STANDING one does not.
    const f = floor();
    const standTotal = 2 * (standHalf() + M.radius); // standing total height (1.8)
    const slideTotal = 2 * (slideHalf() + M.radius); // crouched total height (0.9)
    const ceilBottom = slideTotal + 0.2; // headroom for crouch only, < standTotal
    const ceiling: Solid = {
      type: 'box',
      pos: [0, ceilBottom + 5, 0], // 10-tall box, bottom at ceilBottom
      size: [200, 10, 200],
    };
    expect(ceilBottom).toBeLessThan(standTotal); // sanity: no standing headroom
    const world = new MockTraceWorld([f, ceiling]);

    // Put the player directly into a moving slide under the ceiling (crouched
    // capsule, feet on floor, moving fast in +x). This mirrors the state right
    // after a slide-start; we only need to test the slide-END headroom logic.
    const s = createMoveState({ x: 0, y: groundedCenterY(slideHalf()) + 0.005, z: 0 }, 0);
    s.capsuleHalf = slideHalf();
    s.moveState = 'slide';
    s.vel.x = M.sprintSpeed + M.slideBoost; // fast slide
    run(s, world, input({ buttons: Button.Crouch }), 3); // confirm grounded + sliding
    expect(s.moveState).toBe('slide');
    expect(s.grounded).toBe(true);
    expect(s.capsuleHalf).toBeCloseTo(slideHalf(), 5);

    // Release crouch -> wants to stand, but the ceiling blocks it. Step until the
    // slide would otherwise end (speed decays below slideMinSpeed too).
    for (let i = 0; i < 300; i++) {
      const e2 = newEvents();
      stepMovement(s, input({ buttons: 0 }), world, SIM_DT, e2);
    }
    // Still crouched: no headroom to stand.
    expect(s.capsuleHalf).toBeCloseTo(slideHalf(), 5);
  });

  it('impulse: applyImpulse adds to velocity once then clears', () => {
    const world = new MockTraceWorld([floor()]);
    const s = createMoveState({ x: 0, y: groundedCenterY() + 0.01, z: 0 }, 0);
    run(s, world, input(), 5);
    expect(s.grounded).toBe(true);

    applyImpulse(s, 0, 12, 0); // straight up launch
    expect(s.pendingImpulse.y).toBe(12);

    const ev = newEvents();
    stepMovement(s, input(), world, SIM_DT, ev);
    // Impulse consumed: pendingImpulse cleared, vel.y got the launch (minus 1 tick g).
    expect(s.pendingImpulse.y).toBe(0);
    expect(s.vel.y).toBeGreaterThan(12 - M.gravity * SIM_DT - 0.001);
    const velAfterFirst = s.vel.y;

    // Next tick must NOT re-apply the impulse (only gravity changes vel.y).
    stepMovement(s, input(), world, SIM_DT, ev);
    expect(s.vel.y).toBeLessThan(velAfterFirst); // gravity pulled it down, no second launch
    expect(s.vel.y).toBeCloseTo(velAfterFirst - M.gravity * SIM_DT, 4);
  });
});
