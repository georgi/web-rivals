// Hand-written pointer-lock mouselook. Owns yaw/pitch; applyTo() drives a THREE
// camera from the sim's eye position. No Three controls dep (PRD §10).

import * as THREE from 'three';
import { DEG2RAD } from '@rivals/shared';

const PITCH_LIMIT = 85 * DEG2RAD; // clamp ±85°
const DEFAULT_SENSITIVITY = 0.0022; // radians per device pixel

export class PointerLockCamera {
  yaw = 0;
  pitch = 0;
  sensitivity = DEFAULT_SENSITIVITY;

  private readonly canvas: HTMLCanvasElement;
  private _locked = false;
  private lockCbs: Array<(locked: boolean) => void> = [];
  private lastFov = -1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
  }

  get locked(): boolean {
    return this._locked;
  }

  requestLock(): void {
    this.canvas.requestPointerLock();
  }

  onLockChange(cb: (locked: boolean) => void): void {
    this.lockCbs.push(cb);
  }

  private onPointerLockChange = (): void => {
    this._locked = document.pointerLockElement === this.canvas;
    for (const cb of this.lockCbs) cb(this._locked);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this._locked) return;
    this.yaw -= e.movementX * this.sensitivity;
    this.pitch -= e.movementY * this.sensitivity;
    if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
    else if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
  };

  /** Drive a THREE camera: position at eye, orientation from yaw/pitch, fov. */
  applyTo(
    camera: THREE.PerspectiveCamera,
    eye: { x: number; y: number; z: number },
    fovDeg: number,
  ): void {
    camera.position.set(eye.x, eye.y, eye.z);
    // YXZ: yaw about world-up first, then pitch about local-x — no roll.
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    if (fovDeg !== this.lastFov) {
      camera.fov = fovDeg;
      camera.updateProjectionMatrix();
      this.lastFov = fovDeg;
    }
  }

  destroy(): void {
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.lockCbs = [];
  }
}
