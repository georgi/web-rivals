import { describe, it, expect } from 'vitest';
import { TUNING } from '@rivals/shared';
import { initMatch, stepMatch, type MatchState, type MatchTickCtx, type MatchEvent } from './match';

const W = TUNING.world;
const FULL = TUNING.combat.spawnHealth;

// A connected, alive, nothing-happening tick. Override fields per test.
function ctx(over: Partial<MatchTickCtx> = {}): MatchTickCtx {
  return {
    bothConnected: true,
    hp: [FULL, FULL],
    died: [false, false],
    disconnectedFor: [0, 0],
    ...over,
  };
}

const DT = 1 / 30; // a real server tick — drains exercise fp accumulation honestly.

// Run N quiet ticks of `dt`, collecting every event. Handy for fixed-count runs.
function run(state: MatchState, n: number, dt: number, c: MatchTickCtx = ctx()): MatchEvent[] {
  const events: MatchEvent[] = [];
  for (let i = 0; i < n; i++) events.push(...stepMatch(state, c, dt));
  return events;
}

// Tick at DT under `c` until the phase changes (or a safety bound), collecting
// events. Robust to fp drift in the accumulated phase timer (90*(1/30) lands a
// hair above 0, so a bare ceil(sec/dt) can leave the crossing one tick short).
function drain(state: MatchState, c: MatchTickCtx = ctx()): MatchEvent[] {
  const events: MatchEvent[] = [];
  const from = state.phase;
  for (let i = 0; i < 10000 && state.phase === from; i++) {
    events.push(...stepMatch(state, c, DT));
  }
  return events;
}

// Drive a match from `waiting` up to `live`, round timer fresh. Returns state.
function toLive(): MatchState {
  const s = initMatch();
  stepMatch(s, ctx(), DT); // waiting -> countdown (+reset)
  drain(s); // countdown -> live
  expect(s.phase).toBe('live');
  return s;
}

// A live match with the round timer wound down to the brink: still `live`, but
// the very next DT tick crosses zero (expiry). Ticked under `c` (no deaths) so
// only the clock resolves the round. Leaves it ready for the crossing step.
function toBrink(c: MatchTickCtx): MatchState {
  const s = toLive();
  for (let i = 0; i < 10000 && s.phase === 'live' && s.timer > DT; i++) {
    stepMatch(s, c, DT);
  }
  expect(s.phase).toBe('live');
  expect(s.timer).toBeLessThanOrEqual(DT);
  return s;
}

describe('match reducer', () => {
  it('initMatch starts in waiting with a clean slate', () => {
    const s = initMatch();
    expect(s).toEqual({
      phase: 'waiting',
      timer: 0,
      score: [0, 0],
      round: 1,
      lastRoundWinner: -1,
      matchWinner: -1,
    });
  });

  it('waiting -> countdown when both connect, emitting reset', () => {
    const s = initMatch();
    const ev = stepMatch(s, ctx({ bothConnected: true }), 1 / 30);
    expect(s.phase).toBe('countdown');
    expect(s.timer).toBeCloseTo(W.countdownSec, 6);
    expect(s.round).toBe(1);
    expect(ev).toEqual([{ type: 'reset' }]);
  });

  it('stays in waiting while only one is connected', () => {
    const s = initMatch();
    const ev = stepMatch(s, ctx({ bothConnected: false }), 1 / 30);
    expect(s.phase).toBe('waiting');
    expect(ev).toEqual([]);
  });

  it('countdown -> live after countdownSec, emitting roundStart for the round', () => {
    const s = initMatch();
    stepMatch(s, ctx(), DT); // -> countdown
    const ev = drain(s); // countdown -> live
    expect(s.phase).toBe('live');
    expect(s.timer).toBeCloseTo(W.roundTimeSec, 6);
    expect(ev).toContainEqual({ type: 'roundStart', round: 1 });
    // Exactly one roundStart across the drain.
    expect(ev.filter((e) => e.type === 'roundStart')).toHaveLength(1);
  });

  it('a kill ends the round, scores the killer, and advances to the next round', () => {
    const s = toLive();

    // Player 0 kills player 1 this tick.
    const ev = stepMatch(s, ctx({ died: [false, true], hp: [FULL, 0] }), DT);
    expect(s.phase).toBe('roundEnd');
    expect(s.timer).toBeCloseTo(W.roundEndSec, 6);
    expect(s.score).toEqual([1, 0]);
    expect(s.lastRoundWinner).toBe(0);
    expect(s.matchWinner).toBe(-1);
    expect(ev).toEqual([{ type: 'roundEnd', winner: 0 }]);

    // Drain roundEnd -> countdown for round 2 (emits reset, bumps round).
    const toCountdown = drain(s);
    expect(s.phase).toBe('countdown');
    expect(s.round).toBe(2);
    expect(s.score).toEqual([1, 0]);
    expect(toCountdown).toContainEqual({ type: 'reset' });

    // And the next countdown crosses back into live as round 2.
    const live = drain(s);
    expect(s.phase).toBe('live');
    expect(live).toContainEqual({ type: 'roundStart', round: 2 });
  });

  it('double-KO on the same tick replays the round with no score change', () => {
    const s = toLive();

    const ev = stepMatch(s, ctx({ died: [true, true], hp: [0, 0] }), DT);
    expect(s.phase).toBe('roundEnd');
    expect(s.lastRoundWinner).toBe(-1);
    expect(s.score).toEqual([0, 0]);
    expect(s.matchWinner).toBe(-1);
    expect(ev).toEqual([{ type: 'roundEnd', winner: -1 }]);

    // Drain roundEnd: a draw replays — round bumps but score stays 0/0.
    drain(s);
    expect(s.phase).toBe('countdown');
    expect(s.round).toBe(2);
    expect(s.score).toEqual([0, 0]);
  });

  it('timer expiry: the higher-HP player wins the round', () => {
    const nearlyExpired = ctx({ hp: [70, 40] });
    const s = toBrink(nearlyExpired);

    // The tick that crosses 0 resolves on HP: player 0 (70) beats player 1 (40).
    const ev = stepMatch(s, nearlyExpired, DT);
    expect(s.phase).toBe('roundEnd');
    expect(s.score).toEqual([1, 0]);
    expect(s.lastRoundWinner).toBe(0);
    expect(ev).toEqual([{ type: 'roundEnd', winner: 0 }]);
  });

  it('timer expiry: equal HP replays the round (no point)', () => {
    const tied = ctx({ hp: [55, 55] });
    const s = toBrink(tied);
    const ev = stepMatch(s, tied, DT);
    expect(s.phase).toBe('roundEnd');
    expect(s.lastRoundWinner).toBe(-1);
    expect(s.score).toEqual([0, 0]);
    expect(ev).toEqual([{ type: 'roundEnd', winner: -1 }]);
  });

  it('a death wins the round even on the exact tick the clock expires', () => {
    // At the brink HP favors player 1, but a kill on player 1 overrides expiry.
    const s = toBrink(ctx({ hp: [10, 90] }));
    const ev = stepMatch(s, ctx({ died: [false, true], hp: [10, 0] }), DT);
    expect(s.lastRoundWinner).toBe(0);
    expect(s.score).toEqual([1, 0]);
    expect(ev).toEqual([{ type: 'roundEnd', winner: 0 }]);
  });

  it('best-of-N: first to roundsToWin wins the match', () => {
    const s = toLive();

    const winRoundFor = (winner: number) => {
      const loserDied: [boolean, boolean] = winner === 0 ? [false, true] : [true, false];
      // Resolve the live round with a kill.
      stepMatch(s, ctx({ died: loserDied }), DT);
      expect(s.phase).toBe('roundEnd');
      // Drain roundEnd; if not match over this lands in countdown, else matchEnd.
      drain(s);
      // If still playing, drain the countdown back to live for the next round.
      if (s.phase === 'countdown') drain(s);
    };

    // Player 0 wins roundsToWin rounds.
    for (let i = 0; i < W.roundsToWin; i++) winRoundFor(0);

    expect(s.score).toEqual([W.roundsToWin, 0]);
    expect(s.matchWinner).toBe(0);
    expect(s.phase).toBe('matchEnd');
    expect(s.timer).toBeCloseTo(W.matchEndSec, 6);
  });

  it('runs a full match waiting -> ... -> matchEnd -> waiting (fresh)', () => {
    const s = initMatch();

    // waiting -> live.
    stepMatch(s, ctx(), DT);
    drain(s);
    expect(s.phase).toBe('live');

    // Player 1 wins roundsToWin rounds back-to-back.
    for (let i = 0; i < W.roundsToWin; i++) {
      stepMatch(s, ctx({ died: [true, false] }), DT); // p0 dies -> p1 scores
      drain(s); // roundEnd -> (countdown | matchEnd)
      if (s.phase === 'countdown') drain(s); // countdown -> live
    }
    expect(s.phase).toBe('matchEnd');
    expect(s.matchWinner).toBe(1);
    expect(s.score).toEqual([0, W.roundsToWin]);

    // Drain matchEnd -> waiting, fully reset for the next match.
    drain(s);
    expect(s).toEqual({
      phase: 'waiting',
      timer: 0,
      score: [0, 0],
      round: 1,
      lastRoundWinner: -1,
      matchWinner: -1,
    });
  });

  it('disconnect past grace forfeits the match to the remaining player', () => {
    const s = toLive();

    // Player 1 has been gone exactly the grace window -> player 0 wins by forfeit.
    const ev = stepMatch(s, ctx({ disconnectedFor: [0, W.disconnectGraceSec] }), DT);
    expect(s.phase).toBe('matchEnd');
    expect(s.matchWinner).toBe(0);
    expect(s.timer).toBeCloseTo(W.matchEndSec, 6);
    expect(ev).toEqual([{ type: 'matchEnd', winner: 0 }]);
  });

  it('disconnect under grace does not forfeit yet', () => {
    const s = toLive();

    const ev = stepMatch(s, ctx({ disconnectedFor: [0, W.disconnectGraceSec - 1] }), DT);
    expect(s.phase).toBe('live');
    expect(s.matchWinner).toBe(-1);
    expect(ev).toEqual([]);
  });

  it('forfeit applies during the countdown phase too', () => {
    const s = initMatch();
    stepMatch(s, ctx(), DT); // -> countdown
    expect(s.phase).toBe('countdown');

    const ev = stepMatch(s, ctx({ disconnectedFor: [W.disconnectGraceSec, 0] }), DT);
    expect(s.phase).toBe('matchEnd');
    expect(s.matchWinner).toBe(1); // player 0 gone -> player 1 wins
    expect(ev).toEqual([{ type: 'matchEnd', winner: 1 }]);
  });

  it('forfeit applies during the roundEnd phase too', () => {
    const s = toLive();
    // End a round so we're in roundEnd (score 1-0 for player 0).
    stepMatch(s, ctx({ died: [false, true] }), DT);
    expect(s.phase).toBe('roundEnd');

    // Player 1 goes dark past grace during the round-end pause -> player 0 forfeit win.
    const ev = stepMatch(s, ctx({ disconnectedFor: [0, W.disconnectGraceSec] }), DT);
    expect(s.phase).toBe('matchEnd');
    expect(s.matchWinner).toBe(0);
    expect(ev).toEqual([{ type: 'matchEnd', winner: 0 }]);
  });

  it('both disconnected past grace ends the match with no winner', () => {
    const s = toLive();
    const ev = stepMatch(
      s,
      ctx({ disconnectedFor: [W.disconnectGraceSec, W.disconnectGraceSec] }),
      DT,
    );
    expect(s.phase).toBe('matchEnd');
    expect(s.matchWinner).toBe(-1);
    expect(ev).toEqual([{ type: 'matchEnd', winner: -1 }]);
  });

  it('matchEnd ignores disconnects and just drains its display timer', () => {
    const s = toLive();
    // Win the match for player 0.
    for (let i = 0; i < W.roundsToWin; i++) {
      stepMatch(s, ctx({ died: [false, true] }), DT);
      drain(s);
      if (s.phase === 'countdown') drain(s);
    }
    expect(s.phase).toBe('matchEnd');
    const winnerBefore = s.matchWinner;

    // A disconnect during matchEnd must not re-fire a matchEnd event.
    const ev = stepMatch(s, ctx({ disconnectedFor: [0, W.disconnectGraceSec] }), DT);
    expect(ev).toEqual([]);
    expect(s.phase).toBe('matchEnd');
    expect(s.matchWinner).toBe(winnerBefore);
  });

  it('does not forfeit in the waiting phase (no live round to award)', () => {
    const s = initMatch();
    const ev = stepMatch(
      s,
      ctx({ bothConnected: false, disconnectedFor: [0, W.disconnectGraceSec] }),
      1 / 30,
    );
    expect(s.phase).toBe('waiting');
    expect(s.matchWinner).toBe(-1);
    expect(ev).toEqual([]);
  });
});
