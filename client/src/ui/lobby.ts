// The landing page (PRD §1 "time-to-fun under 15s", §6, §8). A centered, dark,
// on-brand panel over the game backdrop. Unlike the #hud / #overlay layers
// (pointer-events:none), this panel is INTERACTIVE: it owns its own root and
// enables pointer-events on the panel so the player can type and click.
//
// show() resolves a LobbyChoice when the player commits:
//   - FIND MATCH         -> { name }                  (quick match)
//   - CREATE PRIVATE ROOM-> { name, roomCode }        (generated 5-letter code)
//   - JOIN WITH CODE     -> { name, roomCode }        (typed 5-letter code)
// hide() dims/removes the panel so the arena shows behind; show() may be called
// again to return to the lobby after a match. setStatus() shows a status line
// (e.g. "Waiting for opponent…", "Server unreachable — Practice offline").

import { sanitizeName, makeRoomCode } from '@rivals/shared';

export interface LobbyChoice {
  name: string;
  roomCode?: string; // set => create/join private; absent => quick match
}

const NAME_KEY = 'wr.name';
const NAME_MAXLEN = 16;
const CODE_LEN = 5;
const CODE_RE = /[^A-Z]/g; // join input accepts letters only, uppercased

export class Lobby {
  private readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly statusEl: HTMLElement;

  // Generated private-room block (created lazily on "Create Private Room").
  private readonly createBlock: HTMLElement;
  private readonly createCodeEl: HTMLElement;
  private readonly createCopyBtn: HTMLButtonElement;

  // Join-with-code row.
  private readonly joinInput: HTMLInputElement;

  // The pending resolve for the active show() call (null when not awaiting).
  private resolveChoice: ((c: LobbyChoice) => void) | null = null;
  private copyResetTimer = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('wr-lobby-root');

    const panel = el('div', 'wr-lobby');

    // ---- title + tagline ----
    const title = el('h1', 'wr-lobby-title');
    title.textContent = 'WEB RIVALS';
    const tagline = el('p', 'wr-lobby-tagline');
    tagline.textContent = 'Instant 1v1 arena FPS — in your browser.';
    panel.appendChild(title);
    panel.appendChild(tagline);

    // ---- name input ----
    const nameField = el('label', 'wr-field');
    const nameLabel = el('span', 'wr-field-label');
    nameLabel.textContent = 'Callsign';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'wr-input wr-name-input';
    nameInput.spellcheck = false;
    nameInput.autocomplete = 'off';
    nameInput.maxLength = NAME_MAXLEN;
    nameInput.placeholder = 'Player';
    nameInput.value = loadName();
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);
    panel.appendChild(nameField);

    // Live-sanitize as the player types and persist on every change.
    nameInput.addEventListener('input', () => {
      const cleaned = sanitizeLive(nameInput.value);
      if (cleaned !== nameInput.value) {
        const pos = nameInput.selectionStart ?? cleaned.length;
        nameInput.value = cleaned;
        // Keep the caret sane after stripping.
        const p = Math.min(pos, cleaned.length);
        nameInput.setSelectionRange(p, p);
      }
      saveName(nameInput.value);
    });

    // ---- primary action: FIND MATCH ----
    const findBtn = button('wr-btn wr-btn-primary', 'FIND MATCH');
    findBtn.addEventListener('click', () => this.commit());
    panel.appendChild(findBtn);
    // Enter from the name field triggers quick match.
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commit();
      }
    });

    // ---- divider ----
    const divider = el('div', 'wr-divider');
    const dividerLabel = el('span', 'wr-divider-label');
    dividerLabel.textContent = 'or play with a friend';
    divider.appendChild(dividerLabel);
    panel.appendChild(divider);

    // ---- create private room ----
    const createBtn = button('wr-btn wr-btn-ghost', 'CREATE PRIVATE ROOM');
    createBtn.addEventListener('click', () => this.onCreate());
    panel.appendChild(createBtn);

    // Generated-code block (hidden until create is pressed).
    const createBlock = el('div', 'wr-code-block');
    createBlock.hidden = true;
    const createHint = el('span', 'wr-code-hint');
    createHint.textContent = 'Share this code, then start:';
    const createRow = el('div', 'wr-code-row');
    const createCodeEl = el('span', 'wr-code');
    const createCopyBtn = button('wr-copy', 'Copy');
    createCopyBtn.type = 'button';
    createCopyBtn.addEventListener('click', () => this.onCopy());
    const createGoBtn = button('wr-btn wr-btn-primary wr-btn-sm', 'START');
    createGoBtn.addEventListener('click', () => {
      this.commit(createCodeEl.textContent ?? '');
    });
    createRow.appendChild(createCodeEl);
    createRow.appendChild(createCopyBtn);
    createBlock.appendChild(createHint);
    createBlock.appendChild(createRow);
    createBlock.appendChild(createGoBtn);
    panel.appendChild(createBlock);

    // ---- join with code ----
    const joinRow = el('div', 'wr-join-row');
    const joinInput = document.createElement('input');
    joinInput.type = 'text';
    joinInput.className = 'wr-input wr-join-input';
    joinInput.spellcheck = false;
    joinInput.autocomplete = 'off';
    joinInput.maxLength = CODE_LEN;
    joinInput.placeholder = 'CODE';
    joinInput.setAttribute('aria-label', 'Room code');
    joinInput.addEventListener('input', () => {
      joinInput.value = normalizeCode(joinInput.value);
    });
    const joinBtn = button('wr-btn wr-btn-ghost wr-btn-sm', 'JOIN');
    const tryJoin = (): void => {
      const code = normalizeCode(joinInput.value);
      if (code.length === CODE_LEN) this.commit(code);
      else joinInput.classList.add('wr-input-bad');
    };
    joinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        tryJoin();
      }
    });
    joinInput.addEventListener('input', () => joinInput.classList.remove('wr-input-bad'));
    joinBtn.addEventListener('click', tryJoin);
    joinRow.appendChild(joinInput);
    joinRow.appendChild(joinBtn);
    panel.appendChild(joinRow);

    // ---- status line ----
    const statusEl = el('div', 'wr-status');
    statusEl.setAttribute('role', 'status');
    panel.appendChild(statusEl);

    root.appendChild(panel);

    this.panel = panel;
    this.nameInput = nameInput;
    this.statusEl = statusEl;
    this.createBlock = createBlock;
    this.createCodeEl = createCodeEl;
    this.createCopyBtn = createCopyBtn;
    this.joinInput = joinInput;
  }

  /** Show the lobby and resolve when the player commits to a choice. */
  show(): Promise<LobbyChoice> {
    this.root.classList.remove('wr-lobby-hidden');
    this.panel.classList.remove('wr-lobby-busy');
    this.createBlock.hidden = true;
    this.setStatus('');
    // Focus the name field so the player can type immediately (time-to-fun).
    // Defer so the element is laid out before focus().
    window.setTimeout(() => {
      this.nameInput.focus();
      this.nameInput.select();
    }, 0);
    return new Promise<LobbyChoice>((resolve) => {
      this.resolveChoice = resolve;
    });
  }

  /** Dim + disable the panel so the arena shows behind it. */
  hide(): void {
    this.root.classList.add('wr-lobby-hidden');
    this.resolveChoice = null;
  }

  /** Status line under the actions (e.g. "Waiting for opponent…"). */
  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  // ---- internals ----

  /** Resolve the active show() with the sanitized name and optional room code. */
  private commit(roomCode?: string): void {
    const resolve = this.resolveChoice;
    if (!resolve) return;
    this.resolveChoice = null;
    // Persist + canonicalize the name through shared semantics.
    const name = sanitizeName(this.nameInput.value);
    this.nameInput.value = name;
    saveName(name);
    // Dim the controls while we hand off to connect/matchmaking.
    this.panel.classList.add('wr-lobby-busy');
    const code = roomCode ? roomCode.toUpperCase() : undefined;
    resolve(code ? { name, roomCode: code } : { name });
  }

  /** Generate + reveal a private room code; START commits with it. */
  private onCreate(): void {
    const code = makeRoomCode(Math.random);
    this.createCodeEl.textContent = code;
    this.createBlock.hidden = false;
    this.createCopyBtn.textContent = 'Copy';
    this.createCopyBtn.classList.remove('wr-copy-done');
  }

  private onCopy(): void {
    const code = this.createCodeEl.textContent ?? '';
    const done = (): void => {
      this.createCopyBtn.textContent = 'Copied';
      this.createCopyBtn.classList.add('wr-copy-done');
      if (this.copyResetTimer) window.clearTimeout(this.copyResetTimer);
      this.copyResetTimer = window.setTimeout(() => {
        this.createCopyBtn.textContent = 'Copy';
        this.createCopyBtn.classList.remove('wr-copy-done');
        this.copyResetTimer = 0;
      }, 1400);
    };
    const clip = navigator.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      clip.writeText(code).then(done, () => done());
    } else {
      // Best-effort fallback: select the code text for manual copy.
      done();
    }
  }
}

// ---- module-local helpers (no DOM identifiers leak out) ----

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function button(className: string, text: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * Live name sanitize while typing: strip control chars and cap length, but keep
 * an in-progress empty/whitespace value as typed (so the field isn't yanked to
 * "Player" mid-edit). Final canonicalization happens via sanitizeName on commit.
 */
function sanitizeLive(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1F\x7F]+/g, '').slice(0, NAME_MAXLEN);
}

/** Uppercase, letters only, capped to the code length. */
function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(CODE_RE, '').slice(0, CODE_LEN);
}

function loadName(): string {
  try {
    const v = window.localStorage.getItem(NAME_KEY);
    return v ? sanitizeLive(v) : '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    window.localStorage.setItem(NAME_KEY, name);
  } catch {
    // localStorage may be unavailable (private mode / disabled) — non-fatal.
  }
}
