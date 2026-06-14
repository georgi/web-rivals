// A stationary target dummy for the M2 local combat sandbox. Render-only state
// lives here; the capsule it exposes (capsuleTarget) is what hitscan and the
// explosion sim test against. Damage is applied locally in M2; M3 moves the
// authority to the server. Box-humanoid (stacked boxes, enemy-red, PRD §10)
// with a billboarded HP bar that follows the camera.

import * as THREE from 'three';
import { TUNING, clamp } from '@rivals/shared';
import type { Vec3 } from '@rivals/shared';
import type { CapsuleTarget } from '../combat/hitscan';
import { Humanoid } from './humanoid';

// Capsule the analytic/explosion math sees. Slightly wider/shorter than the
// player capsule so the humanoid silhouette reads as a fair target.
const RADIUS = 0.4;
const HALF_HEIGHT = 0.5; // cylinder half-segment; full hittable height ~1.8

const MAX_HP = TUNING.combat.spawnHealth;
const RESET_DELAY = 2.0; // seconds after the last hit -> heal back to full
const DEATH_HIDE = 0.5; // seconds the body stays hidden after a kill
const FLASH_TIME = 0.12; // seconds the body glows white after a hit

const HP_BAR_WIDTH = 1.0;
const HP_BAR_HEIGHT = 0.12;
const HP_BAR_LIFT = 1.35; // meters above capsule center

const BODY_COLOR = 0xff5a5a; // enemy-red (PRD §10)
const FLASH_COLOR = 0xffffff;
const HP_GREEN = new THREE.Color(0x46d35a);
const HP_RED = new THREE.Color(0xff4040);

// Scratch reused every frame; the HP bar billboard only needs the camera's
// world position, so no per-frame allocation here.
const _camPos = new THREE.Vector3();

export class Dummy {
  readonly object: THREE.Object3D;
  readonly id: number;

  center: Vec3;
  radius = RADIUS;
  halfHeight = HALF_HEIGHT;
  facingYaw: number;
  hp = MAX_HP;

  private readonly body: Humanoid;
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly hpBar: THREE.Sprite;
  private readonly hpBarMat: THREE.SpriteMaterial;

  private flash = 0; // remaining flash time
  private resetTimer = 0; // counts down to heal-to-full (0 = idle)
  private deathTimer = 0; // counts down while dead/hidden (0 = alive)

  // Reuse one Color instance for HP-bar tinting to avoid per-frame allocation.
  private readonly _tint = new THREE.Color();

  constructor(id: number, center: Vec3) {
    this.id = id;
    this.center = { x: center.x, y: center.y, z: center.z };
    this.facingYaw = Math.PI; // face back toward the arena / spawn

    this.object = new THREE.Group();
    this.object.name = `dummy:${id}`;
    this.object.position.set(center.x, center.y, center.z);
    this.object.rotation.y = this.facingYaw;

    // Shared material for all body boxes so a single color write flashes them.
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: BODY_COLOR,
      roughness: 0.85,
      metalness: 0.0,
      flatShading: true,
    });

    this.body = new Humanoid(this.bodyMat);
    this.object.add(this.body.object);

    // Billboarded HP bar. A SpriteMaterial with a canvas texture: the green/red
    // fill is drawn into the canvas and the texture updated only on change.
    this.hpBarMat = new THREE.SpriteMaterial({
      color: 0xffffff,
      depthTest: false,
      transparent: true,
    });
    this.hpBar = new THREE.Sprite(this.hpBarMat);
    this.hpBar.scale.set(HP_BAR_WIDTH, HP_BAR_HEIGHT, 1);
    this.hpBar.position.set(0, HP_BAR_LIFT, 0);
    this.hpBar.renderOrder = 999;
    this.object.add(this.hpBar);

    this.refreshHpBar();
  }

  capsuleTarget(): CapsuleTarget {
    return {
      id: this.id,
      center: this.center,
      radius: this.radius,
      halfHeight: this.halfHeight,
    };
  }

  applyDamage(amount: number): void {
    if (this.deathTimer > 0) return; // already dead; ignore until respawn
    this.hp = clamp(this.hp - amount, 0, MAX_HP);
    this.flash = FLASH_TIME;
    this.refreshHpBar();

    if (this.hp <= 0) {
      // Hide the body briefly, then respawn at full.
      this.deathTimer = DEATH_HIDE;
      this.resetTimer = 0;
      this.body.object.visible = false;
      this.hpBar.visible = false;
    } else {
      // (Re)start the heal-back timer on every non-fatal hit.
      this.resetTimer = RESET_DELAY;
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    // --- death / respawn ---
    if (this.deathTimer > 0) {
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) {
        this.deathTimer = 0;
        this.hp = MAX_HP;
        this.body.object.visible = true;
        this.hpBar.visible = true;
        this.flash = 0;
        this.bodyMat.color.setHex(BODY_COLOR);
        this.refreshHpBar();
      }
      return; // hidden: skip flash/billboard work
    }

    // --- heal-to-full timer ---
    if (this.resetTimer > 0) {
      this.resetTimer -= dt;
      if (this.resetTimer <= 0) {
        this.resetTimer = 0;
        this.hp = MAX_HP;
        this.refreshHpBar();
      }
    }

    // --- flash decay (lerp body color back to enemy-red) ---
    if (this.flash > 0) {
      this.flash -= dt;
      const t = clamp(this.flash / FLASH_TIME, 0, 1);
      this.bodyMat.color.setHex(BODY_COLOR).lerp(FLASH_WHITE, t);
      if (this.flash <= 0) {
        this.flash = 0;
        this.bodyMat.color.setHex(BODY_COLOR);
      }
    }

    // --- idle animation (stationary target → breathing only) ---
    this.body.update(dt, 0, true);

    // --- billboard the HP bar toward the camera (yaw only via Sprite) ---
    // THREE.Sprite already faces the camera; nothing to rotate. Keep the camera
    // reference used so the signature stays honest and future bars (text) can
    // orient. Touch camera world pos to avoid an unused-param lint and to allow
    // distance-based scaling later.
    camera.getWorldPosition(_camPos);
  }

  private refreshHpBar(): void {
    const frac = clamp(this.hp / MAX_HP, 0, 1);
    this._tint.copy(HP_RED).lerp(HP_GREEN, frac);
    this.hpBarMat.color.copy(this._tint);
    // Shrink the bar width to the fill fraction so it drains left-to-right.
    this.hpBar.scale.x = HP_BAR_WIDTH * Math.max(frac, 0.001);
    // Keep the (shrinking) bar left-anchored under the head.
    this.hpBar.position.x = -((HP_BAR_WIDTH - this.hpBar.scale.x) / 2);
  }
}

const FLASH_WHITE = new THREE.Color(FLASH_COLOR);
