# Deploying Web Rivals

Two pieces ship separately (PRD §3, §21.3):

| Piece      | What it is                              | Where it runs                                        |
| ---------- | --------------------------------------- | ---------------------------------------------------- |
| **Client** | Static `index.html` + hashed JS/CSS     | Any static host (Netlify, Cloudflare Pages, S3, …)   |
| **Server** | Persistent Node process, in-memory rooms | A box that stays on (Fly.io, Render, a VPS)         |

The server is **stateful and always-on** — it runs a fixed-tick simulation and keeps
every active match in memory. It must NOT go on serverless / edge / auto-sleeping
platforms: a cold start or idle-stop drops live games. The client is the opposite:
pure static files, no backend of its own.

The one wire between them is `WS_URL`, baked into the client bundle **at build time**.

---

## The one rule about `WS_URL` (read this first)

`client/vite.config.ts` injects the server address at build:

```ts
define: { __WS_URL__: JSON.stringify(process.env.WS_URL ?? 'ws://localhost:8080') }
```

So `WS_URL` is **not** read in the browser at runtime — it is compiled into the JS.
Consequences:

- Set `WS_URL` **before** you build the client, in the static host's build env.
- Use **`wss://`** (TLS), not `ws://`. An https page may not open an insecure `ws://`
  socket; the browser blocks it as mixed content. Fly/Render give you https, so this
  is automatic — just write `wss://`.
- Changing the server URL means a **rebuild + redeploy** of the client. There is no
  runtime config to flip.

---

## 1. Deploy the server to Fly.io

Config lives in [`fly.toml`](./fly.toml) and [`server/Dockerfile`](./server/Dockerfile).
The Docker build context is the **monorepo root** (it needs the root lockfile + the
`shared` workspace); the Dockerfile is referenced via `[build] dockerfile`.

```bash
# Install flyctl once: https://fly.io/docs/flyctl/install/  (macOS: brew install flyctl)
flyctl auth login

# From the repo root. --copy-config reuses our fly.toml; --no-deploy lets us review.
flyctl launch --no-deploy --copy-config
#   -> pick/confirm an app name; it rewrites `app = "..."` in fly.toml.
#   -> keep the region (edit primary_region in fly.toml if you want closer).

# Ship it.
flyctl deploy

# Find your host:
flyctl status        # APP NAME -> reachable at https://<app>.fly.dev
flyctl logs          # tail to confirm: "[server] Web Rivals listening on :8080 ..."
```

Your server WebSocket URL is then:

```
wss://<app>.fly.dev
```

**Why `auto_stop_machines = "off"` matters:** rooms are in memory. If Fly stops the
machine on idle, every match in progress is gone and the next player hits a cold
start. `fly.toml` pins `min_machines_running = 1` and disables auto-stop on purpose.
Don't "optimize" that back on.

Health checks are **TCP**, not HTTP: the `ws` server answers a plain `GET /` with
`426 Upgrade Required`, so an HTTP 2xx check would flap. A successful TCP connect is
the correct liveness signal.

### Render or a VPS instead

- **Render:** New → Web Service → Docker, root directory `.`, Dockerfile path
  `server/Dockerfile`. Set `PORT` (Render injects its own — the server honors it).
  Disable any "spin down on idle" plan setting (same in-memory reason as Fly).
- **Bare VPS:** `docker build -f server/Dockerfile -t web-rivals-server .` then run it
  behind a TLS reverse proxy (Caddy/nginx) that upgrades WebSockets, so the browser
  gets `wss://`. Keep it up with a process/restart policy (`--restart=always`, or systemd).

---

## 2. Build the client against the deployed server

```bash
# WS_URL must be wss:// and must point at the host from step 1.
WS_URL=wss://<app>.fly.dev npm run build -w @rivals/client
# -> writes client/dist/  (index.html + assets/*)
```

On a hosted build you set `WS_URL` in the host's environment instead of inline (below).

---

## 3. Deploy `client/dist` to a static host

### Option A — Netlify

Config is in [`netlify.toml`](./netlify.toml) (build command + publish dir + caching).

1. Connect the repo (or `netlify deploy --prod --dir client/dist` from the CLI).
2. **Set `WS_URL` in the site environment** before building:
   _Site settings → Build & deploy → Environment → Environment variables_ →
   `WS_URL = wss://<app>.fly.dev`.
3. Trigger a deploy. Netlify runs `npm run build -w @rivals/client` and publishes
   `client/dist`. Because `WS_URL` is build-time, **changing it needs a fresh deploy**
   (clear cache + redeploy).

It's a single page — no SPA redirect rule is needed.

### Option B — Cloudflare Pages

Pages has no committed config file here (it's set in the dashboard). Use:

- **Build command:** `npm run build -w @rivals/client`
- **Build output directory:** `client/dist`
- **Root directory:** `/` (repo root — the build needs root workspace deps)
- **Environment variables:** `WS_URL = wss://<app>.fly.dev` and `NODE_VERSION = 22`,
  set under _Settings → Environment variables_ for the **production** environment.
  Same build-time rule as Netlify: edit `WS_URL` → redeploy.

Again, single static page — no SPA fallback / functions needed.

---

## 4. Smoke test cross-network

Don't trust localhost — test from two different networks (e.g. laptop on wifi +
phone on cellular) so you actually exercise the public `wss://`:

1. Open `https://<your-static-site>` in two browsers/devices on different networks.
2. Both should reach the **Lobby**. Quick-match (or share a room code) → you should
   pair into a live 1v1.
3. Confirm in `flyctl logs`: two `joined room` lines, then snapshots flowing.
4. Sanity: movement, firing (AR/rocket/grenade/knife), hitmarkers, round/score
   banners, and forfeit-on-disconnect (close one tab → the other wins the round).
5. Open DevTools → Network → WS on the client: the socket URL must be your
   `wss://<app>.fly.dev`, **Status 101** (Switching Protocols). If it's `ws://` or
   localhost, `WS_URL` wasn't set at build time — fix the host env and redeploy.

---

## Local production-style run

Reproduce the deployed setup on one machine before pushing.

**Server (Docker, exactly what Fly runs):**

```bash
# From the repo root (context = root; Dockerfile under server/).
docker build -f server/Dockerfile -t web-rivals-server .
docker run --rm -p 8080:8080 web-rivals-server
# -> "[server] Web Rivals listening on :8080 — sim ...Hz, snapshots ...Hz"
```

**Client (real production bundle, not the dev server):**

```bash
# ws:// (not wss://) is fine here — localhost is a secure context, no TLS needed.
WS_URL=ws://localhost:8080 npm run build -w @rivals/client
npm run preview -w @rivals/client      # serves client/dist on http://localhost:4173
```

Open `http://localhost:4173` in two tabs → you should pair into a local 1v1.

### IPv4 / IPv6 + port-collision note (carried over from dev)

- **`localhost` resolves to both `::1` (IPv6) and `127.0.0.1` (IPv4).** The `ws`
  server binds per Node's defaults; if a client resolves `localhost` to a stack the
  server isn't listening on, the socket silently fails to connect. If `ws://localhost`
  misbehaves locally, try **`ws://127.0.0.1:8080`** explicitly. In Docker, `-p 8080:8080`
  publishes on the host's IPv4 — prefer `127.0.0.1` for the client `WS_URL`.
- **Port 8080 collisions:** the dev server, the Docker container, and any stray
  previous run all want `:8080`. `EADDRINUSE` on boot means something already holds it
  — `lsof -i :8080` and kill it, or run the container on another host port
  (`docker run -p 9090:8080 ...` and build the client with `WS_URL=ws://localhost:9090`).
- **Vite preview** is fixed to `:4173`, the dev server to `:5173` — they won't fight
  the game server's `:8080`.

---

## Later: the uWebSockets.js transport upgrade (PRD §M3)

The server currently uses the `ws` library (reliable to install on Node 22). The PRD's
performance path swaps it for **uWebSockets.js** once the protocol goes binary. That's
a **later, isolated change behind the same transport interface** in `server/src/index.ts`
— the room/match/sim layers don't care which socket library delivers bytes. None of the
deploy scaffolding here changes when that swap happens: same Dockerfile, same `tsx`
entrypoint, same `PORT`, same Fly/Netlify config.
