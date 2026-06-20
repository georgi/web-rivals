// Client-side rockets/grenades: renders + simulates using the EXISTING shared
// ballistics (StepProjectile/ComputeExplosion). On detonation it resolves
// damage/knockback through hooks. Ported from client/src/combat/local-projectiles.ts.
//
// OFFLINE: full local damage/knockback. ONLINE: a cosmetic predicted copy whose
// damage hooks no-op (server owns damage) but self-knockback (rocket-jump) stays.

using System;
using System.Collections.Generic;
using Godot;
using WebRivals.Shared;
using WebRivals.Shared.Sim;
using WebRivals.Client.Combat;
using static WebRivals.Client.GodotConv;

namespace WebRivals.Client.Render;

public interface IProjectileHooks
{
    int LocalPlayerId { get; }
    List<CapsuleTarget> Targets();
    void OnDamage(int id, double amount);
    void OnImpulse(int id, Vec3 impulse);
    void OnDetonate(Vec3 pos);
}

public sealed class LocalProjectiles
{
    public readonly Node3D Object;

    private const int Pool = 16;
    private const double SmokeSpacing = 0.6;
    private const double DirectHitSlop = 0.25;

    private sealed class Slot
    {
        public Projectile Proj;
        public MeshInstance3D Mesh;
        public bool Active;
        public double SmokeAccum;
        public double LastX, LastY, LastZ;
    }

    private readonly ITraceWorld _world;
    private readonly Particles _particles;
    private readonly IProjectileHooks _hooks;

    private readonly Slot[] _slots = new Slot[Pool];
    private int _nextId = 1;
    private int _head = 0;

    private readonly ProjectileStep _step = new() { Detonated = false, Point = VMath.V3() };
    private readonly List<PlayerCapsule> _players = new();

    private readonly Mesh _rocketMesh;
    private readonly Mesh _grenadeMesh;
    private readonly Material _rocketMat;
    private readonly Material _grenadeMat;

    public LocalProjectiles(ITraceWorld world, Particles particles, IProjectileHooks hooks)
    {
        _world = world;
        _particles = particles;
        _hooks = hooks;
        Object = new Node3D { Name = "Projectiles" };

        _rocketMat = new StandardMaterial3D { AlbedoColor = new Color(1f, 0.812f, 0.416f), ShadingMode = BaseMaterial3D.ShadingModeEnum.Unshaded };
        _grenadeMat = new StandardMaterial3D { AlbedoColor = new Color(0.227f, 0.290f, 0.188f), Roughness = 0.8f, Metallic = 0.1f };
        // Rocket: a short tube laid along +Z (height along Z via rotation).
        _rocketMesh = new CylinderMesh { TopRadius = 0.08f, BottomRadius = 0.08f, Height = 0.5f, RadialSegments = 8 };
        _grenadeMesh = new SphereMesh { Radius = 0.13f, Height = 0.26f, RadialSegments = 8, Rings = 6 };

        for (int i = 0; i < Pool; i++)
        {
            var proj = Projectiles.MakeProjectile(0, ProjKind.Rocket, VMath.V3(), VMath.V3(), 0, 0);
            proj.Alive = false;
            var mesh = new MeshInstance3D { Mesh = _rocketMesh, MaterialOverride = _rocketMat, Visible = false, CastShadow = GeometryInstance3D.ShadowCastingSetting.Off };
            Object.AddChild(mesh);
            _slots[i] = new Slot { Proj = proj, Mesh = mesh, Active = false };
        }
    }

    public void Spawn(string kind, Vec3 origin, Vec3 dir, int ownerId)
        => Spawn(kind == "rocket" ? ProjKind.Rocket : ProjKind.Grenade, origin, dir, ownerId);

    public void Spawn(ProjKind kind, Vec3 origin, Vec3 dir, int ownerId)
    {
        var slot = Acquire();
        double speed = kind == ProjKind.Rocket ? Tuning.Rocket.ProjSpeed : Tuning.Grenade.ProjSpeed;
        double fuse = kind == ProjKind.Grenade ? Tuning.Grenade.Fuse : 0;

        var p = slot.Proj;
        p.Id = _nextId++;
        p.Kind = kind;
        p.Pos.X = origin.X; p.Pos.Y = origin.Y; p.Pos.Z = origin.Z;
        p.Vel.X = dir.X * speed; p.Vel.Y = dir.Y * speed; p.Vel.Z = dir.Z * speed;
        p.OwnerId = ownerId;
        p.Fuse = fuse;
        p.Alive = true;

        slot.Active = true;
        slot.SmokeAccum = 0;
        slot.LastX = origin.X; slot.LastY = origin.Y; slot.LastZ = origin.Z;

        slot.Mesh.Mesh = kind == ProjKind.Rocket ? _rocketMesh : _grenadeMesh;
        slot.Mesh.MaterialOverride = kind == ProjKind.Rocket ? _rocketMat : _grenadeMat;
        slot.Mesh.Position = ToGd(origin);
        if (kind == ProjKind.Rocket)
            OrientToVelocity(slot.Mesh, origin, dir);
        else
            slot.Mesh.Rotation = Vector3.Zero;
        slot.Mesh.Visible = true;
    }

    public void Update(double dt)
    {
        for (int i = 0; i < _slots.Length; i++)
        {
            var slot = _slots[i];
            if (!slot.Active) continue;
            var p = slot.Proj;

            Projectiles.StepProjectile(p, _world, dt, _step);
            slot.Mesh.Position = ToGd(p.Pos);

            if (p.Kind == ProjKind.Rocket)
            {
                double dx = p.Pos.X - slot.LastX, dy = p.Pos.Y - slot.LastY, dz = p.Pos.Z - slot.LastZ;
                slot.SmokeAccum += Math.Sqrt(dx * dx + dy * dy + dz * dz);
                slot.LastX = p.Pos.X; slot.LastY = p.Pos.Y; slot.LastZ = p.Pos.Z;
                if (slot.SmokeAccum >= SmokeSpacing)
                {
                    slot.SmokeAccum = 0;
                    _particles.Smoke(p.Pos);
                }
                OrientToVelocity(slot.Mesh, p.Pos, p.Vel);
            }

            if (_step.Detonated) Detonate(slot);
        }
    }

    private void Detonate(Slot slot)
    {
        var p = slot.Proj;
        _particles.Explosion(p.Pos);
        _hooks.OnDetonate(p.Pos);

        var targets = _hooks.Targets();
        _players.Clear();
        int directHitId = -1;
        for (int i = 0; i < targets.Count; i++)
        {
            var t = targets[i];
            _players.Add(new PlayerCapsule { Id = t.Id, Center = t.Center, Radius = t.Radius, HalfHeight = t.HalfHeight });
            if (p.Kind == ProjKind.Rocket && directHitId == -1 && WithinCapsule(p.Pos, t, DirectHitSlop))
                directHitId = t.Id;
        }

        var hits = Projectiles.ComputeExplosion(p.Kind, p.Pos, p.OwnerId, _players, _world, directHitId);
        for (int i = 0; i < hits.Count; i++)
        {
            var h = hits[i];
            if (h.Damage > 0) _hooks.OnDamage(h.Id, h.Damage);
            _hooks.OnImpulse(h.Id, h.Impulse);
        }

        slot.Active = false;
        slot.Proj.Alive = false;
        slot.Mesh.Visible = false;
    }

    public void Clear()
    {
        foreach (var slot in _slots)
        {
            slot.Active = false;
            slot.Proj.Alive = false;
            slot.Mesh.Visible = false;
        }
    }

    private static bool WithinCapsule(Vec3 point, CapsuleTarget t, double slop)
    {
        double segBottom = t.Center.Y - t.HalfHeight;
        double segTop = t.Center.Y + t.HalfHeight;
        double cy = point.Y < segBottom ? segBottom : (point.Y > segTop ? segTop : point.Y);
        double dx = point.X - t.Center.X;
        double dy = point.Y - cy;
        double dz = point.Z - t.Center.Z;
        double r = t.Radius + slop;
        return dx * dx + dy * dy + dz * dz <= r * r;
    }

    private static void OrientToVelocity(MeshInstance3D mesh, Vec3 pos, Vec3 dir)
    {
        var d = ToGd(dir);
        if (d.LengthSquared() < 1e-6f) return;
        // CylinderMesh axis is +Y; align +Y to travel direction.
        var fwd = d.Normalized();
        var up = Mathf.Abs(fwd.Y) < 0.99f ? Vector3.Up : Vector3.Right;
        var right = up.Cross(fwd).Normalized();
        var newUp = fwd; // cylinder long axis
        var basis = new Basis(right, newUp, right.Cross(newUp).Normalized());
        mesh.GlobalTransform = new Transform3D(basis.Orthonormalized(), mesh.GlobalPosition);
    }

    private Slot Acquire()
    {
        for (int i = 0; i < _slots.Length; i++)
            if (!_slots[i].Active) return _slots[i];
        var slot = _slots[_head];
        _head = (_head + 1) % _slots.Length;
        return slot;
    }
}
