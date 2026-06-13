// M2 EXIT GATE (PRD §18.5 / §13.1): a deliberate rocket-jump must reach the
// center high-ground (platform top y=3) from flat ground, while self-damage stays
// modest (selfDamageScale) so the move is viable (PRD §4). Headless sim only —
// MockTraceWorld with one large flat floor whose TOP is y=0. No Three.js, no DOM.

import { describe, it, expect } from 'vitest';
import type { Solid } from '../geometry';
import { TUNING, SIM_DT } from '../tuning';
import { v3 } from '../math';
import { MockTraceWorld } from './mock-traceworld';
import {
  stepMovement,
  createMoveState,
  newEvents,
  applyImpulse,
  standHalf,
  type PlayerMoveState,
  type InputFrame,
} from './movement';
import { computeExplosion, type PlayerCapsule } from './projectiles';

const M = TUNING.movement;

// The platform top the player must reach (PRD §13.1 center high-ground).
const PLATFORM_TOP = 3.0;
const PLAYER_ID = 1;

// Floor: a big box 200x10x200 centered so its TOP face sits at y=0.
function floor(): Solid {
  return { type: 'box', pos: [0, -5, 0], size: [200, 10, 200] };
}

function input(partial: Partial<InputFrame> = {}): InputFrame {
  return { buttons: 0, yaw: 0, pitch: 0, jump: false, ...partial };
}

// Feet height = capsule center - (cylinder half + radius).
function feetY(s: PlayerMoveState): number {
  return s.pos.y - (s.capsuleHalf + M.radius);
}

// A grounded player standing on the floor: spawn feet just above y=0 and settle
// a few empty ticks so it drops onto the floor and `grounded` becomes true.
function spawnGrounded(world: MockTraceWorld): PlayerMoveState {
  // Feet at y=0 -> center at radius + standHalf(); start a hair above so the
  // ground check fires on the way down (resting exactly on the face does not).
  const centerY = M.radius + standHalf() + 0.01;
  const s = createMoveState({ x: 0, y: centerY, z: 0 }, 0);
  const ev = newEvents();
  for (let i = 0; i < 5; i++) stepMovement(s, input(), world, SIM_DT, ev);
  expect(s.grounded).toBe(true);
  return s;
}

// The player's analytic explosion hitbox at its current pose.
function playerCapsule(s: PlayerMoveState): PlayerCapsule {
  return { id: PLAYER_ID, center: v3(s.pos.x, s.pos.y, s.pos.z), radius: M.radius, halfHeight: s.capsuleHalf };
}

// Simulate from a grounded start: optionally detonate a rocket at the feet
// (applying the self-knockback impulse) and/or press jump on tick 0, then step
// for `ticks` ticks. Returns the peak FEET height reached and the self-damage
// the rocket dealt to the owner (0 if no rocket).
function simulate(opts: { rocket: boolean; jump: boolean; ticks?: number }): {
  peakFeet: number;
  selfDamage: number;
} {
  const world = new MockTraceWorld([floor()]);
  const s = spawnGrounded(world);

  let selfDamage = 0;
  if (opts.rocket) {
    // Rocket detonates straight down at the player's feet: center {x, y:0, z}.
    const feet = v3(s.pos.x, 0, s.pos.z);
    const hits = computeExplosion('rocket', feet, PLAYER_ID, [playerCapsule(s)], world);
    const self = hits.find((h) => h.id === PLAYER_ID);
    expect(self).toBeDefined();
    selfDamage = self!.damage;
    applyImpulse(s, self!.impulse.x, self!.impulse.y, self!.impulse.z);
  }

  const ev = newEvents();
  const ticks = opts.ticks ?? 120; // 2s default
  let peakFeet = feetY(s);
  for (let i = 0; i < ticks; i++) {
    // Press jump only on the first tick (the deliberate rocket-jump moment).
    stepMovement(s, input({ jump: opts.jump && i === 0 }), world, SIM_DT, ev);
    const fy = feetY(s);
    if (fy > peakFeet) peakFeet = fy;
  }
  return { peakFeet, selfDamage };
}

describe('M2 exit gate — rocket-jump to center high-ground', () => {
  it('a rocket-jump (rocket at feet, no jump key) clears the platform top y=3', () => {
    const { peakFeet, selfDamage } = simulate({ rocket: true, jump: false });
    // Reaches the high-ground with a little margin (aim ~3.2-3.8m so it is
    // reliably reachable but not absurd).
    expect(peakFeet).toBeGreaterThanOrEqual(PLATFORM_TOP);
    expect(peakFeet).toBeGreaterThanOrEqual(3.2);
    expect(peakFeet).toBeLessThanOrEqual(3.9);
    // Self-damage is modest (selfDamageScale applied) so the move stays viable.
    expect(selfDamage).toBeLessThanOrEqual(20);
  });

  it('a NORMAL jump alone (no rocket) does NOT reach the platform top y=3', () => {
    const { peakFeet, selfDamage } = simulate({ rocket: false, jump: true });
    expect(selfDamage).toBe(0);
    expect(peakFeet).toBeLessThan(PLATFORM_TOP);
  });

  it('a rocket-jump combined with the normal jump overshoots the platform comfortably', () => {
    const { peakFeet } = simulate({ rocket: true, jump: true });
    expect(peakFeet).toBeGreaterThan(PLATFORM_TOP + 0.5);
  });

  it('self-knockback is full (selfKnockbackScale) but self-damage is scaled (PRD §4)', () => {
    const world = new MockTraceWorld([floor()]);
    const s = spawnGrounded(world);
    const feet = v3(s.pos.x, 0, s.pos.z);
    const hits = computeExplosion('rocket', feet, PLAYER_ID, [playerCapsule(s)], world);
    const self = hits.find((h) => h.id === PLAYER_ID)!;
    // Upward impulse dominates (blast below the player core -> direction ~ +y).
    expect(self.impulse.y).toBeGreaterThan(0);
    // Self-damage is at most splashDamageMax * selfDamageScale.
    expect(self.damage).toBeLessThanOrEqual(
      TUNING.rocket.splashDamageMax * TUNING.rocket.selfDamageScale,
    );
  });
});
