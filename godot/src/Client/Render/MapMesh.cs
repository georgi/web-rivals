// Build the static level mesh from MapData. Boxes -> BoxMesh; ramps ->
// ArrayMesh from the shared solidMeshArrays so render and collider never disagree
// about a surface. The bright "clean arena" look (Roblox Rivals): near-white
// surfaces with a tiled panel texture (triplanar), depth from AO + light shadows.

using Godot;
using WebRivals.Shared;

namespace WebRivals.Client.Render;

public static class MapMesh
{
    private static readonly Color SurfaceColor = new(0.867f, 0.882f, 0.910f);
    private const float TileWorld = 2.0f;

    public static Node3D Build(MapData map)
    {
        var root = new Node3D { Name = "Map" };
        var tex = TileTexture();

        var mat = new StandardMaterial3D
        {
            AlbedoColor = SurfaceColor,
            Roughness = 0.88f,
            Metallic = 0.0f,
            AlbedoTexture = tex,
            Uv1Triplanar = true,
            Uv1Scale = new Vector3(1f / TileWorld, 1f / TileWorld, 1f / TileWorld),
            TextureFilter = BaseMaterial3D.TextureFilterEnum.LinearWithMipmapsAnisotropic,
        };

        // Ramps render double-sided so winding differences never read as see-through.
        var rampMat = (StandardMaterial3D)mat.Duplicate();
        rampMat.CullMode = BaseMaterial3D.CullModeEnum.Disabled;

        foreach (var s in map.Solids)
        {
            MeshInstance3D mi;
            if (s.Type == SolidType.Box)
            {
                var box = new BoxMesh { Size = new Vector3((float)s.Size[0], (float)s.Size[1], (float)s.Size[2]) };
                mi = new MeshInstance3D { Mesh = box, MaterialOverride = mat };
                mi.Position = new Vector3((float)s.Pos[0], (float)s.Pos[1], (float)s.Pos[2]);
            }
            else
            {
                mi = new MeshInstance3D { Mesh = BuildRampMesh(s), MaterialOverride = rampMat };
                // Ramp vertices are already world-space.
            }
            mi.CastShadow = GeometryInstance3D.ShadowCastingSetting.On;
            root.AddChild(mi);
        }

        return root;
    }

    private static ArrayMesh BuildRampMesh(Solid s)
    {
        var (verts, indices) = Geometry.SolidMeshArrays(s);
        var st = new SurfaceTool();
        st.Begin(Mesh.PrimitiveType.Triangles);
        for (int i = 0; i < indices.Length; i++)
        {
            int vi = indices[i] * 3;
            st.SetUV(new Vector2(verts[vi] / TileWorld, verts[vi + 2] / TileWorld));
            st.AddVertex(new Vector3(verts[vi], verts[vi + 1], verts[vi + 2]));
        }
        st.GenerateNormals();
        st.GenerateTangents();
        return st.Commit();
    }

    // White panel with a faint seam border and a grey "+" at each corner so the
    // repeated texture stamps a cross at every tile intersection.
    private static ImageTexture TileTexture()
    {
        const int px = 256;
        var img = Image.CreateEmpty(px, px, false, Image.Format.Rgba8);
        img.Fill(new Color(0.925f, 0.933f, 0.949f));

        var seam = new Color(0.588f, 0.624f, 0.678f, 0.45f);
        // Seam border (1px frame).
        for (int i = 0; i < px; i++)
        {
            img.SetPixel(i, 0, seam); img.SetPixel(i, 1, seam);
            img.SetPixel(i, px - 1, seam); img.SetPixel(i, px - 2, seam);
            img.SetPixel(0, i, seam); img.SetPixel(1, i, seam);
            img.SetPixel(px - 1, i, seam); img.SetPixel(px - 2, i, seam);
        }
        // Corner "+" arms (so neighbours form a full cross when tiled).
        var cross = new Color(0.471f, 0.506f, 0.573f, 0.62f);
        const int L = 24, T = 7;
        (int, int)[] corners = { (0, 0), (px, 0), (0, px), (px, px) };
        foreach (var (cx, cy) in corners)
        {
            for (int dx = -L; dx < L; dx++)
                for (int dy = -T / 2; dy <= T / 2; dy++)
                    Plot(img, cx + dx, cy + dy, cross);
            for (int dy = -L; dy < L; dy++)
                for (int dx = -T / 2; dx <= T / 2; dx++)
                    Plot(img, cx + dx, cy + dy, cross);
        }

        img.GenerateMipmaps();
        return ImageTexture.CreateFromImage(img);
    }

    private static void Plot(Image img, int x, int y, Color c)
    {
        if (x < 0 || y < 0 || x >= img.GetWidth() || y >= img.GetHeight()) return;
        img.SetPixel(x, y, c);
    }
}
