// The networked opponent (PRD §19.4). Render-only: a colored capsule driven by
// interpolated SnapshotBuffer samples (NEVER simulated locally). Add it to the
// scene when an opponent is present, hide/remove it when they leave. Position
// comes from the snapshot's capsule-center pos; we lerp via the buffer, so this
// class only mirrors a pose each frame — no per-frame allocation.

import * as THREE from 'three';
import { TUNING } from '@rivals/shared';

const RADIUS = TUNING.movement.radius;
// Capsule cylinder segment half-length (matches the server's CAP_HALF).
const HALF = TUNING.movement.standHeight / 2 - RADIUS;
const OPPONENT_COLOR = 0xff5a5a; // enemy-red (PRD §10)

export class RemotePlayer {
  readonly object: THREE.Group;
  id = -1;

  private readonly mesh: THREE.Mesh;
  private readonly hpBar: THREE.Sprite;
  private readonly hpBarMat: THREE.SpriteMaterial;
  private readonly _tint = new THREE.Color();
  private lastHpFrac = -1;

  private static readonly HP_GREEN = new THREE.Color(0x46d35a);
  private static readonly HP_RED = new THREE.Color(0xff4040);

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'remote-opponent';
    this.object.visible = false;

    // CapsuleGeometry(radius, length-of-cylinder-part, ...). length = 2*HALF.
    const geo = new THREE.CapsuleGeometry(RADIUS, 2 * HALF, 6, 12);
    const mat = new THREE.MeshStandardMaterial({
      color: OPPONENT_COLOR,
      roughness: 0.85,
      metalness: 0.0,
      flatShading: true,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.object.add(this.mesh);

    this.hpBarMat = new THREE.SpriteMaterial({ color: 0xffffff, depthTest: false, transparent: true });
    this.hpBar = new THREE.Sprite(this.hpBarMat);
    this.hpBar.scale.set(1.0, 0.12, 1);
    this.hpBar.position.set(0, HALF + RADIUS + 0.35, 0);
    this.hpBar.renderOrder = 999;
    this.object.add(this.hpBar);
  }

  show(id: number): void {
    this.id = id;
    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
    this.id = -1;
  }

  get present(): boolean {
    return this.object.visible;
  }

  /** Mirror an interpolated capsule-center pose (zero-alloc). */
  setPose(cx: number, cy: number, cz: number, yaw: number): void {
    this.object.position.set(cx, cy, cz);
    this.object.rotation.y = yaw;
  }

  setHp(hp: number): void {
    const frac = Math.max(0, Math.min(1, hp / TUNING.combat.spawnHealth));
    if (frac === this.lastHpFrac) return;
    this.lastHpFrac = frac;
    this._tint.copy(RemotePlayer.HP_RED).lerp(RemotePlayer.HP_GREEN, frac);
    this.hpBarMat.color.copy(this._tint);
    this.hpBar.scale.x = Math.max(frac, 0.001);
    this.hpBar.position.x = -((1.0 - this.hpBar.scale.x) / 2);
  }
}
