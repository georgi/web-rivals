// First-person viewmodel: a small set of primitives per weapon, parented to the
// camera, lower-right of view. Procedural bob + a recoil spring. Ported from
// client/src/weapons/viewmodel.ts.

using System;
using Godot;
using WebRivals.Shared;

namespace WebRivals.Client.Render;

public sealed class Viewmodel
{
    public readonly Node3D Object;

    private const float RestX = 0.28f, RestY = -0.26f, RestZ = -0.6f;
    private const double BobX = 0.012, BobY = 0.018, BobPhasePerM = 1.6;
    private const double RecoilBack = 0.06, RecoilUp = 0.03, RecoilPitch = 0.18, RecoilRecover = 12;

    private readonly Node3D[] _models = new Node3D[5]; // index 1..4
    private int _current = 1;

    private double _bobPhase = 0;
    private double _recoilZ = 0, _recoilY = 0, _recoilPitch = 0;

    public Viewmodel()
    {
        Object = new Node3D { Name = "Viewmodel", Position = new Vector3(RestX, RestY, RestZ) };
        _models[1] = BuildAr();
        _models[2] = BuildRocket();
        _models[3] = BuildKnife();
        _models[4] = BuildGrenade();
        for (int k = 1; k <= 4; k++)
        {
            _models[k].Visible = k == _current;
            Object.AddChild(_models[k]);
        }
    }

    private static StandardMaterial3D Mat(Color color) => new()
    {
        AlbedoColor = color,
        Roughness = 0.6f,
        Metallic = 0.3f,
        // A touch of self-illumination so the weapon reads even in shadow.
        EmissionEnabled = true,
        Emission = color * 0.18f,
    };

    private static MeshInstance3D Box(Color c, float w, float h, float d, Vector3 pos, Vector3 rot = default)
        => new() { Mesh = new BoxMesh { Size = new Vector3(w, h, d) }, MaterialOverride = Mat(c), Position = pos, Rotation = rot, CastShadow = GeometryInstance3D.ShadowCastingSetting.Off };

    private static MeshInstance3D Cyl(Color c, float rTop, float rBot, float h, Vector3 pos, Vector3 rot = default)
        => new() { Mesh = new CylinderMesh { TopRadius = rTop, BottomRadius = rBot, Height = h, RadialSegments = 12 }, MaterialOverride = Mat(c), Position = pos, Rotation = rot, CastShadow = GeometryInstance3D.ShadowCastingSetting.Off };

    private static MeshInstance3D Sph(Color c, float r, Vector3 pos)
        => new() { Mesh = new SphereMesh { Radius = r, Height = r * 2, RadialSegments = 12, Rings = 10 }, MaterialOverride = Mat(c), Position = pos, CastShadow = GeometryInstance3D.ShadowCastingSetting.Off };

    private static Node3D BuildAr()
    {
        var g = new Node3D();
        g.AddChild(Box(new Color(0.2f, 0.227f, 0.247f), 0.06f, 0.07f, 0.42f, Vector3.Zero));
        g.AddChild(Cyl(new Color(0.125f, 0.141f, 0.157f), 0.012f, 0.012f, 0.3f, new Vector3(0, 0.01f, -0.32f), new Vector3(Mathf.Pi / 2, 0, 0)));
        g.AddChild(Box(new Color(0.078f, 0.094f, 0.106f), 0.045f, 0.12f, 0.05f, new Vector3(0, -0.09f, 0.04f)));
        g.AddChild(Box(new Color(0.078f, 0.094f, 0.106f), 0.04f, 0.09f, 0.05f, new Vector3(0, -0.07f, 0.16f), new Vector3(-0.25f, 0, 0)));
        return g;
    }

    private static Node3D BuildRocket()
    {
        var g = new Node3D();
        g.AddChild(Cyl(new Color(0.29f, 0.231f, 0.165f), 0.06f, 0.06f, 0.5f, new Vector3(0, 0, -0.05f), new Vector3(Mathf.Pi / 2, 0, 0)));
        g.AddChild(Cyl(new Color(0.165f, 0.125f, 0.094f), 0.08f, 0.07f, 0.06f, new Vector3(0, 0, -0.3f), new Vector3(Mathf.Pi / 2, 0, 0)));
        g.AddChild(Box(new Color(0.125f, 0.125f, 0.125f), 0.02f, 0.05f, 0.08f, new Vector3(0, 0.07f, -0.02f)));
        g.AddChild(Box(new Color(0.078f, 0.094f, 0.106f), 0.04f, 0.09f, 0.05f, new Vector3(0, -0.08f, 0.12f)));
        return g;
    }

    private static Node3D BuildKnife()
    {
        var g = new Node3D();
        g.AddChild(Box(new Color(0.784f, 0.8f, 0.816f), 0.02f, 0.14f, 0.02f, new Vector3(0, 0.12f, -0.05f), new Vector3(-0.4f, 0, 0)));
        g.AddChild(Box(new Color(0.165f, 0.102f, 0.063f), 0.03f, 0.09f, 0.03f, Vector3.Zero));
        g.AddChild(Box(new Color(0.227f, 0.227f, 0.227f), 0.06f, 0.015f, 0.04f, new Vector3(0, 0.05f, -0.02f)));
        return g;
    }

    private static Node3D BuildGrenade()
    {
        var g = new Node3D();
        g.AddChild(Sph(new Color(0.184f, 0.227f, 0.149f), 0.05f, Vector3.Zero));
        g.AddChild(Cyl(new Color(0.333f, 0.345f, 0.353f), 0.02f, 0.02f, 0.03f, new Vector3(0, 0.06f, 0)));
        g.AddChild(Box(new Color(0.604f, 0.604f, 0.188f), 0.015f, 0.06f, 0.01f, new Vector3(0.03f, 0.05f, 0)));
        return g;
    }

    public void SetWeapon(int slot)
    {
        if (slot == _current) return;
        _models[_current].Visible = false;
        _current = slot;
        _models[slot].Visible = true;
    }

    public void OnFire(int slot)
    {
        double scale = 1;
        if (slot == 2) scale = 2.2;
        else if (slot == 3) scale = 1.4;
        else if (slot == 4) scale = 1.2;
        _recoilZ += RecoilBack * scale;
        _recoilY += RecoilUp * scale;
        _recoilPitch += RecoilPitch * scale;
    }

    public void Update(double dt, double speed, bool grounded)
    {
        bool moving = grounded && speed > 0.5;
        if (moving) _bobPhase += speed * dt * BobPhasePerM;
        double ampScale = moving ? Math.Min(1, speed / Tuning.Movement.WalkSpeed) : 0;
        double bobX = Math.Cos(_bobPhase) * BobX * ampScale;
        double bobY = Math.Abs(Math.Sin(_bobPhase)) * BobY * ampScale;

        _recoilZ = VMath.Damp(_recoilZ, 0, RecoilRecover, dt);
        _recoilY = VMath.Damp(_recoilY, 0, RecoilRecover, dt);
        _recoilPitch = VMath.Damp(_recoilPitch, 0, RecoilRecover, dt);

        Object.Position = new Vector3((float)(RestX + bobX), (float)(RestY + bobY + _recoilY), (float)(RestZ + _recoilZ));
        Object.Rotation = new Vector3((float)_recoilPitch, 0, 0);
    }
}
