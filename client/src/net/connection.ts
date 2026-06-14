// NetClient (PRD §3.1, §3.3, §16): the single seam between the client and the
// authoritative server. Owns the live Transport, the protocol codec, clock sync,
// and the snapshot buffer; everything the render/sim layer needs is exposed as
// plain getters + event hooks so main.ts never touches a raw WebSocket.
//
// Authority model honoured here:
//   - movement is client-authoritative: we SEND pos/vel/yaw/pitch each input
//     tick and only react to a Correction (snap-back).
//   - damage is server-authoritative: local hp comes from Damage messages.
//   - rockets/grenades are simulated server-side and reconciled cosmetically;
//     own self-knockback stays predicted locally (we dedupe the server impulse).
//
// NO sim/Three here — this is pure wiring over @rivals/shared protocol shapes.

import {
  encode,
  decode,
  TUNING,
  type WeaponSlot,
  type Vec3Tuple,
  type ServerMessage,
  type JoinedMsg,
  type SnapshotMsg,
  type PongMsg,
  type DamageMsg,
  type SpawnProjMsg,
  type DetonateMsg,
  type KillMsg,
  type MatchStateMsg,
  type RespawnMsg,
  type OpponentMsg,
  type CorrectionMsg,
} from '@rivals/shared';

import type { Transport } from './transport';
import { ClockSync, SnapshotBuffer } from './snapshots';

/** The local player's per-tick movement report (client-authoritative). */
export interface InputState {
  pos: Vec3Tuple;
  vel: Vec3Tuple;
  yaw: number;
  pitch: number;
  buttons: number;
  events: number;
}

/** Opponent roster entry surfaced via onOpponent. */
export interface OpponentInfo {
  present: boolean;
  id: number;
  name: string;
}

type Cb<T> = (msg: T) => void;
const noop = (): void => {};

const PING_INTERVAL_MS = 2000;

export class NetClient {
  readonly clock = new ClockSync();
  readonly snapshots = new SnapshotBuffer();

  // Populated on Joined.
  private _playerId = -1;
  private _mapId = '';
  private _connected = false;
  private _joined = false;

  // Server-authoritative local hp (seeded on connect to spawn health; the first
  // Damage that targets us overwrites it with the authoritative value).
  private _hp = TUNING.combat.spawnHealth;

  // serverTime of the freshest snapshot we've received (for the network graph).
  private _lastSnapServerTime = -Infinity;

  private readonly transport: Transport;
  private joinResolve: ((joined: JoinedMsg) => void) | null = null;
  private joinReject: ((err: Error) => void) | null = null;

  private pendingName = '';
  private pendingRoomCode: string | undefined;

  // Monotonic counters for the protocol seq fields.
  private inputSeq = 0;
  private shootSeq = 0;

  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // ---- event hooks (default to noop so callers can subscribe selectively) ----
  onDamage: Cb<DamageMsg> = noop;
  onKill: Cb<KillMsg> = noop;
  onMatchState: Cb<MatchStateMsg> = noop;
  onRespawn: Cb<RespawnMsg> = noop;
  onOpponent: Cb<OpponentInfo> = noop;
  onSpawnProj: Cb<SpawnProjMsg> = noop;
  onDetonate: Cb<DetonateMsg> = noop;
  onCorrection: Cb<CorrectionMsg> = noop;
  onClose: () => void = noop;

  constructor(transport: Transport) {
    this.transport = transport;
    transport.onMessage((data) => this.handleMessage(data));
    transport.onOpen(() => this.handleOpen());
    transport.onClose(() => this.handleClose());
  }

  // ---- lifecycle ----

  /**
   * Send Hello and resolve once the server replies Joined. Rejects if the
   * transport closes first or the timeout elapses (the caller falls back to the
   * offline sandbox). `timeoutMs` guards a server that never answers.
   */
  connect(name: string, roomCode?: string, timeoutMs = 4000): Promise<JoinedMsg> {
    this.pendingName = name;
    this.pendingRoomCode = roomCode;

    return new Promise<JoinedMsg>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.joinResolve = null;
        this.joinReject = null;
        reject(new Error('connect timeout'));
      }, timeoutMs);

      this.joinResolve = (joined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(joined);
      };
      this.joinReject = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      // If the transport is already open (e.g. a pre-opened/fake transport in
      // tests), fire the hello immediately; otherwise handleOpen() will.
      if (this.transport.isOpen) this.handleOpen();
    });
  }

  private handleOpen(): void {
    if (this._connected) return; // open can fire once; guard double-hello
    this._connected = true;
    this.transport.send(
      encode({ t: 'hello', name: this.pendingName, roomCode: this.pendingRoomCode }),
    );
    // Drive ClockSync from a steady 2s ping.
    this.sendPing();
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  private handleClose(): void {
    this._connected = false;
    this._joined = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.joinReject) this.joinReject(new Error('transport closed'));
    this.joinResolve = null;
    this.joinReject = null;
    this.onClose();
  }

  /** Tear down: stop the ping timer and close the transport. */
  close(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.transport.close();
  }

  // ---- outgoing ----

  /** Per-tick movement report (call at TUNING.world.inputHz). */
  sendInput(state: InputState): void {
    if (!this._joined) return;
    this.transport.send(
      encode({
        t: 'input',
        seq: ++this.inputSeq,
        clientTime: this.clientTime(),
        pos: state.pos,
        vel: state.vel,
        yaw: state.yaw,
        pitch: state.pitch,
        buttons: state.buttons,
        events: state.events,
      }),
    );
  }

  /**
   * Report a fired shot. clientTime is on the SERVER timeline (ClockSync) so the
   * server can rewind victims to the moment we pulled the trigger (lag comp).
   */
  sendShoot(weapon: WeaponSlot, origin: Vec3Tuple, dir: Vec3Tuple): void {
    if (!this._joined) return;
    this.transport.send(
      encode({
        t: 'shoot',
        seq: ++this.shootSeq,
        weapon,
        origin,
        dir,
        clientTime: this.serverNow(),
      }),
    );
  }

  private sendPing(): void {
    if (!this._connected) return;
    this.transport.send(encode({ t: 'ping', clientTime: this.clientTime() }));
  }

  // ---- incoming ----

  private handleMessage(data: string): void {
    let msg: ServerMessage;
    try {
      msg = decode<ServerMessage>(data);
    } catch {
      return; // malformed frame; drop
    }

    switch (msg.t) {
      case 'joined':
        this._playerId = msg.playerId;
        this._mapId = msg.mapId;
        this._joined = true;
        if (this.joinResolve) this.joinResolve(msg);
        this.joinResolve = null;
        this.joinReject = null;
        break;

      case 'snapshot': {
        const s = msg as SnapshotMsg;
        this.snapshots.insert(s);
        if (s.serverTime > this._lastSnapServerTime) this._lastSnapServerTime = s.serverTime;
        break;
      }

      case 'pong':
        this.clock.onPong((msg as PongMsg).clientTime, (msg as PongMsg).serverTime, this.clientTime());
        break;

      case 'damage': {
        const d = msg as DamageMsg;
        if (d.victim === this._playerId) this._hp = d.newHp;
        this.onDamage(d);
        break;
      }

      case 'spawn_proj':
        this.onSpawnProj(msg as SpawnProjMsg);
        break;

      case 'detonate':
        this.onDetonate(msg as DetonateMsg);
        break;

      case 'kill':
        this.onKill(msg as KillMsg);
        break;

      case 'match_state':
        this.onMatchState(msg as MatchStateMsg);
        break;

      case 'respawn':
        this.onRespawn(msg as RespawnMsg);
        break;

      case 'opponent': {
        const o = msg as OpponentMsg;
        this.onOpponent({ present: o.present, id: o.id, name: o.name });
        break;
      }

      case 'correction': {
        const c = msg as CorrectionMsg;
        // Authoritative snap-back: seed our hp is untouched, movement caller
        // applies pos/vel via the hook.
        this.onCorrection(c);
        break;
      }
    }
  }

  // ---- accessors ----

  get isConnected(): boolean {
    return this._connected && this._joined;
  }

  get playerId(): number {
    return this._playerId;
  }

  get mapId(): string {
    return this._mapId;
  }

  get hp(): number {
    return this._hp;
  }

  /** Force-set local hp (e.g. on a local respawn) until the next server Damage. */
  setHp(hp: number): void {
    this._hp = hp;
  }

  /** Milliseconds since last received snapshot, on the local clock estimate. */
  snapshotAgeMs(nowMs: number): number {
    if (this._lastSnapServerTime === -Infinity) return Infinity;
    return this.serverTime(nowMs) - this._lastSnapServerTime;
  }

  // The local monotonic clock we stamp outgoing messages with.
  private clientTime(): number {
    return performance.now();
  }

  // Server-clock estimate for "now".
  private serverNow(): number {
    return this.clock.serverTimeEstimate(this.clientTime());
  }

  /** Server-clock estimate for an explicit local time. */
  serverTime(nowMs: number): number {
    return this.clock.serverTimeEstimate(nowMs);
  }
}
