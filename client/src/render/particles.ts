// Cosmetic combat FX: tracers, impacts, explosions, smoke. ALL pools are
// pre-allocated at construction; update(dt) only mutates existing objects
// (position/scale/opacity/visible). Zero per-frame allocation — GC pauses read
// as stutter (PRD §10). object is a Group the caller adds to the scene once.

import * as THREE from 'three';
import type { Vec3 } from '@rivals/shared';
import { TUNING } from '@rivals/shared';

// Pool sizes: generous enough that fast fire never starves a pool, small enough
// to stay cheap. Oldest-in-flight is overwritten when a pool wraps (ring buffer).
const TRACER_POOL = 48;
const IMPACT_POOL = 24;
const IMPACT_SPARKS = 10; // points per impact burst
const EXPLOSION_POOL = 8;
const EXPLOSION_DEBRIS = 14; // points per explosion burst
const SMOKE_POOL = 96;

// Lifetimes (seconds).
const IMPACT_LIFE = 0.35;
const EXPLOSION_LIFE = 0.5;
const SMOKE_LIFE = 0.9;

// ---- module scratch (zero-alloc) ----
const _v = new THREE.Vector3();

// A single fading line drawn with two buffer vertices; visible toggled per use.
interface TracerSlot {
  line: THREE.Line;
  positions: Float32Array; // 6 floats: from(xyz), to(xyz)
  life: number; // seconds remaining; <=0 means free
}

// A small Points burst (sparks/debris): each point gets an outward velocity so
// the cloud expands. Velocities live in a parallel Float32Array.
interface BurstSlot {
  points: THREE.Points;
  positions: Float32Array; // count*3
  velocities: Float32Array; // count*3
  count: number;
  life: number;
  maxLife: number;
}

interface SphereSlot {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

export class Particles {
  readonly object: THREE.Group;

  private readonly tracers: TracerSlot[] = [];
  private tracerHead = 0;

  private readonly impacts: BurstSlot[] = [];
  private impactHead = 0;

  private readonly explosionFlashes: SphereSlot[] = [];
  private readonly explosionDebris: BurstSlot[] = [];
  private explosionHead = 0;

  private readonly smokes: SphereSlot[] = [];
  private smokeHead = 0;

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'particles';
    // FX never occlude themselves oddly and read against geometry; skip frustum
    // culling churn — these are tiny and short-lived.
    this.object.frustumCulled = false;

    this.buildTracers();
    this.buildImpacts();
    this.buildExplosions();
    this.buildSmoke();
  }

  // ---- construction: every object made once, hidden until used ----

  private buildTracers(): void {
    const mat = new THREE.LineBasicMaterial({
      color: 0xffe08a,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    for (let i = 0; i < TRACER_POOL; i++) {
      const positions = new Float32Array(6);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      // Per-slot material clone so each tracer fades on its own opacity.
      const line = new THREE.Line(geo, mat.clone());
      line.visible = false;
      line.frustumCulled = false;
      this.object.add(line);
      this.tracers.push({ line, positions, life: 0 });
    }
  }

  private buildImpacts(): void {
    for (let i = 0; i < IMPACT_POOL; i++) {
      this.impacts.push(this.makeBurst(IMPACT_SPARKS, 0xffd27a, 0.06));
    }
  }

  private buildExplosions(): void {
    const flashGeo = new THREE.SphereGeometry(1, 12, 8);
    for (let i = 0; i < EXPLOSION_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffa83a,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(flashGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.object.add(mesh);
      this.explosionFlashes.push({ mesh, life: 0, maxLife: EXPLOSION_LIFE });
      this.explosionDebris.push(this.makeBurst(EXPLOSION_DEBRIS, 0x9a9088, 0.1));
    }
  }

  private buildSmoke(): void {
    const geo = new THREE.SphereGeometry(1, 6, 5);
    for (let i = 0; i < SMOKE_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xb9bcc2,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.object.add(mesh);
      this.smokes.push({ mesh, life: 0, maxLife: SMOKE_LIFE });
    }
  }

  private makeBurst(count: number, color: number, size: number): BurstSlot {
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color,
      size,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.visible = false;
    points.frustumCulled = false;
    this.object.add(points);
    return { points, positions, velocities, count, life: 0, maxLife: IMPACT_LIFE };
  }

  // ---- emit (no allocation; reuse next ring slot) ----

  tracer(from: Vec3, to: Vec3): void {
    const slot = this.tracers[this.tracerHead];
    this.tracerHead = (this.tracerHead + 1) % TRACER_POOL;
    const p = slot.positions;
    p[0] = from.x;
    p[1] = from.y;
    p[2] = from.z;
    p[3] = to.x;
    p[4] = to.y;
    p[5] = to.z;
    (slot.line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    slot.life = TUNING.ar.tracerFade;
    slot.line.visible = true;
    (slot.line.material as THREE.LineBasicMaterial).opacity = 1;
  }

  impact(point: Vec3, normal: Vec3): void {
    const slot = this.impacts[this.impactHead];
    this.impactHead = (this.impactHead + 1) % IMPACT_POOL;
    // Sparks fly out roughly along the surface normal, spread into a cone.
    this.seedBurst(slot, point, normal, 3.5, 1.0, IMPACT_LIFE);
  }

  explosion(point: Vec3): void {
    const flash = this.explosionFlashes[this.explosionHead];
    const debris = this.explosionDebris[this.explosionHead];
    this.explosionHead = (this.explosionHead + 1) % EXPLOSION_POOL;

    flash.mesh.position.set(point.x, point.y, point.z);
    flash.mesh.scale.setScalar(0.2);
    flash.mesh.visible = true;
    (flash.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    flash.life = flash.maxLife;

    // Debris sprays in all directions (normal +y, wide spread).
    _v.set(0, 1, 0);
    this.seedBurst(debris, point, _v, 6.0, 1.0, EXPLOSION_LIFE);
  }

  smoke(point: Vec3): void {
    const slot = this.smokes[this.smokeHead];
    this.smokeHead = (this.smokeHead + 1) % SMOKE_POOL;
    slot.mesh.position.set(point.x, point.y, point.z);
    slot.mesh.scale.setScalar(0.12);
    slot.mesh.visible = true;
    (slot.mesh.material as THREE.MeshBasicMaterial).opacity = 0.5;
    slot.life = slot.maxLife;
  }

  // Seed a burst's points at `origin`, each with an outward velocity biased
  // toward `dir` (unit) with `spread` (0..1 = none..hemisphere) and `speed` m/s.
  private seedBurst(
    slot: BurstSlot,
    origin: Vec3,
    dir: Vec3,
    speed: number,
    spread: number,
    life: number,
  ): void {
    const pos = slot.positions;
    const vel = slot.velocities;
    for (let i = 0; i < slot.count; i++) {
      const j = i * 3;
      pos[j] = origin.x;
      pos[j + 1] = origin.y;
      pos[j + 2] = origin.z;
      // Random direction in a cone around dir: jitter each axis then bias.
      const rx = (Math.random() - 0.5) * 2 * spread;
      const ry = (Math.random() - 0.5) * 2 * spread;
      const rz = (Math.random() - 0.5) * 2 * spread;
      let vx = dir.x + rx;
      let vy = dir.y + ry + 0.3; // slight upward bias so bursts loft
      let vz = dir.z + rz;
      const len = Math.hypot(vx, vy, vz) || 1;
      const s = (speed * (0.5 + Math.random() * 0.5)) / len;
      vx *= s;
      vy *= s;
      vz *= s;
      vel[j] = vx;
      vel[j + 1] = vy;
      vel[j + 2] = vz;
    }
    (slot.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    slot.points.position.set(0, 0, 0);
    slot.points.visible = true;
    (slot.points.material as THREE.PointsMaterial).opacity = 1;
    slot.life = life;
    slot.maxLife = life;
  }

  // ---- advance all live FX; recycle when life expires ----

  update(dt: number): void {
    this.updateTracers(dt);
    this.updateBursts(this.impacts, dt, true);
    this.updateExplosions(dt);
    this.updateSmoke(dt);
  }

  private updateTracers(dt: number): void {
    const fade = TUNING.ar.tracerFade || 0.0001;
    for (let i = 0; i < this.tracers.length; i++) {
      const t = this.tracers[i];
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.line.visible = false;
        continue;
      }
      (t.line.material as THREE.LineBasicMaterial).opacity = t.life / fade;
    }
  }

  private updateBursts(slots: BurstSlot[], dt: number, gravity: boolean): void {
    for (let s = 0; s < slots.length; s++) {
      this.stepBurst(slots[s], dt, gravity);
    }
  }

  private stepBurst(slot: BurstSlot, dt: number, gravity: boolean): void {
    if (slot.life <= 0) return;
    slot.life -= dt;
    if (slot.life <= 0) {
      slot.points.visible = false;
      return;
    }
    const pos = slot.positions;
    const vel = slot.velocities;
    const g = gravity ? 14 * dt : 0;
    for (let i = 0; i < slot.count; i++) {
      const j = i * 3;
      vel[j + 1] -= g;
      pos[j] += vel[j] * dt;
      pos[j + 1] += vel[j + 1] * dt;
      pos[j + 2] += vel[j + 2] * dt;
    }
    (slot.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (slot.points.material as THREE.PointsMaterial).opacity = slot.life / slot.maxLife;
  }

  private updateExplosions(dt: number): void {
    for (let i = 0; i < this.explosionFlashes.length; i++) {
      const f = this.explosionFlashes[i];
      if (f.life > 0) {
        f.life -= dt;
        if (f.life <= 0) {
          f.mesh.visible = false;
        } else {
          const t = 1 - f.life / f.maxLife; // 0..1 over the life
          // Expand fast then ease; fade opacity out.
          f.mesh.scale.setScalar(0.2 + t * 2.6);
          (f.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - t;
        }
      }
      this.stepBurst(this.explosionDebris[i], dt, true);
    }
  }

  private updateSmoke(dt: number): void {
    for (let i = 0; i < this.smokes.length; i++) {
      const s = this.smokes[i];
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.mesh.visible = false;
        continue;
      }
      const t = 1 - s.life / s.maxLife; // 0..1
      s.mesh.position.y += 0.4 * dt; // puffs rise gently
      s.mesh.scale.setScalar(0.12 + t * 0.5);
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - t);
    }
  }
}
