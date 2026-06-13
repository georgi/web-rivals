// "Poor man's lag compensation" (PRD §3.1, §19.5).
//
// The server is damage-authoritative for hitscan. When a client fires it sends
// (origin, dir, clientTime); by the time that report arrives the victim has moved
// on the server, so a naive ray against the victim's *current* position would
// miss shots the shooter saw connect on their screen. LagComp keeps a short ring
// buffer of each player's recent capsule centers (~200ms) and lets the caller
// REWIND every other player to the time the shooter actually saw, then ray-test
// the rewound capsules. Static-world occlusion is the caller's job (the room's
// TraceWorld); LagComp only does the entity rewind + ray.

import { rayCapsule, type Vec3 } from '@rivals/shared';

export interface PlayerHitbox {
  id: number;
  center: Vec3;
  radius: number;
  halfHeight: number;
}

/** How far back the ring buffer reaches. 200ms of comp + a little slack so the
 *  oldest still-useful sample isn't evicted right as a delayed report lands. */
const HISTORY_MS = 250;

interface Sample {
  time: number;
  cx: number;
  cy: number;
  cz: number;
}

interface PlayerTrack {
  // Ring buffer of samples, oldest-to-newest by insertion. record() is always
  // called with monotonically non-decreasing `now` (the server tick clock), so
  // we keep it as a simple FIFO and trim the front when it ages out.
  samples: Sample[];
  radius: number;
  halfHeight: number;
}

export class LagComp {
  private players = new Map<number, PlayerTrack>();

  /** Push a positional sample for a player and drop anything older than ~250ms.
   *  radius/halfHeight are stored per player (latest wins). */
  record(
    playerId: number,
    center: Vec3,
    radius: number,
    halfHeight: number,
    now: number,
  ): void {
    let track = this.players.get(playerId);
    if (track === undefined) {
      track = { samples: [], radius, halfHeight };
      this.players.set(playerId, track);
    }
    track.radius = radius;
    track.halfHeight = halfHeight;

    track.samples.push({ time: now, cx: center.x, cy: center.y, cz: center.z });

    // Evict samples older than the window. Keep at least one sample behind the
    // cutoff so interpolation at a `t` slightly past the cutoff can still bracket.
    const cutoff = now - HISTORY_MS;
    const s = track.samples;
    let drop = 0;
    while (drop + 1 < s.length && s[drop + 1].time < cutoff) drop++;
    if (drop > 0) s.splice(0, drop);
  }

  /** Rewind every player except `shooterId` to time `t`, build their capsule at
   *  that instant, ray-test it, and return the NEAREST hit {id, distance} or null.
   *  `dir` must be normalized. */
  rewindRay(
    shooterId: number,
    origin: Vec3,
    dir: Vec3,
    maxDist: number,
    t: number,
  ): { id: number; distance: number } | null {
    let bestId = -1;
    let bestDist = Infinity;

    for (const [id, track] of this.players) {
      if (id === shooterId) continue;
      if (track.samples.length === 0) continue;

      const c = sampleAt(track.samples, t);
      // Capsule core: base is the bottom endpoint, height spans both endpoints.
      // Reuse the scratch base vec to keep the hot path allocation-free.
      base.x = c.x;
      base.y = c.y - track.halfHeight;
      base.z = c.z;
      const height = track.halfHeight * 2;

      const dist = rayCapsule(origin, dir, base, height, track.radius, maxDist);
      if (dist !== null && dist < bestDist) {
        bestDist = dist;
        bestId = id;
      }
    }

    return bestId === -1 ? null : { id: bestId, distance: bestDist };
  }

  /** Forget a player (disconnect / round reset). */
  remove(playerId: number): void {
    this.players.delete(playerId);
  }
}

// Scratch state for sampleAt / rewindRay. Single-threaded JS, one ray at a time.
const base: Vec3 = { x: 0, y: 0, z: 0 };
const sampled = { x: 0, y: 0, z: 0 };

/** Interpolate a player's center at time `t`. Lerp between the two bracketing
 *  samples; clamp to the nearest endpoint when `t` is outside the buffer range. */
function sampleAt(s: Sample[], t: number): { x: number; y: number; z: number } {
  const n = s.length;
  // Clamp before the oldest / after the newest sample (no extrapolation).
  if (t <= s[0].time || n === 1) {
    sampled.x = s[0].cx;
    sampled.y = s[0].cy;
    sampled.z = s[0].cz;
    return sampled;
  }
  const last = s[n - 1];
  if (t >= last.time) {
    sampled.x = last.cx;
    sampled.y = last.cy;
    sampled.z = last.cz;
    return sampled;
  }

  // Find the bracketing pair [a, b] with a.time <= t < b.time. Buffers are tiny
  // (~5-8 samples at 30Hz), so a linear scan is cheaper than a binary search.
  let i = 1;
  while (i < n && s[i].time <= t) i++;
  const a = s[i - 1];
  const b = s[i];
  const span = b.time - a.time;
  const f = span > 0 ? (t - a.time) / span : 0;
  sampled.x = a.cx + (b.cx - a.cx) * f;
  sampled.y = a.cy + (b.cy - a.cy) * f;
  sampled.z = a.cz + (b.cz - a.cz) * f;
  return sampled;
}
