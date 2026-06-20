// A stationary target dummy for the offline combat sandbox. Render-only state
// lives here; the capsule it exposes is what hitscan and the explosion sim test
// against. Ported from client/src/entities/dummy.ts.

using System;
using Godot;
using WebRivals.Shared;
using WebRivals.Client.Combat;
using static WebRivals.Client.GodotConv;

namespace WebRivals.Client.Render;

public sealed class Dummy
{
    public readonly Node3D Object;
    public readonly int Id;

    public Vec3 Center;
    public double Radius = 0.4;
    public double HalfHeight = 0.5;
    public double FacingYaw;
    public double Hp;

    private const double MaxHp = 100; // Tuning.Combat.SpawnHealth
    private const double ResetDelay = 2.0;
    private const double DeathHide = 0.5;
    private const double FlashTime = 0.12;

    private readonly Humanoid _body;
    private readonly StandardMaterial3D _bodyMat;
    private readonly MeshInstance3D _hpBar;
    private readonly StandardMaterial3D _hpMat;

    private double _flash = 0;
    private double _resetTimer = 0;
    private double _deathTimer = 0;

    private static readonly Color BodyColor = new(1f, 0.353f, 0.353f);
    private static readonly Color FlashWhite = new(1f, 1f, 1f);
    private static readonly Color HpGreen = new(0.275f, 0.827f, 0.353f);
    private static readonly Color HpRed = new(1f, 0.251f, 0.251f);

    public Dummy(int id, Vec3 center)
    {
        Id = id;
        Center = new Vec3(center.X, center.Y, center.Z);
        FacingYaw = Math.PI;
        Hp = MaxHp;

        Object = new Node3D { Name = $"Dummy{id}" };
        Object.Position = ToGd(center);
        Object.Rotation = new Vector3(0, (float)FacingYaw, 0);

        _bodyMat = new StandardMaterial3D { AlbedoColor = BodyColor, Roughness = 0.85f, Metallic = 0.0f };
        _body = new Humanoid(_bodyMat);
        Object.AddChild(_body.Object);

        _hpMat = new StandardMaterial3D
        {
            AlbedoColor = HpGreen,
            ShadingMode = BaseMaterial3D.ShadingModeEnum.Unshaded,
            BillboardMode = BaseMaterial3D.BillboardModeEnum.Enabled,
            NoDepthTest = true,
            RenderPriority = 10,
        };
        _hpBar = new MeshInstance3D
        {
            Mesh = new QuadMesh { Size = new Vector2(1.0f, 0.12f) },
            MaterialOverride = _hpMat,
            Position = new Vector3(0, 1.35f, 0),
            CastShadow = GeometryInstance3D.ShadowCastingSetting.Off,
        };
        Object.AddChild(_hpBar);
        RefreshHpBar();
    }

    public CapsuleTarget CapsuleTarget() => new() { Id = Id, Center = Center, Radius = Radius, HalfHeight = HalfHeight };

    public void ApplyDamage(double amount)
    {
        if (_deathTimer > 0) return;
        Hp = VMath.Clamp(Hp - amount, 0, MaxHp);
        _flash = FlashTime;
        RefreshHpBar();

        if (Hp <= 0)
        {
            _deathTimer = DeathHide;
            _resetTimer = 0;
            _body.Object.Visible = false;
            _hpBar.Visible = false;
        }
        else
        {
            _resetTimer = ResetDelay;
        }
    }

    public void Update(double dt)
    {
        if (_deathTimer > 0)
        {
            _deathTimer -= dt;
            if (_deathTimer <= 0)
            {
                _deathTimer = 0;
                Hp = MaxHp;
                _body.Object.Visible = true;
                _hpBar.Visible = true;
                _flash = 0;
                _bodyMat.AlbedoColor = BodyColor;
                RefreshHpBar();
            }
            return;
        }

        if (_resetTimer > 0)
        {
            _resetTimer -= dt;
            if (_resetTimer <= 0)
            {
                _resetTimer = 0;
                Hp = MaxHp;
                RefreshHpBar();
            }
        }

        if (_flash > 0)
        {
            _flash -= dt;
            double t = VMath.Clamp(_flash / FlashTime, 0, 1);
            _bodyMat.AlbedoColor = BodyColor.Lerp(FlashWhite, (float)t);
            if (_flash <= 0)
            {
                _flash = 0;
                _bodyMat.AlbedoColor = BodyColor;
            }
        }

        _body.Update(dt, 0, true);
    }

    public bool Visible
    {
        get => Object.Visible;
        set => Object.Visible = value;
    }

    private void RefreshHpBar()
    {
        double frac = VMath.Clamp(Hp / MaxHp, 0, 1);
        _hpMat.AlbedoColor = HpRed.Lerp(HpGreen, (float)frac);
        _hpBar.Scale = new Vector3((float)Math.Max(frac, 0.001), 1, 1);
    }
}
