// Server-authoritative projectile sim + explosion resolution. Swept-sphere
// stepping makes tunneling impossible regardless of speed. Pure. Ported from
// shared/src/sim/projectiles.ts.

using System;
using System.Collections.Generic;
using static WebRivals.Shared.VMath;

namespace WebRivals.Shared.Sim;

public enum ProjKind { Rocket, Grenade }

public sealed class Projectile
{
    public int Id;
    public ProjKind Kind;
    public Vec3 Pos = V3();
    public Vec3 Vel = V3();
    public int OwnerId;
    public double Fuse;   // seconds remaining (grenade); rockets detonate on contact
    public bool Alive;
}

/// <summary>Analytic player hitbox for explosion overlap.</summary>
public sealed class PlayerCapsule
{
    public int Id;
    public Vec3 Center;
    public double Radius;
    public double HalfHeight;
}

public sealed class ExplosionHit
{
    public int Id;
    public int Damage;
    public Vec3 Impulse;
}

public sealed class ProjectileStep
{
    public bool Detonated;
    public Vec3 Point = V3();
}

public sealed class PlayerHitResult
{
    public int Id;
    public Vec3 Point;
}

public static class Projectiles
{
    private const double PROJ_RADIUS = 0.15;

    private static readonly Vec3 _delta = V3();
    private static readonly Vec3 _toPlayer = V3();
    private static readonly Vec3 _dir = V3();

    public static Projectile MakeProjectile(int id, ProjKind kind, Vec3 pos, Vec3 vel, int ownerId, double fuse)
    {
        return new Projectile
        {
            Id = id,
            Kind = kind,
            Pos = Copy(V3(), pos),
            Vel = Copy(V3(), vel),
            OwnerId = ownerId,
            Fuse = fuse,
            Alive = true,
        };
    }

    /// <summary>Advance one projectile by dt. Rockets detonate on first static
    /// contact; grenades bounce off geometry and detonate when fuse expires.</summary>
    public static ProjectileStep StepProjectile(Projectile p, ITraceWorld world, double dt, ProjectileStep outStep)
    {
        outStep.Detonated = false;

        if (p.Kind == ProjKind.Rocket)
        {
            p.Vel.Y -= Tuning.Rocket.ProjGravity * dt;

            Scale(_delta, p.Vel, dt);
            var hit = world.CastSphere(p.Pos, PROJ_RADIUS, _delta);
            if (hit != null)
            {
                Copy(outStep.Point, hit.Point);
                Copy(p.Pos, hit.Point);
                outStep.Detonated = true;
                p.Alive = false;
                return outStep;
            }

            AddScaled(p.Pos, p.Pos, p.Vel, dt);
            Copy(outStep.Point, p.Pos);
            return outStep;
        }

        // Grenade
        p.Vel.Y -= Tuning.Grenade.ProjGravity * dt;

        Scale(_delta, p.Vel, dt);
        var ghit = world.CastSphere(p.Pos, PROJ_RADIUS, _delta);
        if (ghit != null)
        {
            Copy(p.Pos, ghit.Point);
            Reflect(p.Vel, p.Vel, ghit.Normal);
            Scale(p.Vel, p.Vel, Tuning.Grenade.Restitution);
            if (HorizontalLength(p.Vel) < 0.5)
            {
                p.Vel.X = 0;
                p.Vel.Z = 0;
            }
        }
        else
        {
            AddScaled(p.Pos, p.Pos, p.Vel, dt);
        }

        p.Fuse -= dt;
        if (p.Fuse <= 0)
        {
            Copy(outStep.Point, p.Pos);
            outStep.Detonated = true;
            p.Alive = false;
            return outStep;
        }

        Copy(outStep.Point, p.Pos);
        return outStep;
    }

    /// <summary>Direct projectile-vs-player contact for the swept segment.
    /// Returns the NEAREST non-owner player whose capsule the swept sphere
    /// crosses, plus the contact point, or null.</summary>
    public static PlayerHitResult ProjectilePlayerHit(Vec3 start, Vec3 end, List<PlayerCapsule> players, int ownerId)
    {
        double dx = end.X - start.X;
        double dy = end.Y - start.Y;
        double dz = end.Z - start.Z;
        double segLen = Math.Sqrt(dx * dx + dy * dy + dz * dz);
        if (segLen < EPSILON) return null;
        Set(_dir, dx / segLen, dy / segLen, dz / segLen);

        double bestT = double.PositiveInfinity;
        int bestId = -1;
        bool found = false;
        foreach (var pl in players)
        {
            if (pl.Id == ownerId) continue;
            Set(_toPlayer, pl.Center.X, pl.Center.Y - pl.HalfHeight, pl.Center.Z);
            double? t = RayCapsule(start, _dir, _toPlayer, pl.HalfHeight * 2, pl.Radius + PROJ_RADIUS, segLen);
            if (t != null && t.Value < bestT)
            {
                bestT = t.Value;
                bestId = pl.Id;
                found = true;
            }
        }
        if (!found) return null;
        return new PlayerHitResult
        {
            Id = bestId,
            Point = new Vec3(start.X + _dir.X * bestT, start.Y + _dir.Y * bestT, start.Z + _dir.Z * bestT),
        };
    }

    /// <summary>Resolve an explosion: damage falloff (linear) + knockback impulse.
    /// Owner takes selfDamageScale damage but full selfKnockbackScale knockback.
    /// Damage requires line-of-sight; knockback applies regardless.</summary>
    public static List<ExplosionHit> ComputeExplosion(
        ProjKind kind, Vec3 center, int ownerId, List<PlayerCapsule> players, ITraceWorld world, int directHitId = -1)
    {
        double splashMax, splashMin, radius, knockback, selfDamageScale, selfKnockbackScale;
        if (kind == ProjKind.Rocket)
        {
            splashMax = Tuning.Rocket.SplashDamageMax;
            splashMin = Tuning.Rocket.SplashDamageMin;
            radius = Tuning.Rocket.SplashRadius;
            knockback = Tuning.Rocket.Knockback;
            selfDamageScale = Tuning.Rocket.SelfDamageScale;
            selfKnockbackScale = Tuning.Rocket.SelfKnockbackScale;
        }
        else
        {
            splashMax = Tuning.Grenade.SplashDamageMax;
            splashMin = Tuning.Grenade.SplashDamageMin;
            radius = Tuning.Grenade.SplashRadius;
            knockback = Tuning.Grenade.Knockback;
            selfDamageScale = Tuning.Grenade.SelfDamageScale;
            selfKnockbackScale = Tuning.Grenade.SelfKnockbackScale;
        }

        var outHits = new List<ExplosionHit>();

        foreach (var player in players)
        {
            double segBottom = player.Center.Y - player.HalfHeight;
            double segTop = player.Center.Y + player.HalfHeight;
            double nearestY = center.Y < segBottom ? segBottom : (center.Y > segTop ? segTop : center.Y);
            Set(_toPlayer, player.Center.X - center.X, nearestY - center.Y, player.Center.Z - center.Z);
            double dist = Math.Sqrt(_toPlayer.X * _toPlayer.X + _toPlayer.Y * _toPlayer.Y + _toPlayer.Z * _toPlayer.Z);
            if (dist > radius) continue;

            double t = Clamp(dist / radius, 0, 1);
            double damage = LerpScalar(splashMax, splashMin, t);
            if (kind == ProjKind.Rocket && directHitId != -1 && player.Id == directHitId)
                damage += Tuning.Rocket.DirectDamage;

            double len = Normalize(_dir, _toPlayer);
            if (len < EPSILON) Set(_dir, 0, 1, 0);

            bool blocked = len >= EPSILON && world.Raycast(center, _dir, dist) != null;
            if (blocked) damage = 0;

            double impulseMag = knockback * (1 - t);

            if (player.Id == ownerId)
            {
                damage *= selfDamageScale;
                impulseMag *= selfKnockbackScale;
            }

            int rounded = (int)Math.Floor(damage + 0.5); // JS Math.round semantics
            if (rounded <= 0 && impulseMag < EPSILON) continue;

            var impulse = V3();
            Scale(impulse, _dir, impulseMag);
            outHits.Add(new ExplosionHit { Id = player.Id, Damage = rounded, Impulse = impulse });
        }

        return outHits;
    }
}
