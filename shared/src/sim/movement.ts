// The feel layer (PRD §4, §24.2). Quake-style: gameplay owns the velocity
// vector at all times; the TraceWorld only resolves where a swept capsule stops.
// Pure function of (state, input, world, dt) — the client runs it for the local
// player (zero added latency); unit tests run it against MockTraceWorld.
//
// pos = capsule CENTER. Total capsule height = 2*(capsuleHalf + radius).

import type { Vec3 } from '../math';
import {
  v3,
  set,
  copy,
  scale,
  normalize,
  projectOntoPlane,
  horizontalLength,
  clamp,
  damp,
  EPSILON,
} from '../math';
import { TUNING } from '../tuning';
import { Button } from '../protocol';
import type { TraceWorld } from './traceworld';

export type MoveStateName = 'ground' | 'air' | 'slide';

/** One simulation tick of input. `jump` is the buffered jump edge (input layer
 *  applies the 100ms buffer + coyote-friendly timing before setting it). */
export interface InputFrame {
  buttons: number; // continuous Button bitfield (protocol.Button)
  yaw: number; // radians
  pitch: number; // radians
  jump: boolean; // jump requested this tick (already buffered upstream)
}

export interface PlayerMoveState {
  pos: Vec3; // capsule center
  vel: Vec3;
  yaw: number;
  pitch: number;
  moveState: MoveStateName;
  grounded: boolean;
  capsuleHalf: number; // half-height of the capsule's cylinder segment
  knifeOut: boolean; // +knifeSpeedBonus while true
  slideTimer: number; // seconds elapsed in current slide
  coyoteTimer: number; // seconds remaining where a jump still registers after leaving ground
  groundNormal: Vec3; // last ground contact normal (ramp slide accel cue)
  fov: number; // smoothed current FOV in degrees (client speed cue)
  pendingImpulse: Vec3; // external impulses (explosions/launches) consumed next tick
}

export interface MoveEvents {
  jumped: boolean;
  slideStarted: boolean;
  slideEnded: boolean;
  landed: boolean;
}

export function newEvents(): MoveEvents {
  return { jumped: false, slideStarted: false, slideEnded: false, landed: false };
}

export function clearEvents(e: MoveEvents): void {
  e.jumped = false;
  e.slideStarted = false;
  e.slideEnded = false;
  e.landed = false;
}

/** Standing capsule cylinder half-height derived from TUNING. */
export function standHalf(): number {
  return TUNING.movement.standHeight / 2 - TUNING.movement.radius;
}

export function slideHalf(): number {
  return TUNING.movement.slideHeight / 2 - TUNING.movement.radius;
}

export function createMoveState(pos: Vec3, yawDeg: number): PlayerMoveState {
  return {
    pos: copy(v3(), pos),
    vel: v3(),
    yaw: (yawDeg * Math.PI) / 180,
    pitch: 0,
    moveState: 'air',
    grounded: false,
    capsuleHalf: standHalf(),
    knifeOut: false,
    slideTimer: 0,
    coyoteTimer: 0,
    groundNormal: v3(0, 1, 0),
    fov: TUNING.movement.fovBase,
    pendingImpulse: v3(),
  };
}

/** Queue an external impulse (explosion knockback / launch). Consumed next step. */
export function applyImpulse(s: PlayerMoveState, ix: number, iy: number, iz: number): void {
  s.pendingImpulse.x += ix;
  s.pendingImpulse.y += iy;
  s.pendingImpulse.z += iz;
}

export function horizontalSpeed(s: PlayerMoveState): number {
  return horizontalLength(s.vel);
}

/** Eye/camera world position = center + (eyeHeight - totalHeight/2). */
export function eyePosition(s: PlayerMoveState, out: Vec3): Vec3 {
  const m = TUNING.movement;
  const totalHeight = 2 * (s.capsuleHalf + m.radius);
  const eyeH = s.moveState === 'slide' ? m.eyeHeightSlide : m.eyeHeightStand;
  out.x = s.pos.x;
  out.y = s.pos.y - totalHeight / 2 + eyeH;
  out.z = s.pos.z;
  return out;
}

// ---- module-level scratch (zero-alloc hot paths) ----
const _wishdir = v3();
const _hvelDir = v3();
const _remaining = v3();
const _down = v3();
const _up = v3();
const _projTmp = v3();
const _downhill = v3();

const SKIN = 0.01; // small back-off so the swept capsule never tunnels into a face

/** Quake-style friction on the horizontal velocity only (vertical is gravity's). */
function applyFriction(s: PlayerMoveState, friction: number, dt: number): void {
  const speed = horizontalLength(s.vel);
  if (speed < EPSILON) return;
  const drop = speed * friction * dt;
  const newSpeed = speed - drop > 0 ? speed - drop : 0;
  const f = newSpeed / speed;
  s.vel.x *= f;
  s.vel.z *= f;
}

/**
 * Quake accelerate: push horizontal velocity toward wishdir, but never above
 * `wishspeed` along wishdir (so air strafing converts turn into speed, and you
 * cannot exceed your move speed by holding forward). `wishdir` is a unit
 * horizontal vector; `wishspeed` caps the contribution.
 */
function accelerate(s: PlayerMoveState, wishdir: Vec3, wishspeed: number, accel: number, dt: number): void {
  const current = s.vel.x * wishdir.x + s.vel.z * wishdir.z; // dot in xz
  const addspeed = wishspeed - current;
  if (addspeed <= 0) return;
  let accelSpeed = accel * wishspeed * dt;
  if (accelSpeed > addspeed) accelSpeed = addspeed;
  s.vel.x += wishdir.x * accelSpeed;
  s.vel.z += wishdir.z * accelSpeed;
}

/**
 * Advance one fixed tick. Mutates `s` in place (zero-alloc); writes one-shot
 * edges into `events`. Order (PRD §24.2): state transitions -> friction ->
 * accelerate -> gravity -> impulses -> collide-and-slide -> ground check -> post.
 */
export function stepMovement(
  s: PlayerMoveState,
  input: InputFrame,
  world: TraceWorld,
  dt: number,
  events: MoveEvents,
): void {
  const m = TUNING.movement;

  events.jumped = false;
  events.slideStarted = false;
  events.slideEnded = false;
  events.landed = false;

  s.yaw = input.yaw;
  s.pitch = input.pitch;

  // -- 1. Timers --
  if (s.moveState === 'slide') s.slideTimer += dt;
  s.coyoteTimer -= dt;

  // Input decode: wishdir in the player's yaw frame (horizontal).
  const b = input.buttons;
  const fwd = (b & Button.Forward) !== 0 ? 1 : 0;
  const back = (b & Button.Back) !== 0 ? 1 : 0;
  const left = (b & Button.Left) !== 0 ? 1 : 0;
  const right = (b & Button.Right) !== 0 ? 1 : 0;
  const sprint = (b & Button.Sprint) !== 0;
  const slideHeld = (b & Button.Crouch) !== 0;

  // yaw=0 looks toward -z (camera-forward convention); forward axis derived from yaw.
  const sinY = Math.sin(s.yaw);
  const cosY = Math.cos(s.yaw);
  const moveF = fwd - back; // +forward
  const moveR = right - left; // +right
  // forward = (-sin, 0, -cos); right = (cos, 0, -sin)
  const wx = -sinY * moveF + cosY * moveR;
  const wz = -cosY * moveF - sinY * moveR;
  set(_wishdir, wx, 0, wz);
  const wishLen = normalize(_wishdir, _wishdir);

  // -- 2. Transitions --
  const hspeedNow = horizontalLength(s.vel);

  // Start slide.
  if (
    s.moveState !== 'slide' &&
    s.grounded &&
    slideHeld &&
    hspeedNow >= m.walkSpeed - EPSILON
  ) {
    const delta = standHalf() - slideHalf(); // shrink amount of the cylinder
    s.moveState = 'slide';
    s.slideTimer = 0;
    // Shrink: drop the center so the FEET stay put (no headroom needed shrinking).
    s.capsuleHalf = slideHalf();
    s.pos.y -= delta;
    // Boost along current horizontal velocity direction.
    set(_hvelDir, s.vel.x, 0, s.vel.z);
    const hlen = normalize(_hvelDir, _hvelDir);
    if (hlen > EPSILON) {
      s.vel.x += _hvelDir.x * m.slideBoost;
      s.vel.z += _hvelDir.z * m.slideBoost;
    }
    events.slideStarted = true;
  } else if (s.moveState === 'slide') {
    // End slide when crouch released OR too slow. Try to stand if there's headroom.
    if (!slideHeld || hspeedNow < m.slideMinSpeed) {
      const delta = standHalf() - slideHalf();
      set(_up, 0, delta + SKIN, 0);
      const headHit = world.castCapsule(s.pos, s.capsuleHalf, m.radius, _up);
      if (headHit === null) {
        // Clear: restore standing capsule and raise center to keep feet planted.
        s.capsuleHalf = standHalf();
        s.pos.y += delta;
        s.moveState = s.grounded ? 'ground' : 'air';
        events.slideEnded = true;
      }
      // else: ceiling too low — stay crouched (remain in slide visually).
    }
  }

  // -- 3. Friction --
  if (s.moveState === 'slide') {
    applyFriction(s, m.slideFriction, dt);
  } else if (s.grounded) {
    applyFriction(s, m.groundFriction, dt);
  }
  // air: no friction.

  // -- 4. Accelerate --
  if (wishLen > EPSILON) {
    const speedMul = s.knifeOut ? 1 + m.knifeSpeedBonus : 1;
    if (s.moveState === 'slide') {
      // Slide: preserve momentum, very low accel, do NOT cap wishspeed.
      const wishspeed = (sprint ? m.sprintSpeed : m.walkSpeed) * speedMul;
      accelerate(s, _wishdir, wishspeed, m.groundAccel * m.airControlFactor, dt);
    } else if (s.grounded) {
      const wishspeed = (sprint ? m.sprintSpeed : m.walkSpeed) * speedMul;
      accelerate(s, _wishdir, wishspeed, m.groundAccel, dt);
    } else {
      // Air: classic Quake air control — tiny wishspeed cap, reduced accel.
      const wishspeed = Math.min((sprint ? m.sprintSpeed : m.walkSpeed) * speedMul, m.airWishSpeedCap);
      accelerate(s, _wishdir, wishspeed, m.groundAccel * m.airControlFactor, dt);
    }
  }

  // Slide-down-ramp accel: while sliding on a slope, add accel along downhill,
  // scaled by slope steepness (1 - groundNormal.y).
  if (s.moveState === 'slide' && s.grounded) {
    const slope = 1 - s.groundNormal.y;
    if (slope > EPSILON) {
      // Downhill = horizontal projection of the (downward) gravity onto the plane.
      // projectOntoPlane((0,-1,0)) then drop vertical -> horizontal downhill dir.
      set(_projTmp, 0, -1, 0);
      projectOntoPlane(_downhill, _projTmp, s.groundNormal);
      _downhill.y = 0;
      const dl = normalize(_downhill, _downhill);
      if (dl > EPSILON) {
        const a = m.slideRampAccel * slope * dt;
        s.vel.x += _downhill.x * a;
        s.vel.z += _downhill.z * a;
      }
    }
  }

  // -- 5. Gravity --
  if (!s.grounded) {
    s.vel.y -= m.gravity * dt;
  }

  // -- 6. Jump + impulses --
  if (input.jump && (s.grounded || s.coyoteTimer > 0)) {
    const slideJump = s.moveState === 'slide' && s.slideTimer <= m.slideJumpWindow;
    // Slide-jump preserves horizontal velocity fully (no clamp); a normal jump
    // also keeps horizontal velocity, so in both cases we only set vel.y.
    s.vel.y = m.jumpImpulse;
    if (slideJump) {
      // Pop out of slide cleanly (stand if possible; otherwise keep capsule but
      // leave slide state so the air branch governs).
      const delta = standHalf() - slideHalf();
      set(_up, 0, delta + SKIN, 0);
      const headHit = world.castCapsule(s.pos, s.capsuleHalf, m.radius, _up);
      if (headHit === null) {
        s.capsuleHalf = standHalf();
        s.pos.y += delta;
      }
      events.slideEnded = true;
    }
    s.moveState = 'air';
    s.grounded = false;
    s.coyoteTimer = 0;
    events.jumped = true;
  }

  // pendingImpulse (explosions / launches) — applied once, then cleared.
  if (s.pendingImpulse.x !== 0 || s.pendingImpulse.y !== 0 || s.pendingImpulse.z !== 0) {
    s.vel.x += s.pendingImpulse.x;
    s.vel.y += s.pendingImpulse.y;
    s.vel.z += s.pendingImpulse.z;
    set(s.pendingImpulse, 0, 0, 0);
    // An upward impulse means we are airborne now.
    if (s.vel.y > EPSILON) {
      s.grounded = false;
      s.moveState = 'air';
    }
  }

  // -- 7. Collide-and-slide move --
  scale(_remaining, s.vel, dt);
  for (let iter = 0; iter < 5; iter++) {
    const rlen = Math.hypot(_remaining.x, _remaining.y, _remaining.z);
    if (rlen < EPSILON) break;
    const hit = world.castCapsule(s.pos, s.capsuleHalf, m.radius, _remaining);
    if (hit === null) {
      s.pos.x += _remaining.x;
      s.pos.y += _remaining.y;
      s.pos.z += _remaining.z;
      break;
    }
    const backoff = rlen > EPSILON ? SKIN / rlen : 0;
    if (hit.fraction <= backoff) {
      // Already resting in contact at the start of the sweep. A swept cast reports
      // fraction 0 even for motion ALONG the surface, so honoring it deadlocks
      // tangent sliding — you cannot walk/sprint up a ramp you are standing on.
      // Depenetrate a hair along the contact normal so the next cast has clearance
      // to slide freely (or to see a real wall ahead), and strip the into-surface
      // velocity component. Self-limiting: once the SKIN gap exists, the next cast
      // returns null (or a real obstacle) and the loop advances normally.
      s.pos.x += hit.normal.x * SKIN;
      s.pos.y += hit.normal.y * SKIN;
      s.pos.z += hit.normal.z * SKIN;
      projectOntoPlane(_remaining, _remaining, hit.normal);
      projectOntoPlane(s.vel, s.vel, hit.normal);
      continue;
    }
    // Advance to just shy of the contact (back off by SKIN along the move dir).
    const moveFrac = hit.fraction - backoff;
    s.pos.x += _remaining.x * moveFrac;
    s.pos.y += _remaining.y * moveFrac;
    s.pos.z += _remaining.z * moveFrac;
    // Project remaining motion and velocity onto the contact plane (slide).
    projectOntoPlane(_remaining, _remaining, hit.normal);
    // Only keep the portion of remaining we have NOT consumed yet.
    scale(_remaining, _remaining, 1 - moveFrac);
    projectOntoPlane(s.vel, s.vel, hit.normal);
  }

  // -- 8. Ground check --
  const probe = 0.05;
  set(_down, 0, -(probe + SKIN), 0);
  const groundHit = world.castCapsule(s.pos, s.capsuleHalf, m.radius, _down);
  const wasGrounded = s.grounded;
  const nowGrounded = groundHit !== null && groundHit.normal.y > m.groundNormalY;

  if (nowGrounded) {
    copy(s.groundNormal, groundHit!.normal);
    if (!wasGrounded) {
      events.landed = true;
    }
    s.grounded = true;
    s.coyoteTimer = m.coyoteTime;
    // Kill tiny residual downward velocity so we rest cleanly (unless we just jumped).
    if (!events.jumped && s.vel.y < 0 && s.vel.y > -1) {
      s.vel.y = 0;
    }
  } else {
    if (wasGrounded && !events.jumped) {
      // Just left the ground without jumping: start coyote countdown.
      s.coyoteTimer = m.coyoteTime;
    }
    s.grounded = false;
  }

  // -- 9. Post: state name + FOV --
  if (s.moveState !== 'slide') {
    s.moveState = s.grounded ? 'ground' : 'air';
  } else if (!s.grounded) {
    // Sliding but airborne (jumped off a ramp mid-slide) stays 'slide' until the
    // slide-end transition fires; nothing to do here.
  }

  const speed = horizontalLength(s.vel);
  const t = clamp(
    (speed - m.fovSpeedThreshold) / (m.fovSpeedMax - m.fovSpeedThreshold),
    0,
    1,
  );
  const fovTarget = m.fovBase + m.fovSprintBonus * t;
  s.fov = damp(s.fov, fovTarget, m.fovLerpRate, dt);
}
