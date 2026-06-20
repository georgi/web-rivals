// "Poor man's lag compensation". The server keeps a short ring buffer of each
// player's recent capsule centers (~250ms) and lets the caller REWIND every other
// player to the time the shooter actually saw, then ray-test the rewound capsules.
// Ported from server/src/lagcomp.ts.

using System;
using System.Collections.Generic;
using WebRivals.Shared;
using static WebRivals.Shared.VMath;

namespace WebRivals.Server;

public struct LagHit
{
    public int Id;
    public double Distance;
}

public sealed class LagComp
{
    private const double HISTORY_MS = 250;

    private struct Sample { public double Time; public double Cx, Cy, Cz; }

    private sealed class PlayerTrack
    {
        public List<Sample> Samples = new();
        public double Radius;
        public double HalfHeight;
    }

    private readonly Dictionary<int, PlayerTrack> _players = new();

    public void Record(int playerId, Vec3 center, double radius, double halfHeight, double now)
    {
        if (!_players.TryGetValue(playerId, out var track))
        {
            track = new PlayerTrack { Radius = radius, HalfHeight = halfHeight };
            _players[playerId] = track;
        }
        track.Radius = radius;
        track.HalfHeight = halfHeight;
        track.Samples.Add(new Sample { Time = now, Cx = center.X, Cy = center.Y, Cz = center.Z });

        double cutoff = now - HISTORY_MS;
        var s = track.Samples;
        int drop = 0;
        while (drop + 1 < s.Count && s[drop + 1].Time < cutoff) drop++;
        if (drop > 0) s.RemoveRange(0, drop);
    }

    private readonly Vec3 _base = new Vec3();

    /// <summary>Rewind every player except shooterId to time t, build their capsule
    /// at that instant, ray-test it, return the NEAREST hit or null. dir must be unit.</summary>
    public LagHit? RewindRay(int shooterId, Vec3 origin, Vec3 dir, double maxDist, double t)
    {
        int bestId = -1;
        double bestDist = double.PositiveInfinity;

        foreach (var kv in _players)
        {
            int id = kv.Key;
            var track = kv.Value;
            if (id == shooterId) continue;
            if (track.Samples.Count == 0) continue;

            var c = SampleAt(track.Samples, t);
            _base.X = c.x;
            _base.Y = c.y - track.HalfHeight;
            _base.Z = c.z;
            double height = track.HalfHeight * 2;

            double? dist = RayCapsule(origin, dir, _base, height, track.Radius, maxDist);
            if (dist != null && dist.Value < bestDist)
            {
                bestDist = dist.Value;
                bestId = id;
            }
        }

        if (bestId == -1) return null;
        return new LagHit { Id = bestId, Distance = bestDist };
    }

    public void Remove(int playerId) => _players.Remove(playerId);

    private static (double x, double y, double z) SampleAt(List<Sample> s, double t)
    {
        int n = s.Count;
        if (t <= s[0].Time || n == 1) return (s[0].Cx, s[0].Cy, s[0].Cz);
        var last = s[n - 1];
        if (t >= last.Time) return (last.Cx, last.Cy, last.Cz);

        int i = 1;
        while (i < n && s[i].Time <= t) i++;
        var a = s[i - 1];
        var b = s[i];
        double span = b.Time - a.Time;
        double f = span > 0 ? (t - a.Time) / span : 0;
        return (a.Cx + (b.Cx - a.Cx) * f, a.Cy + (b.Cy - a.Cy) * f, a.Cz + (b.Cz - a.Cz) * f);
    }
}
