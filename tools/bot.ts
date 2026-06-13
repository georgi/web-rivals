// Headless protocol client for soak-testing rooms (PRD §11, §19.6). Connects,
// runs a scripted patrol + periodic shots, no rendering. Fleshed out in M3.
import { WebSocket } from 'ws';
import { encode } from '@rivals/shared';

const URL = process.env.WS_URL ?? 'ws://localhost:8080';
const NAME = process.env.BOT_NAME ?? 'Bot';

const ws = new WebSocket(URL);
ws.on('open', () => {
  console.log(`[bot] connected to ${URL} as ${NAME}`);
  ws.send(encode({ t: 'hello', name: NAME }));
});
ws.on('message', (raw: Buffer) => console.log(`[bot] <- ${raw.toString()}`));
ws.on('close', () => console.log('[bot] closed'));
ws.on('error', (e) => console.error('[bot] error', e));
