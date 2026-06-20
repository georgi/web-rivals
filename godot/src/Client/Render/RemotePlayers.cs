// The networked opponents (FFA). Render-only: colored humanoids driven by
// interpolated SnapshotBuffer poses (NEVER simulated locally). Ported from
// client/src/entities/remote-player.ts + remote-players.ts.

using System;
using System.Collections.Generic;
using Godot;
using WebRivals.Shared;
using WebRivals.Client.Combat;
using static WebRivals.Client.GodotConv;

namespace WebRivals.Client.Render;

public sealed class RemotePlayer
{
    public readonly Node3D Object;
    public int Id = -1;

    private const float Radius = 0.4f;
    private const float Half = 0.5f; // standHeight/2 - radius
    private static readonly Color OppColor = new(1f, 0.353f, 0.353f);

    private readonly Humanoid _body;
    private readonly MeshInstance3D _hpBar;
    private readonly StandardMaterial3D _hpMat;
    private double _lastHpFrac = -1;

    private Vector3 _prev;
    private bool _prevValid = false;

    private static readonly Color HpGreen = new(0.275f, 0.827f, 0.353f);
    private static readonly Color HpRed = new(1f, 0.251f, 0.251f);

    public RemotePlayer()
    {
        Object = new Node3D { Name = "RemoteOpponent", Visible = false };

        var mat = new StandardMaterial3D
        {
            AlbedoColor = OppColor,
            Roughness = 0.85f,
            Metallic = 0.0f,
        };
        _body = new Humanoid(mat);
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
            Position = new Vector3(0, Half + Radius + 0.35f, 0),
            CastShadow = GeometryInstance3D.ShadowCastingSetting.Off,
        };
        Object.AddChild(_hpBar);
    }

    public void Update(double dt)
    {
        double speed = 0;
        bool grounded = true;
        if (_prevValid && dt > 0)
        {
            float hdx = Object.Position.X - _prev.X;
            float hdz = Object.Position.Z - _prev.Z;
            speed = Math.Sqrt(hdx * hdx + hdz * hdz) / dt;
            double vSpeed = Math.Abs(Object.Position.Y - _prev.Y) / dt;
            grounded = vSpeed < 1.5;
        }
        _prev = Object.Position;
        _prevValid = Object.Visible;
        _body.Update(dt, speed, grounded);
    }

    public void Show(int id) { Id = id; Object.Visible = true; }
    public void Hide() { Object.Visible = false; Id = -1; _prevValid = false; }
    public bool Present => Object.Visible;

    public void SetPose(double cx, double cy, double cz, double yaw)
    {
        Object.Position = ToGd(cx, cy, cz);
        Object.Rotation = new Vector3(0, (float)yaw, 0);
    }

    public void SetHp(double hp)
    {
        double frac = Math.Max(0, Math.Min(1, hp / Tuning.Combat.SpawnHealth));
        if (frac == _lastHpFrac) return;
        _lastHpFrac = frac;
        _hpMat.AlbedoColor = HpRed.Lerp(HpGreen, (float)frac);
        _hpBar.Scale = new Vector3((float)Math.Max(frac, 0.001), 1, 1);
    }
}

public sealed class RemotePlayers
{
    public readonly Node3D Object;
    private readonly Dictionary<int, RemotePlayer> _entries = new();

    private const float Radius = 0.4f;
    private const float Half = 0.5f;

    public RemotePlayers()
    {
        Object = new Node3D { Name = "RemotePlayers" };
    }

    public void SetPresent(int id, string name)
    {
        if (!_entries.TryGetValue(id, out var e))
        {
            e = new RemotePlayer();
            _entries[id] = e;
            Object.AddChild(e.Object);
        }
        e.Show(id);
    }

    public void SetAbsent(int id)
    {
        if (_entries.TryGetValue(id, out var e)) e.Hide();
    }

    public List<int> ActiveIds()
    {
        var ids = new List<int>();
        foreach (var kv in _entries) if (kv.Value.Present) ids.Add(kv.Key);
        return ids;
    }

    public void SetPose(int id, double cx, double cy, double cz, double yaw)
    {
        if (_entries.TryGetValue(id, out var e)) e.SetPose(cx, cy, cz, yaw);
    }

    public void SetHp(int id, double hp)
    {
        if (_entries.TryGetValue(id, out var e)) e.SetHp(hp);
    }

    public void Update(double dt)
    {
        foreach (var e in _entries.Values) if (e.Present) e.Update(dt);
    }

    public List<CapsuleTarget> LiveTargets()
    {
        var outT = new List<CapsuleTarget>();
        foreach (var kv in _entries)
        {
            if (!kv.Value.Present) continue;
            var p = kv.Value.Object.Position;
            outT.Add(new CapsuleTarget { Id = kv.Key, Center = ToVec(p), Radius = Radius, HalfHeight = Half });
        }
        return outT;
    }

    public void HideAll()
    {
        foreach (var e in _entries.Values) e.Hide();
    }
}
