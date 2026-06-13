// Room integration smoke (PRD §3.1, §6). Constructs a real Room (Rapier trace
// world + validator + lag-comp), joins two STUB sockets (a send spy, no real
// network), feeds an input + a shoot, and drives the authoritative tick manually
// via tickOnce() so there are no timers to make the test flaky.
//
// Asserts the three things the room must get right at the wire boundary:
//   1. a snapshot is broadcast on the tick cadence,
//   2. a physically-impossible teleport is rejected with a Correction,
//   3. a hitscan shot down the lane of a rewound opponent deals server-auth damage.

import { describe, it, expect, beforeAll } from 'vitest';
import { decode, fromTuple, TUNING, type ServerMessage, type InputMsg, type ShootMsg } from '@rivals/shared';
import { initRapier } from '@rivals/shared';
import { Room } from './room';

const W = TUNING.world;

// Tick the room until its match reaches `phase` (or a safety bound). The match
// machine starts in `waiting`, flips to `countdown` (frozen) the first tick two
// players are present, then `live` after countdownSec.
function tickUntilPhase(room: Room, phase: string, max = 2000): void {
  for (let i = 0; i < max && room.matchState.phase !== phase; i++) room.tickOnce();
}

// Minimal ws stand-in: records every encoded message it's sent.
class StubSocket {
  sent: ServerMessage[] = [];
  send(data: string): void {
    this.sent.push(decode<ServerMessage>(data));
  }
  close(): void {
    /* noop */
  }
  // The room only ever calls .send()/.close(); cast through unknown for the type.
}

function asWs(s: StubSocket): any {
  return s as unknown as any;
}

function received<T extends ServerMessage['t']>(
  s: StubSocket,
  t: T,
): Extract<ServerMessage, { t: T }>[] {
  return s.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
}

beforeAll(async () => {
  await initRapier(); // warm the WASM once so Room.create() is fast.
});

describe('Room', () => {
  it('joins two players, broadcasts snapshots, and reports presence', async () => {
    const room = await Room.create('TESTA', 'crate');
    const a = new StubSocket();
    const b = new StubSocket();

    const pa = room.addPlayer(asWs(a), 1, 'Alice');
    const pb = room.addPlayer(asWs(b), 2, 'Bob');
    expect(pa).not.toBeNull();
    expect(pb).not.toBeNull();
    expect(room.playerCount).toBe(2);
    expect(room.isFull).toBe(true);

    // Each side learned about the other.
    expect(received(a, 'opponent').some((m) => m.id === 2 && m.present)).toBe(true);
    expect(received(b, 'opponent').some((m) => m.id === 1 && m.present)).toBe(true);

    // Drive a few ticks; a snapshot must reach both clients.
    for (let i = 0; i < 4; i++) room.tickOnce();
    const snaps = received(a, 'snapshot');
    expect(snaps.length).toBeGreaterThan(0);
    const snap = snaps[snaps.length - 1];
    expect(snap.players.length).toBe(2);
    expect(snap.players.every((p) => p.hp === 100)).toBe(true);

    room.destroy();
  });

  it('accepts a plausible move but corrects a teleport', async () => {
    const room = await Room.create('TESTB', 'crate');
    const a = new StubSocket();
    const b = new StubSocket();
    room.addPlayer(asWs(a), 1, 'Alice'); // spawns at spawns[0] = (-12,1,-12)
    room.addPlayer(asWs(b), 2, 'Bob');

    const spawn = fromTuple([-12, 1, -12]);

    // A small, plausible step (well within one-tick displacement budget).
    const good: InputMsg = {
      t: 'input',
      seq: 1,
      clientTime: 0,
      pos: [spawn.x + 0.2, spawn.y, spawn.z],
      vel: [6, 0, 0],
      yaw: 0,
      pitch: 0,
      buttons: 0,
      events: 0,
    };
    room.ingestInput(1, good);
    expect(received(a, 'correction').length).toBe(0);

    // A blatant teleport across the map: must be rejected with a Correction that
    // snaps back to the last accepted position.
    const teleport: InputMsg = {
      t: 'input',
      seq: 2,
      clientTime: 0,
      pos: [10, 1, 10],
      vel: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      buttons: 0,
      events: 0,
    };
    room.ingestInput(1, teleport);
    const corr = received(a, 'correction');
    expect(corr.length).toBe(1);
    // Corrected back near the accepted (good) position, NOT the teleport target.
    expect(corr[0].pos[0]).toBeCloseTo(spawn.x + 0.2, 1);
    expect(corr[0].pos[0]).not.toBeCloseTo(10, 0);

    room.destroy();
  });

  it('resolves a server-authoritative hitscan hit on a lag-comp-rewound victim', async () => {
    const room = await Room.create('TESTC', 'crate');
    const a = new StubSocket();
    const b = new StubSocket();
    room.addPlayer(asWs(a), 1, 'Shooter');
    room.addPlayer(asWs(b), 2, 'Victim');

    // Combat is frozen during the countdown — advance the match to `live` so the
    // shoot isn't dropped by the freeze gate. The victim sits at its spawn
    // (12,1,12), an open corner clear of geometry; lag-comp has samples from the
    // join + every tick, so the rewind has a bracket.
    tickUntilPhase(room, 'live');
    expect(room.matchState.phase).toBe('live');

    // Shooter fires from (12,1,14) along -z toward the victim at (12,1,12): a
    // short clear gap with no static between them. clientTime is large so
    // LagComp clamps to the freshest sample (the victim's current center).
    const shot: ShootMsg = {
      t: 'shoot',
      seq: 1,
      weapon: 1, // AR / hitscan
      origin: [12, 1, 14],
      dir: [0, 0, -1],
      clientTime: 1e12,
    };
    room.ingestShoot(1, shot);

    const dmg = received(b, 'damage');
    expect(dmg.length).toBeGreaterThan(0);
    expect(dmg[0].victim).toBe(2);
    expect(dmg[0].source).toBe(1);
    expect(dmg[0].newHp).toBe(100 - 15); // AR damage = 15

    room.destroy();
  });

  it('runs the match machine: waiting -> countdown -> live, freezing combat in countdown', async () => {
    const room = await Room.create('TESTD', 'crate');
    const a = new StubSocket();
    const b = new StubSocket();
    room.addPlayer(asWs(a), 1, 'Alice');
    room.addPlayer(asWs(b), 2, 'Bob');

    // First tick with both present flips waiting -> countdown (frozen).
    room.tickOnce();
    expect(room.matchState.phase).toBe('countdown');

    // A shoot during the countdown is dropped by the freeze gate (no damage).
    room.ingestShoot(1, {
      t: 'shoot', seq: 1, weapon: 1, origin: [12, 1, 14], dir: [0, 0, -1], clientTime: 1e12,
    });
    expect(received(b, 'damage').length).toBe(0);

    // Snapshots during the countdown report zero velocity (opponent renders still).
    const snapsA = received(a, 'snapshot');
    expect(snapsA[snapsA.length - 1].players.every((p) => p.vel[0] === 0 && p.vel[1] === 0 && p.vel[2] === 0)).toBe(true);

    // Advance through the countdown -> live, then combat is allowed again.
    tickUntilPhase(room, 'live');
    expect(room.matchState.phase).toBe('live');

    room.destroy();
  });

  it('a kill ends the round, increments the survivor score, and freezes', async () => {
    const room = await Room.create('TESTE', 'crate');
    const a = new StubSocket();
    const b = new StubSocket();
    room.addPlayer(asWs(a), 1, 'Shooter');
    room.addPlayer(asWs(b), 2, 'Victim');
    tickUntilPhase(room, 'live');

    // Drop the victim's HP to lethal with repeated AR shots down the clear lane.
    let guard = 0;
    while (room.matchState.phase === 'live' && guard++ < 200) {
      room.ingestShoot(1, {
        t: 'shoot', seq: guard, weapon: 1, origin: [12, 1, 14], dir: [0, 0, -1], clientTime: 1e12,
      });
      room.tickOnce();
    }

    // Round ended: victim slot (1) lost, so player 0 (Shooter) took the round.
    expect(room.matchState.phase).toBe('roundEnd');
    expect(room.matchState.score[0]).toBe(1);
    expect(room.matchState.score[1]).toBe(0);

    // A kill was broadcast naming the shooter.
    const kills = received(b, 'kill');
    expect(kills.length).toBeGreaterThan(0);
    expect(kills[kills.length - 1].victim).toBe(2);
    expect(kills[kills.length - 1].killer).toBe(1);

    room.destroy();
  });

  it('forfeits after the disconnect grace window and finishes the room', async () => {
    const room = await Room.create('TESTF', 'crate');
    const a = new StubSocket();
    const b = new StubSocket();
    room.addPlayer(asWs(a), 1, 'Stay');
    room.addPlayer(asWs(b), 2, 'Leaver');
    tickUntilPhase(room, 'live');

    // The leaver's socket closes — the slot is HELD for the grace window, so the
    // match doesn't end instantly (a brief hiccup must not forfeit, PRD §2).
    room.removePlayer(2);
    expect(room.isFull).toBe(true); // slot still claimed
    room.tickOnce();
    expect(room.matchState.phase).toBe('live'); // still within grace

    // Drive past the grace window -> reducer forfeits to the stayer (slot 0).
    const ticks = Math.ceil((W.disconnectGraceSec + 0.5) * W.serverHz);
    for (let i = 0; i < ticks; i++) room.tickOnce();
    expect(room.matchState.matchWinner).toBe(0);
    expect(['matchEnd', 'waiting']).toContain(room.matchState.phase);

    // The held slot was vacated at matchEnd; once the match drains the room is
    // finished and the lobby will reap it.
    const drain = Math.ceil((W.matchEndSec + 0.5) * W.serverHz);
    for (let i = 0; i < drain; i++) room.tickOnce();
    expect(room.isFinished).toBe(true);

    room.destroy();
  });
});
