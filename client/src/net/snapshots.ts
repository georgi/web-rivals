// Client-side clock synchronization + remote-entity interpolation (PRD §3.3).
//
// Remote players and projectiles are rendered in the past (interpDelayMs) so the
// client always has two snapshots to interpolate between, hiding jitter and
// packet loss. The server clock is estimated from ping/pong RTT so we can place
// "renderTime" on the server's timeline.
//
// NO Three.js / DOM here — plain numbers and the shared PlayerSnap/ProjSnap shapes.

import type { PlayerSnap, ProjSnap, SnapshotMsg } from '@rivals/shared';

const TWO_PI = Math.PI * 2;

/** Shortest-arc angle lerp (handles the +/-PI wrap so yaw never spins the long way). */
function lerpAngle(a: number, b: number, t: number): number {
  // Normalize the delta into (-PI, PI].
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpTuple(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ---------------------------------------------------------------------------
// ClockSync
// ---------------------------------------------------------------------------

/**
 * Estimates the server clock from ping/pong samples.
 *
 * For each pong: rtt = now - clientTime (the original send time we echoed), and a
 * one-way estimate of the server clock at `now` is `serverTime + rtt/2`. The
 * offset that maps local time onto the server timeline is therefore
 * `serverTime + rtt/2 - now`.
 *
 * We favor the *lowest* RTT samples: a low-RTT pong was the least delayed in each
 * direction, so its midpoint estimate is the most trustworthy. The tracked best
 * RTT slowly decays upward so a transient lucky-low sample doesn't pin us forever
 * (periodic re-measurement). When a new sample beats the current best we snap the
 * offset to it; otherwise we ease toward the sample's offset slowly to absorb
 * drift without chasing jitter.
 */
export class ClockSync {
  private offset = 0;
  private bestRtt = Infinity;
  private smoothedRtt = 0;
  private initialized = false;

  // How fast the tracked best-RTT decays back upward (ms of allowance per ms
  // elapsed). ~ re-opens the "snap" window roughly every few seconds.
  private static readonly BEST_RTT_DECAY_PER_MS = 0.02;
  // Easing factor toward a non-best sample's offset.
  private static readonly OFFSET_EASE = 0.1;
  // RTT display smoothing.
  private static readonly RTT_EASE = 0.2;

  private lastPongNow = 0;

  /**
   * @param clientTime the timestamp we put in the ping and the server echoed back
   * @param serverTime the server clock value at the moment it replied
   * @param nowMs      the local clock now (same source serverTimeEstimate is called with)
   */
  onPong(clientTime: number, serverTime: number, nowMs: number): void {
    const rtt = nowMs - clientTime;
    if (rtt < 0) return; // clock went backwards / bogus echo; ignore
    const sampleOffset = serverTime + rtt / 2 - nowMs;

    // Decay the tracked best upward so we periodically re-anchor.
    if (this.initialized && this.lastPongNow > 0) {
      const elapsed = nowMs - this.lastPongNow;
      if (elapsed > 0 && Number.isFinite(this.bestRtt)) {
        this.bestRtt += elapsed * ClockSync.BEST_RTT_DECAY_PER_MS;
      }
    }
    this.lastPongNow = nowMs;

    this.smoothedRtt = this.initialized
      ? lerpNum(this.smoothedRtt, rtt, ClockSync.RTT_EASE)
      : rtt;

    if (!this.initialized || rtt <= this.bestRtt) {
      // Best (or first) sample: trust it, snap.
      this.bestRtt = rtt;
      this.offset = sampleOffset;
      this.initialized = true;
    } else {
      // Worse sample: ease gently toward it to track slow drift.
      this.offset = lerpNum(this.offset, sampleOffset, ClockSync.OFFSET_EASE);
    }
  }

  /** Estimated server clock corresponding to local time `nowMs`. */
  serverTimeEstimate(nowMs: number): number {
    return nowMs + this.offset;
  }

  /** Smoothed round-trip time in ms (0 until the first pong). */
  get rttMs(): number {
    return this.smoothedRtt;
  }
}

// ---------------------------------------------------------------------------
// SnapshotBuffer
// ---------------------------------------------------------------------------

interface Sampled {
  players: PlayerSnap[];
  projectiles: ProjSnap[];
}

/**
 * Holds ~1s of snapshots and produces interpolated state at an arbitrary render
 * time on the server timeline.
 *
 * sample(renderTime):
 *  - bracket renderTime between two snapshots and lerp (pos/vel/yaw/pitch, and
 *    projectile pos) with t in [0,1]; hp/anim/weapon come from the nearer snap.
 *  - if renderTime is before the earliest snapshot, clamp to the earliest.
 *  - if renderTime is past the latest snapshot, FREEZE at the latest (never
 *    extrapolate — a late/dropped snapshot just holds the last known pose).
 */
export class SnapshotBuffer {
  // Kept sorted ascending by serverTime.
  private snaps: SnapshotMsg[] = [];

  // Retain a little over 1s so the interp window (interpDelayMs in the past) is
  // always covered even with reordering.
  private static readonly WINDOW_MS = 1200;

  insert(s: SnapshotMsg): void {
    const n = this.snaps.length;
    if (n === 0 || s.serverTime >= this.snaps[n - 1].serverTime) {
      this.snaps.push(s);
    } else {
      // Out-of-order arrival: insert at the right place (binary search).
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.snaps[mid].serverTime < s.serverTime) lo = mid + 1;
        else hi = mid;
      }
      // Drop exact duplicates of the same serverTime to keep brackets clean.
      if (this.snaps[lo] && this.snaps[lo].serverTime === s.serverTime) {
        this.snaps[lo] = s;
      } else {
        this.snaps.splice(lo, 0, s);
      }
    }
    this.prune();
  }

  private prune(): void {
    const n = this.snaps.length;
    if (n === 0) return;
    const newest = this.snaps[n - 1].serverTime;
    const cutoff = newest - SnapshotBuffer.WINDOW_MS;
    // Always keep at least the two newest so we can still bracket.
    let drop = 0;
    while (drop < n - 2 && this.snaps[drop].serverTime < cutoff) drop++;
    if (drop > 0) this.snaps.splice(0, drop);
  }

  sample(renderTime: number): Sampled {
    const snaps = this.snaps;
    const n = snaps.length;
    if (n === 0) return { players: [], projectiles: [] };
    if (n === 1) return cloneSnap(snaps[0]);

    const earliest = snaps[0];
    const latest = snaps[n - 1];

    // Before the buffer: clamp to earliest.
    if (renderTime <= earliest.serverTime) return cloneSnap(earliest);
    // After the buffer: FREEZE at latest (no extrapolation).
    if (renderTime >= latest.serverTime) return cloneSnap(latest);

    // Find the bracket [a, b] with a.serverTime <= renderTime < b.serverTime.
    // Binary search for the first snap with serverTime > renderTime.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (snaps[mid].serverTime <= renderTime) lo = mid + 1;
      else hi = mid;
    }
    const b = snaps[lo];
    const a = snaps[lo - 1];

    const span = b.serverTime - a.serverTime;
    const t = span > 0 ? (renderTime - a.serverTime) / span : 0;

    return {
      players: interpPlayers(a.players, b.players, t),
      projectiles: interpProjectiles(a.projectiles, b.projectiles, t),
    };
  }

  /** Newest tick in the buffer, or -1 if empty. */
  get latestTick(): number {
    const n = this.snaps.length;
    return n === 0 ? -1 : this.snaps[n - 1].tick;
  }
}

// ---- interpolation helpers -------------------------------------------------

function cloneSnap(s: SnapshotMsg): Sampled {
  return {
    players: s.players.map((p) => ({ ...p, pos: [...p.pos], vel: [...p.vel] })),
    projectiles: s.projectiles.map((pr) => ({ ...pr, pos: [...pr.pos], vel: [...pr.vel] })),
  };
}

function interpPlayers(a: PlayerSnap[], b: PlayerSnap[], t: number): PlayerSnap[] {
  // `b` is the nearer-to-target snapshot for discrete fields (hp/anim/weapon)
  // and the authoritative roster of who exists at the target time.
  const out: PlayerSnap[] = [];
  for (const pb of b) {
    const pa = a.find((p) => p.id === pb.id);
    if (!pa) {
      // Appeared only in the later snapshot: no pair to lerp, take as-is.
      out.push({ ...pb, pos: [...pb.pos], vel: [...pb.vel] });
      continue;
    }
    out.push({
      id: pb.id,
      pos: lerpTuple(pa.pos, pb.pos, t),
      vel: lerpTuple(pa.vel, pb.vel, t),
      yaw: lerpAngle(pa.yaw, pb.yaw, t),
      pitch: lerpNum(pa.pitch, pb.pitch, t),
      // Discrete state comes from the nearer snapshot (b when t>=0.5).
      anim: t < 0.5 ? pa.anim : pb.anim,
      hp: t < 0.5 ? pa.hp : pb.hp,
      weapon: t < 0.5 ? pa.weapon : pb.weapon,
    });
  }
  return out;
}

function interpProjectiles(a: ProjSnap[], b: ProjSnap[], t: number): ProjSnap[] {
  const out: ProjSnap[] = [];
  for (const pb of b) {
    const pa = a.find((p) => p.id === pb.id);
    if (!pa) {
      out.push({ ...pb, pos: [...pb.pos], vel: [...pb.vel] });
      continue;
    }
    out.push({
      id: pb.id,
      kind: pb.kind,
      pos: lerpTuple(pa.pos, pb.pos, t),
      vel: lerpTuple(pa.vel, pb.vel, t),
    });
  }
  return out;
}
