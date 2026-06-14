// Player settings: mouse sensitivity, FOV, and master volume (PRD §8). Persisted
// to localStorage 'wr.settings' — the project's only persistence (PRD §8). The
// SettingsPanel is a framework-free DOM overlay (like the Lobby): it owns its
// root, enables pointer-events on the panel, and fires onChange LIVE as sliders
// move so the camera sensitivity, render FOV, and audio gain preview instantly.

const SETTINGS_KEY = 'wr.settings';

/** Graphics quality tier; maps to the post-processing / shadow / resolution
 * presets in render/scene.ts (QUALITY). */
export type QualityLevel = 'low' | 'medium' | 'high';
const QUALITY_LEVELS: QualityLevel[] = ['low', 'medium', 'high'];

export interface Settings {
  /** Mouselook gain: radians per device pixel (PointerLockCamera.sensitivity). */
  sensitivity: number;
  /** Vertical-ish render FOV in degrees (THREE PerspectiveCamera.fov). */
  fov: number;
  /** Master output gain, 0..1 (scales all procedural SFX). */
  masterVolume: number;
  /** Graphics quality tier (drives the render-side GPU cost). */
  quality: QualityLevel;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 0.0022,
  fov: 90,
  masterVolume: 0.7,
  quality: 'high',
};

// Slider domains. Sensitivity/FOV match camera.ts + TUNING.movement.fovBase=90.
const SENS_MIN = 0.0005;
const SENS_MAX = 0.006;
const SENS_STEP = 0.0001;
const FOV_MIN = 70;
const FOV_MAX = 110;
const FOV_STEP = 1;
const VOL_MIN = 0;
const VOL_MAX = 1;
const VOL_STEP = 0.01;

/** Load persisted settings merged over defaults; never throws (private mode). */
export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      sensitivity: clampNum(parsed.sensitivity, DEFAULT_SETTINGS.sensitivity, SENS_MIN, SENS_MAX),
      fov: clampNum(parsed.fov, DEFAULT_SETTINGS.fov, FOV_MIN, FOV_MAX),
      masterVolume: clampNum(parsed.masterVolume, DEFAULT_SETTINGS.masterVolume, VOL_MIN, VOL_MAX),
      quality: QUALITY_LEVELS.includes(parsed.quality as QualityLevel)
        ? (parsed.quality as QualityLevel)
        : DEFAULT_SETTINGS.quality,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist settings; non-fatal if localStorage is unavailable. */
export function saveSettings(s: Settings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // localStorage may be disabled (private mode) — settings stay in-memory.
  }
}

export class SettingsPanel {
  private readonly root: HTMLElement;
  private readonly onChange: (s: Settings) => void;
  private current: Settings;

  // Value readouts updated live alongside their slider.
  private readonly sensValue: HTMLElement;
  private readonly fovValue: HTMLElement;
  private readonly volValue: HTMLElement;

  constructor(root: HTMLElement, initial: Settings, onChange: (s: Settings) => void) {
    this.root = root;
    this.onChange = onChange;
    this.current = {
      sensitivity: clampNum(initial.sensitivity, DEFAULT_SETTINGS.sensitivity, SENS_MIN, SENS_MAX),
      fov: clampNum(initial.fov, DEFAULT_SETTINGS.fov, FOV_MIN, FOV_MAX),
      masterVolume: clampNum(initial.masterVolume, DEFAULT_SETTINGS.masterVolume, VOL_MIN, VOL_MAX),
      quality: QUALITY_LEVELS.includes(initial.quality) ? initial.quality : DEFAULT_SETTINGS.quality,
    };

    root.classList.add('wr-settings-root', 'wr-settings-hidden');

    const panel = el('div', 'wr-settings');

    const title = el('h2', 'wr-settings-title');
    title.textContent = 'SETTINGS';
    panel.appendChild(title);

    // ---- Sensitivity ----
    const sens = this.buildRow(
      'Sensitivity',
      SENS_MIN,
      SENS_MAX,
      SENS_STEP,
      this.current.sensitivity,
      (v) => {
        this.current = { ...this.current, sensitivity: v };
        this.sensValue.textContent = fmtSens(v);
        this.emit();
      },
    );
    this.sensValue = sens.value;
    this.sensValue.textContent = fmtSens(this.current.sensitivity);
    panel.appendChild(sens.row);

    // ---- FOV ----
    const fov = this.buildRow('Field of View', FOV_MIN, FOV_MAX, FOV_STEP, this.current.fov, (v) => {
      this.current = { ...this.current, fov: v };
      this.fovValue.textContent = fmtFov(v);
      this.emit();
    });
    this.fovValue = fov.value;
    this.fovValue.textContent = fmtFov(this.current.fov);
    panel.appendChild(fov.row);

    // ---- Master Volume ----
    const vol = this.buildRow(
      'Master Volume',
      VOL_MIN,
      VOL_MAX,
      VOL_STEP,
      this.current.masterVolume,
      (v) => {
        this.current = { ...this.current, masterVolume: v };
        this.volValue.textContent = fmtVol(v);
        this.emit();
      },
    );
    this.volValue = vol.value;
    this.volValue.textContent = fmtVol(this.current.masterVolume);
    panel.appendChild(vol.row);

    // ---- Graphics quality (segmented LOW / MEDIUM / HIGH) ----
    panel.appendChild(
      this.buildChoiceRow('Graphics', QUALITY_LEVELS, this.current.quality, (v) => {
        this.current = { ...this.current, quality: v };
        this.emit();
      }),
    );

    // ---- close hint ----
    const hint = el('div', 'wr-settings-hint');
    hint.textContent = 'Changes apply instantly and are saved automatically.';
    panel.appendChild(hint);

    root.appendChild(panel);
  }

  /** Reveal the panel and let it receive pointer events. */
  show(): void {
    this.root.classList.remove('wr-settings-hidden');
  }

  /** Hide the panel and let clicks fall through. */
  hide(): void {
    this.root.classList.add('wr-settings-hidden');
  }

  get settings(): Settings {
    return { ...this.current };
  }

  // ---- internals ----

  /** Persist + notify the host with the live values (preview as the slider moves). */
  private emit(): void {
    saveSettings(this.current);
    this.onChange({ ...this.current });
  }

  private buildRow(
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    onInput: (v: number) => void,
  ): { row: HTMLElement; value: HTMLElement } {
    const row = el('div', 'wr-settings-row');

    const head = el('div', 'wr-settings-head');
    const labelEl = el('span', 'wr-settings-label');
    labelEl.textContent = label;
    const valueEl = el('span', 'wr-settings-value');
    head.appendChild(labelEl);
    head.appendChild(valueEl);
    row.appendChild(head);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'wr-settings-slider';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(value);
    slider.setAttribute('aria-label', label);
    // 'input' fires continuously while dragging => live preview (PRD §8).
    slider.addEventListener('input', () => {
      onInput(Number(slider.value));
    });
    row.appendChild(slider);

    return { row, value: valueEl };
  }

  /** A labelled segmented control: one button per choice, the active one marked
   * with `aria-pressed` (CSS styles the pressed state). Fires onPick on change. */
  private buildChoiceRow(
    label: string,
    choices: QualityLevel[],
    value: QualityLevel,
    onPick: (v: QualityLevel) => void,
  ): HTMLElement {
    const row = el('div', 'wr-settings-row');

    const head = el('div', 'wr-settings-head');
    const labelEl = el('span', 'wr-settings-label');
    labelEl.textContent = label;
    head.appendChild(labelEl);
    row.appendChild(head);

    const group = el('div', 'wr-settings-seg');
    const buttons = new Map<QualityLevel, HTMLButtonElement>();
    for (const choice of choices) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wr-settings-seg-btn';
      btn.textContent = choice.toUpperCase();
      btn.setAttribute('aria-pressed', String(choice === value));
      btn.addEventListener('click', () => {
        for (const [c, b] of buttons) b.setAttribute('aria-pressed', String(c === choice));
        onPick(choice);
      });
      buttons.set(choice, btn);
      group.appendChild(btn);
    }
    row.appendChild(group);

    return row;
  }
}

// ---- module-local helpers (no DOM identifiers leak out) ----

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/** Coerce an unknown persisted/initial value into [min,max], else fall back. */
function clampNum(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/** Show sensitivity as a readable relative multiplier (1.00× == default). */
function fmtSens(v: number): string {
  return `${(v / DEFAULT_SETTINGS.sensitivity).toFixed(2)}×`;
}

function fmtFov(v: number): string {
  return `${Math.round(v)}°`;
}

function fmtVol(v: number): string {
  return `${Math.round(v * 100)}%`;
}
