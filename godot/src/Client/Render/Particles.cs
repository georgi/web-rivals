// Cosmetic combat FX: tracers, impacts, explosions, smoke. All pools are
// pre-allocated; Update(dt) only mutates existing nodes (transform/alpha/visible).
// Ported in spirit from client/src/render/particles.ts.

using System;
using Godot;
using WebRivals.Shared;
using static WebRivals.Client.GodotConv;

namespace WebRivals.Client.Render;

public sealed class Particles
{
    public readonly Node3D Object;

    private const int TracerPool = 48;
    private const int ImpactPool = 24;
    private const int ExplosionPool = 8;
    private const int SmokePool = 96;

    private const double ImpactLife = 0.35;
    private const double ExplosionLife = 0.5;
    private const double SmokeLife = 0.9;

    private sealed class Slot
    {
        public MeshInstance3D Node;
        public StandardMaterial3D Mat;
        public double Life;
        public double MaxLife;
        public Color Base;
    }

    private readonly Slot[] _tracers = new Slot[TracerPool];
    private int _tracerHead = 0;
    private readonly Slot[] _impacts = new Slot[ImpactPool];
    private int _impactHead = 0;
    private readonly Slot[] _flashes = new Slot[ExplosionPool];
    private int _flashHead = 0;
    private readonly Slot[] _smokes = new Slot[SmokePool];
    private int _smokeHead = 0;

    public Particles()
    {
        Object = new Node3D { Name = "Particles" };

        var tracerMesh = new BoxMesh { Size = new Vector3(0.04f, 0.04f, 1f) };
        for (int i = 0; i < TracerPool; i++)
            _tracers[i] = MakeSlot(tracerMesh, new Color(1f, 0.878f, 0.541f));

        var sphere = new SphereMesh { Radius = 1f, Height = 2f, RadialSegments = 10, Rings = 6 };
        for (int i = 0; i < ImpactPool; i++)
            _impacts[i] = MakeSlot(sphere, new Color(1f, 0.824f, 0.478f));
        for (int i = 0; i < ExplosionPool; i++)
            _flashes[i] = MakeSlot(sphere, new Color(1f, 0.659f, 0.227f));
        for (int i = 0; i < SmokePool; i++)
            _smokes[i] = MakeSlot(sphere, new Color(0.725f, 0.737f, 0.761f));
    }

    private Slot MakeSlot(Mesh mesh, Color color)
    {
        var mat = new StandardMaterial3D
        {
            AlbedoColor = color,
            ShadingMode = BaseMaterial3D.ShadingModeEnum.Unshaded,
            Transparency = BaseMaterial3D.TransparencyEnum.Alpha,
            BlendMode = BaseMaterial3D.BlendModeEnum.Add,
            CullMode = BaseMaterial3D.CullModeEnum.Disabled,
        };
        var node = new MeshInstance3D
        {
            Mesh = mesh,
            MaterialOverride = mat,
            Visible = false,
            CastShadow = GeometryInstance3D.ShadowCastingSetting.Off,
        };
        Object.AddChild(node);
        return new Slot { Node = node, Mat = mat, Life = 0, MaxLife = 0, Base = color };
    }

    // ---- emit ----

    public void Tracer(Vec3 from, Vec3 to)
    {
        var slot = _tracers[_tracerHead];
        _tracerHead = (_tracerHead + 1) % TracerPool;
        Vector3 a = ToGd(from), b = ToGd(to);
        Vector3 mid = (a + b) * 0.5f;
        float len = a.DistanceTo(b);
        slot.Node.Position = mid;
        if (len > 0.001f && !a.IsEqualApprox(b))
            slot.Node.LookAt(b, Vector3.Up);
        slot.Node.Scale = new Vector3(1, 1, Mathf.Max(len, 0.001f));
        SetAlpha(slot, 1);
        slot.Node.Visible = true;
        slot.Life = Tuning.Ar.TracerFade;
        slot.MaxLife = Tuning.Ar.TracerFade;
    }

    public void Impact(Vec3 point, Vec3 normal)
    {
        var slot = _impacts[_impactHead];
        _impactHead = (_impactHead + 1) % ImpactPool;
        slot.Node.Position = ToGd(point);
        slot.Node.Scale = Vector3.One * 0.12f;
        SetAlpha(slot, 1);
        slot.Node.Visible = true;
        slot.Life = ImpactLife;
        slot.MaxLife = ImpactLife;
    }

    public void Explosion(Vec3 point)
    {
        var slot = _flashes[_flashHead];
        _flashHead = (_flashHead + 1) % ExplosionPool;
        slot.Node.Position = ToGd(point);
        slot.Node.Scale = Vector3.One * 0.2f;
        SetAlpha(slot, 1);
        slot.Node.Visible = true;
        slot.Life = ExplosionLife;
        slot.MaxLife = ExplosionLife;
    }

    public void Smoke(Vec3 point)
    {
        var slot = _smokes[_smokeHead];
        _smokeHead = (_smokeHead + 1) % SmokePool;
        slot.Node.Position = ToGd(point);
        slot.Node.Scale = Vector3.One * 0.12f;
        SetAlpha(slot, 0.5f);
        slot.Node.Visible = true;
        slot.Life = SmokeLife;
        slot.MaxLife = SmokeLife;
    }

    // ---- advance ----

    public void Update(double dt)
    {
        double fade = Tuning.Ar.TracerFade <= 0 ? 0.0001 : Tuning.Ar.TracerFade;
        foreach (var t in _tracers)
        {
            if (t.Life <= 0) continue;
            t.Life -= dt;
            if (t.Life <= 0) { t.Node.Visible = false; continue; }
            SetAlpha(t, (float)(t.Life / fade));
        }

        foreach (var s in _impacts)
        {
            if (s.Life <= 0) continue;
            s.Life -= dt;
            if (s.Life <= 0) { s.Node.Visible = false; continue; }
            double tt = 1 - s.Life / s.MaxLife;
            s.Node.Scale = Vector3.One * (float)(0.12 + tt * 0.5);
            SetAlpha(s, (float)(1 - tt));
        }

        foreach (var f in _flashes)
        {
            if (f.Life <= 0) continue;
            f.Life -= dt;
            if (f.Life <= 0) { f.Node.Visible = false; continue; }
            double tt = 1 - f.Life / f.MaxLife;
            f.Node.Scale = Vector3.One * (float)(0.2 + tt * 2.6);
            SetAlpha(f, (float)(1 - tt));
        }

        foreach (var s in _smokes)
        {
            if (s.Life <= 0) continue;
            s.Life -= dt;
            if (s.Life <= 0) { s.Node.Visible = false; continue; }
            double tt = 1 - s.Life / s.MaxLife;
            var p = s.Node.Position;
            p.Y += (float)(0.4 * dt);
            s.Node.Position = p;
            s.Node.Scale = Vector3.One * (float)(0.12 + tt * 0.5);
            SetAlpha(s, (float)(0.5 * (1 - tt)));
        }
    }

    private static void SetAlpha(Slot slot, float a)
    {
        var c = slot.Base;
        c.A = a;
        slot.Mat.AlbedoColor = c;
    }
}
