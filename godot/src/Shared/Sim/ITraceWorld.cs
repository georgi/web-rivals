// The trace-layer boundary. The feel layer (Movement) and Projectiles talk ONLY
// to this interface, so the collision backend is swappable. Ported from
// shared/src/sim/traceworld.ts.

using System.Collections.Generic;

namespace WebRivals.Shared.Sim;

public sealed class TraceHit
{
    public double Fraction;  // 0..1 along the swept delta where contact happens
    public Vec3 Point;       // world-space contact point
    public Vec3 Normal;      // surface normal at contact (unit, out of the solid)
}

public interface ITraceWorld
{
    /// <summary>Sweep the player capsule from `from` along `delta`; first static hit or null.</summary>
    TraceHit CastCapsule(Vec3 from, double halfHeight, double radius, Vec3 delta);

    /// <summary>Sweep a sphere (projectiles) from `from` along `delta`; first static hit or null.</summary>
    TraceHit CastSphere(Vec3 from, double radius, Vec3 delta);

    /// <summary>Hitscan ray vs static world. `dir` must be normalized.</summary>
    TraceHit Raycast(Vec3 origin, Vec3 dir, double maxDist);

    /// <summary>Dynamic entity ids whose registered collider overlaps the sphere.</summary>
    List<int> OverlapSphere(Vec3 center, double radius);
}
