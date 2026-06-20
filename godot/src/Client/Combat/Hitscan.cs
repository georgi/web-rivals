// Client-side hitscan resolution and deterministic bloom. Ported from
// client/src/combat/hitscan.ts. Plain Vec3 in/out (engine-free) so the server
// could reuse it; the seeded bloom matches shot-for-shot.

using System;
using System.Collections.Generic;
using WebRivals.Shared;
using WebRivals.Shared.Sim;
using static WebRivals.Shared.VMath;

namespace WebRivals.Client.Combat;

public sealed class CapsuleTarget
{
    public int Id;
    public Vec3 Center;
    public double Radius;
    public double HalfHeight;
}

public enum HitKind { World, Entity, Miss }

public sealed class HitscanResult
{
    public HitKind Kind;
    public Vec3 Point;
    public Vec3 Normal;
    public int EntityId;
    public double Distance;
}

public static class Hitscan
{
    private static readonly Vec3 _capBase = V3();
    private static readonly Vec3 _basisU = V3();
    private static readonly Vec3 _basisV = V3();
    private static readonly Vec3 _perturbed = V3();
    private static readonly Vec3 _ref = V3();

    public static HitscanResult Resolve(Vec3 origin, Vec3 dir, double maxDist, ITraceWorld world, List<CapsuleTarget> targets)
    {
        double bestDist = maxDist;
        int bestEntity = -1;
        double worldNx = 0, worldNy = 1, worldNz = 0;
        bool worldIsBest = false;

        var worldHit = world.Raycast(origin, dir, maxDist);
        if (worldHit != null)
        {
            double d = worldHit.Fraction * maxDist;
            if (d <= bestDist)
            {
                bestDist = d;
                worldIsBest = true;
                worldNx = worldHit.Normal.X;
                worldNy = worldHit.Normal.Y;
                worldNz = worldHit.Normal.Z;
            }
        }

        for (int i = 0; i < targets.Count; i++)
        {
            var t = targets[i];
            Set(_capBase, t.Center.X, t.Center.Y - t.HalfHeight, t.Center.Z);
            double? d = RayCapsule(origin, dir, _capBase, 2 * t.HalfHeight, t.Radius, bestDist);
            if (d != null && d.Value <= bestDist)
            {
                bestDist = d.Value;
                bestEntity = t.Id;
                worldIsBest = false;
            }
        }

        if (bestEntity >= 0)
        {
            var point = V3(origin.X + dir.X * bestDist, origin.Y + dir.Y * bestDist, origin.Z + dir.Z * bestDist);
            var normal = V3(-dir.X, -dir.Y, -dir.Z);
            Normalize(normal, normal);
            return new HitscanResult { Kind = HitKind.Entity, Point = point, Normal = normal, EntityId = bestEntity, Distance = bestDist };
        }

        if (worldIsBest)
        {
            var point = V3(origin.X + dir.X * bestDist, origin.Y + dir.Y * bestDist, origin.Z + dir.Z * bestDist);
            return new HitscanResult { Kind = HitKind.World, Point = point, Normal = V3(worldNx, worldNy, worldNz), EntityId = -1, Distance = bestDist };
        }

        return new HitscanResult
        {
            Kind = HitKind.Miss,
            Point = V3(origin.X + dir.X * maxDist, origin.Y + dir.Y * maxDist, origin.Z + dir.Z * maxDist),
            Normal = V3(0, 1, 0),
            EntityId = -1,
            Distance = maxDist,
        };
    }

    // ---- deterministic seeded bloom ----

    private static double Mulberry32(uint seq)
    {
        unchecked
        {
            uint a = seq + 0x6d2b79f5u;
            a = (a ^ (a >> 15)) * (a | 1u);
            a ^= a + (a ^ (a >> 7)) * (a | 61u);
            return (double)(a ^ (a >> 14)) / 4294967296.0;
        }
    }

    public static void ApplyBloom(Vec3 outV, Vec3 baseDir, double spreadRadians, int seq)
    {
        if (spreadRadians <= 0)
        {
            Copy(outV, baseDir);
            return;
        }

        double r1 = Mulberry32((uint)seq);
        double r2 = Mulberry32((uint)seq ^ 0x9e3779b9u);
        double angle = r1 * Math.PI * 2;
        double radius = Math.Sqrt(r2) * spreadRadians;

        if (Math.Abs(baseDir.Y) < 0.99) Set(_ref, 0, 1, 0);
        else Set(_ref, 1, 0, 0);
        Cross(_basisU, baseDir, _ref);
        if (Normalize(_basisU, _basisU) < EPSILON)
        {
            Set(_ref, 1, 0, 0);
            Cross(_basisU, baseDir, _ref);
            Normalize(_basisU, _basisU);
        }
        Cross(_basisV, baseDir, _basisU);

        double ca = Math.Cos(angle);
        double sa = Math.Sin(angle);
        double tx = ca * _basisU.X + sa * _basisV.X;
        double ty = ca * _basisU.Y + sa * _basisV.Y;
        double tz = ca * _basisU.Z + sa * _basisV.Z;

        double cr = Math.Cos(radius);
        double sr = Math.Sin(radius);
        Set(_perturbed, baseDir.X * cr + tx * sr, baseDir.Y * cr + ty * sr, baseDir.Z * cr + tz * sr);
        Normalize(outV, _perturbed);
    }
}
