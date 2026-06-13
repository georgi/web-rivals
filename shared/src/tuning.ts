// THE single source of truth for tunable gameplay values (PRD §4, §5).
// Mutable on purpose: the F3 debug panel binds directly to this object so values
// can be hot-tweaked during playtests. `git log shared/src/tuning.ts` recovers
// why a value changed (commit each TUNING change with a one-line feel note).

export interface MovementTuning {
  walkSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  knifeSpeedBonus: number; // multiplies current move speed while knife is out

  groundAccel: number; // m/s^2 toward wishspeed on ground
  groundFriction: number; // per-second velocity decay on ground (not sliding)
  airControlFactor: number; // air accel = groundAccel * this (PRD: 30%)
  airWishSpeedCap: number; // cap on wishspeed contribution in air (strafe limit)

  slideBoost: number; // m/s added along horizontal velocity on slide start
  slideFriction: number; // m/s^2 decay while sliding (lower than run)
  slideMinSpeed: number; // ends slide below this horizontal speed
  slideJumpWindow: number; // seconds at slide start where slide-jump preserves momentum
  slideRampAccel: number; // extra accel m/s^2 when sliding down a slope (scaled by slope)

  jumpImpulse: number; // m/s vertical added on jump
  gravity: number; // m/s^2 (deliberately heavy)
  coyoteTime: number; // seconds after leaving ground a jump still registers
  inputBufferTime: number; // seconds an early jump press is remembered (handled in input layer)

  // Capsule geometry
  radius: number;
  standHeight: number; // total capsule height standing
  slideHeight: number; // total capsule height while sliding/crouched (~50%)
  eyeHeightStand: number; // camera offset above feet when standing
  eyeHeightSlide: number; // camera offset above feet when sliding

  groundNormalY: number; // min normal.y to count as ground (slope limit ~50deg)

  // FOV speed cue
  fovBase: number; // degrees
  fovSprintBonus: number; // +deg added as speed cue (PRD: +8)
  fovSpeedThreshold: number; // speed at which FOV starts widening
  fovSpeedMax: number; // speed at which FOV bonus is fully applied
  fovLerpRate: number; // exp smoothing rate for FOV changes
}

export type WeaponType = 'hitscan' | 'projectile' | 'melee';

export interface HitscanTuning {
  slot: 1;
  name: string;
  type: 'hitscan';
  damage: number;
  fireInterval: number; // seconds between shots
  magSize: number;
  reserveAmmo: number;
  reloadTime: number;
  bloomMin: number; // radians of spread, first shot
  bloomMax: number; // radians of spread, sustained fire
  bloomPerShot: number; // radians added per shot
  bloomRecover: number; // radians/sec recovered
  tracerFade: number; // seconds tracer line lives
  range: number;
}

export interface RocketTuning {
  slot: 2;
  name: string;
  type: 'projectile';
  projSpeed: number;
  projGravity: number; // slight gravity on the rocket
  directDamage: number;
  splashDamageMin: number;
  splashDamageMax: number;
  splashRadius: number;
  knockback: number; // m/s impulse at explosion center, linear falloff to 0 at radius
  fireInterval: number;
  magSize: number;
  reserveAmmo: number;
  reloadTime: number;
  selfDamageScale: number; // 25% self-damage (PRD §4)
  selfKnockbackScale: number; // 100% self-knockback
}

export interface KnifeTuning {
  slot: 3;
  name: string;
  type: 'melee';
  damage: number;
  backstabDamage: number;
  backstabDotThreshold: number; // dot(victimForward, attackDir) above this = backstab
  range: number;
  hitboxHalfWidth: number; // box query half-extent perpendicular to view
  swingTime: number;
  speedBonus: number; // +15% while held
}

export interface GrenadeTuning {
  slot: 4;
  name: string;
  type: 'projectile';
  projSpeed: number; // throw speed
  projGravity: number;
  restitution: number; // bounce energy retained
  fuse: number; // seconds from throw to detonation (no hold-cook in MVP)
  splashDamageMin: number;
  splashDamageMax: number;
  splashRadius: number;
  knockback: number;
  count: number; // carried at once
  regenTime: number; // seconds to regenerate after use
  selfDamageScale: number;
  selfKnockbackScale: number;
}

export interface CombatTuning {
  switchTime: number; // weapon swap time
  spawnHealth: number;
}

export interface WorldTuning {
  simHz: number; // fixed local sim rate
  serverHz: number; // server tick rate
  snapshotHz: number; // snapshots to client
  inputHz: number; // client input send rate
  maxCatchupMs: number; // accumulator clamp for tab-out
  interpDelayMs: number; // render remote players this far in the past
  roundTimeSec: number; // 90s round timer
  countdownSec: number;
  roundEndSec: number;
  matchEndSec: number;
  roundsToWin: number; // first to 3
  disconnectGraceSec: number;
}

export interface Tuning {
  movement: MovementTuning;
  ar: HitscanTuning;
  rocket: RocketTuning;
  knife: KnifeTuning;
  grenade: GrenadeTuning;
  combat: CombatTuning;
  world: WorldTuning;
}

export const TUNING: Tuning = {
  movement: {
    walkSpeed: 6,
    sprintSpeed: 9,
    crouchSpeed: 3,
    knifeSpeedBonus: 0.15,

    groundAccel: 90,
    groundFriction: 10,
    airControlFactor: 0.3,
    airWishSpeedCap: 1.2, // small wishspeed cap in air -> Quake-style air strafe steering

    slideBoost: 12,
    slideFriction: 4,
    slideMinSpeed: 4,
    slideJumpWindow: 0.4,
    slideRampAccel: 18,

    jumpImpulse: 5,
    gravity: 20,
    coyoteTime: 0.08,
    inputBufferTime: 0.1,

    radius: 0.4,
    standHeight: 1.8,
    slideHeight: 0.9,
    eyeHeightStand: 1.6,
    eyeHeightSlide: 0.7,

    groundNormalY: 0.7, // ~45.5deg; ramps (50deg-ish) still count as walkable ground

    fovBase: 90,
    fovSprintBonus: 8,
    fovSpeedThreshold: 9, // start widening at sprint speed
    fovSpeedMax: 16, // fully applied around boosted speeds
    fovLerpRate: 8,
  },

  ar: {
    slot: 1,
    name: 'Assault Rifle',
    type: 'hitscan',
    damage: 15,
    fireInterval: 0.1, // 600 RPM
    magSize: 30,
    reserveAmmo: 240,
    reloadTime: 1.5,
    bloomMin: 0.004,
    bloomMax: 0.05,
    bloomPerShot: 0.006,
    bloomRecover: 0.08,
    tracerFade: 0.1,
    range: 200,
  },

  rocket: {
    slot: 2,
    name: 'Rocket Launcher',
    type: 'projectile',
    projSpeed: 25,
    projGravity: 2,
    directDamage: 60,
    splashDamageMin: 10,
    splashDamageMax: 40,
    splashRadius: 3,
    knockback: 16, // m/s at center -> enough to rocket-jump to center high-ground
    fireInterval: 1.2,
    magSize: 4,
    reserveAmmo: 12,
    reloadTime: 2.5,
    selfDamageScale: 0.25,
    selfKnockbackScale: 1.0,
  },

  knife: {
    slot: 3,
    name: 'Knife',
    type: 'melee',
    damage: 35,
    backstabDamage: 90,
    backstabDotThreshold: 0.3, // attacker roughly behind victim
    range: 2,
    hitboxHalfWidth: 0.6,
    swingTime: 0.5,
    speedBonus: 0.15,
  },

  grenade: {
    slot: 4,
    name: 'Frag Grenade',
    type: 'projectile',
    projSpeed: 14,
    projGravity: 20,
    restitution: 0.4,
    fuse: 3,
    splashDamageMin: 10,
    splashDamageMax: 50,
    splashRadius: 3.5,
    knockback: 18,
    count: 1,
    regenTime: 8,
    selfDamageScale: 0.25,
    selfKnockbackScale: 1.0,
  },

  combat: {
    switchTime: 0.3,
    spawnHealth: 100,
  },

  world: {
    simHz: 60,
    serverHz: 30,
    snapshotHz: 20,
    inputHz: 30,
    maxCatchupMs: 250,
    interpDelayMs: 100,
    roundTimeSec: 90,
    countdownSec: 3,
    roundEndSec: 1.5,
    matchEndSec: 5,
    roundsToWin: 3,
    disconnectGraceSec: 10,
  },
};

export const SIM_DT = 1 / TUNING.world.simHz;
