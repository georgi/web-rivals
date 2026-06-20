// Pure math for the shared sim. NO Godot, NO engine types — a plain mutable Vec3
// (reference type, matching the TS {x,y,z} object semantics incl. aliasing) plus
// free functions that take an `out` target to avoid per-call allocation on the
// hot path. Ported 1:1 from shared/src/math.ts; doubles keep JS-number parity so
// the simulation reproduces identically on client and server.

using System;

namespace WebRivals.Shared;

/// <summary>Mutable 3-vector. A class (not struct) so aliasing like
/// ProjectOntoPlane(s.Vel, s.Vel, n) behaves exactly as the TS object did.</summary>
public sealed class Vec3
{
    public double X, Y, Z;

    public Vec3() { }
    public Vec3(double x, double y, double z) { X = x; Y = y; Z = z; }
}

/// <summary>AABB for ray/box intersection (MockTraceWorld + lag comp).</summary>
public sealed class Aabb
{
    public Vec3 Min;
    public Vec3 Max;
    public Aabb(Vec3 min, Vec3 max) { Min = min; Max = max; }
}

public static class VMath
{
    public const double EPSILON = 1e-6;
    public const double DEG2RAD = Math.PI / 180.0;
    public const double RAD2DEG = 180.0 / Math.PI;

    public static Vec3 V3(double x = 0, double y = 0, double z = 0) => new Vec3(x, y, z);

    public static Vec3 FromTuple(double[] t) => new Vec3(t[0], t[1], t[2]);
    public static double[] ToTuple(Vec3 v) => new[] { v.X, v.Y, v.Z };

    public static Vec3 Set(Vec3 o, double x, double y, double z) { o.X = x; o.Y = y; o.Z = z; return o; }
    public static Vec3 Copy(Vec3 o, Vec3 a) { o.X = a.X; o.Y = a.Y; o.Z = a.Z; return o; }
    public static Vec3 Clone(Vec3 a) => new Vec3(a.X, a.Y, a.Z);

    public static Vec3 Add(Vec3 o, Vec3 a, Vec3 b) { o.X = a.X + b.X; o.Y = a.Y + b.Y; o.Z = a.Z + b.Z; return o; }
    public static Vec3 Sub(Vec3 o, Vec3 a, Vec3 b) { o.X = a.X - b.X; o.Y = a.Y - b.Y; o.Z = a.Z - b.Z; return o; }
    public static Vec3 Scale(Vec3 o, Vec3 a, double s) { o.X = a.X * s; o.Y = a.Y * s; o.Z = a.Z * s; return o; }

    /// <summary>o = a + b * s</summary>
    public static Vec3 AddScaled(Vec3 o, Vec3 a, Vec3 b, double s)
    {
        o.X = a.X + b.X * s; o.Y = a.Y + b.Y * s; o.Z = a.Z + b.Z * s; return o;
    }

    public static Vec3 Mul(Vec3 o, Vec3 a, Vec3 b) { o.X = a.X * b.X; o.Y = a.Y * b.Y; o.Z = a.Z * b.Z; return o; }

    public static double Dot(Vec3 a, Vec3 b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z;

    public static Vec3 Cross(Vec3 o, Vec3 a, Vec3 b)
    {
        double ax = a.X, ay = a.Y, az = a.Z;
        double bx = b.X, by = b.Y, bz = b.Z;
        o.X = ay * bz - az * by;
        o.Y = az * bx - ax * bz;
        o.Z = ax * by - ay * bx;
        return o;
    }

    public static double LengthSq(Vec3 a) => a.X * a.X + a.Y * a.Y + a.Z * a.Z;
    public static double Length(Vec3 a) => Math.Sqrt(a.X * a.X + a.Y * a.Y + a.Z * a.Z);

    public static double DistanceSq(Vec3 a, Vec3 b)
    {
        double dx = a.X - b.X, dy = a.Y - b.Y, dz = a.Z - b.Z;
        return dx * dx + dy * dy + dz * dz;
    }

    public static double Distance(Vec3 a, Vec3 b) => Math.Sqrt(DistanceSq(a, b));

    /// <summary>Normalizes a into out and returns the original length (0 if degenerate).</summary>
    public static double Normalize(Vec3 o, Vec3 a)
    {
        double len = Length(a);
        if (len < EPSILON) { o.X = 0; o.Y = 0; o.Z = 0; return 0; }
        double inv = 1.0 / len;
        o.X = a.X * inv; o.Y = a.Y * inv; o.Z = a.Z * inv;
        return len;
    }

    /// <summary>o = a + (b - a) * t</summary>
    public static Vec3 Lerp(Vec3 o, Vec3 a, Vec3 b, double t)
    {
        o.X = a.X + (b.X - a.X) * t;
        o.Y = a.Y + (b.Y - a.Y) * t;
        o.Z = a.Z + (b.Z - a.Z) * t;
        return o;
    }

    /// <summary>Reflect v about a unit normal n: o = v - 2*(v·n)*n</summary>
    public static Vec3 Reflect(Vec3 o, Vec3 v, Vec3 n)
    {
        double d = Dot(v, n);
        o.X = v.X - 2 * d * n.X;
        o.Y = v.Y - 2 * d * n.Y;
        o.Z = v.Z - 2 * d * n.Z;
        return o;
    }

    /// <summary>Remove the component of v along unit normal n: o = v - (v·n)*n</summary>
    public static Vec3 ProjectOntoPlane(Vec3 o, Vec3 v, Vec3 n)
    {
        double d = Dot(v, n);
        o.X = v.X - d * n.X;
        o.Y = v.Y - d * n.Y;
        o.Z = v.Z - d * n.Z;
        return o;
    }

    public static Vec3 ClampLength(Vec3 o, Vec3 a, double max)
    {
        double lsq = LengthSq(a);
        if (lsq > max * max && lsq > EPSILON)
        {
            double s = max / Math.Sqrt(lsq);
            o.X = a.X * s; o.Y = a.Y * s; o.Z = a.Z * s;
        }
        else if (!ReferenceEquals(o, a))
        {
            Copy(o, a);
        }
        return o;
    }

    /// <summary>Horizontal (xz) speed, ignoring vertical component.</summary>
    public static double HorizontalLength(Vec3 a) => Math.Sqrt(a.X * a.X + a.Z * a.Z);

    // ---- scalar helpers ----

    public static double Clamp(double x, double lo, double hi) => x < lo ? lo : (x > hi ? hi : x);
    public static double LerpScalar(double a, double b, double t) => a + (b - a) * t;

    /// <summary>Frame-rate-independent exponential smoothing.</summary>
    public static double Damp(double current, double target, double rate, double dt)
        => LerpScalar(current, target, 1 - Math.Exp(-rate * dt));

    // ---- ray / box intersection ----

    /// <summary>Slab-method ray vs AABB. Returns entry t in [0, maxDist] and writes
    /// the surface normal into outNormal, or null on miss. dir must be normalized.</summary>
    public static double? RayAabb(Vec3 origin, Vec3 dir, Aabb box, double maxDist, Vec3 outNormal)
    {
        double tmin = 0;
        double tmax = maxDist;
        double nx = 0, ny = 0, nz = 0;

        // X slab
        {
            double inv = 1.0 / (dir.X != 0 ? dir.X : EPSILON);
            double t1 = (box.Min.X - origin.X) * inv;
            double t2 = (box.Max.X - origin.X) * inv;
            double sign = -1;
            if (t1 > t2) { (t1, t2) = (t2, t1); sign = 1; }
            if (t1 > tmin) { tmin = t1; nx = sign; ny = 0; nz = 0; }
            if (t2 < tmax) tmax = t2;
            if (tmin > tmax) return null;
        }
        // Y slab
        {
            double inv = 1.0 / (dir.Y != 0 ? dir.Y : EPSILON);
            double t1 = (box.Min.Y - origin.Y) * inv;
            double t2 = (box.Max.Y - origin.Y) * inv;
            double sign = -1;
            if (t1 > t2) { (t1, t2) = (t2, t1); sign = 1; }
            if (t1 > tmin) { tmin = t1; nx = 0; ny = sign; nz = 0; }
            if (t2 < tmax) tmax = t2;
            if (tmin > tmax) return null;
        }
        // Z slab
        {
            double inv = 1.0 / (dir.Z != 0 ? dir.Z : EPSILON);
            double t1 = (box.Min.Z - origin.Z) * inv;
            double t2 = (box.Max.Z - origin.Z) * inv;
            double sign = -1;
            if (t1 > t2) { (t1, t2) = (t2, t1); sign = 1; }
            if (t1 > tmin) { tmin = t1; nx = 0; ny = 0; nz = sign; }
            if (t2 < tmax) tmax = t2;
            if (tmin > tmax) return null;
        }

        outNormal.X = nx; outNormal.Y = ny; outNormal.Z = nz;
        return tmin;
    }

    /// <summary>Ray vs vertical infinite capsule segment (player hitbox for lag-comp).
    /// Segment runs from base up by height with radius. Returns hit distance along
    /// dir (normalized) within maxDist, or null.</summary>
    public static double? RayCapsule(Vec3 origin, Vec3 dir, Vec3 baseP, double height, double radius, double maxDist)
    {
        double ax = baseP.X, ay = baseP.Y, az = baseP.Z;
        double bx = baseP.X, by = baseP.Y + height, bz = baseP.Z;
        double sdx = bx - ax, sdy = by - ay, sdz = bz - az;
        double sLenSq = sdx * sdx + sdy * sdy + sdz * sdz;
        if (sLenSq == 0) sLenSq = EPSILON;

        double rox = origin.X - ax, roy = origin.Y - ay, roz = origin.Z - az;

        double segInv = 1.0 / sLenSq;
        double dDotS = (dir.X * sdx + dir.Y * sdy + dir.Z * sdz) * segInv;
        double oDotS = (rox * sdx + roy * sdy + roz * sdz) * segInv;

        double pdx = dir.X - sdx * dDotS;
        double pdy = dir.Y - sdy * dDotS;
        double pdz = dir.Z - sdz * dDotS;
        double pox = rox - sdx * oDotS;
        double poy = roy - sdy * oDotS;
        double poz = roz - sdz * oDotS;

        double A = pdx * pdx + pdy * pdy + pdz * pdz;
        double B = 2 * (pdx * pox + pdy * poy + pdz * poz);
        double C = pox * pox + poy * poy + poz * poz - radius * radius;

        if (A >= EPSILON)
        {
            double disc = B * B - 4 * A * C;
            if (disc >= 0)
            {
                double sq = Math.Sqrt(disc);
                double t = (-B - sq) / (2 * A);
                if (t >= 0 && t <= maxDist)
                {
                    double segParam = oDotS + dDotS * t;
                    if (segParam >= 0 && segParam <= 1) return t;
                }
            }
        }
        // Endpoint spheres
        double? hitA = RaySphere(origin, dir, ax, ay, az, radius, maxDist);
        double? hitB = RaySphere(origin, dir, bx, by, bz, radius, maxDist);
        if (hitA == null) return hitB;
        if (hitB == null) return hitA;
        return Math.Min(hitA.Value, hitB.Value);
    }

    private static double? RaySphere(Vec3 origin, Vec3 dir, double cx, double cy, double cz, double radius, double maxDist)
    {
        double ox = origin.X - cx, oy = origin.Y - cy, oz = origin.Z - cz;
        double b = ox * dir.X + oy * dir.Y + oz * dir.Z;
        double c = ox * ox + oy * oy + oz * oz - radius * radius;
        double disc = b * b - c;
        if (disc < 0) return null;
        double t = -b - Math.Sqrt(disc);
        if (t >= 0 && t <= maxDist) return t;
        return null;
    }
}
