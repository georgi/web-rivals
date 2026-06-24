// The feel layer. Quake-style: gameplay owns the velocity vector at all times;
// the TraceWorld only resolves where a swept capsule stops. Pure function of
// (state, input, world, dt). Ported 1:1 from shared/src/sim/movement.ts.
//
// pos = capsule CENTER. Total capsule height = 2*(capsuleHalf + radius).

using System;
using static WebRivals.Shared.VMath;

namespace WebRivals.Shared.Sim;

public enum MoveStateName { Ground, Air, Slide }

/// <summary>One simulation tick of input. Jump is the buffered jump edge.</summary>
public sealed class InputFrame
{
    public int Buttons;
    public double Yaw;   // radians
    public double Pitch; // radians
    public bool Jump;    // jump requested this tick (already buffered upstream)
}

public sealed class PlayerMoveState
{
    public Vec3 Pos = V3();
    public Vec3 Vel = V3();
    public double Yaw;
    public double Pitch;
    public MoveStateName MoveState;
    public bool Grounded;
    public double CapsuleHalf;
    public bool KnifeOut;
    public double SlideTimer;
    public double CoyoteTimer;
    public Vec3 GroundNormal = V3(0, 1, 0);
    public double Fov;
    public Vec3 PendingImpulse = V3();
}

public sealed class MoveEvents
{
    public bool Jumped;
    public bool SlideStarted;
    public bool SlideEnded;
    public bool Landed;
}

public static class Movement
{
    private static MovementTuning M => Tuning.Movement;

    /// <summary>Standing capsule cylinder half-height derived from TUNING.</summary>
    public static double StandHalf() => M.StandHeight / 2 - M.Radius;
    public static double SlideHalf() => M.SlideHeight / 2 - M.Radius;

    public static MoveEvents NewEvents() => new MoveEvents();

    public static void ClearEvents(MoveEvents e)
    {
        e.Jumped = false; e.SlideStarted = false; e.SlideEnded = false; e.Landed = false;
    }

    public static PlayerMoveState CreateMoveState(Vec3 pos, double yawDeg)
    {
        return new PlayerMoveState
        {
            Pos = Copy(V3(), pos),
            Vel = V3(),
            Yaw = yawDeg * Math.PI / 180,
            Pitch = 0,
            MoveState = MoveStateName.Air,
            Grounded = false,
            CapsuleHalf = StandHalf(),
            KnifeOut = false,
            SlideTimer = 0,
            CoyoteTimer = 0,
            GroundNormal = V3(0, 1, 0),
            Fov = M.FovBase,
            PendingImpulse = V3(),
        };
    }

    /// <summary>Queue an external impulse (explosion knockback / launch).</summary>
    public static void ApplyImpulse(PlayerMoveState s, double ix, double iy, double iz)
    {
        s.PendingImpulse.X += ix;
        s.PendingImpulse.Y += iy;
        s.PendingImpulse.Z += iz;
    }

    public static double HorizontalSpeed(PlayerMoveState s) => HorizontalLength(s.Vel);

    /// <summary>Eye/camera world position = center + (eyeHeight - totalHeight/2).</summary>
    public static Vec3 EyePosition(PlayerMoveState s, Vec3 outV)
    {
        double totalHeight = 2 * (s.CapsuleHalf + M.Radius);
        double eyeH = s.MoveState == MoveStateName.Slide ? M.EyeHeightSlide : M.EyeHeightStand;
        outV.X = s.Pos.X;
        outV.Y = s.Pos.Y - totalHeight / 2 + eyeH;
        outV.Z = s.Pos.Z;
        return outV;
    }

    // ---- module-level scratch (single-threaded; matches TS module scratch) ----
    private static readonly Vec3 _wishdir = V3();
    private static readonly Vec3 _hvelDir = V3();
    private static readonly Vec3 _remaining = V3();
    private static readonly Vec3 _down = V3();
    private static readonly Vec3 _up = V3();
    private static readonly Vec3 _projTmp = V3();
    private static readonly Vec3 _downhill = V3();
    private static readonly Vec3 _stepStartPos = V3();
    private static readonly Vec3 _stepStartVel = V3();
    private static readonly Vec3 _stepNormalPos = V3();
    private static readonly Vec3 _stepNormalVel = V3();
    private static readonly Vec3 _stepUp = V3();
    private static readonly Vec3 _stepFwd = V3();
    private static readonly Vec3 _stepDownV = V3();

    private const double SKIN = 0.01;
    // Max ledge a grounded player auto-steps over (stairs, and the lip where a ramp
    // meets a platform that the swept-box collider can't round) and the distance we
    // snap back down to stay on a walkable surface. Smaller than the shortest real
    // obstacle (the 2 m cover boxes) so nothing else becomes climbable.
    private const double StepHeight = 0.9;

    private static void ApplyFriction(PlayerMoveState s, double friction, double dt)
    {
        double speed = HorizontalLength(s.Vel);
        if (speed < EPSILON) return;
        double drop = speed * friction * dt;
        double newSpeed = speed - drop > 0 ? speed - drop : 0;
        double f = newSpeed / speed;
        s.Vel.X *= f;
        s.Vel.Z *= f;
    }

    private static void Accelerate(PlayerMoveState s, Vec3 wishdir, double wishspeed, double accel, double dt)
    {
        double current = s.Vel.X * wishdir.X + s.Vel.Z * wishdir.Z;
        double addspeed = wishspeed - current;
        if (addspeed <= 0) return;
        double accelSpeed = accel * wishspeed * dt;
        if (accelSpeed > addspeed) accelSpeed = addspeed;
        s.Vel.X += wishdir.X * accelSpeed;
        s.Vel.Z += wishdir.Z * accelSpeed;
    }

    /// <summary>Advance one fixed tick. Mutates s in place; writes one-shot edges into events.</summary>
    public static void StepMovement(PlayerMoveState s, InputFrame input, ITraceWorld world, double dt, MoveEvents events)
    {
        var m = M;

        events.Jumped = false;
        events.SlideStarted = false;
        events.SlideEnded = false;
        events.Landed = false;

        s.Yaw = input.Yaw;
        s.Pitch = input.Pitch;

        // -- 1. Timers --
        if (s.MoveState == MoveStateName.Slide) s.SlideTimer += dt;
        s.CoyoteTimer -= dt;

        int b = input.Buttons;
        int fwd = (b & Button.Forward) != 0 ? 1 : 0;
        int back = (b & Button.Back) != 0 ? 1 : 0;
        int left = (b & Button.Left) != 0 ? 1 : 0;
        int right = (b & Button.Right) != 0 ? 1 : 0;
        bool sprint = (b & Button.Sprint) != 0;
        bool slideHeld = (b & Button.Crouch) != 0;

        double sinY = Math.Sin(s.Yaw);
        double cosY = Math.Cos(s.Yaw);
        int moveF = fwd - back;
        int moveR = right - left;
        double wx = -sinY * moveF + cosY * moveR;
        double wz = -cosY * moveF - sinY * moveR;
        Set(_wishdir, wx, 0, wz);
        double wishLen = Normalize(_wishdir, _wishdir);

        // -- 2. Transitions --
        double hspeedNow = HorizontalLength(s.Vel);

        if (s.MoveState != MoveStateName.Slide && s.Grounded && slideHeld && hspeedNow >= m.WalkSpeed - EPSILON)
        {
            double delta = StandHalf() - SlideHalf();
            s.MoveState = MoveStateName.Slide;
            s.SlideTimer = 0;
            s.CapsuleHalf = SlideHalf();
            s.Pos.Y -= delta;
            Set(_hvelDir, s.Vel.X, 0, s.Vel.Z);
            double hlen = Normalize(_hvelDir, _hvelDir);
            if (hlen > EPSILON)
            {
                s.Vel.X += _hvelDir.X * m.SlideBoost;
                s.Vel.Z += _hvelDir.Z * m.SlideBoost;
            }
            events.SlideStarted = true;
        }
        else if (s.MoveState == MoveStateName.Slide)
        {
            if (!slideHeld || hspeedNow < m.SlideMinSpeed)
            {
                double delta = StandHalf() - SlideHalf();
                Set(_up, 0, delta + SKIN, 0);
                var headHit = world.CastCapsule(s.Pos, s.CapsuleHalf, m.Radius, _up);
                if (headHit == null)
                {
                    s.CapsuleHalf = StandHalf();
                    s.Pos.Y += delta;
                    s.MoveState = s.Grounded ? MoveStateName.Ground : MoveStateName.Air;
                    events.SlideEnded = true;
                }
            }
        }

        // -- 3. Friction --
        if (s.MoveState == MoveStateName.Slide)
            ApplyFriction(s, m.SlideFriction, dt);
        else if (s.Grounded)
            ApplyFriction(s, m.GroundFriction, dt);

        // -- 4. Accelerate --
        if (wishLen > EPSILON)
        {
            double speedMul = s.KnifeOut ? 1 + m.KnifeSpeedBonus : 1;
            if (s.MoveState == MoveStateName.Slide)
            {
                double wishspeed = (sprint ? m.SprintSpeed : m.WalkSpeed) * speedMul;
                Accelerate(s, _wishdir, wishspeed, m.GroundAccel * m.AirControlFactor, dt);
            }
            else if (s.Grounded)
            {
                double wishspeed = (sprint ? m.SprintSpeed : m.WalkSpeed) * speedMul;
                Accelerate(s, _wishdir, wishspeed, m.GroundAccel, dt);
            }
            else
            {
                double wishspeed = Math.Min((sprint ? m.SprintSpeed : m.WalkSpeed) * speedMul, m.AirWishSpeedCap);
                Accelerate(s, _wishdir, wishspeed, m.GroundAccel * m.AirControlFactor, dt);
            }
        }

        // Slide-down-ramp accel.
        if (s.MoveState == MoveStateName.Slide && s.Grounded)
        {
            double slope = 1 - s.GroundNormal.Y;
            if (slope > EPSILON)
            {
                Set(_projTmp, 0, -1, 0);
                ProjectOntoPlane(_downhill, _projTmp, s.GroundNormal);
                _downhill.Y = 0;
                double dl = Normalize(_downhill, _downhill);
                if (dl > EPSILON)
                {
                    double a = m.SlideRampAccel * slope * dt;
                    s.Vel.X += _downhill.X * a;
                    s.Vel.Z += _downhill.Z * a;
                }
            }
        }

        // -- 5. Gravity --
        if (!s.Grounded) s.Vel.Y -= m.Gravity * dt;

        // -- 6. Jump + impulses --
        if (input.Jump && (s.Grounded || s.CoyoteTimer > 0))
        {
            bool slideJump = s.MoveState == MoveStateName.Slide && s.SlideTimer <= m.SlideJumpWindow;
            s.Vel.Y = m.JumpImpulse;
            if (slideJump)
            {
                double delta = StandHalf() - SlideHalf();
                Set(_up, 0, delta + SKIN, 0);
                var headHit = world.CastCapsule(s.Pos, s.CapsuleHalf, m.Radius, _up);
                if (headHit == null)
                {
                    s.CapsuleHalf = StandHalf();
                    s.Pos.Y += delta;
                }
                events.SlideEnded = true;
            }
            s.MoveState = MoveStateName.Air;
            s.Grounded = false;
            s.CoyoteTimer = 0;
            events.Jumped = true;
        }

        if (s.PendingImpulse.X != 0 || s.PendingImpulse.Y != 0 || s.PendingImpulse.Z != 0)
        {
            s.Vel.X += s.PendingImpulse.X;
            s.Vel.Y += s.PendingImpulse.Y;
            s.Vel.Z += s.PendingImpulse.Z;
            Set(s.PendingImpulse, 0, 0, 0);
            if (s.Vel.Y > EPSILON)
            {
                s.Grounded = false;
                s.MoveState = MoveStateName.Air;
            }
        }

        // -- 7. Collide-and-slide move (with stair/ledge step-up) --
        bool groundedBeforeMove = s.Grounded;
        Copy(_stepStartPos, s.Pos);
        Copy(_stepStartVel, s.Vel);
        Scale(_remaining, s.Vel, dt);
        bool hitWall = CollideSlide(s, world, m, _remaining);

        // If a wall stopped us while on the ground, retry the move lifted by
        // StepHeight so we can climb small ledges and crest the top of a ramp onto a
        // platform — the swept-box collider can't round a convex top edge the way a
        // real capsule would. Keep the stepped result only when it advances farther
        // horizontally AND settles back onto walkable ground.
        if (hitWall && groundedBeforeMove && s.MoveState != MoveStateName.Slide)
        {
            Copy(_stepNormalPos, s.Pos);
            Copy(_stepNormalVel, s.Vel);
            Copy(s.Pos, _stepStartPos);
            Copy(s.Vel, _stepStartVel);
            double stepped = TryStepMove(s, world, m, dt);
            if (stepped < 0 || stepped <= HorizDistSq(_stepStartPos, _stepNormalPos) + EPSILON)
            {
                Copy(s.Pos, _stepNormalPos); // stepping gained nothing — keep the plain move
                Copy(s.Vel, _stepNormalVel);
            }
            else if (s.Vel.Y > 0)
            {
                s.Vel.Y = 0; // stepped up onto the ledge; shed leftover up-ramp velocity
            }
        }

        // -- 8. Ground check --
        double probe = 0.05;
        Set(_down, 0, -(probe + SKIN), 0);
        var groundHit = world.CastCapsule(s.Pos, s.CapsuleHalf, m.Radius, _down);
        bool wasGrounded = s.Grounded;
        bool nowGrounded = groundHit != null && groundHit.Normal.Y > m.GroundNormalY;

        // Stay-on-ground: if we were grounded and the move left us just barely off a
        // walkable surface, snap back down onto it. The swept-box ramp surface is a
        // knife edge, so a high-speed climb would otherwise drift off and fling us
        // into the air (the up-slope velocity becomes a launch). Bounded by
        // StepHeight, so genuine ledges/drops still let us fall.
        if (!nowGrounded && wasGrounded && !events.Jumped && s.MoveState != MoveStateName.Slide)
        {
            Set(_down, 0, -(StepHeight + SKIN), 0);
            var snap = world.CastCapsule(s.Pos, s.CapsuleHalf, m.Radius, _down);
            if (snap != null && snap.Normal.Y > m.GroundNormalY)
            {
                double d = snap.Fraction * (StepHeight + SKIN) - SKIN;
                if (d > 0) s.Pos.Y -= d;
                groundHit = snap;
                nowGrounded = true;
                if (s.Vel.Y > 0) s.Vel.Y = 0; // shed up-ramp velocity so we don't relaunch
            }
        }

        if (nowGrounded)
        {
            Copy(s.GroundNormal, groundHit.Normal);
            if (!wasGrounded) events.Landed = true;
            s.Grounded = true;
            s.CoyoteTimer = m.CoyoteTime;
            if (!events.Jumped && s.Vel.Y < 0 && s.Vel.Y > -1) s.Vel.Y = 0;
        }
        else
        {
            if (wasGrounded && !events.Jumped) s.CoyoteTimer = m.CoyoteTime;
            s.Grounded = false;
        }

        // -- 9. Post: state name + FOV --
        if (s.MoveState != MoveStateName.Slide)
        {
            s.MoveState = s.Grounded ? MoveStateName.Ground : MoveStateName.Air;
        }

        double speed = HorizontalLength(s.Vel);
        double t = Clamp((speed - m.FovSpeedThreshold) / (m.FovSpeedMax - m.FovSpeedThreshold), 0, 1);
        double fovTarget = m.FovBase + m.FovSprintBonus * t;
        s.Fov = Damp(s.Fov, fovTarget, m.FovLerpRate, dt);
    }

    /// <summary>Swept collide-and-slide of the capsule through `remaining` (mutated).
    /// Mutates s.Pos/s.Vel. Returns true if it hit a steep (non-walkable) surface —
    /// the cue for the caller to attempt a step-up.</summary>
    private static bool CollideSlide(PlayerMoveState s, MovementTuning m, ITraceWorld world, Vec3 remaining)
    {
        bool hitWall = false;
        for (int iter = 0; iter < 5; iter++)
        {
            double rlen = Math.Sqrt(remaining.X * remaining.X + remaining.Y * remaining.Y + remaining.Z * remaining.Z);
            if (rlen < EPSILON) break;
            var hit = world.CastCapsule(s.Pos, s.CapsuleHalf, m.Radius, remaining);
            if (hit == null)
            {
                s.Pos.X += remaining.X;
                s.Pos.Y += remaining.Y;
                s.Pos.Z += remaining.Z;
                break;
            }
            if (hit.Normal.Y <= m.GroundNormalY) hitWall = true;
            double backoff = rlen > EPSILON ? SKIN / rlen : 0;
            if (hit.Fraction <= backoff)
            {
                s.Pos.X += hit.Normal.X * SKIN;
                s.Pos.Y += hit.Normal.Y * SKIN;
                s.Pos.Z += hit.Normal.Z * SKIN;
                ProjectOntoPlane(remaining, remaining, hit.Normal);
                ProjectOntoPlane(s.Vel, s.Vel, hit.Normal);
                continue;
            }
            double moveFrac = hit.Fraction - backoff;
            s.Pos.X += remaining.X * moveFrac;
            s.Pos.Y += remaining.Y * moveFrac;
            s.Pos.Z += remaining.Z * moveFrac;
            ProjectOntoPlane(remaining, remaining, hit.Normal);
            Scale(remaining, remaining, 1 - moveFrac);
            ProjectOntoPlane(s.Vel, s.Vel, hit.Normal);
        }
        return hitWall;
    }

    // Convenience overload taking the args in the existing call order.
    private static bool CollideSlide(PlayerMoveState s, ITraceWorld world, MovementTuning m, Vec3 remaining)
        => CollideSlide(s, m, world, remaining);

    /// <summary>Stair-step maneuver: lift by StepHeight, redo the horizontal move,
    /// drop back onto the ledge. Mutates s.Pos/s.Vel. Returns the squared horizontal
    /// distance advanced from the entry position, or -1 if the step is invalid (no
    /// headroom, or it doesn't settle on walkable ground).</summary>
    private static double TryStepMove(PlayerMoveState s, ITraceWorld world, MovementTuning m, double dt)
    {
        double sx = s.Pos.X, sz = s.Pos.Z;

        // 1. Up by StepHeight (clamped by any ceiling).
        Set(_stepUp, 0, StepHeight, 0);
        var up = world.CastCapsule(s.Pos, s.CapsuleHalf, m.Radius, _stepUp);
        double rise = (up == null ? StepHeight : up.Fraction * StepHeight) - SKIN;
        if (rise < SKIN) return -1;
        s.Pos.Y += rise;

        // 2. Horizontal move at the raised height.
        Set(_stepFwd, s.Vel.X * dt, 0, s.Vel.Z * dt);
        CollideSlide(s, m, world, _stepFwd);

        // 3. Settle back down onto the ledge (no farther than we rose).
        Set(_stepDownV, 0, -(rise + SKIN), 0);
        var down = world.CastCapsule(s.Pos, s.CapsuleHalf, m.Radius, _stepDownV);
        if (down == null || down.Normal.Y <= m.GroundNormalY) return -1; // stepped into air / onto a wall
        double drop = down.Fraction * (rise + SKIN) - SKIN;
        if (drop > 0) s.Pos.Y -= drop;

        double dx = s.Pos.X - sx, dz = s.Pos.Z - sz;
        return dx * dx + dz * dz;
    }

    private static double HorizDistSq(Vec3 a, Vec3 b)
    {
        double dx = a.X - b.X, dz = a.Z - b.Z;
        return dx * dx + dz * dz;
    }
}
