# Deploying Web Rivals

One Docker container runs everything: the Node server serves the built client
**and** the authoritative game WebSocket on a single port. No database, no second
service, no env files required. The client connects its WebSocket back to the
same origin it was served from, so it works on any host/port and auto-upgrades to
`wss://` when served over HTTPS.

These instructions target a fresh Linux VM (e.g. a Hetzner Cloud server).

> The game is a **6-player free-for-all deathmatch**; rooms are kept in memory,
> so the server is stateful and always-on (don't put it on a sleeping/serverless
> host — see §9).

---

## 1. Prerequisites

A server with Docker installed. On a fresh Hetzner/Ubuntu box:

```bash
curl -fsSL https://get.docker.com | sh
```

Open the web ports in your firewall. Hetzner Cloud firewall: allow inbound TCP
**80** and **443**. If you also run a host firewall:

```bash
ufw allow 80/tcp && ufw allow 443/tcp
```

---

## 2. Get the code

```bash
git clone https://github.com/georgi/web-rivals.git
cd web-rivals
```

---

## 3. Build & run

### Option A — plain Docker (quickest)

```bash
docker build -t web-rivals .
docker run -d --restart unless-stopped -p 80:8080 --name web-rivals web-rivals
```

Browse to `http://<your-server-ip>/`. That's it — the game is live (HTTP only;
see §5 for HTTPS).

- `-p 80:8080` maps host port 80 to the container's port 8080.
- `--restart unless-stopped` brings it back after reboots/crashes.
- The container listens on `8080` internally (`PORT` env). To change it:
  `docker run ... -e PORT=9000 -p 80:9000 ...`.

### Option B — Docker Compose (recommended for a server)

A `docker-compose.yml` is included. From the repo root:

```bash
docker compose up -d --build
```

Manage it with `docker compose logs -f`, `docker compose down`,
`docker compose up -d --build` (to update).

---

## 4. Verify

```bash
# Frontend responds with HTML
curl -I http://localhost/                # -> HTTP/1.1 200 OK, content-type: text/html

# Container is serving
docker logs web-rivals | tail            # -> "[server] Web Rivals listening on :8080 ... serving /app/client/dist"
```

Then open the site, click **FIND MATCH**, and open a second tab to confirm you
meet in the same free-for-all match.

---

## 5. HTTPS (recommended for a public domain)

Browsers prefer HTTPS, and the client automatically uses `wss://` when the page
is served over `https://` — no app config needed. Easiest path is
[Caddy](https://caddyserver.com) (automatic Let's Encrypt certs).

1. Point your domain's DNS **A record** at the server's IP.
2. Run the app bound to localhost on an internal port:

   ```bash
   docker run -d --restart unless-stopped -p 127.0.0.1:8080:8080 --name web-rivals web-rivals
   ```

3. Install Caddy, then `/etc/caddy/Caddyfile`:

   ```
   rivals.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

   Caddy proxies WebSockets transparently — no extra directives needed.

4. `systemctl reload caddy`

`https://rivals.example.com/` now serves the game over TLS with `wss://` netcode.
(Any reverse proxy works — nginx/Traefik — Caddy is just the least config.)

---

## 6. Updating

```bash
cd web-rivals && git pull
docker compose up -d --build          # Compose
# or, plain Docker:
docker build -t web-rivals . && docker rm -f web-rivals && \
  docker run -d --restart unless-stopped -p 80:8080 --name web-rivals web-rivals
```

Rebuilding restarts the process and drops in-progress matches (state is
in-memory; players reconnect and re-matchmake automatically).

---

## 7. Operations

| Task | Command |
|------|---------|
| Logs (follow) | `docker logs -f web-rivals` |
| Restart | `docker restart web-rivals` |
| Stop / remove | `docker rm -f web-rivals` |
| Shell in | `docker exec -it web-rivals sh` |
| Resource usage | `docker stats web-rivals` |

**Sizing:** image ~600 MB; runtime memory is modest (tens of MB plus a little per
active room). A small Hetzner instance (e.g. CX22) handles many concurrent
6-player rooms.

---

## 8. Configuration

All optional — defaults work out of the box.

| Env var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `8080` | Port the server listens on inside the container |
| `STATIC_DIR` | built client, relative to the server | Where static files are served from |

Gameplay tuning (frag limit, respawn delay, max players, match time cap, …) lives
in `shared/src/tuning.ts` and is compiled into the build — edit and rebuild.

---

## 9. How it fits together

```
            ┌───────────────────── container (one port) ─────────────────────┐
browser ──► │  Node server (server/src/index.ts)                             │
  HTTP  ──► │   ├─ GET *    → serves client/dist (the built Three.js client)  │
  WS    ──► │   └─ Upgrade  → ws server → authoritative 30Hz FFA game rooms   │
            └────────────────────────────────────────────────────────────────┘
```

- Frontend and WebSocket share one port; the client talks to its own origin, so
  there's nothing to wire between them.
- The server is authoritative for combat/damage/scoring; movement is client-side
  with server validation. Design notes: `docs/superpowers/specs/`.
- **Keep it always-on.** Rooms live in memory; a sleeping/auto-stopping host
  would drop live matches on every idle period. A plain always-running container
  (as above) is the right model — not serverless/edge.

---

## Troubleshooting

- **Page loads but FIND MATCH never connects** → the WebSocket is blocked. Behind
  a proxy, ensure it forwards `Upgrade`/`Connection` headers (Caddy does this
  automatically). Always serve page + socket over the same scheme — the app does
  this (https→wss, http→ws); a browser blocks an https page opening `ws://`.
- **Port already in use** → host port 80 is taken; map another (`-p 8080:8080`)
  or stop the conflicting service.
- **Container exits immediately** → `docker logs web-rivals` shows the error.

---

## Note: legacy split-host scaffolding

The repo also contains older deploy files from before the single-container setup —
`server/Dockerfile` (server-only image), `fly.toml`, and `netlify.toml`. They
describe a **different** model: client hosted separately on a static host with the
server URL baked in at build via `WS_URL=wss://…`. That still works **only if you
explicitly set `WS_URL` at build time** (the default is now empty = same-origin,
which is what the single-container setup above relies on). For a single server
(this guide) those files are unused and can be removed.
