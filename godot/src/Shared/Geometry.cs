// Static geometry derived from the map. ONE source of truth for the corner
// vertices so the client render mesh and the trace collider never disagree.
// Ported from shared/src/geometry.ts.
//
// Ramp convention: Dir is the horizontal direction the slope ASCENDS toward.
// The full-height (vertical) face is on the Dir side; the slope descends to floor
// level on the -Dir side. A ramp is a right-triangular prism.

using System.Collections.Generic;
using static WebRivals.Shared.VMath;

namespace WebRivals.Shared;

public enum SolidType { Box, Ramp }

public enum RampDir { PlusX, MinusX, PlusZ, MinusZ }

public sealed class Solid
{
    public SolidType Type;
    public double[] Pos;   // center [x,y,z]
    public double[] Size;  // full extents [x,y,z]
    public RampDir Dir;    // ramps only

    public static Solid Box(double px, double py, double pz, double sx, double sy, double sz)
        => new Solid { Type = SolidType.Box, Pos = new[] { px, py, pz }, Size = new[] { sx, sy, sz } };

    public static Solid Ramp(double px, double py, double pz, double sx, double sy, double sz, RampDir dir)
        => new Solid { Type = SolidType.Ramp, Pos = new[] { px, py, pz }, Size = new[] { sx, sy, sz }, Dir = dir };
}

public sealed class SpawnPoint
{
    public double[] Pos; // [x,y,z]
    public double Yaw;   // degrees
    public SpawnPoint(double x, double y, double z, double yaw) { Pos = new[] { x, y, z }; Yaw = yaw; }
}

public sealed class MapData
{
    public List<Solid> Solids = new();
    public List<SpawnPoint> Spawns = new();
    public double KillY;
}

public static class Geometry
{
    /// <summary>World-space corner vertices: box -> 8, ramp -> 6 (triangular prism).</summary>
    public static List<Vec3> SolidVertices(Solid s)
    {
        double cx = s.Pos[0], cy = s.Pos[1], cz = s.Pos[2];
        double sx = s.Size[0], sy = s.Size[1], sz = s.Size[2];
        double hx = sx / 2, hy = sy / 2, hz = sz / 2;
        double by = cy - hy;
        double ty = cy + hy;

        if (s.Type == SolidType.Box)
        {
            return new List<Vec3>
            {
                V3(cx - hx, by, cz - hz),
                V3(cx + hx, by, cz - hz),
                V3(cx + hx, by, cz + hz),
                V3(cx - hx, by, cz + hz),
                V3(cx - hx, ty, cz - hz),
                V3(cx + hx, ty, cz - hz),
                V3(cx + hx, ty, cz + hz),
                V3(cx - hx, ty, cz + hz),
            };
        }

        bool alongX = s.Dir == RampDir.PlusX || s.Dir == RampDir.MinusX;
        bool highPos = s.Dir == RampDir.PlusX || s.Dir == RampDir.PlusZ;

        var verts = new List<Vec3>();
        foreach (int w in new[] { -1, 1 })
        {
            if (alongX)
            {
                double wz = cz + w * hz;
                double toeX = highPos ? cx - hx : cx + hx;
                double backX = highPos ? cx + hx : cx - hx;
                verts.Add(V3(toeX, by, wz));
                verts.Add(V3(backX, by, wz));
                verts.Add(V3(backX, ty, wz));
            }
            else
            {
                double wx = cx + w * hx;
                double toeZ = highPos ? cz - hz : cz + hz;
                double backZ = highPos ? cz + hz : cz - hz;
                verts.Add(V3(wx, by, toeZ));
                verts.Add(V3(wx, by, backZ));
                verts.Add(V3(wx, ty, backZ));
            }
        }
        return verts;
    }

    /// <summary>Triangle indices into SolidVertices(). Box -> 12 tris, ramp -> 8.</summary>
    public static int[] SolidTriangleIndices(Solid s)
    {
        if (s.Type == SolidType.Box)
        {
            return new[]
            {
                0, 2, 1, 0, 3, 2,       // bottom
                4, 5, 6, 4, 6, 7,       // top
                0, 1, 5, 0, 5, 4,       // -z
                3, 7, 6, 3, 6, 2,       // +z
                0, 4, 7, 0, 7, 3,       // -x
                1, 2, 6, 1, 6, 5,       // +x
            };
        }
        return new[]
        {
            0, 2, 1,                    // side A
            3, 4, 5,                    // side B
            0, 1, 4, 0, 4, 3,           // bottom quad
            1, 2, 5, 1, 5, 4,           // back wall
            0, 3, 5, 0, 5, 2,           // slope
        };
    }

    /// <summary>Flat vertex buffer + index array for building a mesh / trimesh.</summary>
    public static (float[] vertices, int[] indices) SolidMeshArrays(Solid s)
    {
        var verts = SolidVertices(s);
        var outv = new float[verts.Count * 3];
        for (int i = 0; i < verts.Count; i++)
        {
            outv[i * 3] = (float)verts[i].X;
            outv[i * 3 + 1] = (float)verts[i].Y;
            outv[i * 3 + 2] = (float)verts[i].Z;
        }
        return (outv, SolidTriangleIndices(s));
    }

    /// <summary>Walkable slope surface unit normal for a ramp.</summary>
    public static Vec3 RampNormal(Solid s)
    {
        double sx = s.Size[0], sy = s.Size[1], sz = s.Size[2];
        bool alongX = s.Dir == RampDir.PlusX || s.Dir == RampDir.MinusX;
        double run = alongX ? sx : sz;
        double rise = sy;
        double len = System.Math.Sqrt(run * run + rise * rise);
        if (len == 0) len = 1;
        double ny = run / len;
        double horiz = -rise / len;
        double sign = (s.Dir == RampDir.PlusX || s.Dir == RampDir.PlusZ) ? 1 : -1;
        if (alongX) return V3(sign * horiz, ny, 0);
        return V3(0, ny, sign * horiz);
    }
}
