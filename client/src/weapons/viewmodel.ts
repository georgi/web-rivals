// First-person viewmodel: a small set of primitives per weapon, parented by the
// caller to the camera, positioned lower-right of view. Procedural bob (sin/cos
// of a move-driven phase) + a recoil spring (kick on fire, damped back to rest).
// Zero per-frame allocation: all scratch lives on the instance.

import * as THREE from 'three';
import { TUNING, damp } from '@rivals/shared';
import type { WeaponSlot } from '@rivals/shared';

// Resting pose lower-right of the eye, in camera space (camera looks down -Z).
const REST_X = 0.28;
const REST_Y = -0.26;
const REST_Z = -0.6;

// Bob amplitudes (metres) and phase rate (rad per metre travelled).
const BOB_X = 0.012;
const BOB_Y = 0.018;
const BOB_PHASE_PER_M = 1.6;

// Recoil: kick added on fire, spring-back rate (1/s) via exponential damp.
const RECOIL_BACK = 0.06; // +Z (toward the eye)
const RECOIL_UP = 0.03; // +Y
const RECOIL_PITCH = 0.18; // radians, muzzle climb
const RECOIL_RECOVER = 12;

function mat(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3 });
}

// Build one weapon's primitive group (3-6 shapes), authored around the origin so
// the parent group handles placement/sway/recoil uniformly.
function buildAr(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.42), mat(0x333a3f));
  body.position.set(0, 0, 0);
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.3, 8),
    mat(0x202428),
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.01, -0.32);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.12, 0.05), mat(0x14181b));
  mag.position.set(0, -0.09, 0.04);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.09, 0.05), mat(0x14181b));
  grip.position.set(0, -0.07, 0.16);
  grip.rotation.x = -0.25;
  g.add(body, barrel, mag, grip);
  return g;
}

function buildRocket(): THREE.Group {
  const g = new THREE.Group();
  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 0.5, 12),
    mat(0x4a3b2a),
  );
  tube.rotation.x = Math.PI / 2;
  tube.position.set(0, 0, -0.05);
  const muzzle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.07, 0.06, 12),
    mat(0x2a2018),
  );
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0, 0, -0.3);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.08), mat(0x202020));
  sight.position.set(0, 0.07, -0.02);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.09, 0.05), mat(0x14181b));
  grip.position.set(0, -0.08, 0.12);
  g.add(tube, muzzle, sight, grip);
  return g;
}

function buildKnife(): THREE.Group {
  const g = new THREE.Group();
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.14, 0.02), mat(0xc8ccd0));
  blade.position.set(0, 0.12, -0.05);
  blade.rotation.x = -0.4;
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.03), mat(0x2a1a10));
  handle.position.set(0, 0.0, 0.0);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.015, 0.04), mat(0x3a3a3a));
  guard.position.set(0, 0.05, -0.02);
  g.add(blade, handle, guard);
  return g;
}

function buildGrenade(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), mat(0x2f3a26));
  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.03, 8),
    mat(0x55585a),
  );
  top.position.set(0, 0.06, 0);
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.06, 0.01), mat(0x9a9a30));
  lever.position.set(0.03, 0.05, 0);
  g.add(body, top, lever);
  return g;
}

export class Viewmodel {
  readonly object: THREE.Object3D;

  private readonly models: Record<WeaponSlot, THREE.Group>;
  private current: WeaponSlot = 1;

  // Procedural bob phase, advanced by distance travelled (speed*dt).
  private bobPhase = 0;

  // Recoil offset (springs back to 0): translation z/y and a pitch angle.
  private recoilZ = 0;
  private recoilY = 0;
  private recoilPitch = 0;

  constructor() {
    this.object = new THREE.Group();
    this.object.position.set(REST_X, REST_Y, REST_Z);

    this.models = {
      1: buildAr(),
      2: buildRocket(),
      3: buildKnife(),
      4: buildGrenade(),
    };
    for (const k of [1, 2, 3, 4] as WeaponSlot[]) {
      this.models[k].visible = k === this.current;
      this.object.add(this.models[k]);
    }
  }

  /** Swap which primitive group is visible. */
  setWeapon(slot: WeaponSlot): void {
    if (slot === this.current) return;
    this.models[this.current].visible = false;
    this.current = slot;
    this.models[slot].visible = true;
  }

  /** Recoil kick impulse on fire; rockets/knife kick harder than the AR. */
  onFire(slot: WeaponSlot): void {
    let scale = 1;
    if (slot === 2) scale = 2.2; // rocket thumps
    else if (slot === 3) scale = 1.4; // knife stab
    else if (slot === 4) scale = 1.2; // throw
    this.recoilZ += RECOIL_BACK * scale;
    this.recoilY += RECOIL_UP * scale;
    this.recoilPitch += RECOIL_PITCH * scale;
  }

  /**
   * Procedural sway (bob while moving) + recoil spring-back.
   * @param speed horizontal speed (m/s) for bob amplitude/rate
   * @param grounded suppress bob in the air for a floatier feel
   */
  update(dt: number, speed: number, grounded: boolean): void {
    const moving = grounded && speed > 0.5;

    // Advance bob phase by distance covered; fade amplitude with speed.
    if (moving) {
      this.bobPhase += speed * dt * BOB_PHASE_PER_M;
    }
    const ampScale = moving
      ? Math.min(1, speed / TUNING.movement.walkSpeed)
      : 0;
    const bobX = Math.cos(this.bobPhase) * BOB_X * ampScale;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * BOB_Y * ampScale;

    // Spring recoil back toward rest.
    this.recoilZ = damp(this.recoilZ, 0, RECOIL_RECOVER, dt);
    this.recoilY = damp(this.recoilY, 0, RECOIL_RECOVER, dt);
    this.recoilPitch = damp(this.recoilPitch, 0, RECOIL_RECOVER, dt);

    this.object.position.set(
      REST_X + bobX,
      REST_Y + bobY + this.recoilY,
      REST_Z + this.recoilZ,
    );
    this.object.rotation.set(this.recoilPitch, 0, 0);
  }
}
