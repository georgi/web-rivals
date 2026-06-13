// MovementValidator tests (PRD §3.1). Movement is client-authoritative; the server only
// sanity-checks reports and snaps offenders back. Backend-agnostic: runs against the
// hand-coded MockTraceWorld with a single floor slab. NO Three.js, NO DOM.

import { describe, it, expect, beforeEach } from 'vitest';
import { MockTraceWorld, TUNING, type Solid } from '@rivals/shared';
import { MovementValidator, type MoveReport } from './validate';

// A 40x1x40 floor slab centred at the origin, top surface at y=0.5.
const FLOOR: Solid = { type: 'box', pos: [0, 0, 0], size: [40, 1, 40] };

const m = TUNING.movement;
const HALF_HEIGHT = (m.standHeight - 2 * m.radius) / 2; // capsule core half-length
const REST_Y = 0.5 + m.radius + HALF_HEIGHT; // grounded capsule centre height
const DT = 1 / TUNING.world.serverHz; // one server tick (~33ms)
const MAX_SPEED = m.sprintSpeed + m.slideBoost;

const PLAYER = 1;

function report(pos: { x: number; y: number; z: number }, vel = { x: 0, y: 0, z: 0 }): MoveReport {
  return { pos: { ...pos }, vel: { ...vel }, yaw: 0, pitch: 0 };
}

describe('MovementValidator', () => {
  let world: MockTraceWorld;
  let validator: MovementValidator;

  beforeEach(() => {
    world = new MockTraceWorld([FLOOR]);
    validator = new MovementValidator(world);
    validator.reset(PLAYER, { x: 0, y: REST_Y, z: 0 });
  });

  it('accepts a normal step within the per-tick speed budget', () => {
    // Move at sprint speed for one tick along +x.
    const step = m.sprintSpeed * DT;
    const r = report({ x: step, y: REST_Y, z: 0 }, { x: m.sprintSpeed, y: 0, z: 0 });
    const res = validator.accept(PLAYER, r, DT, 0);

    expect(res.ok).toBe(true);
    expect(res.correctedPos.x).toBeCloseTo(step, 6);
    expect(res.correctedPos.y).toBeCloseTo(REST_Y, 6);
    expect(res.correctedVel.x).toBeCloseTo(m.sprintSpeed, 6);
  });

  it('accepts even the most generous legal displacement (max speed * dt * 1.5)', () => {
    const budget = MAX_SPEED * DT * 1.5;
    // Land just inside the budget.
    const r = report({ x: budget - 1e-3, y: REST_Y, z: 0 });
    const res = validator.accept(PLAYER, r, DT, 0);
    expect(res.ok).toBe(true);
  });

  it('rejects a 5m teleport in one tick and corrects back to the last accepted pos', () => {
    const r = report({ x: 5, y: REST_Y, z: 0 }, { x: 0, y: 0, z: 0 });
    const res = validator.accept(PLAYER, r, DT, 0);

    expect(res.ok).toBe(false);
    // Snap back to where the player actually was (spawn baseline).
    expect(res.correctedPos.x).toBeCloseTo(0, 6);
    expect(res.correctedPos.y).toBeCloseTo(REST_Y, 6);
    expect(res.correctedPos.z).toBeCloseTo(0, 6);
    // Correction velocity is zeroed so the client doesn't keep coasting.
    expect(res.correctedVel.x).toBeCloseTo(0, 6);
    expect(res.correctedVel.y).toBeCloseTo(0, 6);
    expect(res.correctedVel.z).toBeCloseTo(0, 6);
  });

  it('does not advance the baseline on rejection (a follow-up legal step is measured from the old pos)', () => {
    // Reject a teleport...
    validator.accept(PLAYER, report({ x: 5, y: REST_Y, z: 0 }), DT, 0);
    // ...then a small legal step from the ORIGINAL pos is accepted.
    const small = m.walkSpeed * DT;
    const ok = validator.accept(PLAYER, report({ x: small, y: REST_Y, z: 0 }), DT, DT);
    expect(ok.ok).toBe(true);
    expect(ok.correctedPos.x).toBeCloseTo(small, 6);
  });

  it('accepts a large launch displacement within the impulse window after noteImpulse', () => {
    // Without an impulse this displacement is way over budget...
    const launchDist = MAX_SPEED * DT * 3; // 3x the base speed cap (well past the 1.5x budget)
    const tooFar = report({ x: launchDist, y: REST_Y + 2, z: 0 }, { x: 30, y: 8, z: 0 });
    expect(validator.accept(PLAYER, tooFar, DT, 0).ok).toBe(false);

    // ...but right after a known explosion impulse it is allowed (rocket-jump launch).
    validator.reset(PLAYER, { x: 0, y: REST_Y, z: 0 });
    validator.noteImpulse(PLAYER, 1.0);
    const res = validator.accept(PLAYER, tooFar, DT, 1.0 + DT);
    expect(res.ok).toBe(true);
    expect(res.correctedPos.x).toBeCloseTo(launchDist, 6);
  });

  it('stops widening the allowance once the impulse window has elapsed', () => {
    validator.noteImpulse(PLAYER, 1.0);
    const launchDist = MAX_SPEED * DT * 3;
    // Well after the 0.6s window: back to the strict budget -> rejected.
    const res = validator.accept(PLAYER, report({ x: launchDist, y: REST_Y, z: 0 }), DT, 1.0 + 1.0);
    expect(res.ok).toBe(false);
  });

  it('rejects a position buried in the floor and corrects back', () => {
    // Sink the capsule a metre into the floor slab (no horizontal motion, so only the
    // static-penetration check can reject it).
    const r = report({ x: 0, y: REST_Y - 1.0, z: 0 });
    const res = validator.accept(PLAYER, r, DT, 0);

    expect(res.ok).toBe(false);
    expect(res.correctedPos.y).toBeCloseTo(REST_Y, 6);
  });

  it('does not flag a player legitimately resting on the floor as penetrating', () => {
    // A no-op report at the exact rest height must pass (no false-positive correction).
    const res = validator.accept(PLAYER, report({ x: 0, y: REST_Y, z: 0 }), DT, 0);
    expect(res.ok).toBe(true);
  });
});
