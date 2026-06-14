<div align="center">

# ⚔️ Web Rivals

**A browser-based, movement-tech arena FPS — up to 6 players, everyone for themselves.**

Sprint, slide, and rocket-jump around a clean white-box arena and frag your way to the top.
No installs, no launcher — it runs in a tab. A love-letter tribute to *Roblox Rivals*, built from scratch on Three.js with real authoritative netcode.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-r171-000000?logo=three.js&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![Rapier](https://img.shields.io/badge/physics-Rapier-orange)
![status](https://img.shields.io/badge/status-playable-brightgreen)

</div>

---

## ✨ What makes it fun

- **6-player free-for-all deathmatch.** Drop in, instant respawns, first to **15 frags** wins — then it auto-rematches. No waiting around.
- **Movement is the game.** Air-strafing, **slide-jumps**, and **rocket-jumps** off your own splash damage. Ramps let you carry speed. Mastering the arena beats mastering aim.
- **A real arsenal.** Hitscan **Assault Rifle**, splash-damage **Rocket Launcher**, a **Knife** with backstabs, and lobbed **Frag Grenades** — each its own playstyle.
- **It looks like a real game.** Soft shadows, ground-truth ambient occlusion, bloom, and a bright high-key arena — with **Low/Medium/High** graphics tiers so it runs anywhere.
- **Feels instantaneous.** Client-side prediction means your own movement has zero added latency, while the server stays authoritative over every hit.

## 🎮 Controls

| Action | Input | | Action | Input |
|---|---|---|---|---|
| Move | `W` `A` `S` `D` | | Assault Rifle | `1` |
| Look | Mouse | | Rocket Launcher | `2` |
| Sprint | `Shift` | | Knife | `3` |
| Slide / Crouch | `Ctrl` or `C` | | Frag Grenade | `4` |
| Jump | `Space` | | Reload | `R` |
| Fire | Left&nbsp;Click | | Debug overlay | `F3` |

Settings (graphics quality, sensitivity, FOV, volume) live behind the ⚙️ gear in the lobby.

> **Pro tip:** fire a rocket at your feet mid-jump to launch across the map — then slide on landing to keep the speed.

## 🚀 Play it locally

Requires Node 22+.

```bash
git clone https://github.com/georgi/web-rivals.git
cd web-rivals
npm install
npm run dev:all          # starts the game server + the client
```

Open **http://localhost:5173** in two tabs (or two devices), hit **FIND MATCH** in each, and you're in a free-for-all. With no server reachable you still get an **offline practice sandbox** with a target dummy.

Other scripts:

```bash
npm run dev       # client only (offline practice)
npm run server    # game server only (port 8090)
npm test          # the test suite (Vitest)
npm run typecheck # strict TS across all packages
npm run build     # production client bundle
```

## ☁️ Deploy

Everything ships as **one Docker container** — the server serves the frontend *and* the game WebSocket on a single port, and the client talks back to its own origin (auto-`wss://` under HTTPS). On any VM with Docker:

```bash
docker compose up -d --build      # -> http://<host>/
```

Full instructions (HTTPS via Caddy, updates, ops, sizing) are in **[DEPLOY.md](./DEPLOY.md)**.

## 🧠 How it works

The interesting part is the netcode — it's the model competitive shooters use, not a naïve "send everything every frame" loop:

- **Client-authoritative movement, server-authoritative combat.** You simulate your own movement locally (no input lag); the server validates it and snaps you back only if it's physically impossible. Damage, scoring, and death are decided by the server — no trusting the client on hits.
- **Fixed-timestep simulation.** 60 Hz local sim, **30 Hz** authoritative server tick, **20 Hz** snapshots to clients, **30 Hz** input upstream. Rendering interpolates between the two latest snapshots (~100 ms in the past) so opponents move smoothly regardless of packet timing.
- **Lag-compensated hitscan.** When you fire, the server rewinds every other player to where they were on *your* screen when you pulled the trigger, then resolves the shot — so well-aimed shots land despite latency.
- **Zero-GC hot path.** FX (tracers, impacts, explosions, smoke) and vectors are pre-allocated object pools; the render loop allocates nothing, so there are no GC stutters.

The whole thing is a TypeScript monorepo where the **simulation is pure and shared** between client (prediction) and server (authority), so they can never disagree on physics:

```
web-rivals/
├─ shared/   # pure sim, math, protocol, map, tuning — runs on both sides
├─ client/   # Three.js renderer, input, netcode client, HUD, audio
├─ server/   # authoritative rooms, match state machine, lag-comp, validation
└─ tools/    # a headless load-test bot
```

## 🛠️ Tech stack

**TypeScript** · **Three.js** (rendering + post-processing) · **Rapier** (`rapier3d-compat`, collision/traces) · **Vite** (client build) · **ws** (Node WebSocket server) · **Web Audio** (procedural SFX) · **Vitest** (tests) · npm workspaces.

No game engine, no framework — just the web platform.

## ✅ Quality

- Strict TypeScript across all four packages (`npm run typecheck`).
- A focused test suite covering the pure sim, the match reducer, lag-comp, movement validation, and client interpolation (`npm test`).
- Design specs and implementation plans live under [`docs/superpowers/`](./docs/superpowers/).

## 📜 Credits & disclaimer

A personal project and an affectionate tribute to **Roblox Rivals**. Not affiliated with, endorsed by, or connected to Roblox Corporation or the Rivals team — no Roblox assets are used; all geometry, art, and audio here are generated in code.

Built with [Claude Code](https://claude.com/claude-code).
