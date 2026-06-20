// Hand-coded TraceWorld over axis-aligned boxes + ramps. Ported from
// shared/src/sim/mock-traceworld.ts. The whole arena is axis-aligned boxes + 4
// ramps, for which this Minkowski-expanded swept-point method is exact, so it is
// the production collision backend for the Godot port (client AND server) — no
// engine physics, fully deterministic, identical on both sides.

using System;
using System.Collections.Generic;
using static WebRivals.Shared.VMath;

namespace WebRivals.Shared.Sim;

public sealed class MockEntity
{
    public int Id;
    public Vec3 Center;
    public double Radius;
    public double HalfHeight;
}

public sealed class MockTraceWorld : ITraceWorld
{
    private sealed class BoxCollider { public Vec3 Min; public Vec3 Max; }
    private sealed class RampCollider
    {
        public Vec3 Min;
        public Vec3 Max;
        public Vec3 PlanePoint;
        public Vec3 PlaneNormal;
        public RampDir Dir;
    }

    private readonly List<BoxCollider> _boxes = new();
    private readonly List<RampCollider> _ramps = new();
    private readonly Dictionary<int, MockEntity> _entities = new();

    // ---- scratch (single-threaded; mirrors the TS module-level scratch) ----
    private readonly Vec3 _scratchNormal = V3();
    private readonly Vec3 _scratchExpMin = V3();
    private readonly Vec3 _scratchExpMax = V3();
    private readonly Aabb _scratchAabb;
    private readonly Vec3 _scratchOffsetPoint = V3();
    private readonly Vec3 _scratchHitPoint = V3();
    private readonly Vec3 _scratchRayDir = V3();
    private readonly Vec3 _bestNormal = V3();
    private readonly Vec3 _planeDiff = V3();
    private readonly Vec3 _capClosest = V3();

    public MockTraceWorld(IEnumerable<Solid> solids)
    {
        _scratchAabb = new Aabb(_scratchExpMin, _scratchExpMax);
        foreach (var s in solids)
        {
            if (s.Type == SolidType.Box) _boxes.Add(BuildBox(s));
            else _ramps.Add(BuildRamp(s));
        }
    }

    public void RegisterEntity(MockEntity e)
    {
        _entities[e.Id] = new MockEntity
        {
            Id = e.Id,
            Center = new Vec3(e.Center.X, e.Center.Y, e.Center.Z),
            Radius = e.Radius,
            HalfHeight = e.HalfHeight,
        };
    }

    public void RemoveEntity(int id) => _entities.Remove(id);
    public void ClearEntities() => _entities.Clear();

    public TraceHit CastCapsule(Vec3 from, double halfHeight, double radius, Vec3 delta)
        => Sweep(from, delta, radius, radius + halfHeight, radius, radius);

    public TraceHit CastSphere(Vec3 from, double radius, Vec3 delta)
        => Sweep(from, delta, radius, radius, radius, radius);

    private TraceHit Sweep(Vec3 from, Vec3 delta, double expX, double expY, double expZ, double planeOffset)
    {
        double dist = Math.Sqrt(delta.X * delta.X + delta.Y * delta.Y + delta.Z * delta.Z);
        if (dist < EPSILON) return null;
        double invDist = 1.0 / dist;
        Set(_scratchRayDir, delta.X * invDist, delta.Y * invDist, delta.Z * invDist);

        double bestT = dist;
        bool hit = false;

        foreach (var b in _boxes)
        {
            Set(_scratchExpMin, b.Min.X - expX, b.Min.Y - expY, b.Min.Z - expZ);
            Set(_scratchExpMax, b.Max.X + expX, b.Max.Y + expY, b.Max.Z + expZ);
            double? t = RayAabb(from, _scratchRayDir, _scratchAabb, bestT, _scratchNormal);
            if (t != null && t >= 0 && t <= bestT)
            {
                bestT = t.Value;
                Copy(_bestNormal, _scratchNormal);
                hit = true;
            }
        }

        foreach (var r in _ramps)
        {
            Set(_scratchExpMin, r.Min.X - expX, r.Min.Y - expY, r.Min.Z - expZ);
            Set(_scratchExpMax, r.Max.X + expX, r.Max.Y + expY, r.Max.Z + expZ);
            double? tb = RayAabb(from, _scratchRayDir, _scratchAabb, bestT, _scratchNormal);
            if (tb != null && tb >= 0 && tb <= bestT && _scratchNormal.Y <= 0.5)
            {
                bestT = tb.Value;
                Copy(_bestNormal, _scratchNormal);
                hit = true;
            }

            AddScaled(_scratchOffsetPoint, r.PlanePoint, r.PlaneNormal, planeOffset);
            double? tp = RayPlaneClamped(from, _scratchRayDir, _scratchOffsetPoint, r.PlaneNormal, bestT);
            if (tp != null && tp >= 0 && tp <= bestT)
            {
                AddScaled(_scratchHitPoint, from, _scratchRayDir, tp.Value);
                if (_scratchHitPoint.X >= r.Min.X - expX - EPSILON &&
                    _scratchHitPoint.X <= r.Max.X + expX + EPSILON &&
                    _scratchHitPoint.Z >= r.Min.Z - expZ - EPSILON &&
                    _scratchHitPoint.Z <= r.Max.Z + expZ + EPSILON)
                {
                    bestT = tp.Value;
                    Copy(_bestNormal, r.PlaneNormal);
                    hit = true;
                }
            }
        }

        if (!hit) return null;

        double fraction = bestT * invDist;
        var point = V3();
        AddScaled(point, from, _scratchRayDir, bestT);
        return new TraceHit
        {
            Fraction = fraction,
            Point = point,
            Normal = new Vec3(_bestNormal.X, _bestNormal.Y, _bestNormal.Z),
        };
    }

    public TraceHit Raycast(Vec3 origin, Vec3 dir, double maxDist)
    {
        double bestT = maxDist;
        bool hit = false;

        foreach (var b in _boxes)
        {
            Copy(_scratchExpMin, b.Min);
            Copy(_scratchExpMax, b.Max);
            double? t = RayAabb(origin, dir, _scratchAabb, bestT, _scratchNormal);
            if (t != null && t >= 0 && t <= bestT)
            {
                bestT = t.Value;
                Copy(_bestNormal, _scratchNormal);
                hit = true;
            }
        }

        foreach (var r in _ramps)
        {
            Copy(_scratchExpMin, r.Min);
            Copy(_scratchExpMax, r.Max);
            double? tb = RayAabb(origin, dir, _scratchAabb, bestT, _scratchNormal);
            if (tb != null && tb >= 0 && tb <= bestT && _scratchNormal.Y <= 0.5)
            {
                bestT = tb.Value;
                Copy(_bestNormal, _scratchNormal);
                hit = true;
            }

            double? tp = RayPlaneClamped(origin, dir, r.PlanePoint, r.PlaneNormal, bestT);
            if (tp != null && tp >= 0 && tp <= bestT)
            {
                AddScaled(_scratchHitPoint, origin, dir, tp.Value);
                if (_scratchHitPoint.X >= r.Min.X - EPSILON &&
                    _scratchHitPoint.X <= r.Max.X + EPSILON &&
                    _scratchHitPoint.Z >= r.Min.Z - EPSILON &&
                    _scratchHitPoint.Z <= r.Max.Z + EPSILON &&
                    _scratchHitPoint.Y >= r.Min.Y - EPSILON &&
                    _scratchHitPoint.Y <= r.Max.Y + EPSILON)
                {
                    bestT = tp.Value;
                    Copy(_bestNormal, r.PlaneNormal);
                    hit = true;
                }
            }
        }

        if (!hit) return null;
        var point = V3();
        AddScaled(point, origin, dir, bestT);
        return new TraceHit
        {
            Fraction = maxDist > 0 ? bestT / maxDist : 0,
            Point = point,
            Normal = new Vec3(_bestNormal.X, _bestNormal.Y, _bestNormal.Z),
        };
    }

    public List<int> OverlapSphere(Vec3 center, double radius)
    {
        var outIds = new List<int>();
        foreach (var e in _entities.Values)
            if (SphereVsCapsule(center, radius, e)) outIds.Add(e.Id);
        return outIds;
    }

    // ---- builders ----

    private static BoxCollider BuildBox(Solid s)
    {
        double cx = s.Pos[0], cy = s.Pos[1], cz = s.Pos[2];
        double sx = s.Size[0], sy = s.Size[1], sz = s.Size[2];
        return new BoxCollider
        {
            Min = V3(cx - sx / 2, cy - sy / 2, cz - sz / 2),
            Max = V3(cx + sx / 2, cy + sy / 2, cz + sz / 2),
        };
    }

    private static RampCollider BuildRamp(Solid s)
    {
        double cx = s.Pos[0], cy = s.Pos[1], cz = s.Pos[2];
        double sx = s.Size[0], sy = s.Size[1], sz = s.Size[2];
        double hx = sx / 2, hy = sy / 2, hz = sz / 2;
        double by = cy - hy;
        var normal = Geometry.RampNormal(s);

        double toeX = cx, toeZ = cz;
        switch (s.Dir)
        {
            case RampDir.PlusX: toeX = cx - hx; break;
            case RampDir.MinusX: toeX = cx + hx; break;
            case RampDir.PlusZ: toeZ = cz - hz; break;
            case RampDir.MinusZ: toeZ = cz + hz; break;
        }

        return new RampCollider
        {
            Min = V3(cx - hx, by, cz - hz),
            Max = V3(cx + hx, cy + hy, cz + hz),
            PlanePoint = V3(toeX, by, toeZ),
            PlaneNormal = normal,
            Dir = s.Dir,
        };
    }

    // ---- geometry helpers ----

    private double? RayPlaneClamped(Vec3 origin, Vec3 dir, Vec3 point, Vec3 normal, double maxT)
    {
        double denom = Dot(dir, normal);
        if (denom >= -EPSILON) return null;
        _planeDiff.X = point.X - origin.X;
        _planeDiff.Y = point.Y - origin.Y;
        _planeDiff.Z = point.Z - origin.Z;
        double t = Dot(_planeDiff, normal) / denom;
        if (t < 0 || t > maxT) return null;
        return t;
    }

    private bool SphereVsCapsule(Vec3 center, double radius, MockEntity e)
    {
        double segBottom = e.Center.Y - e.HalfHeight;
        double segTop = e.Center.Y + e.HalfHeight;
        double cy = center.Y < segBottom ? segBottom : (center.Y > segTop ? segTop : center.Y);
        Set(_capClosest, e.Center.X, cy, e.Center.Z);
        double dx = center.X - _capClosest.X;
        double dy = center.Y - _capClosest.Y;
        double dz = center.Z - _capClosest.Z;
        double distSq = dx * dx + dy * dy + dz * dz;
        double r = radius + e.Radius;
        return distSq <= r * r;
    }
}
