// F3 debug panel (lil-gui). Live-binds TUNING.movement sliders so feel can be
// tweaked mid-playtest, and shows a readout polled each frame. Starts hidden.

import GUI from 'lil-gui';
import { TUNING } from '@rivals/shared';

export interface DebugReadout {
  speed: number;
  state: string;
  grounded: boolean;
  fov: number;
  pos: { x: number; y: number; z: number };
}

// Live readout backing object — controllers bind to these and we overwrite them.
interface ReadoutBacking {
  speed: number;
  state: string;
  grounded: boolean;
  fov: number;
  x: number;
  y: number;
  z: number;
}

export function createDebugPanel(getReadout: () => DebugReadout): {
  toggle(): void;
  destroy(): void;
} {
  const gui = new GUI({ title: 'Debug (F3)' });
  gui.domElement.style.display = 'none'; // start hidden
  let visible = false;

  // ---- Live feel tuning: bind directly to the shared TUNING object ----
  const m = TUNING.movement;
  const tune = gui.addFolder('Movement Tuning');
  tune.add(m, 'walkSpeed', 1, 14, 0.1);
  tune.add(m, 'sprintSpeed', 1, 20, 0.1);
  tune.add(m, 'slideBoost', 0, 24, 0.5);
  tune.add(m, 'slideFriction', 0, 20, 0.1);
  tune.add(m, 'jumpImpulse', 1, 12, 0.1);
  tune.add(m, 'gravity', 5, 50, 0.5);
  tune.add(m, 'airControlFactor', 0, 1, 0.01);
  tune.add(m, 'slideJumpWindow', 0, 1, 0.01);
  tune.add(m, 'coyoteTime', 0, 0.5, 0.01);

  // ---- Readout (refreshed via rAF) ----
  const r: ReadoutBacking = {
    speed: 0,
    state: '',
    grounded: false,
    fov: 0,
    x: 0,
    y: 0,
    z: 0,
  };
  const out = gui.addFolder('Readout');
  const cSpeed = out.add(r, 'speed').decimals(2).disable();
  const cState = out.add(r, 'state').disable();
  const cGround = out.add(r, 'grounded').disable();
  const cFov = out.add(r, 'fov').decimals(1).disable();
  const cX = out.add(r, 'x').decimals(2).disable();
  const cY = out.add(r, 'y').decimals(2).disable();
  const cZ = out.add(r, 'z').decimals(2).disable();

  let rafId = 0;
  const tick = (): void => {
    if (visible) {
      const d = getReadout();
      r.speed = d.speed;
      r.state = d.state;
      r.grounded = d.grounded;
      r.fov = d.fov;
      r.x = d.pos.x;
      r.y = d.pos.y;
      r.z = d.pos.z;
      cSpeed.updateDisplay();
      cState.updateDisplay();
      cGround.updateDisplay();
      cFov.updateDisplay();
      cX.updateDisplay();
      cY.updateDisplay();
      cZ.updateDisplay();
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  const toggle = (): void => {
    visible = !visible;
    gui.domElement.style.display = visible ? '' : 'none';
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'F3') {
      e.preventDefault();
      toggle();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  const destroy = (): void => {
    cancelAnimationFrame(rafId);
    window.removeEventListener('keydown', onKeyDown);
    gui.destroy();
  };

  return { toggle, destroy };
}
