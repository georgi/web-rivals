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
      const reachedCap = W.matchTimeCapSec > 0 && state.clock > W.matchTimeCapSec;
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
