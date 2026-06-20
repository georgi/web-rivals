# ⚔️ Web Rivals — Godot 4 / C# port

A faithful port of the Three.js **Web Rivals** arena FPS to the **Godot 4** engine
in **C#**. Same game: 6-player free-for-all deathmatch, Quake-style movement
(air-strafe, slide-jump, rocket-jump), four weapons, and the **same authoritative
netcode** — client-side prediction, lag-compensated hitscan, and 20 Hz snapshot
interpolation — over the **same JSON-over-WebSocket wire protocol** as the
original (so this C# server is wire-compatible with the original TypeScript
client, and vice-versa).

## Architecture

The TypeScript monorepo's structure is preserved 1:1 under `src/`:

```
godot/src/
├─ Shared/     # pure deterministic sim — NO engine deps (so it's unit-testable)
│  ├─ VMath, Tuning, Geometry, Maps, Protocol
│  └─ Sim/    ITraceWorld, MockTraceWorld, Movement, Projectiles
├─ Server/     # authoritative rooms, match FSM, lag-comp, validation, WS lobby
└─ Client/     # prediction, snapshot interp, rendering, input, HUD, FX, audio
```

* **The simulation is pure and shared** between client (prediction) and server
  (authority) — they can never disagree on physics. It runs in `double`
  precision to reproduce the JavaScript original bit-for-bit.
* **Collision** uses the hand-coded `MockTraceWorld` (Minkowski-expanded swept
  point over axis-aligned boxes + ramps). The whole arena is boxes + 4 ramps,
  for which this is exact — so it is the production backend on both sides, fully
  deterministic and engine-free (no Godot physics, no Rapier).
* **One executable, two roles.** `Bootstrap` reads the command line: `--server`
  runs the headless authoritative server; otherwise it loads the client scene.

## Toolchain

Requires the **.NET 8 SDK** and **Godot 4.4 (.NET / Mono build)**. On this
machine they were installed to `/opt/dotnet` and `/opt/godot` (see
`/etc/profile.d/godot-dotnet.sh`). `godot` is on the `PATH`.

```bash
# Build the C# assembly
dotnet build godot/WebRivals.csproj -c Debug
```

## Run

```bash
# Authoritative server (headless), default port 8090:
godot --headless --path godot -- --server --port=8090

# Client (opens the lobby; FIND MATCH quick-matches against ws://127.0.0.1:8090):
godot --path godot
# point it elsewhere with:  WS_URL=ws://host:8090 godot --path godot
#                      or:  godot --path godot -- --ws=ws://host:8090

# Headless auto-connecting client (CI / load test / bot):
godot --headless --path godot -- --auto --name=Bot --ws=ws://127.0.0.1:8090
```

Controls match the original: `WASD` move, mouse look, `Shift` sprint,
`Ctrl`/`C` slide, `Space` jump, `1-4` weapons, `R` reload, left-click fire,
`Esc` releases the mouse.

## Tests

The pure simulation is engine-free, so it is verified by a zero-dependency
console harness that ports the original Vitest suites and asserts **behavioral
parity** (movement feel, projectiles, explosions, trace world, the match
reducer, lag-comp, movement validation, clock sync, snapshot interpolation, and
the protocol codec):

```bash
dotnet run --project godot.tests -c Release      # 46 parity checks

# End-to-end server smoke (start the server first, then):
dotnet run --project godot.smoke -c Release -- ws://127.0.0.1:8090
```

## Notes / not yet ported

The core game and full netcode are complete. The in-game **Settings overlay**
(graphics tiers, sensitivity/FOV/volume sliders) and the **F3 debug panel** from
the original are not yet ported — sensitivity/FOV/volume live in code/tuning for
now. Post-processing is Godot-native (sky, SSAO, glow, filmic tonemap) rather
than the Three.js GTAO/bloom stack, but reads as the same bright white-box arena.
