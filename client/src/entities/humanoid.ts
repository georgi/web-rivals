// Procedural articulated humanoid — the blocky Rivals-style body shared by the
// networked opponent and the practice dummy. Limbs hang from shoulder/hip pivot
// groups so a single X-rotation swings each one; the update() drives a
// speed-scaled contralateral walk/run cycle, a subtle idle breath when still,
// and a tucked airborne pose. No skeletons/assets — all code, zero per-frame
// alloc (only scalar rotations are written).

import * as THREE from 'three';
import { TUNING, damp } from '@rivals/shared';

// Proportions (local space; y=0 is the capsule centre, matching the entity
// transforms). Tuned to fill the ~1.8m standing capsule silhouette.
const TORSO = { w: 0.5, h: 0.7, d: 0.28, y: 0.15 };
const HEAD = { s: 0.34, y: 0.68 };
const ARM = { w: 0.16, h: 0.6, d: 0.18, x: 0.37, pivotY: 0.48 };
const LEG = { w: 0.2, h: 0.7, d: 0.22, x: 0.13, pivotY: -0.2 };

// Gait: phase advances by distance travelled so stride frequency tracks speed;
// amplitudes are reached near sprint speed.
const STEP_PER_M = 1.35; // radians of cycle phase per metre travelled
const RUN_REF = TUNING.movement.sprintSpeed; // speed at which amp saturates
const MOVE_EPS = 0.4; // m/s below which we treat the body as standing
const MAX_LEG = 0.85; // peak leg swing (rad)
const MAX_ARM = 0.55; // peak arm swing (rad)
const ARM_REST = 0.06; // slight forward arm rest so they aren't dead straight
const BREATHE_HZ = 1.4; // idle breathing rate

// Make a limb that hangs below a pivot group, so rotating the pivot swings the
// limb from the shoulder/hip. Returns the pivot to parent + animate.
function limb(
  mat: THREE.MeshStandardMaterial,
  w: number,
  h: number,
  d: number,
  x: number,
  pivotY: number,
): THREE.Group {
  const pivot = new THREE.Group();
  pivot.position.set(x, pivotY, 0);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(0, -h / 2, 0); // top of the limb sits at the pivot
  pivot.add(mesh);
  return pivot;
}

export class Humanoid {
  readonly object: THREE.Group;

  private readonly torso: THREE.Group;
  private readonly lArm: THREE.Group;
  private readonly rArm: THREE.Group;
  private readonly lLeg: THREE.Group;
  private readonly rLeg: THREE.Group;

  private phase = 0; // gait cycle phase (advances with distance)
  private time = 0; // wall time (idle breathing)
  private amp = 0; // damped move amplitude 0..1
  private air = 0; // damped airborne blend 0..1

  constructor(mat: THREE.MeshStandardMaterial) {
    this.object = new THREE.Group();

    // Torso group also carries the head + arms so the idle breath lifts them
    // together; legs hang off the root so they stay planted.
    this.torso = new THREE.Group();
    const torsoMesh = new THREE.Mesh(
      new THREE.BoxGeometry(TORSO.w, TORSO.h, TORSO.d),
      mat,
    );
    torsoMesh.position.set(0, TORSO.y, 0);
    const headMesh = new THREE.Mesh(
      new THREE.BoxGeometry(HEAD.s, HEAD.s, HEAD.s),
      mat,
    );
    headMesh.position.set(0, HEAD.y, 0);
    this.torso.add(torsoMesh, headMesh);

    this.lArm = limb(mat, ARM.w, ARM.h, ARM.d, -ARM.x, ARM.pivotY);
    this.rArm = limb(mat, ARM.w, ARM.h, ARM.d, ARM.x, ARM.pivotY);
    this.torso.add(this.lArm, this.rArm);

    this.lLeg = limb(mat, LEG.w, LEG.h, LEG.d, -LEG.x, LEG.pivotY);
    this.rLeg = limb(mat, LEG.w, LEG.h, LEG.d, LEG.x, LEG.pivotY);

    this.object.add(this.torso, this.lLeg, this.rLeg);
  }

  /**
   * Advance the animation.
   * @param speed horizontal speed (m/s) — drives stride freq + amplitude
   * @param grounded false blends toward the tucked airborne pose
   */
  update(dt: number, speed: number, grounded: boolean): void {
    this.time += dt;

    const moving = speed > MOVE_EPS;
    if (moving) this.phase += speed * dt * STEP_PER_M;

    // Damp the move amplitude + air blend so transitions don't snap.
    const targetAmp = moving ? Math.min(speed / RUN_REF, 1) : 0;
    this.amp = damp(this.amp, targetAmp, 9, dt);
    this.air = damp(this.air, grounded ? 0 : 1, 10, dt);

    // --- grounded gait ---
    const swing = Math.sin(this.phase);
    const legA = swing * MAX_LEG * this.amp;
    const armA = -swing * MAX_ARM * this.amp; // arms counter the legs

    // --- airborne pose: front leg tucks up, back leg trails, arms raise ---
    const legAir = 0.7; // both legs rotate forward/up a touch in the air
    const armAir = -0.5; // arms come up

    const a = this.air;
    this.lLeg.rotation.x = legA * (1 - a) + legAir * a;
    this.rLeg.rotation.x = -legA * (1 - a) + legAir * 0.4 * a;
    this.lArm.rotation.x = (ARM_REST + armA) * (1 - a) + armAir * a;
    this.rArm.rotation.x = (ARM_REST - armA) * (1 - a) + armAir * a;

    // --- idle breathing (only when essentially still + grounded) ---
    const stillness = (1 - this.amp) * (1 - this.air);
    const breath = Math.sin(this.time * BREATHE_HZ * Math.PI * 2);
    this.torso.position.y = breath * 0.012 * stillness;
    this.torso.rotation.x = breath * 0.02 * stillness;
  }
}
