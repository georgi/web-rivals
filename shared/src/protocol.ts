// Wire protocol (PRD §16.2). JSON over WS for the MVP; binary is a later,
// profiling-driven swap. Every message is defined here ONCE so the client and
// server can never disagree about field names. Tuples (Vec3Tuple) keep the JSON
// compact. Define even the messages we don't send yet — renaming fields across
// two codebases later is where evenings go to die.

import type { Vec3Tuple } from './math';

export type WeaponSlot = 1 | 2 | 3 | 4;

export const Button = {
  Forward: 1 << 0,
  Back: 1 << 1,
  Left: 1 << 2,
  Right: 1 << 3,
  Jump: 1 << 4,
  Sprint: 1 << 5,
  Crouch: 1 << 6, // slide trigger
  Fire: 1 << 7,
  AltFire: 1 << 8,
  Reload: 1 << 9,
} as const;
export type ButtonBit = (typeof Button)[keyof typeof Button];

/** One-shot edges reported alongside continuous button state. */
export const EventFlag = {
  Jumped: 1 << 0,
  SlideStart: 1 << 1,
  Landed: 1 << 2,
} as const;

export type RoundPhase = 'waiting' | 'countdown' | 'live' | 'roundEnd' | 'matchEnd';

export type AnimState = 'idle' | 'run' | 'slide' | 'air';

// ---------------- Client -> Server ----------------

export interface HelloMsg {
  t: 'hello';
  name: string;
  roomCode?: string; // join a private room; omit for quick match
}

export interface InputMsg {
  t: 'input';
  seq: number;
  clientTime: number;
  pos: Vec3Tuple;
  vel: Vec3Tuple;
  yaw: number;
  pitch: number;
  buttons: number; // bitfield of Button
  events: number; // bitfield of EventFlag this frame
}

export interface ShootMsg {
  t: 'shoot';
  seq: number;
  weapon: WeaponSlot;
  origin: Vec3Tuple;
  dir: Vec3Tuple;
  clientTime: number;
}

export interface PingMsg {
  t: 'ping';
  clientTime: number;
}

export type ClientMessage = HelloMsg | InputMsg | ShootMsg | PingMsg;

// ---------------- Server -> Client ----------------

export interface JoinedMsg {
  t: 'joined';
  playerId: number;
  roomId: string;
  mapId: string;
  serverTime: number;
  youAreReady: boolean;
}

export interface PlayerSnap {
  id: number;
  pos: Vec3Tuple;
  vel: Vec3Tuple;
  yaw: number;
  pitch: number;
  anim: AnimState;
  hp: number;
  weapon: WeaponSlot;
}

export interface ProjSnap {
  id: number;
  kind: 'rocket' | 'grenade';
  pos: Vec3Tuple;
  vel: Vec3Tuple;
}

export interface SnapshotMsg {
  t: 'snapshot';
  tick: number;
  serverTime: number;
  players: PlayerSnap[];
  projectiles: ProjSnap[];
}

/** Server snaps a client back when movement sanity checks fail. */
export interface CorrectionMsg {
  t: 'correction';
  pos: Vec3Tuple;
  vel: Vec3Tuple;
  seq: number;
}

export interface DamageMsg {
  t: 'damage';
  victim: number;
  amount: number;
  newHp: number;
  source: number; // attacker player id, or -1 for world/fall
  weapon: WeaponSlot | 0;
  dirToSource?: Vec3Tuple; // for the directional damage indicator
}

export interface SpawnProjMsg {
  t: 'spawn_proj';
  id: number;
  kind: 'rocket' | 'grenade';
  owner: number;
  pos: Vec3Tuple;
  vel: Vec3Tuple;
}

export interface DetonateMsg {
  t: 'detonate';
  id: number;
  pos: Vec3Tuple;
  kind: 'rocket' | 'grenade';
}

export interface KillMsg {
  t: 'kill';
  killer: number;
  victim: number;
  weapon: WeaponSlot | 0;
  fall: boolean;
}

export interface RoundStateMsg {
  t: 'round_state';
  phase: RoundPhase;
  score: [number, number]; // [player0Wins, player1Wins]
  timer: number; // seconds remaining in current phase
  round: number;
}

export interface PongMsg {
  t: 'pong';
  clientTime: number; // echoed
  serverTime: number;
}

export interface OpponentMsg {
  t: 'opponent';
  present: boolean;
  name: string;
  id: number;
}

export type ServerMessage =
  | JoinedMsg
  | SnapshotMsg
  | CorrectionMsg
  | DamageMsg
  | SpawnProjMsg
  | DetonateMsg
  | KillMsg
  | RoundStateMsg
  | PongMsg
  | OpponentMsg;

export type AnyMessage = ClientMessage | ServerMessage;

// ---------------- encode / decode ----------------
// Behind functions so a binary codec can replace JSON without touching callers.

export function encode(msg: AnyMessage): string {
  return JSON.stringify(msg);
}

export function decode<T extends AnyMessage = AnyMessage>(data: string): T {
  return JSON.parse(data) as T;
}

/** Sanitize a display name: trim, strip control chars, cap at 16 (PRD §6). */
export function sanitizeName(raw: string): string {
  const cleaned = (raw ?? '')
    .replace(/[\x00-\x1F\x7F]+/g, "")
    .trim()
    .slice(0, 16);
  return cleaned.length > 0 ? cleaned : 'Player';
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion

/** 5-letter room code from a seeded RNG (PRD §6). RNG passed in for determinism. */
export function makeRoomCode(rng: () => number): string {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(rng() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}
