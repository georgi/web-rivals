// Multi-opponent manager for FFA (PRD §19.4 generalized to N). Owns a pool of
// RemotePlayer entries keyed by player id; each is the animated blocky humanoid
// + hp bar driven by interpolated snapshot poses (remotes are NEVER simulated
// locally). One root Group is added to the scene once. Zero per-frame allocation
// beyond the RemotePlayer's own (which is already alloc-free per pose).

import * as THREE from 'three';
import type { CapsuleTarget } from '../combat/hitscan';
import { TUNING } from '@rivals/shared';
import { RemotePlayer } from './remote-player';

const RADIUS = TUNING.movement.radius;
const HALF = TUNING.movement.standHeight / 2 - RADIUS;

export class RemotePlayers {
  readonly object: THREE.Group;
  private readonly entries = new Map<number, RemotePlayer>();

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'remote-players';
  }

  /** Ensure an opponent with this id is present + visible (idempotent). */
  setPresent(id: number, _name: string): void {
    let e = this.entries.get(id);
    if (!e) {
      e = new RemotePlayer();
      this.entries.set(id, e);
      this.object.add(e.object);
    }
    e.show(id);
  }

  /** Hide + retire an opponent (kept in the pool group, just invisible). */
  setAbsent(id: number): void {
    const e = this.entries.get(id);
    if (e) e.hide();
  }

  /** Ids currently shown. */
  activeIds(): number[] {
    const ids: number[] = [];
    for (const [id, e] of this.entries) if (e.present) ids.push(id);
    return ids;
  }

  setPose(id: number, cx: number, cy: number, cz: number, yaw: number): void {
    this.entries.get(id)?.setPose(cx, cy, cz, yaw);
  }

  setHp(id: number, hp: number): void {
    this.entries.get(id)?.setHp(hp);
  }

  /** Advance every present opponent's walk/idle animation. */
  update(dt: number): void {
    for (const e of this.entries.values()) if (e.present) e.update(dt);
  }

  /** Capsule targets for the cosmetic client-side hitscan (all present opponents). */
  liveTargets(): CapsuleTarget[] {
    const out: CapsuleTarget[] = [];
    for (const [id, e] of this.entries) {
      if (!e.present) continue;
      const p = e.object.position;
      out.push({ id, center: { x: p.x, y: p.y, z: p.z }, radius: RADIUS, halfHeight: HALF });
    }
    return out;
  }

  /** Hide everyone (e.g. leaving online mode). */
  hideAll(): void {
    for (const e of this.entries.values()) e.hide();
  }
}
