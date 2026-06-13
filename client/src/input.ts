// Keyboard/mouse -> protocol Button bitfield + buffered jump edge. The sim
// consumes InputFrame; this layer owns the 100ms jump buffer (PRD §4, §24.2).

import { Button, TUNING } from '@rivals/shared';
import type { InputFrame } from '@rivals/shared';

export class Input {
  selectedWeapon = 1; // 1..4 (M2 weapon select)

  private readonly target: HTMLElement;
  private buttonState = 0;
  private enabled = true;

  // Jump buffering (ms timestamps via performance.now()).
  private lastJumpPress = -Infinity;
  private jumpConsumed = true;
  private readonly bufferMs = TUNING.movement.inputBufferTime * 1000;

  constructor(target: HTMLElement) {
    this.target = target;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('mousedown', this.onMouseDown);
    target.addEventListener('mouseup', this.onMouseUp);
    target.addEventListener('wheel', this.onWheel, { passive: true });
    // Drop mouse buttons if the pointer leaves / context is lost.
    target.addEventListener('contextmenu', this.onContextMenu);
  }

  get buttons(): number {
    return this.buttonState;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.buttonState = 0;
      this.jumpConsumed = true;
    }
  }

  /** Map a KeyboardEvent.code to a Button bit, or 0 if unbound. */
  private codeToButton(code: string): number {
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        return Button.Forward;
      case 'KeyS':
      case 'ArrowDown':
        return Button.Back;
      case 'KeyA':
      case 'ArrowLeft':
        return Button.Left;
      case 'KeyD':
      case 'ArrowRight':
        return Button.Right;
      case 'ShiftLeft':
      case 'ShiftRight':
        return Button.Sprint;
      case 'Space':
        return Button.Jump;
      case 'ControlLeft':
      case 'KeyC':
        return Button.Crouch;
      case 'KeyR':
        return Button.Reload;
      default:
        return 0;
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    // Weapon select 1..4.
    if (e.code === 'Digit1') this.selectedWeapon = 1;
    else if (e.code === 'Digit2') this.selectedWeapon = 2;
    else if (e.code === 'Digit3') this.selectedWeapon = 3;
    else if (e.code === 'Digit4') this.selectedWeapon = 4;

    const bit = this.codeToButton(e.code);
    if (bit === 0) return;
    if (e.repeat) {
      // Keep state set, but don't re-arm the jump buffer on auto-repeat.
      this.buttonState |= bit;
      return;
    }
    this.buttonState |= bit;
    if (bit === Button.Jump) {
      this.lastJumpPress = performance.now();
      this.jumpConsumed = false;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const bit = this.codeToButton(e.code);
    if (bit !== 0) this.buttonState &= ~bit;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.enabled) return;
    if (e.button === 0) this.buttonState |= Button.Fire;
    else if (e.button === 2) this.buttonState |= Button.AltFire;
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.buttonState &= ~Button.Fire;
    else if (e.button === 2) this.buttonState &= ~Button.AltFire;
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    const dir = e.deltaY > 0 ? 1 : -1;
    // Cycle 1..4, wrapping.
    this.selectedWeapon = ((this.selectedWeapon - 1 + dir + 4) % 4) + 1;
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  /** Build the per-tick frame the sim consumes. jump = unconsumed buffered edge. */
  buildFrame(yaw: number, pitch: number): InputFrame {
    let jump = false;
    if (this.enabled && !this.jumpConsumed) {
      jump = performance.now() - this.lastJumpPress <= this.bufferMs;
    }
    return { buttons: this.enabled ? this.buttonState : 0, yaw, pitch, jump };
  }

  /** Call after stepMovement when events.jumped, to clear the buffer. */
  consumeJump(): void {
    this.jumpConsumed = true;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('mousedown', this.onMouseDown);
    this.target.removeEventListener('mouseup', this.onMouseUp);
    this.target.removeEventListener('wheel', this.onWheel);
    this.target.removeEventListener('contextmenu', this.onContextMenu);
  }
}
