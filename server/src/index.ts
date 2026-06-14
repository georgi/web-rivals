// Game server entry (PRD §6, §15, §19). MVP transport is `ws` (reliable install
// on Node 22); the PRD's uWebSockets.js is a drop-in swap behind the same socket
// interface once we go binary. This is the lobby: it accepts a connection, awaits
// the client's `hello`, allocates a Room (private by room code, or quick-match
// into the first room with a free slot), and routes every later message to that
// player's room. Rooms own all authoritative game state; the lobby owns only the
// id->room mapping and room lifecycle (created on demand, destroyed when empty).

import { WebSocketServer, type WebSocket } from 'ws';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, sep } from 'node:path';
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

// Default 8090 (not the common-collision 8080 — must match the client's WS_URL
// default in client/vite.config.ts); override with the PORT env var.
const PORT = Number(process.env.PORT ?? 8090);

// ---- static frontend hosting ------------------------------------------------
// One process serves BOTH the built client AND the game WebSocket on a single
// port, so the deployment is a single container with one exposed port. The
// client connects WS back to its own origin (see client/src/main.ts), so no URL
// configuration is needed. STATIC_DIR defaults to the built client relative to
// THIS module (cwd-independent), overridable via the STATIC_DIR env var.
const STATIC_DIR = process.env.STATIC_DIR
  ? normalize(process.env.STATIC_DIR)
  : fileURLToPath(new URL('../../client/dist', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reqPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // Strip leading slashes + any `..` segments, then resolve under STATIC_DIR so a
  // crafted path can never escape the served directory.
  const rel = normalize(reqPath).replace(/^([/\\]|\.\.([/\\]|$))+/, '');
  let file = join(STATIC_DIR, rel);
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + sep)) {
    file = join(STATIC_DIR, 'index.html');
  }
  try {
    const s = await stat(file);
    if (s.isDirectory()) throw new Error('dir');
  } catch {
    file = join(STATIC_DIR, 'index.html'); // unknown path / dir -> SPA entry
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const httpServer = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }
  void serveStatic(req, res);
});

// The WS server shares the HTTP server, so upgrades on any path land here.
const wss = new WebSocketServer({ server: httpServer });
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
          // Send the existing-player roster AFTER `joined` so the client has
          // wired its onOpponent handler (otherwise the roster is dropped and
          // the newcomer never learns existing opponents' names).
          room.sendRosterTo(playerId);
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

httpServer.listen(PORT, () => {
  console.log(
    `[server] Web Rivals listening on :${PORT} — sim ${TUNING.world.serverHz}Hz, ` +
      `snapshots ${TUNING.world.snapshotHz}Hz, serving ${STATIC_DIR}`,
  );
});
