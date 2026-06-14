# FFA Deathmatch (6-player) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the 1v1 round-based arena into a free-for-all frag deathmatch for up to 6 players (everyone against everyone), with drop-in play and auto-rematch.

**Architecture:** The wire/sim foundation is already per-id (snapshots carry a `PlayerSnap[]`, interpolation/lagcomp/explosion key on id). The work is: rewrite the pure match reducer for FFA phases, rework the room's scoring/respawn/membership, add a `match_state` + `respawn` protocol message, replace the client's single opponent with a multi-opponent manager, and rebuild the HUD score elements.

**Tech Stack:** TypeScript (ESM), Vitest, Node `ws` server, Three.js r171 client, Rapier (`@dimforge/rapier3d-compat`) for traces, shared workspace `@rivals/shared`.

**Spec:** `docs/superpowers/specs/2026-06-14-ffa-deathmatch-design.md`

**Conventions:**
- Run all commands from the repo root `/Users/mg/dev/rivals`.
- Typecheck everything: `npm run typecheck`. Run tests: `npm test`.
- `hud.ts` contains emoji glyphs — grep it with `grep -a` if needed.
- Commit after each task. Branch is `feat/web-rivals-mvp` (continue on it).

---

## File Structure

**Shared (`shared/src/`):**
- `tuning.ts` — MODIFY: retire round fields, add FFA fields.
- `protocol.ts` — MODIFY: `MatchPhase`, `MatchStateMsg`, `RespawnMsg`; remove `RoundPhase`/`RoundStateMsg`.
- `map-crate.json` — MODIFY: 2 → 6 spawns.

**Server (`server/src/`):**
- `match.ts` — REWRITE: pure FFA reducer.
- `match.test.ts` — REWRITE: FFA reducer tests.
- `room.ts` — MODIFY: FFA scoring/respawn/membership; remove slots & grace.
- `room.test.ts` — MODIFY: N-player, frags, respawn.
- `index.ts` — MODIFY: log `/6`, `youAreReady` semantics.

**Client (`client/src/`):**
- `net/connection.ts` — MODIFY: `onMatchState`, `onRespawn`.
- `entities/remote-players.ts` — CREATE: multi-opponent manager.
- `entities/remote-players.test.ts` — CREATE: roster unit test.
- `main.ts` — MODIFY: many opponents, FFA targeting, local death/respawn, HUD wiring.
- `ui/hud.ts` — MODIFY: live frag table + N-player scoreboard + death cue.
- `ui/style.css` — MODIFY: frag-table + scoreboard styles.

---

## Task 1: Tuning — FFA fields

**Files:**
- Modify: `shared/src/tuning.ts` (the `WorldTuning` interface ~line 119-133, and the `world` literal ~line 256-267)

- [ ] **Step 1: Update the `WorldTuning` interface**

Replace the round fields in the `WorldTuning` interface with FFA fields. Find:

```ts
  maxCatchupMs: number; // accumulator clamp for tab-out
  interpDelayMs: number; // render remote players this far in the past
  roundTimeSec: number; // 90s round timer
  countdownSec: number;
  roundEndSec: number;
  matchEndSec: number;
  roundsToWin: number; // first to 3
  disconnectGraceSec: number;
}
```

Replace with:

```ts
  maxCatchupMs: number; // accumulator clamp for tab-out
  interpDelayMs: number; // render remote players this far in the past
  maxPlayers: number; // players per room (FFA)
  fragLimit: number; // kills to win a match
  respawnDelaySec: number; // delay before a dead player respawns
  matchTimeCapSec: number; // stalemate backstop; 0 disables. most frags wins
  warmupMinPlayers: number; // connected players required to go live
  matchEndSec: number; // scoreboard display duration
}
```

- [ ] **Step 2: Update the `world` literal**

Find:

```ts
    maxCatchupMs: 250,
    interpDelayMs: 100,
    roundTimeSec: 90,
    countdownSec: 3,
    roundEndSec: 1.5,
    matchEndSec: 5,
    roundsToWin: 3,
    disconnectGraceSec: 10,
  },
```

Replace with:

```ts
    maxCatchupMs: 250,
    interpDelayMs: 100,
    maxPlayers: 6,
    fragLimit: 15,
    respawnDelaySec: 1.5,
    matchTimeCapSec: 600,
    warmupMinPlayers: 2,
    matchEndSec: 5,
  },
```

- [ ] **Step 3: Find every consumer of the removed fields**

Run: `grep -rn "roundTimeSec\|countdownSec\|roundEndSec\|roundsToWin\|disconnectGraceSec" --include=*.ts .`
Expected: matches only in `server/src/match.ts`, `server/src/room.ts`, `server/src/match.test.ts` (all rewritten in later tasks). If anything else appears (e.g. client), note it — it must be handled in this plan. There should be no client consumers.

- [ ] **Step 4: Typecheck (expected to fail in server only)**

Run: `npx tsc -p shared/tsconfig.json`
Expected: PASS (shared compiles; the removed fields are only referenced from server, compiled separately). If shared fails, fix before continuing.

- [ ] **Step 5: Commit**

```bash
git add shared/src/tuning.ts
git commit -m "feat(tuning): FFA deathmatch fields (maxPlayers, fragLimit, respawn, timeCap)"
```

---

## Task 2: Protocol — match_state + respawn

**Files:**
- Modify: `shared/src/protocol.ts`

- [ ] **Step 1: Replace the `RoundPhase` type**

Find:

```ts
export type RoundPhase = 'waiting' | 'countdown' | 'live' | 'roundEnd' | 'matchEnd';
```

Replace with:

```ts
export type MatchPhase = 'warmup' | 'live' | 'matchEnd';
```

- [ ] **Step 2: Replace `RoundStateMsg` with `MatchStateMsg` and add `RespawnMsg`**

Find:

```ts
export interface RoundStateMsg {
  t: 'round_state';
  phase: RoundPhase;
  score: [number, number]; // [player0Wins, player1Wins]
  timer: number; // seconds remaining in current phase
  round: number;
}
```

Replace with:

```ts
/** Per-player frag entry for the live scoreboard / match-end ranking. */
export interface FragEntry {
  id: number;
  frags: number;
}

export interface MatchStateMsg {
  t: 'match_state';
  phase: MatchPhase;
  timer: number; // live: match clock (counts up); matchEnd: scoreboard countdown
  fragLimit: number;
  scores: FragEntry[]; // all players present, unordered (client ranks)
  winner: number; // playerId at matchEnd, else -1
}

/** Server-authoritative respawn: the client snaps its local player here. */
export interface RespawnMsg {
  t: 'respawn';
  id: number;
  pos: Vec3Tuple;
  yaw: number;
}
```

- [ ] **Step 3: Update the `ServerMessage` union**

Find:

```ts
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
```

Replace with:

```ts
export type ServerMessage =
  | JoinedMsg
  | SnapshotMsg
  | CorrectionMsg
  | DamageMsg
  | SpawnProjMsg
  | DetonateMsg
  | KillMsg
  | MatchStateMsg
  | RespawnMsg
  | PongMsg
  | OpponentMsg;
```

- [ ] **Step 4: Check the shared index re-exports the new types**

Run: `grep -n "RoundStateMsg\|RoundPhase\|MatchStateMsg\|RespawnMsg\|FragEntry" shared/src/index.ts`
- If `index.ts` re-exports specific names (not `export *`), replace `RoundStateMsg`/`RoundPhase` with `MatchStateMsg`, `RespawnMsg`, `FragEntry`, `MatchPhase`. If it uses `export * from './protocol'`, no change needed.

- [ ] **Step 5: Typecheck shared**

Run: `npx tsc -p shared/tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/src/protocol.ts shared/src/index.ts
git commit -m "feat(protocol): match_state + respawn messages; drop round_state"
```

---

## Task 3: Map — 6 spawn points

**Files:**
- Modify: `shared/src/map-crate.json` (the `spawns` array)

- [ ] **Step 1: Replace the `spawns` array**

Find:

```json
"spawns": [{"pos":[-12,1,-12],"yaw":225},{"pos":[12,1,12],"yaw":45}]
```

Replace with (6 spawns around the 30×30 arena, each facing roughly toward center; keep the original two first):

```json
"spawns": [{"pos":[-12,1,-12],"yaw":225},{"pos":[12,1,12],"yaw":45},{"pos":[12,1,-12],"yaw":135},{"pos":[-12,1,12],"yaw":315},{"pos":[0,1,13],"yaw":0},{"pos":[0,1,-13],"yaw":180}]
```

> Yaw convention (degrees): the map builder converts to radians and the server forward basis is `(-sin yaw, 0, -cos yaw)`. yaw 0 faces −z, 90 faces −x, 180 faces +z, 270 faces +x. The four corners face the center; the two mid-edge spawns face across.

- [ ] **Step 2: Validate the JSON parses and has 6 spawns**

Run: `node -e "const j=require('./shared/src/map-crate.json'); console.log(j.spawns.length); j.spawns.forEach(s=>{if(Math.abs(s.pos[0])>15||Math.abs(s.pos[2])>15)throw new Error('spawn out of bounds')})"`
Expected: prints `6`, no throw.

- [ ] **Step 3: Commit**

```bash
git add shared/src/map-crate.json
git commit -m "feat(map): 6 FFA spawn points around the arena"
```

---

## Task 4: Rewrite the match reducer (pure FFA)

**Files:**
- Rewrite: `server/src/match.ts`
- Test: `server/src/match.test.ts`

- [ ] **Step 1: Write the new failing tests**

Replace the ENTIRE contents of `server/src/match.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { TUNING } from '@rivals/shared';
import { initMatch, stepMatch, type MatchState, type MatchTickCtx, type MatchEvent } from './match';

const W = TUNING.world;
const DT = 1 / 30;

function ctx(over: Partial<MatchTickCtx> = {}): MatchTickCtx {
  return { connectedCount: 0, topFrags: 0, topFragsPlayer: -1, ...over };
}

function run(state: MatchState, n: number, c: MatchTickCtx): MatchEvent[] {
  const events: MatchEvent[] = [];
  for (let i = 0; i < n; i++) events.push(...stepMatch(state, c, DT));
  return events;
}

describe('FFA match reducer', () => {
  it('starts in warmup with no winner', () => {
    const s = initMatch();
    expect(s.phase).toBe('warmup');
    expect(s.matchWinner).toBe(-1);
  });

  it('stays in warmup with fewer than warmupMinPlayers', () => {
    const s = initMatch();
    const ev = run(s, 5, ctx({ connectedCount: 1 }));
    expect(s.phase).toBe('warmup');
    expect(ev.filter((e) => e.type === 'matchStart')).toHaveLength(0);
  });

  it('goes live and emits matchStart when enough players connect', () => {
    const s = initMatch();
    const ev = stepMatch(s, ctx({ connectedCount: W.warmupMinPlayers }), DT);
    expect(s.phase).toBe('live');
    expect(s.clock).toBe(0);
    expect(ev).toContainEqual({ type: 'matchStart' });
  });

  it('accumulates the match clock while live', () => {
    const s = initMatch();
    stepMatch(s, ctx({ connectedCount: 2 }), DT); // -> live, clock reset to 0
    run(s, 30, ctx({ connectedCount: 2 }));
    expect(s.clock).toBeGreaterThan(0.9);
    expect(s.clock).toBeLessThan(1.1);
  });

  it('ends the match when a player reaches the frag limit', () => {
    const s = initMatch();
    stepMatch(s, ctx({ connectedCount: 2 }), DT); // -> live
    const ev = stepMatch(
      s,
      ctx({ connectedCount: 2, topFrags: W.fragLimit, topFragsPlayer: 7 }),
      DT,
    );
    expect(s.phase).toBe('matchEnd');
    expect(s.matchWinner).toBe(7);
    expect(s.clock).toBeCloseTo(W.matchEndSec);
    expect(ev).toContainEqual({ type: 'matchEnd', winner: 7 });
  });

  it('ends the match on the time cap, awarding the top fragger', () => {
    const s = initMatch();
    stepMatch(s, ctx({ connectedCount: 2 }), DT); // -> live
    // Jump near the cap by ticking with a large dt once.
    stepMatch(s, ctx({ connectedCount: 2, topFrags: 4, topFragsPlayer: 3 }), W.matchTimeCapSec);
    const ev = stepMatch(s, ctx({ connectedCount: 2, topFrags: 4, topFragsPlayer: 3 }), DT);
    expect(s.phase).toBe('matchEnd');
    expect(s.matchWinner).toBe(3);
    expect(ev).toContainEqual({ type: 'matchEnd', winner: 3 });
  });

  it('drops back to warmup (keeping no winner) when players leave mid-match', () => {
    const s = initMatch();
    stepMatch(s, ctx({ connectedCount: 2 }), DT); // -> live
    run(s, 10, ctx({ connectedCount: 2 }));
    stepMatch(s, ctx({ connectedCount: 1 }), DT);
    expect(s.phase).toBe('warmup');
    expect(s.matchWinner).toBe(-1);
  });

  it('resets after the matchEnd display and re-arms', () => {
    const s = initMatch();
    stepMatch(s, ctx({ connectedCount: 2 }), DT); // -> live
    stepMatch(s, ctx({ connectedCount: 2, topFrags: W.fragLimit, topFragsPlayer: 1 }), DT); // -> matchEnd
    // Drain the matchEnd display timer.
    const ev: MatchEvent[] = [];
    for (let i = 0; i < 10000 && s.phase === 'matchEnd'; i++) {
      ev.push(...stepMatch(s, ctx({ connectedCount: 2 }), DT));
    }
    expect(ev).toContainEqual({ type: 'reset' });
    // After reset it returns to warmup, then immediately re-goes-live next tick.
    expect(['warmup', 'live']).toContain(s.phase);
  });

  it('matchEnd ignores connectedCount changes until its timer drains', () => {
    const s = initMatch();
    stepMatch(s, ctx({ connectedCount: 2 }), DT);
    stepMatch(s, ctx({ connectedCount: 2, topFrags: W.fragLimit, topFragsPlayer: 1 }), DT);
    stepMatch(s, ctx({ connectedCount: 0 }), DT); // everyone leaves
    expect(s.phase).toBe('matchEnd'); // still draining the scoreboard
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run server/src/match.test.ts`
Expected: FAIL (old `match.ts` exports a different `MatchTickCtx`/`MatchState` shape — compile/assertion errors).

- [ ] **Step 3: Rewrite `match.ts`**

Replace the ENTIRE contents of `server/src/match.ts` with:

```ts
// The PURE FFA deathmatch reducer. No I/O, no Rapier, no ws, no DOM — `stepMatch`
// takes the current state plus a per-tick aggregate snapshot and mutates the
// state, returning the events the Room must act on (match start, match end,
// reset). Frag COUNTS are NOT stored here — they live on RoomPlayer and are
// incremented at the kill site; the reducer only reads the aggregate (top frags,
// connected count) so it stays pure and exhaustively unit-testable.
//
// Phases: warmup (<2 players, free-roam) -> live (>=2, clock counts up) ->
// matchEnd (scoreboard for matchEndSec) -> reset -> warmup. Timings come from
// TUNING.world so the reducer never drifts from the single source of truth.

import { TUNING } from '@rivals/shared';

export type MatchPhase = 'warmup' | 'live' | 'matchEnd';

export interface MatchState {
  phase: MatchPhase;
  clock: number; // live: seconds elapsed in the match; matchEnd: seconds left on display
  matchWinner: number; // playerId at matchEnd, else -1
}

export interface MatchTickCtx {
  connectedCount: number;
  topFrags: number; // highest frag count among players this tick
  topFragsPlayer: number; // that player's id (lowest id on ties), -1 if none
}

export type MatchEvent =
  | { type: 'matchStart' }
  | { type: 'matchEnd'; winner: number }
  | { type: 'reset' };

const W = TUNING.world;

export function initMatch(): MatchState {
  return { phase: 'warmup', clock: 0, matchWinner: -1 };
}

/**
 * Advance the match by `dt` seconds against this tick's aggregate context.
 * MUTATES `state` and returns the events produced this tick (0 or 1). The Room
 * calls this once per server tick.
 */
export function stepMatch(state: MatchState, ctx: MatchTickCtx, dt: number): MatchEvent[] {
  const events: MatchEvent[] = [];

  switch (state.phase) {
    case 'warmup': {
      if (ctx.connectedCount >= W.warmupMinPlayers) {
        state.phase = 'live';
        state.clock = 0;
        state.matchWinner = -1;
        events.push({ type: 'matchStart' });
      }
      break;
    }

    case 'live': {
      state.clock += dt;
      if (ctx.connectedCount < W.warmupMinPlayers) {
        // Not enough players to keep playing — pause back to warmup. Frags are
        // kept on the players; only an actual matchEnd->reset zeroes them.
        state.phase = 'warmup';
        break;
      }
      const reachedLimit = ctx.topFragsPlayer >= 0 && ctx.topFrags >= W.fragLimit;
      const reachedCap = W.matchTimeCapSec > 0 && state.clock >= W.matchTimeCapSec;
      if (reachedLimit || reachedCap) {
        state.matchWinner = ctx.topFragsPlayer;
        state.phase = 'matchEnd';
        state.clock = W.matchEndSec;
        events.push({ type: 'matchEnd', winner: ctx.topFragsPlayer });
      }
      break;
    }

    case 'matchEnd': {
      state.clock -= dt;
      if (state.clock <= 0) {
        state.phase = 'warmup';
        state.clock = 0;
        state.matchWinner = -1;
        events.push({ type: 'reset' });
      }
      break;
    }
  }

  return events;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run server/src/match.test.ts`
Expected: PASS (all FFA reducer tests green).

- [ ] **Step 5: Commit**

```bash
git add server/src/match.ts server/src/match.test.ts
git commit -m "feat(server): rewrite match reducer as pure FFA deathmatch"
```

---

## Task 5: Rework the Room for FFA

This is the largest task. The room keeps all of its projectile/hitscan/lagcomp/validator/transport code unchanged; we change membership, scoring, respawn, freeze, and the match-state broadcast. Do the edits in order, then update the tests.

**Files:**
- Modify: `server/src/room.ts`
- Test: `server/src/room.test.ts`

- [ ] **Step 1: Update imports and the player-count constant**

In `server/src/room.ts`, update the type import line to add `RespawnMsg`/`FragEntry` and drop nothing else. Find the import of `match.js`:

```ts
import { initMatch, stepMatch, type MatchState, type MatchTickCtx } from './match.js';
```

Leave it as-is (those names still exist). Then find:

```ts
const MAX_PLAYERS = 2;
```

Replace with:

```ts
const MAX_PLAYERS = TUNING.world.maxPlayers;
```

- [ ] **Step 2: Replace the `RoomPlayer` match-bookkeeping fields**

Find the tail of the `RoomPlayer` interface:

```ts
  alive: boolean;
  lastSeq: number;
  // Match-machine bookkeeping. `slot` is the stable 0/1 index the pure reducer
  // keys score/hp/death arrays on (join order; preserved across the disconnect
  // grace window). `connected` is false while the socket is gone but the slot is
  // still held for the grace window. `disconnectedFor` accumulates seconds-gone
  // in TICK time (dt-driven, not wall clock) so forfeit timing tracks the sim,
  // not the event-loop schedule. `diedPending` latches a death (HP crossed to 0,
  // by any path) until the next match step consumes it, so a kill landing between
  // ticks via ingestShoot is never missed.
  slot: number;
  connected: boolean;
  disconnectedFor: number;
  diedPending: boolean;
}
```

Replace with:

```ts
  alive: boolean;
  lastSeq: number;
  // FFA bookkeeping. `frags` is this player's kill count for the current match
  // (zeroed at matchEnd->reset). `respawnTimer` counts down while dead; at <=0
  // the tick respawns the player. There are no slots and no disconnect grace in
  // FFA — a departure is just a departure.
  frags: number;
  respawnTimer: number;
}
```

- [ ] **Step 3: Replace the match-bookkeeping member fields on the class**

Find:

```ts
  // The pure 1v1 match/round state machine (server/src/match.ts). The room owns
  // the MatchState, builds a per-tick MatchTickCtx, and acts on the events.
  private readonly match: MatchState = initMatch();
  // Stable slot -> playerId map (join order). A slot stays claimed through the
  // disconnect grace window so the reducer's score/hp/death arrays line up.
  private readonly slots: [number, number] = [-1, -1];
  // While frozen (countdown / roundEnd / matchEnd) the room ignores shoots and
  // reports zero velocity in snapshots so the opponent renders still.
  private frozen = true;
  // The last round-state we sent, so we only re-broadcast on change or ~1Hz.
  private lastSentPhase: MatchState['phase'] | null = null;
  private lastSentScore: [number, number] = [-1, -1];
  private lastSentRound = -1;
  private roundStateAccum = 0; // counts ticks toward the ~1Hz heartbeat
  // Set true once the match has truly ended AND its slots are vacated — the
  // lobby polls this (isFinished) to tear the room down.
  private finished = false;
  // True once the match has reached `matchEnd` at least once. A brand-new room
  // sits in `waiting` with one claimed slot before the second player arrives —
  // that must NOT count as finished. Only a match that actually ended and then
  // drained back to waiting with a vacated slot (a forfeit the player never
  // returned from) finishes the room.
  private matchEverEnded = false;
  // Whether a kill was already broadcast for the current round (a lethal hit or
  // a fall). roundEnd-by-timer-expiry has no kill, so we synthesize one.
  private killEmittedThisRound = false;
```

Replace with:

```ts
  // The pure FFA match state machine (server/src/match.ts). The room owns the
  // MatchState, builds a per-tick aggregate MatchTickCtx, and acts on the events.
  private readonly match: MatchState = initMatch();
  // While frozen (matchEnd scoreboard only) the room ignores shoots and reports
  // zero velocity in snapshots so everyone renders still on the scoreboard.
  private frozen = false;
  // The last match-state we sent, so we only re-broadcast on change or ~1Hz.
  private lastSentPhase: MatchState['phase'] | null = null;
  private matchStateAccum = 0; // counts ticks toward the ~1Hz heartbeat
```

- [ ] **Step 4: Simplify `playerCount`, remove slot getters, fix `isFull`/`isFinished`**

Find:

```ts
  /** Number of CONNECTED players (sockets live). Disconnected-but-grace excluded. */
  get playerCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  /** Claimed slots — counts players still held through the disconnect grace window. */
  private get claimedSlots(): number {
    return (this.slots[0] >= 0 ? 1 : 0) + (this.slots[1] >= 0 ? 1 : 0);
  }

  // A room is full when both slots are claimed — including a slot held open for a
  // disconnected player inside the grace window, so a brief hiccup can't lose the
  // seat to a stranger (PRD §2).
  get isFull(): boolean {
    return this.claimedSlots >= MAX_PLAYERS;
  }

  get isEmpty(): boolean {
    return this.players.size === 0;
  }

  /** True once the match is over and slots vacated — the lobby tears us down. */
  get isFinished(): boolean {
    return this.finished;
  }
```

Replace with:

```ts
  /** Number of players in the room (FFA has no grace seats). */
  get playerCount(): number {
    return this.players.size;
  }

  get isFull(): boolean {
    return this.players.size >= MAX_PLAYERS;
  }

  get isEmpty(): boolean {
    return this.players.size === 0;
  }

  /** FFA rooms auto-rematch forever; they only end by emptying out. The lobby
   * reaper destroys empty rooms, so a room is never "finished" while populated. */
  get isFinished(): boolean {
    return false;
  }
```

- [ ] **Step 5: Remove the slot helpers**

Find and DELETE these three methods entirely:

```ts
  /** Stable slot (0 or 1) the player holds — used for the reducer score arrays. */
  private slotIndex(id: number): number {
    if (this.slots[0] === id) return 0;
    if (this.slots[1] === id) return 1;
    return -1;
  }

  /** The player currently in a given slot, if any. */
  private playerInSlot(slot: number): RoomPlayer | undefined {
    const id = this.slots[slot];
    return id >= 0 ? this.players.get(id) : undefined;
  }
```

- [ ] **Step 6: Rewrite `addPlayer`**

Find the whole `addPlayer` method and replace it with:

```ts
  /** Add a player up to MAX_PLAYERS. Returns the spawned player or null if full. */
  addPlayer(ws: WebSocket, id: number, name: string): RoomPlayer | null {
    if (this.isFull) return null;

    const spawn = this.pickSpawn();
    const pos = fromTuple(spawn.pos);

    const player: RoomPlayer = {
      id,
      ws,
      name,
      pos,
      vel: { x: 0, y: 0, z: 0 },
      yaw: (spawn.yaw * Math.PI) / 180,
      pitch: 0,
      buttons: 0,
      anim: 'idle',
      hp: TUNING.combat.spawnHealth,
      weapon: 1,
      ammo: this.freshAmmo(),
      cooldowns: { 1: 0, 2: 0, 3: 0, 4: 0 },
      alive: true,
      lastSeq: 0,
      frags: 0,
      respawnTimer: 0,
    };
    this.players.set(id, player);

    this.validator.reset(id, pos);
    this.lagcomp.record(id, this.center(pos), CAP_RADIUS, CAP_HALF, this.now());

    // Tell the newcomer about every existing player, and every existing player
    // about the newcomer. (The match machine decides when the match goes live.)
    for (const other of this.players.values()) {
      if (other.id === id) continue;
      this.sendTo(player, { t: 'opponent', present: true, name: other.name, id: other.id });
      this.sendTo(other, { t: 'opponent', present: true, name: player.name, id: player.id });
    }

    this.broadcastMatchState();
    return player;
  }
```

- [ ] **Step 7: Rewrite `removePlayer` and replace `vacateSlot`**

Find the whole `removePlayer` method AND the `vacateSlot` method that follows it, and replace BOTH with:

```ts
  /**
   * The socket closed. In FFA there is no grace window — a departure is just a
   * departure. Drop the player, announce it to everyone, and let the match
   * reducer fall back to warmup if the room drops below warmupMinPlayers.
   */
  removePlayer(id: number): void {
    const player = this.players.get(id);
    if (!player) return;

    for (const other of this.players.values()) {
      if (other.id === id) continue;
      this.sendTo(other, { t: 'opponent', present: false, name: player.name, id });
    }

    this.players.delete(id);
    this.validator.reset(id, { x: 0, y: 0, z: 0 });
    this.lagcomp.remove(id);
    this.world.removeEntity(id);
    this.broadcastMatchState();
  }
```

- [ ] **Step 8: Credit frags and arm respawn in `applyDamage`**

Find the tail of `applyDamage`:

```ts
    if (victim.hp <= 0) {
      victim.alive = false;
      victim.diedPending = true; // consumed as a rising edge by the next match step
      this.broadcast({ t: 'kill', killer: source, victim: victim.id, weapon, fall });
      this.killEmittedThisRound = true;
    }
  }
```

Replace with:

```ts
    if (victim.hp <= 0) {
      victim.alive = false;
      victim.respawnTimer = TUNING.world.respawnDelaySec;
      // Frag credit: a real kill by ANOTHER player. Suicide (fall / own rocket,
      // source === victim or -1) scores nothing for anyone.
      if (source >= 0 && source !== victim.id) {
        const killer = this.players.get(source);
        if (killer) killer.frags += 1;
      }
      this.broadcast({ t: 'kill', killer: source, victim: victim.id, weapon, fall });
    }
  }
```

- [ ] **Step 9: Rewrite the tick body's fall-kill + add respawn processing**

Find this block in `tickOnce`:

```ts
    if (!this.frozen) {
      // Step server projectiles; resolve detonations against current capsules.
      this.stepProjectiles(dt, now);

      // Fall-out-of-world kill (killY): server-auth. Credit the opponent (the
      // surviving slot) so the score goes the right way; flag it a fall.
      for (const p of this.players.values()) {
        if (p.alive && p.connected && p.pos.y < this.map.killY) {
          const opp = this.playerInSlot(p.slot === 0 ? 1 : 0);
          this.applyDamage(p, p.hp, opp ? opp.id : -1, 0, true);
        }
      }
    }
```

Replace with:

```ts
    if (!this.frozen) {
      // Step server projectiles; resolve detonations against current capsules.
      this.stepProjectiles(dt, now);

      // Fall-out-of-world kill (killY): server-auth suicide (no frag credit).
      for (const p of this.players.values()) {
        if (p.alive && p.pos.y < this.map.killY) {
          this.applyDamage(p, p.hp, -1, 0, true);
        }
      }

      // Respawn dead players whose delay has elapsed.
      for (const p of this.players.values()) {
        if (p.alive) continue;
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0) this.respawnPlayer(p);
      }
    }
```

- [ ] **Step 10: Replace the disconnect-accumulation loop in `tickOnce`**

Find:

```ts
    // Accumulate disconnect time in TICK seconds (not wall clock) so the grace
    // window tracks the sim. A reconnect would clear `connected` back to true.
    for (const p of this.players.values()) {
      if (!p.connected) p.disconnectedFor += dt;
    }

```

DELETE this block entirely (FFA has no disconnect grace).

- [ ] **Step 11: Replace `stepMatchMachine`, `handleMatchEnd`, and `resetRound`**

Find the three methods `stepMatchMachine`, `handleMatchEnd`, and `resetRound` (contiguous) and replace ALL THREE with:

```ts
  /**
   * Build this tick's aggregate MatchTickCtx, advance the pure reducer, and act
   * on its events. Frags live on the players; the reducer only reads the top
   * fragger + connected count.
   */
  private stepMatchMachine(dt: number): void {
    let topFrags = 0;
    let topFragsPlayer = -1;
    for (const p of this.players.values()) {
      // Lowest id wins frag ties (deterministic scoreboard winner).
      if (p.frags > topFrags || (p.frags === topFrags && topFragsPlayer >= 0 && p.id < topFragsPlayer)) {
        if (p.frags > topFrags) {
          topFrags = p.frags;
          topFragsPlayer = p.id;
        } else if (p.frags === topFrags && p.frags > 0) {
          topFragsPlayer = Math.min(topFragsPlayer, p.id);
        }
      } else if (topFragsPlayer < 0 && p.frags > 0) {
        topFrags = p.frags;
        topFragsPlayer = p.id;
      }
    }

    const ctx: MatchTickCtx = {
      connectedCount: this.players.size,
      topFrags,
      topFragsPlayer,
    };

    const events = stepMatch(this.match, ctx, dt);
    for (const ev of events) {
      switch (ev.type) {
        case 'matchStart':
          this.frozen = false;
          break;
        case 'matchEnd':
          this.frozen = true;
          break;
        case 'reset':
          // New match: zero every player's frags and respawn them fresh.
          for (const p of this.players.values()) {
            p.frags = 0;
            this.respawnPlayer(p);
          }
          this.frozen = false;
          break;
      }
    }
  }

  /** Respawn a player at the spawn farthest from any living player; full hp/ammo. */
  private respawnPlayer(p: RoomPlayer): void {
    const spawn = this.pickSpawn();
    const pos = fromTuple(spawn.pos);
    p.pos = pos;
    p.vel = { x: 0, y: 0, z: 0 };
    p.yaw = (spawn.yaw * Math.PI) / 180;
    p.pitch = 0;
    p.hp = TUNING.combat.spawnHealth;
    p.alive = true;
    p.respawnTimer = 0;
    p.weapon = 1;
    p.ammo = this.freshAmmo();
    p.cooldowns = { 1: 0, 2: 0, 3: 0, 4: 0 };
    p.anim = 'idle';
    this.validator.reset(p.id, pos);
    this.lagcomp.record(p.id, this.center(pos), CAP_RADIUS, CAP_HALF, this.now());
    // Tell the client (movement is client-auth) to snap to the new spawn.
    this.sendTo(p, { t: 'respawn', id: p.id, pos: toTuple(pos), yaw: p.yaw });
  }

  /** Pick the spawn point farthest from the nearest living player (anti-camp). */
  private pickSpawn(): { pos: Vec3Tuple; yaw: number } {
    const spawns = this.map.spawns;
    let best = spawns[0];
    let bestScore = -Infinity;
    for (const s of spawns) {
      let nearest = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const dx = p.pos.x - s.pos[0];
        const dz = p.pos.z - s.pos[2];
        const d2 = dx * dx + dz * dz;
        if (d2 < nearest) nearest = d2;
      }
      // No living players -> all spawns score equally; the first wins.
      if (nearest > bestScore) {
        bestScore = nearest;
        best = s;
      }
    }
    return best;
  }
```

> Note: `this.map.spawns` entries are `{ pos: Vec3Tuple; yaw: number }` (degrees). `Vec3Tuple` is already imported in room.ts.

- [ ] **Step 12: Update the freeze handling in `sendSnapshot` (no code change needed, verify)**

`sendSnapshot` already reads `this.frozen`. With `frozen` now meaning matchEnd only, dead players are conveyed by `hp <= 0` (the client hides them). No change required. Confirm the method still references `this.frozen` and `p.anim`/`p.vel` only.

- [ ] **Step 13: Replace the round-state broadcast methods**

Find `broadcastRoundState` and `maybeBroadcastRoundState` (contiguous) and replace BOTH with:

```ts
  /** Send the current match-state unconditionally (membership changes). */
  private broadcastMatchState(): void {
    const m = this.match;
    this.lastSentPhase = m.phase;
    this.matchStateAccum = 0;
    this.broadcast(this.matchStateMsg());
  }

  /** Build the match_state wire message from current room state. */
  private matchStateMsg(): ServerMessage {
    const m = this.match;
    const scores: Array<{ id: number; frags: number }> = [];
    for (const p of this.players.values()) scores.push({ id: p.id, frags: p.frags });
    return {
      t: 'match_state',
      phase: m.phase,
      // live: the match clock; matchEnd: the scoreboard countdown.
      timer: Math.max(0, m.phase === 'matchEnd' ? Math.ceil(m.clock) : Math.floor(m.clock)),
      fragLimit: TUNING.world.fragLimit,
      scores,
      winner: m.matchWinner,
    };
  }

  /**
   * Broadcast match-state when the phase changes, otherwise as a ~1Hz heartbeat
   * (so the client clock + live frag table stay fresh without per-tick churn).
   * Frag changes ride the heartbeat (≤1s lag on the scoreboard is fine; the kill
   * feed is immediate). Called once per tick.
   */
  private maybeBroadcastMatchState(): void {
    const m = this.match;
    const changed = m.phase !== this.lastSentPhase;
    this.matchStateAccum++;
    const heartbeat = this.matchStateAccum >= TUNING.world.serverHz; // ~1Hz
    if (changed || heartbeat) this.broadcastMatchState();
  }
```

- [ ] **Step 14: Point the tick at the renamed broadcast**

Find in `tickOnce`:

```ts
    // Round-state broadcast: on phase/score/round change, else a ~1Hz heartbeat.
    this.maybeBroadcastRoundState();
```

Replace with:

```ts
    // Match-state broadcast: on phase change, else a ~1Hz heartbeat.
    this.maybeBroadcastMatchState();
```

- [ ] **Step 15: Fix the `matchState` getter comment (optional) and typecheck**

Run: `npx tsc -p shared/tsconfig.json && npx tsc -p server/tsconfig.json`
Expected: PASS. If errors mention `playerInSlot`, `slot`, `connected`, `diedPending`, `frozen` init, `broadcastRoundState`, or `freshAmmo` unused — resolve them (they indicate a missed edit above). `freshAmmo` is still used by `addPlayer`/`respawnPlayer`; keep it.

- [ ] **Step 16: Update `room.test.ts` for FFA**

Open `server/src/room.test.ts`. In the first test ("joins two players, broadcasts snapshots, and reports presence"), the capacity assertion is now wrong — 2 players no longer fills a 6-player room. Find:

```ts
    expect(room.playerCount).toBe(2);
    expect(room.isFull).toBe(true);
```

Replace with:

```ts
    expect(room.playerCount).toBe(2);
    expect(room.isFull).toBe(false); // FFA room holds up to maxPlayers (6)
```

Then update the phase helper comment and add FFA assertions:

Find:

```ts
// Tick the room until its match reaches `phase` (or a safety bound). The match
// machine starts in `waiting`, flips to `countdown` (frozen) the first tick two
// players are present, then `live` after countdownSec.
function tickUntilPhase(room: Room, phase: string, max = 2000): void {
  for (let i = 0; i < max && room.matchState.phase !== phase; i++) room.tickOnce();
}
```

Replace with:

```ts
// Tick the room until its match reaches `phase` (or a safety bound). The FFA
// machine starts in `warmup`, flips to `live` the first tick two players are
// present (no countdown), and to `matchEnd` when someone hits the frag limit.
function tickUntilPhase(room: Room, phase: string, max = 2000): void {
  for (let i = 0; i < max && room.matchState.phase !== phase; i++) room.tickOnce();
}
```

- [ ] **Step 17: Add FFA room tests**

Append these tests inside the top-level `describe('Room', ...)` block in `room.test.ts` (before its closing `});`). They reuse the `StubSocket`, `asWs`, `received`, and `decode` helpers already defined in the file:

```ts
  it('goes live (no countdown) the first tick two players are present', async () => {
    const room = await Room.create('FFA1', 'crate');
    room.addPlayer(asWs(new StubSocket()), 1, 'Alice');
    expect(room.matchState.phase).toBe('warmup'); // one player -> warmup
    room.addPlayer(asWs(new StubSocket()), 2, 'Bob');
    room.tickOnce();
    expect(room.matchState.phase).toBe('live'); // two players -> live immediately
  });

  it('reports all players in match_state scores', async () => {
    const room = await Room.create('FFA2', 'crate');
    const a = new StubSocket();
    const b = new StubSocket();
    const c = new StubSocket();
    room.addPlayer(asWs(a), 1, 'A');
    room.addPlayer(asWs(b), 2, 'B');
    room.addPlayer(asWs(c), 3, 'C');
    expect(room.playerCount).toBe(3);

    tickUntilPhase(room, 'live');
    for (let i = 0; i < 4; i++) room.tickOnce();

    const ms = received(a, 'match_state').at(-1);
    expect(ms).toBeDefined();
    expect(ms!.scores.map((s) => s.id).sort()).toEqual([1, 2, 3]);
    expect(ms!.fragLimit).toBe(TUNING.world.fragLimit);
  });

  it('accepts up to maxPlayers and rejects the overflow', async () => {
    const room = await Room.create('FFA3', 'crate');
    const made: number[] = [];
    for (let i = 1; i <= TUNING.world.maxPlayers + 1; i++) {
      const p = room.addPlayer(asWs(new StubSocket()), i, `P${i}`);
      if (p) made.push(i);
    }
    expect(made.length).toBe(TUNING.world.maxPlayers);
    expect(room.isFull).toBe(true);
  });
```

> The first added test is intentionally light on the kill path (the private
> `applyDamage` isn't reachable from a stub without a full shoot pipeline). Frag
> crediting is covered end-to-end by the manual 3-client verification in Task 11
> and unit-covered by the reducer in Task 4. The `match_state` scores test and the
> capacity test give real room-level coverage of the FFA changes.

- [ ] **Step 18: Run the server tests**

Run: `npx vitest run server/src/room.test.ts server/src/match.test.ts`
Expected: PASS. If the existing hitscan-damage test in `room.test.ts` fails because it relied on `countdown`/`waiting` phases, update its `tickUntilPhase(room, 'live')` call (it should already target `'live'`, which is still valid) and ensure it adds two players first.

- [ ] **Step 19: Full server typecheck + test**

Run: `npx tsc -p server/tsconfig.json && npx vitest run server/`
Expected: PASS.

- [ ] **Step 20: Commit**

```bash
git add server/src/room.ts server/src/room.test.ts
git commit -m "feat(server): FFA room — frags, respawn, far-spawn, drop slots/grace"
```

---

## Task 6: Server lobby logging

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Fix the join log and `youAreReady`**

Find:

```ts
          console.log(`[server] ${name} (#${playerId}) joined room ${room.id} (${room.playerCount}/2)`);
          ws.send(
            encode({
              t: 'joined',
              playerId,
              roomId: room.id,
              mapId: room.mapId,
              serverTime: nowMs(),
              youAreReady: room.playerCount >= 2,
            }),
          );
```

Replace with:

```ts
          console.log(
            `[server] ${name} (#${playerId}) joined room ${room.id} (${room.playerCount}/${TUNING.world.maxPlayers})`,
          );
          ws.send(
            encode({
              t: 'joined',
              playerId,
              roomId: room.id,
              mapId: room.mapId,
              serverTime: nowMs(),
              youAreReady: room.playerCount >= TUNING.world.warmupMinPlayers,
            }),
          );
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc -p server/tsconfig.json`
Expected: PASS.

```bash
git add server/src/index.ts
git commit -m "feat(server): log room capacity /maxPlayers; ready at warmupMinPlayers"
```

---

## Task 7: Client connection — match_state + respawn hooks

**Files:**
- Modify: `client/src/net/connection.ts`

- [ ] **Step 1: Update imports**

At the top of `connection.ts`, the type imports include `RoundStateMsg`. Replace `RoundStateMsg` with `MatchStateMsg, RespawnMsg` in the import list from `@rivals/shared` (find the import block and edit the names).

- [ ] **Step 2: Rename the hook and add a respawn hook**

Find:

```ts
  onRoundState: Cb<RoundStateMsg> = noop;
  onOpponent: Cb<OpponentInfo> = noop;
```

Replace with:

```ts
  onMatchState: Cb<MatchStateMsg> = noop;
  onRespawn: Cb<RespawnMsg> = noop;
  onOpponent: Cb<OpponentInfo> = noop;
```

- [ ] **Step 3: Update the message switch**

Find:

```ts
      case 'round_state':
        this.onRoundState(msg as RoundStateMsg);
        break;
```

Replace with:

```ts
      case 'match_state':
        this.onMatchState(msg as MatchStateMsg);
        break;

      case 'respawn':
        this.onRespawn(msg as RespawnMsg);
        break;
```

- [ ] **Step 4: Typecheck client (expected to fail in main.ts only)**

Run: `npx tsc -p client/tsconfig.json`
Expected: FAIL only in `main.ts` (it still calls `nc.onRoundState`). That's fixed in Task 9. `connection.ts` itself must compile.

- [ ] **Step 5: Commit**

```bash
git add client/src/net/connection.ts
git commit -m "feat(client): connection onMatchState + onRespawn hooks"
```

---

## Task 8: RemotePlayers manager

**Files:**
- Create: `client/src/entities/remote-players.ts`
- Test: `client/src/entities/remote-players.test.ts`

- [ ] **Step 1: Write the failing roster test**

Create `client/src/entities/remote-players.test.ts`:

```ts
// Roster bookkeeping for the multi-opponent manager. Three.js object creation
// works headless (no WebGLRenderer needed); we only assert the id<->entry map.
import { describe, it, expect } from 'vitest';
import { RemotePlayers } from './remote-players';

describe('RemotePlayers', () => {
  it('shows and hides opponents by id', () => {
    const rp = new RemotePlayers();
    rp.setPresent(2, 'Bob');
    rp.setPresent(3, 'Cara');
    expect(rp.activeIds().sort()).toEqual([2, 3]);

    rp.setAbsent(2);
    expect(rp.activeIds()).toEqual([3]);
  });

  it('pose updates only affect present opponents', () => {
    const rp = new RemotePlayers();
    rp.setPresent(5, 'Eve');
    rp.setPose(5, 1, 2, 3, 0.5);
    rp.setPose(9, 0, 0, 0, 0); // absent id -> ignored, no throw
    expect(rp.activeIds()).toEqual([5]);
  });

  it('liveTargets returns a capsule per present opponent', () => {
    const rp = new RemotePlayers();
    rp.setPresent(2, 'Bob');
    rp.setPose(2, 4, 5, 6, 0);
    const targets = rp.liveTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe(2);
    expect(targets[0].center.x).toBeCloseTo(4);
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run client/src/entities/remote-players.test.ts`
Expected: FAIL ("Cannot find module './remote-players'").

- [ ] **Step 3: Implement the manager**

Create `client/src/entities/remote-players.ts`:

```ts
// Multi-opponent manager for FFA (PRD §19.4 generalized to N). Owns a pool of
// RemotePlayer entries keyed by player id; each is the animated blocky humanoid
// + hp bar driven by interpolated snapshot poses (remotes are NEVER simulated
// locally). One root Group is added to the scene once. Zero per-frame allocation
// beyond the RemotePlayer's own (which is already alloc-free per pose).

import * as THREE from 'three';
import type { CapsuleTarget } from '../combat/hitscan';
import { TUNING } from '@rivals/shared';
import { RemotePlayer } from './remote-player';

const RADIUS = TUNING.movement.radius;
const HALF = TUNING.movement.standHeight / 2 - RADIUS;

export class RemotePlayers {
  readonly object: THREE.Group;
  private readonly entries = new Map<number, RemotePlayer>();

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'remote-players';
  }

  /** Ensure an opponent with this id is present + visible (idempotent). */
  setPresent(id: number, _name: string): void {
    let e = this.entries.get(id);
    if (!e) {
      e = new RemotePlayer();
      this.entries.set(id, e);
      this.object.add(e.object);
    }
    e.show(id);
  }

  /** Hide + retire an opponent (kept in the pool group, just invisible). */
  setAbsent(id: number): void {
    const e = this.entries.get(id);
    if (e) e.hide();
  }

  /** Ids currently shown. */
  activeIds(): number[] {
    const ids: number[] = [];
    for (const [id, e] of this.entries) if (e.present) ids.push(id);
    return ids;
  }

  setPose(id: number, cx: number, cy: number, cz: number, yaw: number): void {
    this.entries.get(id)?.setPose(cx, cy, cz, yaw);
  }

  setHp(id: number, hp: number): void {
    this.entries.get(id)?.setHp(hp);
  }

  /** Advance every present opponent's walk/idle animation. */
  update(dt: number): void {
    for (const e of this.entries.values()) if (e.present) e.update(dt);
  }

  /** Capsule targets for the cosmetic client-side hitscan (all present opponents). */
  liveTargets(): CapsuleTarget[] {
    const out: CapsuleTarget[] = [];
    for (const [id, e] of this.entries) {
      if (!e.present) continue;
      const p = e.object.position;
      out.push({ id, center: { x: p.x, y: p.y, z: p.z }, radius: RADIUS, halfHeight: HALF });
    }
    return out;
  }

  /** Hide everyone (e.g. leaving online mode). */
  hideAll(): void {
    for (const e of this.entries.values()) e.hide();
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run client/src/entities/remote-players.test.ts`
Expected: PASS. If it errors on `document` (jsdom missing) when constructing `RemotePlayer` (its hp-bar `SpriteMaterial` needs no canvas, so this is unlikely), check `client`'s vitest environment; the existing `client/src/net/snapshots.test.ts` runs fine, so the env is adequate for pure-object Three.js.

- [ ] **Step 5: Commit**

```bash
git add client/src/entities/remote-players.ts client/src/entities/remote-players.test.ts
git commit -m "feat(client): RemotePlayers multi-opponent manager"
```

---

## Task 9: Wire FFA into main.ts

The client currently renders a single `remote` opponent, targets it for hitscan, drives one set of footsteps, and runs the round/countdown HUD. Replace all of that with the manager + FFA flow.

**Files:**
- Modify: `client/src/main.ts`

- [ ] **Step 1: Swap the import**

Find:

```ts
import { RemotePlayer } from './entities/remote-player';
```

Replace with:

```ts
import { RemotePlayers } from './entities/remote-players';
```

- [ ] **Step 2: Replace the single remote with the manager**

Find:

```ts
  // ---- networked opponent capsule (online only; shown on join) ----
  const remote = new RemotePlayer();
  scene.add(remote.object);
  registerShadows(remote.object);
```

Replace with:

```ts
  // ---- networked opponents (online only; up to maxPlayers-1, shown on join) ----
  const remotes = new RemotePlayers();
  scene.add(remotes.object);
```

> Shadows: the manager's humanoids are added dynamically; we skip `registerShadows`
> on join for simplicity (opponents still receive the world's shadows; they just
> don't cast onto each other — acceptable and cheaper). If you want casters, call
> `registerShadows` inside `RemotePlayers.setPresent` after `this.object.add`.

- [ ] **Step 3: Add local-death state next to the session vars**

Find:

```ts
  // Frozen during countdown/roundEnd/matchEnd: input locked + velocity zeroed.
  let frozen = false;
```

Replace with:

```ts
  // Frozen during the match-end scoreboard: input locked + velocity zeroed.
  let frozen = false;
  // True while the local player is dead awaiting a server respawn. Input is
  // gated off until the `respawn` message lands (movement is client-auth, so we
  // must not send a stale pose between death and the authoritative respawn).
  let localDead = false;
```

- [ ] **Step 4: Rewrite `wireNet`'s `onOpponent` to drive the manager**

Find:

```ts
    nc.onOpponent = (o) => {
      if (o.id >= 0) names.set(o.id, o.name);
      if (o.present) {
        opponentPresent = true;
        remote.show(o.id);
        dummy.object.visible = false;
      } else {
        opponentPresent = false;
        remote.hide();
        dummy.object.visible = true;
      }
    };
```

Replace with:

```ts
    nc.onOpponent = (o) => {
      if (o.id >= 0) names.set(o.id, o.name);
      if (o.present) {
        remotes.setPresent(o.id, o.name);
        dummy.object.visible = false; // no practice dummy online
      } else {
        remotes.setAbsent(o.id);
        names.delete(o.id);
      }
    };
```

- [ ] **Step 5: Replace `onRoundState` with `onMatchState` and add `onRespawn`**

Find the entire `nc.onRoundState = (rs) => { ... };` assignment (it spans the countdown/live/roundEnd/matchEnd banner switch — from `nc.onRoundState = (rs) => {` through its closing `};`) and replace the WHOLE thing with:

```ts
    nc.onMatchState = (ms) => {
      // Live frag table + leader progress; the HUD ranks the entries itself.
      hud.setFrags(ms.scores, localId, names, ms.fragLimit);
      // Show the match clock only while live; hidden otherwise.
      hud.setRoundTimer(ms.phase === 'live' ? ms.timer : 0);

      // Freeze only on the match-end scoreboard.
      frozen = ms.phase === 'matchEnd';
      if (frozen) {
        state.vel.x = 0;
        state.vel.y = 0;
        state.vel.z = 0;
        input.setEnabled(false);
      } else if (plc.locked && !localDead) {
        input.setEnabled(true);
      }

      const phaseChanged = ms.phase !== lastPhase;
      if (phaseChanged) {
        if (ms.phase === 'live') {
          hud.hideScoreboard();
          hud.showBanner('FIGHT', '');
        } else if (ms.phase === 'matchEnd') {
          hud.showScoreboardFFA(ms.scores, names, localId, myName, ms.winner);
          hud.hideBanner();
          audio.roundEnd(ms.winner === localId);
        }
      }
      lastPhase = ms.phase;
    };

    nc.onRespawn = (r) => {
      if (r.id !== localId) return; // opponents respawn via snapshots
      set(state.pos, r.pos[0], r.pos[1], r.pos[2]);
      state.vel.x = 0;
      state.vel.y = 0;
      state.vel.z = 0;
      state.grounded = false;
      state.moveState = 'air';
      state.capsuleHalf = standHalf();
      state.yaw = r.yaw;
      plc.yaw = r.yaw;
      localHp = TUNING.combat.spawnHealth;
      if (net) net.setHp(localHp);
      localDead = false;
      hidePrompt();
      if (plc.locked && !frozen) input.setEnabled(true);
    };
```

> `hud.setFrags`, `hud.showScoreboardFFA` are added in Task 10. `set`, `standHalf`,
> `TUNING` are already imported in main.ts.

- [ ] **Step 6: Local death on the kill message**

Find:

```ts
    nc.onKill = (k) => {
      const killer = names.get(k.killer) ?? (k.killer === localId ? myName : 'Opponent');
      const victim = names.get(k.victim) ?? (k.victim === localId ? myName : 'Opponent');
      hud.addKill(killer, victim, k.weapon, k.fall);
      // 1v1: every kill involves me — sting on my frags (skip my own deaths).
      if (k.killer === localId && k.victim !== localId) audio.kill();
    };
```

Replace with:

```ts
    nc.onKill = (k) => {
      const killer = names.get(k.killer) ?? (k.killer === localId ? myName : 'Player');
      const victim = names.get(k.victim) ?? (k.victim === localId ? myName : 'Player');
      hud.addKill(killer, victim, k.weapon, k.fall);
      if (k.killer === localId && k.victim !== localId) audio.kill();
      // My own death: enter the dead state and freeze input until the server's
      // respawn message arrives (server owns respawn position + timing in FFA).
      if (k.victim === localId) {
        localDead = true;
        state.vel.x = 0;
        state.vel.y = 0;
        state.vel.z = 0;
        input.setEnabled(false);
        showPrompt('Respawning…');
      }
    };
```

- [ ] **Step 7: Stop client-predicting death in `onDamage`**

Find:

```ts
        if (localHp <= 0) respawn();
      } else {
        // We damaged the opponent -> hitmarker feedback.
        hud.hitmarker();
        audio.hitmarker();
      }
```

Replace with:

```ts
        // Death + respawn are server-driven in FFA (kill + respawn messages); do
        // not client-predict a respawn here.
      } else {
        // We damaged someone -> hitmarker feedback.
        hud.hitmarker();
        audio.hitmarker();
      }
```

- [ ] **Step 8: Update `onClose`**

Find:

```ts
    nc.onClose = () => {
      // Lost the server mid-session: surface it; the sandbox keeps running with
      // local movement (no further net traffic). Return to the lobby.
      opponentPresent = false;
      remote.hide();
      dummy.object.visible = true;
      frozen = false;
      returnToLobby = true;
    };
```

Replace with:

```ts
    nc.onClose = () => {
      // Lost the server mid-session: surface it and return to the lobby.
      remotes.hideAll();
      dummy.object.visible = true;
      frozen = false;
      localDead = false;
      returnToLobby = true;
    };
```

- [ ] **Step 9: Reset the teardown hooks for the new handler names**

Find:

```ts
      net.onOpponent = NOOP;
      net.onRoundState = NOOP;
      net.onKill = NOOP;
```

Replace with:

```ts
      net.onOpponent = NOOP;
      net.onMatchState = NOOP;
      net.onRespawn = NOOP;
      net.onKill = NOOP;
```

- [ ] **Step 10: Clean per-match state in `teardownSession`**

Find:

```ts
    names.clear();
    remote.hide();
    dummy.object.visible = true;
    hud.hideBanner();
    projectiles.clear();
    respawn();
```

Replace with:

```ts
    names.clear();
    remotes.hideAll();
    dummy.object.visible = true;
    localDead = false;
    hud.hideBanner();
    projectiles.clear();
    respawn();
```

- [ ] **Step 11: `enterOffline` — hide remotes instead of one**

Find:

```ts
    dummy.object.visible = true;
    remote.hide();
  }
```

Replace with:

```ts
    dummy.object.visible = true;
    remotes.hideAll();
  }
```

- [ ] **Step 12: FFA hitscan targeting in `fireWeapon`**

Find:

```ts
      if (online) {
        const targets = opponentPresent
          ? [{ id: remote.id, center: remoteCenter(), radius: m.radius, halfHeight: standHalf() }]
          : [];
        const res = hitscan(_eye, _dir, TUNING.ar.range, world, targets);
```

Replace with:

```ts
      if (online) {
        const targets = remotes.liveTargets();
        const res = hitscan(_eye, _dir, TUNING.ar.range, world, targets);
```

- [ ] **Step 13: Remove the single-opponent footstep + center scratch vars**

FFA per-opponent footsteps are out of scope for this cut (the local-player SFX
stay). Delete these declarations (search and remove each):

```ts
  // Opponent footstep cadence (online): emit a positional step every interval
  // while the remote is moving on the ground.
  let footstepTimer = 0;
  const FOOTSTEP_INTERVAL = 0.34; // seconds between steps at a walking cadence
  const FOOTSTEP_SPEED_MIN = 2; // m/s horizontal: ignore near-stationary jitter
  const _remotePrev: Vec3 = v3();
  let remotePrevValid = false;
```

And remove:

```ts
  // Remote capsule center for the cosmetic AR tracer endpoint (last sampled pose).
  const _remoteCenter: Vec3 = v3();
  const remoteCenter = (): Vec3 => _remoteCenter;
```

Also remove the now-unused `opponentPresent` declaration:

```ts
  let opponentPresent = false;
```

(Search for remaining `opponentPresent` references; the F3 debug panel uses it — see Step 15.)

- [ ] **Step 14: Replace the render() opponent-sampling block**

Find the whole block in `render` that starts with `// ---- sample + drive the remote opponent (online) ----` and ends just before `particles.update(dt);` — replace it with:

```ts
    // ---- sample + drive ALL remote opponents (online) ----
    if (net) {
      const renderTime = net.serverTime(nowMs) - TUNING.world.interpDelayMs;
      const sampled = net.snapshots.sample(renderTime);
      for (const opp of sampled.players) {
        if (opp.id === localId) continue;
        remotes.setPresent(opp.id, names.get(opp.id) ?? 'Player');
        remotes.setPose(opp.id, opp.pos[0], opp.pos[1], opp.pos[2], opp.yaw);
        remotes.setHp(opp.id, opp.hp);
      }
      remotes.update(dt);
    }
```

- [ ] **Step 15: Fix the F3 debug panel's `opponentPresent` reference**

Find in the `createDebugPanel` call:

```ts
          mode: opponentPresent ? 'online (1v1)' : 'online (solo-wait)',
```

Replace with:

```ts
          mode: `online (FFA ${remotes.activeIds().length + 1}p)`,
```

- [ ] **Step 16: Gate local fall-respawn + firing on online/dead state**

Find in `step`:

```ts
    if (state.pos.y < CRATE_MAP.killY) respawn();
```

Replace with:

```ts
    // Offline: client owns fall-respawn. Online: keep falling + reporting so the
    // server detects killY and drives the authoritative kill + respawn.
    if (!online && state.pos.y < CRATE_MAP.killY) respawn();
```

Then find:

```ts
    const active = locked && !frozen;
```

Replace with:

```ts
    const active = locked && !frozen && !localDead;
```

- [ ] **Step 17: Typecheck the client**

Run: `npx tsc -p client/tsconfig.json`
Expected: FAIL only on the not-yet-added `hud.setFrags` / `hud.showScoreboardFFA` (Task 10). Every other main.ts error must be resolved. If you see errors about `remote`, `opponentPresent`, `remoteCenter`, `footstepTimer`, `onRoundState` — a Step above was missed.

- [ ] **Step 18: Commit**

```bash
git add client/src/main.ts
git commit -m "feat(client): FFA flow — many opponents, server respawn, match_state HUD"
```

---

## Task 10: HUD — frag table, FFA scoreboard, death cue

The HUD currently has a 2-player score chip (`scoreA`/`scoreB`/`roundLabel`) and a
2-player match-end scoreboard. Replace the public API used by main.ts with FFA
versions. We keep the DOM-on-change discipline but the rosters are small (≤6) so a
full re-render per `match_state` (~1Hz) is fine.

**Files:**
- Modify: `client/src/ui/hud.ts`
- Modify: `client/src/ui/style.css`

- [ ] **Step 1: Add a `setFrags` method (live frag table)**

In `hud.ts`, find the `setScore` method:

```ts
  // Top-center round score "[a] – [b]" plus a "ROUND n" label.
  setScore(a: number, b: number, round: number): void {
    if (a !== this.lastScoreA) {
      this.lastScoreA = a;
      this.scoreA.textContent = String(a);
    }
    if (b !== this.lastScoreB) {
      this.lastScoreB = b;
      this.scoreB.textContent = String(b);
    }
    if (round !== this.lastRound) {
      this.lastRound = round;
      this.roundLabel.textContent = `ROUND ${round}`;
    }
  }
```

Replace it with:

```ts
  // Live FFA frag table (top-right): every player ranked by frags, you + the
  // leader highlighted, the leader's "x / fragLimit" progress shown. Re-renders
  // wholesale on each match_state (~1Hz, ≤6 rows — cheap).
  setFrags(
    scores: Array<{ id: number; frags: number }>,
    localId: number,
    names: Map<number, string>,
    fragLimit: number,
  ): void {
    const ranked = [...scores].sort((p, q) => q.frags - p.frags || p.id - q.id);
    const leaderFrags = ranked.length ? ranked[0].frags : 0;
    const rows = ranked
      .map((s, i) => {
        const me = s.id === localId ? ' me' : '';
        const lead = i === 0 && s.frags > 0 ? ' lead' : '';
        const name = s.id === localId ? 'You' : names.get(s.id) ?? `P${s.id}`;
        return `<div class="wr-frag-row${me}${lead}"><span class="wr-frag-name">${escapeHtml(
          name,
        )}</span><span class="wr-frag-n">${s.frags}</span></div>`;
      })
      .join('');
    this.fragTable.innerHTML =
      `<div class="wr-frag-head">${leaderFrags} / ${fragLimit}</div>` + rows;
  }
```

- [ ] **Step 2: Replace `showScoreboard` with `showScoreboardFFA`**

Find:

```ts
  // Match-end overlay (~5s): final score, both names, WIN / LOSE.
  showScoreboard(score: [number, number], names: [string, string], youWon: boolean): void {
    this.sbScore.textContent = `${score[0]} – ${score[1]}`;
    this.sbNameA.textContent = names[0];
    this.sbNameB.textContent = names[1];
    this.sbResult.textContent = youWon ? 'VICTORY' : 'DEFEAT';
    this.sbResult.classList.toggle('win', youWon);
    this.sbResult.classList.toggle('lose', !youWon);
    this.scoreboard.classList.add('show');
    if (this.scoreboardTimer) window.clearTimeout(this.scoreboardTimer);
    this.scoreboardTimer = window.setTimeout(() => {
      this.scoreboard.classList.remove('show');
      this.scoreboardTimer = 0;
    }, SCOREBOARD_MS);
  }
```

Replace with:

```ts
  // Match-end overlay (~5s): the full ranked frag table with the winner crowned.
  showScoreboardFFA(
    scores: Array<{ id: number; frags: number }>,
    names: Map<number, string>,
    localId: number,
    myName: string,
    winnerId: number,
  ): void {
    const ranked = [...scores].sort((p, q) => q.frags - p.frags || p.id - q.id);
    const youWon = winnerId === localId;
    this.sbResult.textContent = youWon ? 'VICTORY' : 'DEFEAT';
    this.sbResult.classList.toggle('win', youWon);
    this.sbResult.classList.toggle('lose', !youWon);
    this.sbScore.innerHTML = ranked
      .map((s, i) => {
        const name = s.id === localId ? myName : names.get(s.id) ?? `P${s.id}`;
        const crown = s.id === winnerId ? '👑 ' : '';
        const me = s.id === localId ? ' me' : '';
        return `<div class="wr-sb-row${me}"><span class="wr-sb-rank">${i + 1}</span><span class="wr-sb-name">${crown}${escapeHtml(
          name,
        )}</span><span class="wr-sb-n">${s.frags}</span></div>`;
      })
      .join('');
    this.scoreboard.classList.add('show');
    if (this.scoreboardTimer) window.clearTimeout(this.scoreboardTimer);
    this.scoreboardTimer = window.setTimeout(() => {
      this.scoreboard.classList.remove('show');
      this.scoreboardTimer = 0;
    }, SCOREBOARD_MS);
  }
```

- [ ] **Step 3: Add the `fragTable` element + `escapeHtml`, retire the old score chip elements**

In the constructor, find where `this.scoreA` / `this.scoreB` / `this.roundLabel`
are created and their DOM appended (search for `scoreA`). Those build the
top-center score chip. Replace their creation with a single top-right frag table.
Concretely:

1. In the class field declarations, find:

```ts
  // --- round/match elements ---
  private readonly scoreA: HTMLElement;
  private readonly scoreB: HTMLElement;
  private readonly roundLabel: HTMLElement;
  private readonly timerEl: HTMLElement;
```

Replace with:

```ts
  // --- match elements ---
  private readonly fragTable: HTMLElement;
  private readonly timerEl: HTMLElement;
```

2. Find the constructor code that creates and wires `scoreA`/`scoreB`/`roundLabel`
(a small block building the score chip; it assigns `this.scoreA = ...` etc. and
appends them to a container). Replace that block with:

```ts
    // Top-right live frag table (FFA). Populated by setFrags on each match_state.
    this.fragTable = el('div', 'wr-frag-table');
    root.appendChild(this.fragTable);
```

> If `scoreA`/`scoreB`/`roundLabel` were appended into a shared parent element
> created alongside the timer, keep the timer element creation and only remove the
> three score nodes. Leave `this.timerEl` creation intact.

3. Remove the now-dead cache fields. Find and delete:

```ts
  private lastScoreA = NaN;
  private lastScoreB = NaN;
  private lastRound = -1;
```

(Search for each; they were only used by the removed `setScore`.)

4. Add `escapeHtml` as a module-local helper at the bottom of the file, next to
the existing `el` helper:

```ts
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
```

- [ ] **Step 4: Remove the old 2-player scoreboard name nodes**

The FFA scoreboard writes `this.sbScore.innerHTML` and `this.sbResult`. The old
`sbNameA`/`sbNameB` nodes are unused now. Find their field declarations:

```ts
  private readonly sbNameA: HTMLElement;
  private readonly sbNameB: HTMLElement;
```

Delete them, and delete the constructor lines that create/append `this.sbNameA` /
`this.sbNameB` (search `sbNameA`). Keep `sbScore`, `sbResult`, `scoreboard`.

- [ ] **Step 5: Add CSS for the frag table + FFA scoreboard rows**

Append to `client/src/ui/style.css`:

```css
/* ---- FFA live frag table (top-right) ---- */
.wr-frag-table {
  position: fixed;
  top: 14px;
  right: 14px;
  min-width: 150px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font: 600 13px system-ui, -apple-system, sans-serif;
  color: #f5f7fa;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
  pointer-events: none;
  z-index: 5;
}
.wr-frag-head {
  align-self: flex-end;
  font: 700 12px ui-monospace, "SF Mono", Menlo, monospace;
  color: #ffd27a;
  letter-spacing: 0.06em;
  margin-bottom: 2px;
}
.wr-frag-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 8px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.32);
}
.wr-frag-row.me {
  background: rgba(47, 127, 240, 0.4);
}
.wr-frag-row.lead .wr-frag-n {
  color: #ffd27a;
}
.wr-frag-n {
  font-variant-numeric: tabular-nums;
  font-weight: 800;
}

/* ---- FFA match-end scoreboard rows (reuses .show on .wr-scoreboard) ---- */
.wr-sb-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 18px;
  font: 600 18px system-ui, -apple-system, sans-serif;
  color: #f5f7fa;
}
.wr-sb-row.me {
  background: rgba(47, 127, 240, 0.28);
  border-radius: 8px;
}
.wr-sb-rank {
  width: 1.5em;
  color: rgba(245, 247, 250, 0.5);
  font-variant-numeric: tabular-nums;
}
.wr-sb-name {
  flex: 1;
  text-align: left;
}
.wr-sb-n {
  font-variant-numeric: tabular-nums;
  font-weight: 800;
  color: #ffd27a;
}
```

- [ ] **Step 6: Typecheck the client**

Run: `npx tsc -p client/tsconfig.json`
Expected: PASS. Resolve any leftover references to removed fields (`scoreA`,
`scoreB`, `roundLabel`, `lastScoreA/B`, `lastRound`, `sbNameA/B`, `setScore`,
`showScoreboard`) — they should all be gone from `hud.ts` and `main.ts`.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS (all suites). Then `npm run typecheck` → PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/ui/hud.ts client/src/ui/style.css
git commit -m "feat(hud): live FFA frag table + ranked match-end scoreboard"
```

---

## Task 11: End-to-end verification (3 clients)

**Files:** none (verification only).

- [ ] **Step 1: Build + full check**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, all tests pass, client builds.

- [ ] **Step 2: Launch server + client**

Run: `npm run dev:all` (server on :8090, client on :5173). Confirm the log reads
`listening on :8090`.

- [ ] **Step 3: Drive 3 headless clients into one room**

Use the chrome-debug skill's `chromectl.py`:

```bash
SK=/Users/mg/.claude/skills/chrome-debug/scripts/chromectl.py
$SK start --headless
A=$($SK open "http://localhost:5173" | jq -r .id)
B=$($SK open "http://localhost:5173" | jq -r .id)
C=$($SK open "http://localhost:5173" | jq -r .id)
sleep 4
for T in $A $B $C; do
  $SK eval --id $T -e "[...document.querySelectorAll('button')].find(x=>/find match/i.test(x.textContent||''))?.click()"
done
sleep 6
# Server should show 3/6 in one room and the match live.
tail -8 /tmp/rivals-devall.log
```

Expected: server log shows three players joined the **same** room `(1/6)`,
`(2/6)`, `(3/6)`.

- [ ] **Step 4: Confirm opponents render + frag table**

```bash
$SK eval --id $A -e "window.__dev.setView(0,9,9,0,-0.8)"
sleep 1
$SK screenshot --id $A -o /tmp/ffa-A.png
```

Read `/tmp/ffa-A.png`. Expected: two red humanoid opponents visible in the arena,
and the top-right frag table listing 3 rows (You + two others) with `0 / 15`.

- [ ] **Step 5: Confirm no console errors**

```bash
$SK console-tail --id $A --for 6 > /tmp/ffa-console.log 2>&1 &
sleep 6
grep -iE '"(error)"|webgl|undefined is not' /tmp/ffa-console.log || echo "clean"
$SK stop
```

Expected: `clean` (ignore unrelated 404s for favicon).

- [ ] **Step 6: Manual smoke (optional, recommended)**

In a real browser, open 3 tabs → FIND MATCH in each → confirm: you can see and
shoot opponents, kills appear in the feed, the killed player respawns after ~1.5s,
the frag table updates, and hitting 15 frags shows the ranked scoreboard then
auto-rematches.

- [ ] **Step 7: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(ffa): verified 3-client free-for-all end to end"
```

---

## Self-Review Notes

- **Spec coverage:** tuning (T1), protocol match_state+respawn (T2), 6 spawns (T3),
  FFA reducer (T4), room frags/respawn/far-spawn/no-grace (T5), lobby capacity
  (T6), client hooks (T7), multi-opponent manager (T8), client FFA flow incl.
  local death/respawn + FFA hitscan (T9), HUD frag table + scoreboard (T10),
  3-client verification (T11). All spec sections map to a task.
- **Tiebreak:** lowest id wins (reducer T4 ctx builder in T5 Step 11; documented).
- **Out-of-scope honored:** no teams; map only gains spawns; matchmaking unchanged
  besides capacity. Opponent footsteps intentionally dropped for this cut (noted
  in T9 Step 13) — restore later if wanted.
- **Known follow-ups:** opponent shadow casting is disabled for perf (T9 Step 2);
  opponent footstep audio removed; no spawn invulnerability.