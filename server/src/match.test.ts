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
