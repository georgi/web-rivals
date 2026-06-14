# Free-For-All Deathmatch (up to 6 players) — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Supersedes:** the 1v1 round-based match model (PRD §2)

## Goal

Turn the 1v1 round-based arena into a **free-for-all deathmatch** for **up to 6
players** — everyone against everyone. First decided mode; teams may follow later
(out of scope here).

## Decided rules

- **Mode:** frag-limit deathmatch. First player to `fragLimit` kills wins.
- **Lifecycle:** drop-in + auto-rematch.
  - 1 player → **warmup** free-roam (no frags counted toward a win).
  - 2+ players → **live**, frags count.
  - A player hits `fragLimit` (or the match clock reaches `matchTimeCapSec`) →
    **matchEnd**: show a ranked scoreboard for `matchEndSec`, then reset all
    frags and resume with whoever is still connected (same room).
  - Players join/leave anytime.
- **Respawn:** instant after a short `respawnDelaySec` delay, at the spawn point
  **farthest from any living player** (anti-spawn-camp).
- **Suicide** (fall-out / own rocket): no frag credit to anyone, `killer = -1`.
  No score penalty.
- **Scores survive** a brief drop below 2 players (back to warmup keeps frags);
  frags reset only at the matchEnd→reset boundary.

## Why these choices

- Frag deathmatch keeps all 6 players continuously in the action (round-based
  elimination would leave most players spectating each round).
- Auto-rematch suits a drop-in arena: no lobby round-trip between matches.
- Deleting the disconnect grace/forfeit machinery is safe — it only existed to
  protect a 1v1 from a hiccup; in FFA a disconnect is just a departure.

## Architecture

The wire/sim foundation is already N-player-ready: `snapshot` carries a
`PlayerSnap[]`, client interpolation keys players by id, and `LagComp`,
`computeExplosion`, and hitscan rewind are all per-id and exclude the
shooter/owner. The work concentrates in the match reducer, the room's
slot/scoring/respawn logic, the client's single→many opponents, and the HUD.

### 1. Tuning (`shared/src/tuning.ts`)

Retire round fields: `roundsToWin`, `roundTimeSec`, `roundEndSec`, `countdownSec`,
`disconnectGraceSec`.

Add to `world`:

| field | value | meaning |
|---|---|---|
| `maxPlayers` | 6 | players per room |
| `fragLimit` | 15 | kills to win |
| `respawnDelaySec` | 1.5 | delay before respawn |
| `matchTimeCapSec` | 600 | stalemate backstop (0 = disabled); most frags wins |
| `warmupMinPlayers` | 2 | players needed to go live |
| `matchEndSec` | 5 | scoreboard display (kept) |

### 2. Match reducer (`server/src/match.ts`) — rewritten, pure, unit-tested

```
type MatchPhase = 'warmup' | 'live' | 'matchEnd';

interface MatchState {
  phase: MatchPhase;
  clock: number;        // live: counts up (match clock); matchEnd: counts down (display)
  matchWinner: number;  // playerId at matchEnd, else -1
}

interface MatchTickCtx {
  connectedCount: number;
  topFrags: number;        // highest frag count among players
  topFragsPlayer: number;  // that player's id, -1 if none
}

type MatchEvent =
  | { type: 'matchStart' }
  | { type: 'matchEnd'; winner: number }
  | { type: 'reset' };   // zero all frags, return to warmup/live
```

Transitions:

- **warmup**: `connectedCount >= warmupMinPlayers` → `live`, `clock = 0`, emit
  `matchStart`.
- **live**: `clock += dt`.
  - `connectedCount < warmupMinPlayers` → `warmup` (frags kept).
  - else `topFrags >= fragLimit` → `matchEnd`, `winner = topFragsPlayer`,
    `clock = matchEndSec`, emit `matchEnd`.
  - else `matchTimeCapSec > 0 && clock >= matchTimeCapSec` → `matchEnd`,
    `winner = topFragsPlayer`, emit `matchEnd`.
- **matchEnd**: `clock -= dt`; at `<= 0` → `warmup`, emit `reset` (room zeroes all
  frags; re-enters `live` next tick if still 2+).

Frags are **not** stored in the reducer — they live on `RoomPlayer.frags` and are
incremented at the kill site (room). The reducer reads only the aggregate ctx, so
it stays pure and exhaustively testable.

### 3. Server room (`server/src/room.ts`)

- `MAX_PLAYERS = TUNING.world.maxPlayers` (6).
- **Delete** `slots`, `connected`, `disconnectedFor`, the forfeit path, and the
  grace window. `removePlayer` vacates immediately and announces departure via the
  existing per-id `opponent { present:false }`.
- `RoomPlayer` gains `frags: number` and `respawnTimer: number`; drops
  `slot/connected/disconnectedFor/diedPending` (death is handled inline now).
- **Kill credit** (`applyDamage`): on lethal hit, `attacker.frags++` when
  `source >= 0 && source !== victim.id`; broadcast `kill`. Set
  `victim.alive = false`, `victim.respawnTimer = respawnDelaySec`.
- **Fall / own-rocket** = suicide: `applyDamage(..., source = -1)`, no credit.
- **Respawn** (tick): decrement `respawnTimer` for dead players; at `<= 0`
  respawn at the spawn farthest from any living player, full hp/ammo/weapon,
  `alive = true`, and send a `respawn` message.
- **Spawn selection** `pickSpawn()`: choose the spawn maximizing distance to the
  nearest living player. O(spawns × players).
- `frozen` collapses to `phase === 'matchEnd'`. Dead players (`!alive`) are hidden
  client-side (hp<=0) and cannot shoot. No round freeze, no countdown.
- Room never finishes while populated; the reaper destroys it only when empty.
  Remove `isFinished`/`matchEverEnded`/round-state churn fields tied to the old
  model; keep the ~1Hz `match_state` heartbeat.

### 4. Protocol (`shared/src/protocol.ts`)

- `RoundStateMsg` (`round_state`) → **`MatchStateMsg`** (`match_state`):

  ```
  interface MatchStateMsg {
    t: 'match_state';
    phase: 'warmup' | 'live' | 'matchEnd';
    timer: number;                        // live: match clock; matchEnd: countdown
    fragLimit: number;
    scores: Array<{ id: number; frags: number }>;  // all players, for the live table
    winner: number;                       // playerId at matchEnd, else -1
  }
  ```

- New **`RespawnMsg`** (`respawn`): `{ id: number; pos: Vec3Tuple; yaw: number }`.
- `RoundPhase` type → `MatchPhase` (`'warmup'|'live'|'matchEnd'`).
- `snapshot` / `PlayerSnap` unchanged (dead ⟺ `hp <= 0`). `kill`, `damage`,
  `opponent`, `spawn_proj`, `detonate`, `correction` unchanged.
- `JoinedMsg.youAreReady` → repurpose as "match already live" (informational).

### 5. Client

- **`client/src/entities/remote-players.ts`** (new): a `RemotePlayers` manager
  owning a `Map<id, RemotePlayer>` (pooled to `maxPlayers - 1`). Each entry is the
  existing `RemotePlayer` (animated humanoid + hp bar + nameplate). API:
  `syncRoster(present ids+names)`, `setPose(id, …)`, `setHp(id, …)`, `update(dt)`,
  `liveTargets()` → capsule list for cosmetic hitscan. Adds one root group to the
  scene.
- **`main.ts`**:
  - Drive opponents from `snapshot.players.filter(p => p.id !== localId)` instead
    of `find(one)`.
  - Cosmetic online hitscan targets `remotePlayers.liveTargets()` (all opponents).
  - Local death/respawn: on `kill` with `victim === localId` → set `dead`, freeze
    input, show "Respawning…"; on `respawn` for `localId` → snap `state.pos`/yaw,
    reset `localHp` + weapon-state ammo, clear `dead`, unfreeze.
  - Remove round/countdown banner logic; keep a brief "FIGHT"/"GO" flash on
    `matchStart` (optional). Scoreboard on `matchEnd`.
  - The offline practice `dummy` is unchanged (offline mode keeps it).
- **HUD** (`client/src/ui/hud.ts`):
  - Replace the 2-player `scoreA/scoreB` chip with a **live frag table**
    (top-right): ranked rows `name — frags`, local player + current leader
    highlighted, fed from `match_state.scores`. Show `x / fragLimit` for the
    leader.
  - Match-end **scoreboard**: ranked N-row list, winner highlighted.
  - Kill feed unchanged. Add a "Respawning…" / death state cue.

### 6. Map (`shared/src/map-crate.json`)

Add 4 spawn points (total **6**) distributed around the 30×30 arena, each facing
roughly toward center. Keep the existing 2.

### 7. Tests

- **Rewrite `server/src/match.test.ts`**: warmup→live at 2 players; live→matchEnd
  at `fragLimit`; time-cap end picks top frags; matchEnd→reset zeroes frags;
  live→warmup when dropping below 2 keeps frags; `topFragsPlayer` tiebreak is
  deterministic (lowest id wins ties — document it).
- **Update `server/src/room.test.ts`**: N-player add/remove; frag credit on kill;
  no credit on suicide/fall; respawn after `respawnDelaySec`; `pickSpawn` picks
  the farthest spawn; `match_state.scores` reflects all players.
- Validator / lagcomp / client-snapshot tests are per-id already → expected to
  pass unchanged.

## Out of scope

- Teams / team scoring (explicitly "first, everyone against everyone").
- Map geometry changes beyond spawn points.
- Matchmaking changes beyond raising room capacity to 6 (quick-match still fills
  the first room with a free slot; private codes unchanged).

## Risks / edge cases

- **Spawn protection:** none beyond farthest-spawn selection (no spawn
  invulnerability). Acceptable for MVP; note for follow-up if camping is bad.
- **Client-auth respawn:** the server-sent `respawn` must land before the client
  re-enables input, or a dead-but-unfrozen frame could send a stale pos. Gate
  input on the local `dead` flag until `respawn` arrives.
- **Tiebreak at time cap / equal top frags:** lowest player id wins (deterministic
  and documented), surfaced as the scoreboard winner.
