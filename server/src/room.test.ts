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
import { decode, fromTuple, type ServerMessage, type InputMsg, type ShootMsg } from '@rivals/shared';
import { initRapier } from '@rivals/shared';
import { Room } from './room';

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

    // The victim sits at its spawn (12,1,12) — an open corner clear of geometry.
    // addPlayer already recorded that center into lag-comp; tick once so a
    // second sample lands and the rewind has a bracket.
    room.tickOnce();

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
});
