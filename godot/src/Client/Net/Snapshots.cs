// Client-side clock synchronization + remote-entity interpolation. Remote players
// and projectiles are rendered in the past (interpDelayMs) so the client always
// has two snapshots to interpolate between. Ported from client/src/net/snapshots.ts.
// Pure numbers — no engine types.

using System;
using System.Collections.Generic;
using WebRivals.Shared;

namespace WebRivals.Client.Net;

public sealed class SampledState
{
    public List<PlayerSnap> Players = new();
    public List<ProjSnap> Projectiles = new();
}

/// <summary>Estimates the server clock from ping/pong samples.</summary>
public sealed class ClockSync
{
    private double _offset = 0;
    private double _bestRtt = double.PositiveInfinity;
    private double _smoothedRtt = 0;
    private bool _initialized = false;

    private const double BEST_RTT_DECAY_PER_MS = 0.02;
    private const double OFFSET_EASE = 0.1;
    private const double RTT_EASE = 0.2;

    private double _lastPongNow = 0;

    private static double LerpNum(double a, double b, double t) => a + (b - a) * t;

    public void OnPong(double clientTime, double serverTime, double nowMs)
    {
        double rtt = nowMs - clientTime;
        if (rtt < 0) return;
        double sampleOffset = serverTime + rtt / 2 - nowMs;

        if (_initialized && _lastPongNow > 0)
        {
            double elapsed = nowMs - _lastPongNow;
            if (elapsed > 0 && !double.IsInfinity(_bestRtt))
                _bestRtt += elapsed * BEST_RTT_DECAY_PER_MS;
        }
        _lastPongNow = nowMs;

        _smoothedRtt = _initialized ? LerpNum(_smoothedRtt, rtt, RTT_EASE) : rtt;

        if (!_initialized || rtt <= _bestRtt)
        {
            _bestRtt = rtt;
            _offset = sampleOffset;
            _initialized = true;
        }
        else
        {
            _offset = LerpNum(_offset, sampleOffset, OFFSET_EASE);
        }
    }

    public double ServerTimeEstimate(double nowMs) => nowMs + _offset;
    public double RttMs => _smoothedRtt;
}

/// <summary>Holds ~1s of snapshots and produces interpolated state at an arbitrary
/// render time on the server timeline.</summary>
public sealed class SnapshotBuffer
{
    private readonly List<SnapshotMsg> _snaps = new();
    private const double WINDOW_MS = 1200;
    private const double TWO_PI = Math.PI * 2;

    public void Insert(SnapshotMsg s)
    {
        int n = _snaps.Count;
        if (n == 0 || s.ServerTime >= _snaps[n - 1].ServerTime)
        {
            _snaps.Add(s);
        }
        else
        {
            int lo = 0, hi = n;
            while (lo < hi)
            {
                int mid = (lo + hi) >> 1;
                if (_snaps[mid].ServerTime < s.ServerTime) lo = mid + 1;
                else hi = mid;
            }
            if (lo < _snaps.Count && _snaps[lo].ServerTime == s.ServerTime) _snaps[lo] = s;
            else _snaps.Insert(lo, s);
        }
        Prune();
    }

    private void Prune()
    {
        int n = _snaps.Count;
        if (n == 0) return;
        double newest = _snaps[n - 1].ServerTime;
        double cutoff = newest - WINDOW_MS;
        int drop = 0;
        while (drop < n - 2 && _snaps[drop].ServerTime < cutoff) drop++;
        if (drop > 0) _snaps.RemoveRange(0, drop);
    }

    public SampledState Sample(double renderTime)
    {
        int n = _snaps.Count;
        if (n == 0) return new SampledState();
        if (n == 1) return CloneSnap(_snaps[0]);

        var earliest = _snaps[0];
        var latest = _snaps[n - 1];

        if (renderTime <= earliest.ServerTime) return CloneSnap(earliest);
        if (renderTime >= latest.ServerTime) return CloneSnap(latest);

        int lo = 0, hi = n;
        while (lo < hi)
        {
            int mid = (lo + hi) >> 1;
            if (_snaps[mid].ServerTime <= renderTime) lo = mid + 1;
            else hi = mid;
        }
        var b = _snaps[lo];
        var a = _snaps[lo - 1];

        double span = b.ServerTime - a.ServerTime;
        double t = span > 0 ? (renderTime - a.ServerTime) / span : 0;

        return new SampledState
        {
            Players = InterpPlayers(a.Players, b.Players, t),
            Projectiles = InterpProjectiles(a.Projectiles, b.Projectiles, t),
        };
    }

    public int LatestTick => _snaps.Count == 0 ? -1 : _snaps[_snaps.Count - 1].Tick;

    // ---- interpolation helpers ----

    private static double LerpAngle(double a, double b, double t)
    {
        double d = (b - a) % TWO_PI;
        if (d > Math.PI) d -= TWO_PI;
        else if (d < -Math.PI) d += TWO_PI;
        return a + d * t;
    }

    private static double LerpNum(double a, double b, double t) => a + (b - a) * t;

    private static double[] LerpTuple(double[] a, double[] b, double t)
        => new[] { a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t };

    private static SampledState CloneSnap(SnapshotMsg s)
    {
        var outS = new SampledState();
        foreach (var p in s.Players)
            outS.Players.Add(new PlayerSnap { Id = p.Id, Pos = (double[])p.Pos.Clone(), Vel = (double[])p.Vel.Clone(), Yaw = p.Yaw, Pitch = p.Pitch, Anim = p.Anim, Hp = p.Hp, Weapon = p.Weapon });
        foreach (var pr in s.Projectiles)
            outS.Projectiles.Add(new ProjSnap { Id = pr.Id, Kind = pr.Kind, Pos = (double[])pr.Pos.Clone(), Vel = (double[])pr.Vel.Clone() });
        return outS;
    }

    private static List<PlayerSnap> InterpPlayers(PlayerSnap[] a, PlayerSnap[] b, double t)
    {
        var outP = new List<PlayerSnap>();
        foreach (var pb in b)
        {
            PlayerSnap pa = null;
            foreach (var p in a) if (p.Id == pb.Id) { pa = p; break; }
            if (pa == null)
            {
                outP.Add(new PlayerSnap { Id = pb.Id, Pos = (double[])pb.Pos.Clone(), Vel = (double[])pb.Vel.Clone(), Yaw = pb.Yaw, Pitch = pb.Pitch, Anim = pb.Anim, Hp = pb.Hp, Weapon = pb.Weapon });
                continue;
            }
            outP.Add(new PlayerSnap
            {
                Id = pb.Id,
                Pos = LerpTuple(pa.Pos, pb.Pos, t),
                Vel = LerpTuple(pa.Vel, pb.Vel, t),
                Yaw = LerpAngle(pa.Yaw, pb.Yaw, t),
                Pitch = LerpNum(pa.Pitch, pb.Pitch, t),
                Anim = t < 0.5 ? pa.Anim : pb.Anim,
                Hp = t < 0.5 ? pa.Hp : pb.Hp,
                Weapon = t < 0.5 ? pa.Weapon : pb.Weapon,
            });
        }
        return outP;
    }

    private static List<ProjSnap> InterpProjectiles(ProjSnap[] a, ProjSnap[] b, double t)
    {
        var outP = new List<ProjSnap>();
        foreach (var pb in b)
        {
            ProjSnap pa = null;
            foreach (var p in a) if (p.Id == pb.Id) { pa = p; break; }
            if (pa == null)
            {
                outP.Add(new ProjSnap { Id = pb.Id, Kind = pb.Kind, Pos = (double[])pb.Pos.Clone(), Vel = (double[])pb.Vel.Clone() });
                continue;
            }
            outP.Add(new ProjSnap { Id = pb.Id, Kind = pb.Kind, Pos = LerpTuple(pa.Pos, pb.Pos, t), Vel = LerpTuple(pa.Vel, pb.Vel, t) });
        }
        return outP;
    }
}
