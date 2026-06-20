// Boundary conversions between the double-precision sim Vec3 and Godot's
// single-precision Vector3. The sim runs in doubles for JS-parity; rendering uses
// floats. Convert only at the seam.

using Godot;
using WebRivals.Shared;

namespace WebRivals.Client;

public static class GodotConv
{
    public static Vector3 ToGd(Vec3 v) => new Vector3((float)v.X, (float)v.Y, (float)v.Z);
    public static Vector3 ToGd(double x, double y, double z) => new Vector3((float)x, (float)y, (float)z);
    public static Vec3 ToVec(Vector3 v) => new Vec3(v.X, v.Y, v.Z);
}
