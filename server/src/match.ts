// The PURE 1v1 match/round state machine (PRD §2). No I/O, no Rapier, no ws,
// no DOM — `stepMatch` takes the current state plus a per-tick context snapshot
// and mutates the state, returning the events the Room must act on (respawn,
// unfreeze, end-of-round/end-of-match). Keeping it pure makes every PRD §2 edge
// case exhaustively unit-testable: this is the cheapest place in the project to
// be rigorous (PRD §20.1).
//
// Timings + thresholds come straight from TUNING.world / TUNING.combat so the
// reducer never drifts from the single source of truth.

import { TUNING } from '@rivals/shared';

export type MatchPhase = 'waiting' | 'countdown' | 'live' | 'roundEnd' | 'matchEnd';

export interface MatchState {
  phase: MatchPhase;
  timer: number; // seconds remaining in the current timed phase
  score: [number, number]; // round wins per player index 0/1
  round: number; // 1-based current round
  lastRoundWinner: number; // 0|1 of the round that just ended, else -1
  matchWinner: number; // 0|1 or -1
}

export interface MatchTickCtx {
  bothConnected: boolean;
  hp: [number, number];
  died: [boolean, boolean]; // crossed to dead THIS tick (hp<=0 or fell off)
  disconnectedFor: [number, number]; // seconds each player has been disconnected (0 if connected)
}

export type MatchEvent =
  // room: respawn both at spawns, full hp/ammo, zero velocity, freeze input
  | { type: 'reset' }
  // room: unfreeze
  | { type: 'roundStart'; round: number }
  // winner -1 = draw/replay (no point)
  | { type: 'roundEnd'; winner: number }
  | { type: 'matchEnd'; winner: number };

const W = TUNING.world;

export function initMatch(): MatchState {
  return {
    phase: 'waiting',
    timer: 0,
    score: [0, 0],
    round: 1,
    lastRoundWinner: -1,
    matchWinner: -1,
  };
}

/**
 * Advance the match by `dt` seconds against this tick's context. MUTATES
 * `state` and returns the events produced this tick (usually 0 or 1, but the
 * round-result + phase-advance can co-occur and is folded into a single
 * roundEnd event). The Room calls this once per server tick.
 */
export function stepMatch(state: MatchState, ctx: MatchTickCtx, dt: number): MatchEvent[] {
  const events: MatchEvent[] = [];

  // --- Disconnect forfeit (any active phase except matchEnd). A player who has
  // been gone past the grace window forfeits to the still-connected opponent.
  // matchEnd already has a winner and is just draining its display timer, so we
  // leave it alone. waiting has nobody to forfeit to yet (no live round), so it
  // is excluded too — connection there is handled by the bothConnected gate.
  if (state.phase === 'countdown' || state.phase === 'live' || state.phase === 'roundEnd') {
    const aGone = ctx.disconnectedFor[0] >= W.disconnectGraceSec;
    const bGone = ctx.disconnectedFor[1] >= W.disconnectGraceSec;
    if (aGone || bGone) {
      // If both are gone past grace, there is no one to award it to (-1).
      const winner = aGone && bGone ? -1 : aGone ? 1 : 0;
      state.matchWinner = winner;
      state.lastRoundWinner = winner;
      state.phase = 'matchEnd';
      state.timer = W.matchEndSec;
      events.push({ type: 'matchEnd', winner });
      return events;
    }
  }

  switch (state.phase) {
    case 'waiting': {
      if (ctx.bothConnected) {
        // round stays whatever it is (1 at match start); freeze + respawn both.
        state.phase = 'countdown';
        state.timer = W.countdownSec;
        events.push({ type: 'reset' });
      }
      break;
    }

    case 'countdown': {
      state.timer -= dt;
      if (state.timer <= 0) {
        state.phase = 'live';
        state.timer = W.roundTimeSec;
        events.push({ type: 'roundStart', round: state.round });
      }
      break;
    }

    case 'live': {
      state.timer -= dt;

      // Resolve a round result THIS tick, if any. Death takes precedence over
      // timer expiry (a kill on the very tick the clock runs out still counts
      // as a kill, double-KO included).
      const aDied = ctx.died[0];
      const bDied = ctx.died[1];
      let winner: number | null = null;

      if (aDied || bDied) {
        if (aDied && bDied) {
          winner = -1; // double-KO: no point, replay the round
        } else {
          winner = aDied ? 1 : 0; // the survivor takes the round
        }
      } else if (state.timer <= 0) {
        // Timer expiry: higher HP wins; a tie replays the round.
        if (ctx.hp[0] > ctx.hp[1]) winner = 0;
        else if (ctx.hp[1] > ctx.hp[0]) winner = 1;
        else winner = -1;
      }

      if (winner !== null) {
        state.lastRoundWinner = winner;
        if (winner !== -1) {
          state.score[winner]++;
          if (state.score[winner] >= W.roundsToWin) {
            state.matchWinner = winner;
          }
        }
        state.phase = 'roundEnd';
        state.timer = W.roundEndSec;
        events.push({ type: 'roundEnd', winner });
      }
      break;
    }

    case 'roundEnd': {
      state.timer -= dt;
      if (state.timer <= 0) {
        if (state.matchWinner !== -1) {
          state.phase = 'matchEnd';
          state.timer = W.matchEndSec;
          events.push({ type: 'matchEnd', winner: state.matchWinner });
        } else {
          // Next round: bump the counter, freeze + respawn, run the countdown.
          state.phase = 'countdown';
          state.timer = W.countdownSec;
          state.round++;
          events.push({ type: 'reset' });
        }
      }
      break;
    }

    case 'matchEnd': {
      state.timer -= dt;
      if (state.timer <= 0) {
        // Drain to a fresh match, ready for a rematch / new pair.
        state.phase = 'waiting';
        state.timer = 0;
        state.score = [0, 0];
        state.round = 1;
        state.matchWinner = -1;
        state.lastRoundWinner = -1;
      }
      break;
    }
  }

  return events;
}
