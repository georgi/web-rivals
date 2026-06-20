// THE single source of truth for tunable gameplay values. Ported from
// shared/src/tuning.ts. Mutable on purpose (the F3 debug panel binds to it).

namespace WebRivals.Shared;

public sealed class MovementTuning
{
    public double WalkSpeed;
    public double SprintSpeed;
    public double CrouchSpeed;
    public double KnifeSpeedBonus;

    public double GroundAccel;
    public double GroundFriction;
    public double AirControlFactor;
    public double AirWishSpeedCap;

    public double SlideBoost;
    public double SlideFriction;
    public double SlideMinSpeed;
    public double SlideJumpWindow;
    public double SlideRampAccel;

    public double JumpImpulse;
    public double Gravity;
    public double CoyoteTime;
    public double InputBufferTime;

    public double Radius;
    public double StandHeight;
    public double SlideHeight;
    public double EyeHeightStand;
    public double EyeHeightSlide;

    public double GroundNormalY;

    public double FovBase;
    public double FovSprintBonus;
    public double FovSpeedThreshold;
    public double FovSpeedMax;
    public double FovLerpRate;
}

public sealed class HitscanTuning
{
    public int Slot;
    public string Name;
    public double Damage;
    public double FireInterval;
    public int MagSize;
    public int ReserveAmmo;
    public double ReloadTime;
    public double BloomMin;
    public double BloomMax;
    public double BloomPerShot;
    public double BloomRecover;
    public double TracerFade;
    public double Range;
}

public sealed class RocketTuning
{
    public int Slot;
    public string Name;
    public double ProjSpeed;
    public double ProjGravity;
    public double DirectDamage;
    public double SplashDamageMin;
    public double SplashDamageMax;
    public double SplashRadius;
    public double Knockback;
    public double FireInterval;
    public int MagSize;
    public int ReserveAmmo;
    public double ReloadTime;
    public double SelfDamageScale;
    public double SelfKnockbackScale;
}

public sealed class KnifeTuning
{
    public int Slot;
    public string Name;
    public double Damage;
    public double BackstabDamage;
    public double BackstabDotThreshold;
    public double Range;
    public double HitboxHalfWidth;
    public double SwingTime;
    public double SpeedBonus;
}

public sealed class GrenadeTuning
{
    public int Slot;
    public string Name;
    public double ProjSpeed;
    public double ProjGravity;
    public double Restitution;
    public double Fuse;
    public double SplashDamageMin;
    public double SplashDamageMax;
    public double SplashRadius;
    public double Knockback;
    public int Count;
    public double RegenTime;
    public double SelfDamageScale;
    public double SelfKnockbackScale;
}

public sealed class CombatTuning
{
    public double SwitchTime;
    public double SpawnHealth;
}

public sealed class WorldTuning
{
    public int SimHz;
    public int ServerHz;
    public int SnapshotHz;
    public int InputHz;
    public double MaxCatchupMs;
    public double InterpDelayMs;
    public int MaxPlayers;
    public int FragLimit;
    public double RespawnDelaySec;
    public double MatchTimeCapSec;
    public int WarmupMinPlayers;
    public double MatchEndSec;
}

public static class Tuning
{
    public static readonly MovementTuning Movement = new()
    {
        WalkSpeed = 6,
        SprintSpeed = 9,
        CrouchSpeed = 3,
        KnifeSpeedBonus = 0.15,

        GroundAccel = 90,
        GroundFriction = 10,
        AirControlFactor = 0.3,
        AirWishSpeedCap = 1.2,

        SlideBoost = 12,
        SlideFriction = 4,
        SlideMinSpeed = 4,
        SlideJumpWindow = 0.4,
        SlideRampAccel = 18,

        JumpImpulse = 5,
        Gravity = 20,
        CoyoteTime = 0.08,
        InputBufferTime = 0.1,

        Radius = 0.4,
        StandHeight = 1.8,
        SlideHeight = 0.9,
        EyeHeightStand = 1.6,
        EyeHeightSlide = 0.7,

        GroundNormalY = 0.7,

        FovBase = 90,
        FovSprintBonus = 8,
        FovSpeedThreshold = 9,
        FovSpeedMax = 16,
        FovLerpRate = 8,
    };

    public static readonly HitscanTuning Ar = new()
    {
        Slot = 1,
        Name = "Assault Rifle",
        Damage = 15,
        FireInterval = 0.1,
        MagSize = 30,
        ReserveAmmo = 240,
        ReloadTime = 1.5,
        BloomMin = 0.004,
        BloomMax = 0.05,
        BloomPerShot = 0.006,
        BloomRecover = 0.08,
        TracerFade = 0.1,
        Range = 200,
    };

    public static readonly RocketTuning Rocket = new()
    {
        Slot = 2,
        Name = "Rocket Launcher",
        ProjSpeed = 25,
        ProjGravity = 2,
        DirectDamage = 60,
        SplashDamageMin = 10,
        SplashDamageMax = 40,
        SplashRadius = 3,
        Knockback = 14,
        FireInterval = 1.2,
        MagSize = 4,
        ReserveAmmo = 12,
        ReloadTime = 2.5,
        SelfDamageScale = 0.25,
        SelfKnockbackScale = 1.0,
    };

    public static readonly KnifeTuning Knife = new()
    {
        Slot = 3,
        Name = "Knife",
        Damage = 35,
        BackstabDamage = 90,
        BackstabDotThreshold = 0.3,
        Range = 2,
        HitboxHalfWidth = 0.6,
        SwingTime = 0.5,
        SpeedBonus = 0.15,
    };

    public static readonly GrenadeTuning Grenade = new()
    {
        Slot = 4,
        Name = "Frag Grenade",
        ProjSpeed = 14,
        ProjGravity = 20,
        Restitution = 0.4,
        Fuse = 3,
        SplashDamageMin = 10,
        SplashDamageMax = 50,
        SplashRadius = 3.5,
        Knockback = 18,
        Count = 1,
        RegenTime = 8,
        SelfDamageScale = 0.25,
        SelfKnockbackScale = 1.0,
    };

    public static readonly CombatTuning Combat = new()
    {
        SwitchTime = 0.3,
        SpawnHealth = 100,
    };

    public static readonly WorldTuning World = new()
    {
        SimHz = 60,
        ServerHz = 30,
        SnapshotHz = 20,
        InputHz = 30,
        MaxCatchupMs = 250,
        InterpDelayMs = 100,
        MaxPlayers = 6,
        FragLimit = 15,
        RespawnDelaySec = 1.5,
        MatchTimeCapSec = 600,
        WarmupMinPlayers = 2,
        MatchEndSec = 5,
    };

    public static double SimDt => 1.0 / World.SimHz;
}
