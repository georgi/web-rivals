// Server-side movement sanity check. Movement is CLIENT-authoritative: the client
// simulates its own player and reports pos+vel each tick. The server validates
// plausibility and snaps offenders back via a Correction. Ported from
// server/src/validate.ts. Talks to the world only through ITraceWorld.

using System;
using System.Collections.Generic;
using WebRivals.Shared;
using WebRivals.Shared.Sim;
using static WebRivals.Shared.VMath;

namespace WebRivals.Server;

public struct MoveReport
{
    public Vec3 Pos;
    public Vec3 Vel;
    public double Yaw;
    public double Pitch;
}

public struct ValidationResult
{
    public bool Ok;
    public Vec3 CorrectedPos;
    public Vec3 CorrectedVel;
}

public sealed class MovementValidator
{
    private sealed class PlayerRecord
    {
        public Vec3 Pos;
        public Vec3 Vel;
        public double LastImpulseTime;
    }

    private static readonly double MAX_SPEED = Tuning.Movement.SprintSpeed + Tuning.Movement.SlideBoost;
    private const double DISPLACEMENT_SLACK = 1.5;
    private const double IMPULSE_WINDOW_SEC = 0.6;
    private const double IMPULSE_ALLOWANCE_MULT = 4;
    private const double PENETRATION_SKIN = 0.06;

    private readonly ITraceWorld _world;
    private readonly Dictionary<int, PlayerRecord> _records = new();

    public MovementValidator(ITraceWorld world) { _world = world; }

    private static Vec3 CloneVec(Vec3 v) => new Vec3(v.X, v.Y, v.Z);

    public void Reset(int playerId, Vec3 pos)
    {
        _records[playerId] = new PlayerRecord
        {
            Pos = CloneVec(pos),
            Vel = new Vec3(0, 0, 0),
            LastImpulseTime = double.NegativeInfinity,
        };
    }

    public void NoteImpulse(int playerId, double now)
    {
        if (_records.TryGetValue(playerId, out var rec)) rec.LastImpulseTime = now;
        else _records[playerId] = new PlayerRecord { Pos = new Vec3(), Vel = new Vec3(), LastImpulseTime = now };
    }

    public ValidationResult Accept(int playerId, MoveReport report, double dtSec, double now)
    {
        if (!_records.TryGetValue(playerId, out var rec))
        {
            rec = new PlayerRecord { Pos = CloneVec(report.Pos), Vel = CloneVec(report.Vel), LastImpulseTime = double.NegativeInfinity };
            _records[playerId] = rec;
            return new ValidationResult { Ok = true, CorrectedPos = CloneVec(report.Pos), CorrectedVel = CloneVec(report.Vel) };
        }

        bool launching = now - rec.LastImpulseTime <= IMPULSE_WINDOW_SEC;

        double dx = report.Pos.X - rec.Pos.X;
        double dz = report.Pos.Z - rec.Pos.Z;
        double horizDist = Math.Sqrt(dx * dx + dz * dz);
        double horizBudget = MAX_SPEED * Math.Max(dtSec, 0) * DISPLACEMENT_SLACK;
        if (launching) horizBudget *= IMPULSE_ALLOWANCE_MULT;

        if (horizDist > horizBudget) return Reject(rec);
        if (PenetratesStatic(report.Pos)) return Reject(rec);

        rec.Pos.X = report.Pos.X; rec.Pos.Y = report.Pos.Y; rec.Pos.Z = report.Pos.Z;
        rec.Vel.X = report.Vel.X; rec.Vel.Y = report.Vel.Y; rec.Vel.Z = report.Vel.Z;
        return new ValidationResult { Ok = true, CorrectedPos = CloneVec(report.Pos), CorrectedVel = CloneVec(report.Vel) };
    }

    private static ValidationResult Reject(PlayerRecord rec)
        => new ValidationResult { Ok = false, CorrectedPos = CloneVec(rec.Pos), CorrectedVel = new Vec3(0, 0, 0) };

    private bool PenetratesStatic(Vec3 pos)
    {
        var m = Tuning.Movement;
        double halfHeight = (m.StandHeight - 2 * m.Radius) / 2;
        var from = new Vec3(pos.X, pos.Y + PENETRATION_SKIN, pos.Z);
        var delta = new Vec3(0, -2 * PENETRATION_SKIN, 0);
        var hit = _world.CastCapsule(from, halfHeight, m.Radius, delta);
        return hit != null && hit.Fraction <= 0;
    }
}
