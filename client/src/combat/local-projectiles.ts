// M2 LOCAL-ONLY projectiles. Renders + simulates rockets/grenades client-side
// using the EXISTING shared ballistics (stepProjectile/computeExplosion) — no
// reimplementation. On detonation it resolves damage/knockback through hooks so
// the integration layer applies them to the dummy and the local player (rocket
// jump). The server takes this over in M3; this class disappears then.

import * as THREE from 'three';
import type { Vec3, ProjKind, TraceWorld, Projectile, ExplosionHit } from '@rivals/shared';
import {
  TUNING,
  makeProjectile,
  stepProjectile,
  computeExplosion,
  v3,
} from '@rivals/shared';
import type { CapsuleTarget } from './hitscan';
import type { Particles } from '../render/particles';

export interface ProjectileHooks {
  localPlayerId: number;
  targets(): CapsuleTarget[]; // explosion candidates this frame (dummy + local player)
  onDamage(id: number, amount: number): void; // apply damage to entity id
  onImpulse(id: number, impulse: Vec3): void; // apply knockback (localPlayerId -> rocket jump)
  onDetonate?(pos: Vec3): void; // detonation FX cue (e.g. spatial explosion audio)
}

// Pre-sized pool: more than enough in flight at once (rocket fires ~0.83/s,
// grenade 1 carried). Spawning past capacity overwrites the oldest live one.
const POOL = 16;

// Emit a smoke puff roughly every this many metres of rocket travel.
const SMOKE_SPACING = 0.6;

// Direct-hit slop: a rocket counts as a direct hit on a capsule when the
// detonation point sits within (radius + this) of the capsule core segment.
const DIRECT_HIT_SLOP = 0.25;

// ---- module scratch (zero-alloc hot path) ----
const _step = { detonated: false, point: v3() };
const _impulse = v3();

interface Slot {
  proj: Projectile;
  mesh: THREE.Mesh;
  active: boolean;
  smokeAccum: number; // metres travelled since last smoke puff
  lastX: number;
  lastY: number;
  lastZ: number;
}

export class LocalProjectiles {
  readonly object: THREE.Group;

  private readonly world: TraceWorld;
  private readonly particles: Particles;
  private readonly hooks: ProjectileHooks;

  private readonly slots: Slot[] = [];
  private nextId = 1;
  private head = 0; // ring cursor for overwrite-oldest on overflow

  // Reused explosion-candidate buffer: shared computeExplosion wants
  // PlayerCapsule[]; CapsuleTarget is structurally identical, so we copy the
  // per-frame target list into a stable array to avoid per-detonation alloc.
  private readonly players: CapsuleTarget[] = [];

  // Two materials, built once.
  private readonly rocketMat: THREE.MeshBasicMaterial;
  private readonly grenadeMat: THREE.MeshStandardMaterial;
  private readonly rocketGeo: THREE.CylinderGeometry;
  private readonly grenadeGeo: THREE.SphereGeometry;

  constructor(world: TraceWorld, particles: Particles, hooks: ProjectileHooks) {
    this.world = world;
    this.particles = particles;
    this.hooks = hooks;

    this.object = new THREE.Group();
    this.object.name = 'projectiles';

    this.rocketMat = new THREE.MeshBasicMaterial({ color: 0xffcf6a });
    this.grenadeMat = new THREE.MeshStandardMaterial({
      color: 0x3a4a30,
      roughness: 0.8,
      metalness: 0.1,
      flatShading: true,
    });
    // Rocket: a short tube laid along +Z (we orient it to velocity at spawn).
    this.rocketGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.5, 8);
    this.rocketGeo.rotateX(Math.PI / 2); // align cylinder axis (+Y) to +Z
    this.grenadeGeo = new THREE.SphereGeometry(0.13, 8, 6);

    // Pre-allocate the pool: a dummy Projectile + a hidden mesh per slot.
    for (let i = 0; i < POOL; i++) {
      const proj = makeProjectile(0, 'rocket', v3(), v3(), 0, 0);
      proj.alive = false;
      const mesh = new THREE.Mesh(this.rocketGeo, this.rocketMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.object.add(mesh);
      this.slots.push({ proj, mesh, active: false, smokeAccum: 0, lastX: 0, lastY: 0, lastZ: 0 });
    }
  }

  // velocity = dir * TUNING[kind].projSpeed; grenades get a fuse.
  spawn(kind: ProjKind, origin: Vec3, dir: Vec3, ownerId: number): void {
    const slot = this.acquire();
    const speed = TUNING[kind].projSpeed;
    const fuse = kind === 'grenade' ? TUNING.grenade.fuse : 0;

    const p = slot.proj;
    p.id = this.nextId++;
    p.kind = kind;
    p.pos.x = origin.x;
    p.pos.y = origin.y;
    p.pos.z = origin.z;
    p.vel.x = dir.x * speed;
    p.vel.y = dir.y * speed;
    p.vel.z = dir.z * speed;
    p.ownerId = ownerId;
    p.fuse = fuse;
    p.alive = true;

    slot.active = true;
    slot.smokeAccum = 0;
    slot.lastX = origin.x;
    slot.lastY = origin.y;
    slot.lastZ = origin.z;

    // Swap the mesh geometry/material to match the kind.
    slot.mesh.geometry = kind === 'rocket' ? this.rocketGeo : this.grenadeGeo;
    slot.mesh.material = kind === 'rocket' ? this.rocketMat : this.grenadeMat;
    slot.mesh.position.set(origin.x, origin.y, origin.z);
    if (kind === 'rocket') {
      // Point the tube down its travel direction.
      slot.mesh.lookAt(origin.x + dir.x, origin.y + dir.y, origin.z + dir.z);
    } else {
      slot.mesh.rotation.set(0, 0, 0);
    }
    slot.mesh.visible = true;
  }

  update(dt: number): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.active) continue;
      const p = slot.proj;

      stepProjectile(p, this.world, dt, _step);

      // Move the mesh to the projectile's new position.
      slot.mesh.position.set(p.pos.x, p.pos.y, p.pos.z);

      // Smoke trail for rockets, every SMOKE_SPACING metres of travel.
      if (p.kind === 'rocket') {
        const dx = p.pos.x - slot.lastX;
        const dy = p.pos.y - slot.lastY;
        const dz = p.pos.z - slot.lastZ;
        slot.smokeAccum += Math.hypot(dx, dy, dz);
        slot.lastX = p.pos.x;
        slot.lastY = p.pos.y;
        slot.lastZ = p.pos.z;
        if (slot.smokeAccum >= SMOKE_SPACING) {
          slot.smokeAccum = 0;
          this.particles.smoke(p.pos);
        }
        // Keep the tube oriented to velocity.
        slot.mesh.lookAt(p.pos.x + p.vel.x, p.pos.y + p.vel.y, p.pos.z + p.vel.z);
      }

      if (_step.detonated) {
        this.detonate(slot);
      }
    }
  }

  private detonate(slot: Slot): void {
    const p = slot.proj;
    this.particles.explosion(p.pos);
    this.hooks.onDetonate?.(p.pos);

    // Build the candidate list from this frame's targets (stable array reuse).
    const targets = this.hooks.targets();
    this.players.length = 0;
    let directHitId: number | undefined;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      this.players.push(t);
      // Direct hit (rocket only): detonation point within radius+slop of the
      // capsule's vertical core segment.
      if (p.kind === 'rocket' && directHitId === undefined) {
        if (this.withinCapsule(p.pos, t, DIRECT_HIT_SLOP)) directHitId = t.id;
      }
    }

    const hits: ExplosionHit[] = computeExplosion(
      p.kind,
      p.pos,
      p.ownerId,
      this.players,
      this.world,
      directHitId,
    );
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (h.damage > 0) this.hooks.onDamage(h.id, h.damage);
      _impulse.x = h.impulse.x;
      _impulse.y = h.impulse.y;
      _impulse.z = h.impulse.z;
      this.hooks.onImpulse(h.id, _impulse);
    }

    // Retire the slot.
    slot.active = false;
    slot.proj.alive = false;
    slot.mesh.visible = false;
  }

  // Retire every live projectile (e.g. on a session/match teardown) so stale
  // rockets/grenades never linger into the next match.
  clear(): void {
    for (const slot of this.slots) {
      slot.active = false;
      slot.proj.alive = false;
      slot.mesh.visible = false;
    }
  }

  // Distance from `point` to the capsule's vertical core segment < radius + slop.
  private withinCapsule(point: Vec3, t: CapsuleTarget, slop: number): boolean {
    const segBottom = t.center.y - t.halfHeight;
    const segTop = t.center.y + t.halfHeight;
    const cy = point.y < segBottom ? segBottom : point.y > segTop ? segTop : point.y;
    const dx = point.x - t.center.x;
    const dy = point.y - cy;
    const dz = point.z - t.center.z;
    const r = t.radius + slop;
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  // Grab a free slot, or overwrite the oldest live one (ring) if the pool is full.
  private acquire(): Slot {
    for (let i = 0; i < this.slots.length; i++) {
      if (!this.slots[i].active) return this.slots[i];
    }
    const slot = this.slots[this.head];
    this.head = (this.head + 1) % this.slots.length;
    return slot;
  }
}
