// Game server entry (PRD §6, §15, §19). MVP transport is `ws` (reliable install
// on Node 22); the PRD's uWebSockets.js is a drop-in swap behind the same socket
// interface once we go binary. This is the lobby: it accepts a connection, awaits
// the client's `hello`, allocates a Room (private by room code, or quick-match
// into the first room with a free slot), and routes every later message to that
// player's room. Rooms own all authoritative game state; the lobby owns only the
// id->room mapping and room lifecycle (created on demand, destroyed when empty).

import { WebSocketServer, type WebSocket } from 'ws';
import {
  TUNING,
  DEFAULT_MAP_ID,
  decode,
  encode,
  sanitizeName,
  makeRoomCode,
  type ClientMessage,
} from '@rivals/shared';
import { Room } from './room.js';

const PORT = Number(process.env.PORT ?? 8080);

const wss = new WebSocketServer({ port: PORT });
let nextId = 1;

// All live rooms by id. Private rooms key on their room code; quick-match rooms
// key on a generated code too (so the maps are uniform).
const rooms = new Map<string, Room>();

// playerId -> the room they belong to, for routing + cleanup on close.
const playerRooms = new Map<number, Room>();

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Allocate a room for a joining player: private by code, else quick-match. */
async function allocateRoom(roomCode: string | undefined): Promise<Room> {
  if (roomCode) {
    const existing = rooms.get(roomCode);
    if (existing && !existing.isFull) return existing;
    if (existing && existing.isFull) {
      // Private code is full — fall through to a fresh room under a new code so
      // the player isn't wedged out (rare; two friends + a straggler).
    } else {
      const room = await Room.create(roomCode, DEFAULT_MAP_ID);
      room.start();
      rooms.set(roomCode, room);
      return room;
    }
  }

  // Quick match: first room with a free slot.
  for (const room of rooms.values()) {
    if (!room.isFull) return room;
  }

  // None free — spin up a new quick-match room under a fresh code.
  let code = makeRoomCode(Math.random);
  while (rooms.has(code)) code = makeRoomCode(Math.random);
  const room = await Room.create(code, DEFAULT_MAP_ID);
  room.start();
  rooms.set(code, room);
  return room;
}

function destroyIfEmpty(room: Room): void {
  if (!room.isEmpty) return;
  room.destroy();
  rooms.delete(room.id);
  console.log(`[server] room ${room.id} empty -> destroyed`);
}

// Reaper: a room that drained to empty or finished (a forfeit drained a held
// slot, or both players left) gets destroyed. We can't tear down inside the
// room's own tick from the lobby, so we sweep here on a slow timer. Rooms in a
// grace window keep their disconnected slot and are NOT reaped until they
// finish (the match reducer forfeits after the grace, then the room finishes).
const reaper = setInterval(() => {
  for (const room of [...rooms.values()]) {
    if (room.isEmpty || room.isFinished) {
      room.destroy();
      rooms.delete(room.id);
      console.log(`[server] room ${room.id} ${room.isFinished ? 'finished' : 'empty'} -> destroyed`);
    }
  }
}, 1000);
reaper.unref?.();

wss.on('connection', (ws: WebSocket) => {
  const playerId = nextId++;
  let joined = false;

  ws.on('message', (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = decode<ClientMessage>(raw.toString());
    } catch {
      return;
    }

    // The first valid message MUST be `hello`; it allocates the room. Everything
    // after is routed to that room.
    if (!joined) {
      if (msg.t !== 'hello') return; // ignore anything before hello
      joined = true;
      const name = sanitizeName(msg.name);

      void allocateRoom(msg.roomCode)
        .then((room) => {
          const player = room.addPlayer(ws, playerId, name);
          if (!player) {
            // Room filled between allocation and add (race). Drop politely.
            try {
              ws.close();
            } catch {
              /* already closing */
            }
            return;
          }
          playerRooms.set(playerId, room);
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
        })
        .catch((err) => {
          console.error(`[server] failed to allocate room for #${playerId}:`, err);
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        });
      return;
    }

    const room = playerRooms.get(playerId);
    if (!room) return;

    switch (msg.t) {
      case 'input':
        room.ingestInput(playerId, msg);
        break;
      case 'shoot':
        room.ingestShoot(playerId, msg);
        break;
      case 'ping':
        room.ingestPing(playerId, msg);
        break;
      // A second `hello` is ignored — a player can't re-join from the same socket.
    }
  });

  ws.on('close', () => {
    console.log(`[server] #${playerId} disconnected`);
    const room = playerRooms.get(playerId);
    if (room) {
      room.removePlayer(playerId);
      playerRooms.delete(playerId);
      destroyIfEmpty(room);
    }
  });

  ws.on('error', (err: Error) => {
    console.error(`[server] socket error #${playerId}:`, err.message);
  });
});

console.log(
  `[server] Web Rivals listening on :${PORT} — sim ${TUNING.world.serverHz}Hz, ` +
    `snapshots ${TUNING.world.snapshotHz}Hz`,
);
