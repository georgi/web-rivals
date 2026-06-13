import { describe, it, expect } from 'vitest';
import type { PlayerSnap, ProjSnap, SnapshotMsg } from '@rivals/shared';
import { ClockSync, SnapshotBuffer } from './snapshots';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function player(
  id: number,
  pos: [number, number, number],
  yaw = 0,
  over: Partial<PlayerSnap> = {},
): PlayerSnap {
  return {
    id,
    pos,
    vel: [0, 0, 0],
    yaw,
    pitch: 0,
    anim: 'idle',
    hp: 100,
    weapon: 1,
    ...over,
  };
}

function snap(
  tick: number,
  serverTime: number,
  players: PlayerSnap[],
  projectiles: ProjSnap[] = [],
): SnapshotMsg {
  return { t: 'snapshot', tick, serverTime, players, projectiles };
}

// ---------------------------------------------------------------------------
// ClockSync
// ---------------------------------------------------------------------------

describe('ClockSync', () => {
  it('estimates the server offset from a clean pong (no jitter)', () => {
    const cs = new ClockSync();
    // Server clock is local + 1000. Symmetric 40ms RTT: we sent at clientTime,
    // pong arrives 40ms later; server replied at its midpoint.
    // local now = 1040, clientTime (send) = 1000, serverTime at reply = (1020)+1000 = 2020.
    cs.onPong(1000, 2020, 1040);
    // offset = serverTime + rtt/2 - now = 2020 + 20 - 1040 = 1000.
    expect(cs.serverTimeEstimate(5000)).toBeCloseTo(6000, 6);
    expect(cs.rttMs).toBeCloseTo(40, 6);
  });

  it('converges the offset toward ~1000 across several jittery pongs', () => {
    const cs = new ClockSync();
    const trueOffset = 1000;
    // Simulate sends every 100ms of local time, with varying (asymmetric) latency.
    // serverTime at reply = (send + upLatency) + trueOffset; now = send + rtt.
    const samples: Array<[number, number, number]> = [];
    let send = 1000;
    const lats = [60, 20, 45, 25, 80, 22, 70, 21];
    for (const rtt of lats) {
      const up = rtt / 2; // assume symmetric split for the server's reply clock
      const serverAtReply = send + up + trueOffset;
      const now = send + rtt;
      samples.push([send, serverAtReply, now]);
      send += 100;
    }
    for (const [c, s, now] of samples) cs.onPong(c, s, now);

    // After favoring low-RTT samples, the estimate should be very close to truth.
    const est = cs.serverTimeEstimate(send) - send;
    expect(est).toBeCloseTo(trueOffset, 1);
  });

  it('serverTimeEstimate advances monotonically with local time at a fixed offset', () => {
    const cs = new ClockSync();
    cs.onPong(1000, 2020, 1040); // offset 1000
    const a = cs.serverTimeEstimate(2000);
    const b = cs.serverTimeEstimate(2001);
    const c = cs.serverTimeEstimate(3000);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('ignores a pong with a negative rtt (bogus echo)', () => {
    const cs = new ClockSync();
    cs.onPong(1000, 2020, 1040);
    const before = cs.serverTimeEstimate(5000);
    cs.onPong(9000, 2020, 1040); // clientTime in the future -> rtt < 0
    expect(cs.serverTimeEstimate(5000)).toBeCloseTo(before, 6);
  });
});

// ---------------------------------------------------------------------------
// SnapshotBuffer
// ---------------------------------------------------------------------------

describe('SnapshotBuffer', () => {
  it('interpolates a moving player to the midpoint at the bracket center', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(0, 0, [player(7, [0, 0, 0])]));
    buf.insert(snap(1, 50, [player(7, [1, 0, 0])]));

    const out = buf.sample(25);
    expect(out.players).toHaveLength(1);
    expect(out.players[0].pos[0]).toBeCloseTo(0.5, 6);
    expect(out.players[0].pos[1]).toBeCloseTo(0, 6);
  });

  it('interpolates vel and pitch linearly too', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(0, 0, [player(7, [0, 0, 0], 0, { vel: [0, 0, 0], pitch: 0 })]));
    buf.insert(snap(1, 100, [player(7, [0, 0, 0], 0, { vel: [10, 0, 0], pitch: 0.4 })]));
    const out = buf.sample(25);
    expect(out.players[0].vel[0]).toBeCloseTo(2.5, 6);
    expect(out.players[0].pitch).toBeCloseTo(0.1, 6);
  });

  it('freezes at the latest snapshot when renderTime is in the future (no extrapolation)', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(0, 0, [player(7, [0, 0, 0])]));
    buf.insert(snap(1, 50, [player(7, [1, 0, 0])]));

    // 200ms past the latest snapshot — must NOT keep moving past x=1.
    const out = buf.sample(250);
    expect(out.players[0].pos[0]).toBeCloseTo(1, 6);
    expect(buf.latestTick).toBe(1);
  });

  it('clamps to the earliest snapshot when renderTime is before the buffer', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(3, 100, [player(7, [5, 0, 0])]));
    buf.insert(snap(4, 150, [player(7, [6, 0, 0])]));
    const out = buf.sample(0);
    expect(out.players[0].pos[0]).toBeCloseTo(5, 6);
  });

  it('interpolates yaw the short way across the +/-PI seam', () => {
    const buf = new SnapshotBuffer();
    // From just under +PI to just over -PI: short arc crosses the seam (~+PI/-PI),
    // NOT the long way back through 0.
    const a = Math.PI - 0.1;
    const b = -Math.PI + 0.1; // == +PI + 0.1 wrapped
    buf.insert(snap(0, 0, [player(7, [0, 0, 0], a)]));
    buf.insert(snap(1, 100, [player(7, [0, 0, 0], b)]));

    const out = buf.sample(50);
    const yaw = out.players[0].yaw;
    // Short arc midpoint sits at ~+PI (or equivalently -PI), well away from 0.
    // |yaw| should be near PI, definitely > PI/2 (the long way would pass 0).
    expect(Math.abs(yaw)).toBeGreaterThan(Math.PI / 2);
  });

  it('takes discrete fields (hp/anim/weapon) from the nearer snapshot', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(0, 0, [player(7, [0, 0, 0], 0, { hp: 100, anim: 'idle', weapon: 1 })]));
    buf.insert(snap(1, 100, [player(7, [1, 0, 0], 0, { hp: 40, anim: 'run', weapon: 2 })]));

    const near0 = buf.sample(25); // closer to a
    expect(near0.players[0].hp).toBe(100);
    expect(near0.players[0].anim).toBe('idle');
    expect(near0.players[0].weapon).toBe(1);

    const near1 = buf.sample(75); // closer to b
    expect(near1.players[0].hp).toBe(40);
    expect(near1.players[0].anim).toBe('run');
    expect(near1.players[0].weapon).toBe(2);
  });

  it('interpolates projectile positions between snapshots', () => {
    const proj = (pos: [number, number, number]): ProjSnap => ({
      id: 1,
      kind: 'rocket',
      pos,
      vel: [0, 0, 0],
    });
    const buf = new SnapshotBuffer();
    buf.insert(snap(0, 0, [], [proj([0, 0, 0])]));
    buf.insert(snap(1, 100, [], [proj([10, 0, 0])]));
    const out = buf.sample(50);
    expect(out.projectiles).toHaveLength(1);
    expect(out.projectiles[0].pos[0]).toBeCloseTo(5, 6);
  });

  it('handles out-of-order inserts by sorting on serverTime', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(1, 50, [player(7, [1, 0, 0])]));
    buf.insert(snap(0, 0, [player(7, [0, 0, 0])])); // arrives late
    const out = buf.sample(25);
    expect(out.players[0].pos[0]).toBeCloseTo(0.5, 6);
    expect(buf.latestTick).toBe(1);
  });

  it('prunes snapshots older than the retention window', () => {
    const buf = new SnapshotBuffer();
    for (let i = 0; i <= 40; i++) {
      // 50ms apart -> 2000ms span, beyond the ~1.2s window.
      buf.insert(snap(i, i * 50, [player(7, [i, 0, 0])]));
    }
    // Sampling near the very start should now clamp to the oldest retained snap,
    // which is well after t=0 (early ones pruned). The buffer must still bracket.
    const out = buf.sample(0);
    expect(out.players[0].pos[0]).toBeGreaterThan(0);
    expect(buf.latestTick).toBe(40);
  });

  it('returns empty arrays when no snapshots have been inserted', () => {
    const buf = new SnapshotBuffer();
    const out = buf.sample(123);
    expect(out.players).toEqual([]);
    expect(out.projectiles).toEqual([]);
    expect(buf.latestTick).toBe(-1);
  });
});
