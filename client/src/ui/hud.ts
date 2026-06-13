// The combat HUD (PRD §8): center crosshair (four ticks + dot whose gap grows
// with weapon bloom), bottom-left health, bottom-right ammo, top-center weapon
// name, plus a transient hitmarker. Pure DOM over the canvas; the whole #hud
// layer is pointer-events:none. update(s) writes only changed fields so there
// is no per-frame string churn driving layout/paint.

export interface HudState {
  hp: number;
  weaponName: string;
  clip: number;
  reserve: number;
}

const HITMARKER_MS = 120; // how long the hitmarker stays lit
const CROSSHAIR_BASE_GAP = 4; // px, gap between center dot and each tick at rest

export class Hud {
  private readonly healthFill: HTMLElement;
  private readonly healthNum: HTMLElement;
  private readonly ammoClip: HTMLElement;
  private readonly ammoReserve: HTMLElement;
  private readonly weaponName: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly hitmarkerEl: HTMLElement;

  // Cached last-rendered values; only DOM-write on change.
  private lastHp = NaN;
  private lastClip = NaN;
  private lastReserve = NaN;
  private lastWeapon = '';
  private lastGap = -1;

  private hitmarkerTimer = 0; // setTimeout handle (window.setTimeout -> number)

  constructor(root: HTMLElement) {
    // ---- crosshair (center): four ticks + a center dot ----
    const crosshair = el('div', 'rivals-crosshair');
    crosshair.id = 'crosshair';
    crosshair.appendChild(el('div', 'ch-dot'));
    crosshair.appendChild(el('div', 'ch-tick ch-top'));
    crosshair.appendChild(el('div', 'ch-tick ch-bottom'));
    crosshair.appendChild(el('div', 'ch-tick ch-left'));
    crosshair.appendChild(el('div', 'ch-tick ch-right'));

    // Hitmarker: four diagonal ticks, hidden until hitmarker() lights it.
    const hitmarker = el('div', 'hitmarker');
    hitmarker.appendChild(el('div', 'hm-tick hm-tl'));
    hitmarker.appendChild(el('div', 'hm-tick hm-tr'));
    hitmarker.appendChild(el('div', 'hm-tick hm-bl'));
    hitmarker.appendChild(el('div', 'hm-tick hm-br'));
    crosshair.appendChild(hitmarker);

    // ---- bottom-left health ----
    const health = el('div', 'hud-health');
    const healthBar = el('div', 'hud-health-bar');
    const healthFill = el('div', 'hud-health-fill');
    healthBar.appendChild(healthFill);
    const healthNum = el('div', 'hud-health-num');
    health.appendChild(healthBar);
    health.appendChild(healthNum);

    // ---- bottom-right ammo ----
    const ammo = el('div', 'hud-ammo');
    const ammoClip = el('span', 'hud-ammo-clip');
    const ammoSep = el('span', 'hud-ammo-sep');
    ammoSep.textContent = '/';
    const ammoReserve = el('span', 'hud-ammo-reserve');
    ammo.appendChild(ammoClip);
    ammo.appendChild(ammoSep);
    ammo.appendChild(ammoReserve);

    // ---- top-center weapon name ----
    const weapon = el('div', 'hud-weapon');

    root.appendChild(crosshair);
    root.appendChild(health);
    root.appendChild(ammo);
    root.appendChild(weapon);

    this.crosshair = crosshair;
    this.hitmarkerEl = hitmarker;
    this.healthFill = healthFill;
    this.healthNum = healthNum;
    this.ammoClip = ammoClip;
    this.ammoReserve = ammoReserve;
    this.weaponName = weapon;

    // Seed the crosshair gap so the CSS var exists from frame 0.
    this.crosshair.style.setProperty('--ch-gap', `${CROSSHAIR_BASE_GAP}px`);
  }

  update(s: HudState): void {
    if (s.hp !== this.lastHp) {
      this.lastHp = s.hp;
      const hp = Math.max(0, Math.round(s.hp));
      this.healthNum.textContent = String(hp);
      this.healthFill.style.width = `${Math.max(0, Math.min(100, hp))}%`;
      // Tint the fill green -> red as health drops (hue 120 -> 0).
      const hue = Math.max(0, Math.min(120, (hp / 100) * 120));
      this.healthFill.style.background = `hsl(${hue}, 70%, 50%)`;
    }
    if (s.clip !== this.lastClip) {
      this.lastClip = s.clip;
      this.ammoClip.textContent = String(s.clip);
    }
    if (s.reserve !== this.lastReserve) {
      this.lastReserve = s.reserve;
      this.ammoReserve.textContent = String(s.reserve);
    }
    if (s.weaponName !== this.lastWeapon) {
      this.lastWeapon = s.weaponName;
      this.weaponName.textContent = s.weaponName;
    }
  }

  hitmarker(): void {
    this.hitmarkerEl.classList.add('show');
    if (this.hitmarkerTimer) window.clearTimeout(this.hitmarkerTimer);
    this.hitmarkerTimer = window.setTimeout(() => {
      this.hitmarkerEl.classList.remove('show');
      this.hitmarkerTimer = 0;
    }, HITMARKER_MS);
  }

  // Grow the crosshair gap with bloom (px). Spread maps to extra gap so the
  // crosshair "opens" while spraying and recovers as bloom decays.
  setCrosshairBloom(spreadPx: number): void {
    const gap = CROSSHAIR_BASE_GAP + Math.max(0, spreadPx);
    // Quantize to whole px so we only touch the DOM when it visibly changes.
    const q = Math.round(gap);
    if (q === this.lastGap) return;
    this.lastGap = q;
    this.crosshair.style.setProperty('--ch-gap', `${q}px`);
  }
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
