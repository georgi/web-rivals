// Game server entry (PRD §6, §15, §19). MVP transport is `ws` (reliable install
// on Node 22); the PRD's uWebSockets.js is a drop-in swap behind the same socket
// interface once netcode (M3) lands. For now this is the lobby/room skeleton:
// it accepts connections, parses `hello`, and acks `joined` so the §15 check
// ("npm run server starts a process; imports a shared constant") passes.

import { WebSocketServer, type WebSocket } from 'ws';
import {
  TUNING,
  DEFAULT_MAP_ID,
  decode,
  encode,
  sanitizeName,
  type ClientMessage,
} from '@rivals/shared';

const PORT = Number(process.env.PORT ?? 8080);

const wss = new WebSocketServer({ port: PORT });
let nextId = 1;

wss.on('connection', (ws: WebSocket) => {
  const playerId = nextId++;
  ws.on('message', (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = decode<ClientMessage>(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'hello') {
      const name = sanitizeName(msg.name);
      console.log(`[server] hello from ${name} (#${playerId})`);
      ws.send(
        encode({
          t: 'joined',
          playerId,
          roomId: 'lobby',
          mapId: DEFAULT_MAP_ID,
          serverTime: nowMs(),
          youAreReady: false,
        }),
      );
    }
  });
  ws.on('close', () => console.log(`[server] #${playerId} disconnected`));
});

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

console.log(
  `[server] Web Rivals listening on :${PORT} — sim ${TUNING.world.serverHz}Hz, ` +
    `snapshots ${TUNING.world.snapshotHz}Hz`,
);
