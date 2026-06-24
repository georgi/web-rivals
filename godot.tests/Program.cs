// Zero-dependency parity test harness for the ported pure simulation. Mirrors the
// vitest suites in shared/src/sim/*.test.ts. Run with `dotnet run` from this dir;
// exits non-zero if any assertion fails.

using System;
using System.Collections.Generic;
using WebRivals.Shared;
using WebRivals.Shared.Sim;
using WebRivals.Server;
using WebRivals.Client.Net;
using static WebRivals.Shared.VMath;

internal static class Program
{
    static int _passed = 0;
    static int _failed = 0;
    static string _suite = "";

    static void Suite(string name) { _suite = name; Console.WriteLine($"\n== {name} =="); }

    static void Test(string name, Action body)
    {
        try
        {
            body();
            _passed++;
            Console.WriteLine($"  ok   {name}");
        }
        catch (Exception e)
        {
            _failed++;
            Console.WriteLine($"  FAIL {name}\n         {e.Message}");
        }
    }

    static void True(bool cond, string msg = "expected true")
    { if (!cond) throw new Exception(msg); }

    static void Close(double actual, double expected, double digits, string msg = "")
    {
        // vitest toBeCloseTo: |a-e| < 0.5 * 10^-digits
        double tol = 0.5 * Math.Pow(10, -digits);
        if (Math.Abs(actual - expected) >= tol)
            throw new Exception($"{msg} expected ~{expected} (±{tol}), got {actual}");
    }

    static void Greater(double a, double b, string msg = "")
    { if (!(a > b)) throw new Exception($"{msg} expected {a} > {b}"); }

    static void Less(double a, double b, string msg = "")
    { if (!(a < b)) throw new Exception($"{msg} expected {a} < {b}"); }

    static void Eq(double a, double b, string msg = "")
    { if (a != b) throw new Exception($"{msg} expected {a} == {b}"); }

    // ---- movement helpers (mirror movement.test.ts) ----
    static MovementTuning M => Tuning.Movement;
    static double SimDt => Tuning.SimDt;

    static Solid Floor() => Solid.Box(0, -5, 0, 200, 10, 200);
    static double GroundedCenterY(double half) => half + M.Radius;
    static double GroundedCenterY() => Movement.StandHalf() + M.Radius;

    static InputFrame Inp(int buttons = 0, double yaw = 0, double pitch = 0, bool jump = false)
        => new InputFrame { Buttons = buttons, Yaw = yaw, Pitch = pitch, Jump = jump };

    static MoveEvents Run(PlayerMoveState s, MockTraceWorld world, InputFrame inp, int n)
    {
        var ev = Movement.NewEvents();
        for (int i = 0; i < n; i++) Movement.StepMovement(s, inp, world, SimDt, ev);
        return ev;
    }

    static int Main()
    {
        MovementTests();
        ProjectileTests();
        TraceWorldTests();
        ProtocolTests();
        MatchTests();
        LagCompTests();
        ValidatorTests();
        SnapshotTests();

        Console.WriteLine($"\n{_passed} passed, {_failed} failed");
        return _failed == 0 ? 0 : 1;
    }

    static void MovementTests()
    {
        Suite("stepMovement");

        Test("gravity: falls and becomes grounded with vel.y ~0", () =>
        {
            var world = new MockTraceWorld(new[] { Floor() });
            var s = Movement.CreateMoveState(V3(0, 3, 0), 0);
            True(!s.Grounded);
            Run(s, world, Inp(), 120);
            True(s.Grounded, "grounded");
            Less(Math.Abs(s.Vel.Y), 0.05, "vel.y small");
            Close(s.Pos.Y, GroundedCenterY(), 1, "rest center y");
        });

        Test("sprint reaches ~sprintSpeed on flat ground", () =>
        {
            var world = new MockTraceWorld(new[] { Floor() });
            var s = Movement.CreateMoveState(V3(0, GroundedCenterY() + 0.01, 0), 0);
            Run(s, world, Inp(), 5);
            Run(s, world, Inp(Button.Forward | Button.Sprint), 120);
            double speed = Movement.HorizontalSpeed(s);
            Greater(speed, M.SprintSpeed - 0.3);
            Less(speed, M.SprintSpeed + 0.3);
        });

        Test("slide: raises speed by ~slideBoost then decays", () =>
        {
            var world = new MockTraceWorld(new[] { Floor() });
            var s = Movement.CreateMoveState(V3(0, GroundedCenterY() + 0.01, 0), 0);
            Run(s, world, Inp(), 5);
            Run(s, world, Inp(Button.Forward | Button.Sprint), 120);
            double beforeSlide = Movement.HorizontalSpeed(s);
            Greater(beforeSlide, M.SprintSpeed - 0.3);

            var ev = Movement.NewEvents();
            var slideInp = Inp(Button.Forward | Button.Sprint | Button.Crouch);
            Movement.StepMovement(s, slideInp, world, SimDt, ev);
            True(ev.SlideStarted, "slideStarted");
            True(s.MoveState == MoveStateName.Slide, "slide state");
            Close(s.CapsuleHalf, Movement.SlideHalf(), 5);
            double justAfterBoost = Movement.HorizontalSpeed(s);
            double maxFrictionDrop = (beforeSlide + M.SlideBoost) * M.SlideFriction * SimDt;
            Greater(justAfterBoost, beforeSlide + M.SlideBoost - maxFrictionDrop - 0.01);

            Run(s, world, slideInp, 30);
            Less(Movement.HorizontalSpeed(s), justAfterBoost);
        });

        Test("slide-jump preserves horizontal speed and adds vertical", () =>
        {
            var world = new MockTraceWorld(new[] { Floor() });
            var s = Movement.CreateMoveState(V3(0, GroundedCenterY() + 0.01, 0), 0);
            Run(s, world, Inp(), 5);
            Run(s, world, Inp(Button.Forward | Button.Sprint), 120);

            var ev = Movement.NewEvents();
            var slideInp = Inp(Button.Forward | Button.Sprint | Button.Crouch);
            Movement.StepMovement(s, slideInp, world, SimDt, ev);
            True(s.MoveState == MoveStateName.Slide);
            double hBefore = Movement.HorizontalSpeed(s);
            Greater(hBefore, M.SprintSpeed);

            var jumpEv = Movement.NewEvents();
            var jumpInp = Inp(Button.Forward | Button.Sprint | Button.Crouch, jump: true);
            Movement.StepMovement(s, jumpInp, world, SimDt, jumpEv);
            True(jumpEv.Jumped, "jumped");
            Close(s.Vel.Y, M.JumpImpulse, 5);
            double frictionDrop = hBefore * M.SlideFriction * SimDt;
            Greater(Movement.HorizontalSpeed(s), hBefore - frictionDrop - 0.01);
            Greater(Movement.HorizontalSpeed(s), M.SprintSpeed);
        });

        Test("coyote: jumping shortly after leaving a ledge still registers", () =>
        {
            var platform = Solid.Box(0, -5, 0, 10, 10, 10);
            var world = new MockTraceWorld(new[] { platform });
            var s = Movement.CreateMoveState(V3(4, GroundedCenterY() + 0.01, 0), 0);
            Run(s, world, Inp(), 5);
            True(s.Grounded);
            s.Vel.X = M.SprintSpeed;
            bool leftGround = false;
            for (int i = 0; i < 30; i++)
            {
                var ev = Movement.NewEvents();
                Movement.StepMovement(s, Inp(Button.Right), world, SimDt, ev);
                if (!s.Grounded) { leftGround = true; break; }
            }
            True(leftGround, "left ground");
            Greater(s.CoyoteTimer, 0);
            var jumpEv = Movement.NewEvents();
            Movement.StepMovement(s, Inp(Button.Right, jump: true), world, SimDt, jumpEv);
            True(jumpEv.Jumped, "coyote jump");
            Greater(s.Vel.Y, 0);
        });

        Test("headroom: ending a slide under a low ceiling does NOT un-crouch", () =>
        {
            var f = Floor();
            double standTotal = 2 * (Movement.StandHalf() + M.Radius);
            double slideTotal = 2 * (Movement.SlideHalf() + M.Radius);
            double ceilBottom = slideTotal + 0.2;
            var ceiling = Solid.Box(0, ceilBottom + 5, 0, 200, 10, 200);
            Less(ceilBottom, standTotal, "no standing headroom");
            var world = new MockTraceWorld(new[] { f, ceiling });

            var s = Movement.CreateMoveState(V3(0, GroundedCenterY(Movement.SlideHalf()) + 0.005, 0), 0);
            s.CapsuleHalf = Movement.SlideHalf();
            s.MoveState = MoveStateName.Slide;
            s.Vel.X = M.SprintSpeed + M.SlideBoost;
            Run(s, world, Inp(Button.Crouch), 3);
            True(s.MoveState == MoveStateName.Slide);
            True(s.Grounded);
            Close(s.CapsuleHalf, Movement.SlideHalf(), 5);

            for (int i = 0; i < 300; i++)
            {
                var e2 = Movement.NewEvents();
                Movement.StepMovement(s, Inp(0), world, SimDt, e2);
            }
            Close(s.CapsuleHalf, Movement.SlideHalf(), 5);
        });

        Test("impulse: applyImpulse adds to velocity once then clears", () =>
        {
            var world = new MockTraceWorld(new[] { Floor() });
            var s = Movement.CreateMoveState(V3(0, GroundedCenterY() + 0.01, 0), 0);
            Run(s, world, Inp(), 5);
            True(s.Grounded);
            Movement.ApplyImpulse(s, 0, 12, 0);
            Eq(s.PendingImpulse.Y, 12);
            var ev = Movement.NewEvents();
            Movement.StepMovement(s, Inp(), world, SimDt, ev);
            Eq(s.PendingImpulse.Y, 0);
            Greater(s.Vel.Y, 12 - M.Gravity * SimDt - 0.001);
            double velAfterFirst = s.Vel.Y;
            Movement.StepMovement(s, Inp(), world, SimDt, ev);
            Less(s.Vel.Y, velAfterFirst);
            Close(s.Vel.Y, velAfterFirst - M.Gravity * SimDt, 4);
        });
    }

    static ProjectileStep FreshStep() => new ProjectileStep { Detonated = false, Point = V3() };
    static readonly Solid PFLOOR = Solid.Box(0, 0, 0, 20, 1, 20);
    static readonly Solid PWALL = Solid.Box(5, 2, 0, 1, 4, 10);

    static PlayerCapsule Cap(int id, double x, double y, double z)
        => new PlayerCapsule { Id = id, Center = V3(x, y, z), Radius = 0.4, HalfHeight = 0.9 };

    static void ProjectileTests()
    {
        Suite("stepProjectile / computeExplosion");

        Test("rocket detonates on the first step into a wall", () =>
        {
            var world = new MockTraceWorld(new[] { PFLOOR, PWALL });
            var rocket = Projectiles.MakeProjectile(1, ProjKind.Rocket, V3(0, 2, 0), V3(Tuning.Rocket.ProjSpeed, 0, 0), 0, 0);
            var outS = FreshStep();
            bool det = false;
            for (int i = 0; i < 60 && !det; i++)
            {
                Projectiles.StepProjectile(rocket, world, 1.0 / 60, outS);
                det = outS.Detonated;
            }
            True(det, "detonated");
            True(!rocket.Alive, "dead");
            Close(outS.Point.X, 4.35, 2, "wall face");
        });

        Test("rocket flies freely over open floor", () =>
        {
            var world = new MockTraceWorld(new[] { PFLOOR });
            var rocket = Projectiles.MakeProjectile(1, ProjKind.Rocket, V3(0, 3, 0), V3(Tuning.Rocket.ProjSpeed, 0, 0), 0, 0);
            var outS = FreshStep();
            Projectiles.StepProjectile(rocket, world, 1.0 / 60, outS);
            True(!outS.Detonated);
            True(rocket.Alive);
            Close(rocket.Pos.X, Tuning.Rocket.ProjSpeed / 60, 4);
            Less(rocket.Vel.Y, 0);
        });

        Test("grenade bounces off a wall: reflects + slows", () =>
        {
            var world = new MockTraceWorld(new[] { PFLOOR, PWALL });
            double speed = 14;
            var g = Projectiles.MakeProjectile(2, ProjKind.Grenade, V3(0, 2, 0), V3(speed, 0, 0), 0, Tuning.Grenade.Fuse);
            var outS = FreshStep();
            double beforeVx = g.Vel.X;
            bool bounced = false;
            for (int i = 0; i < 60 && !bounced; i++)
            {
                Projectiles.StepProjectile(g, world, 1.0 / 60, outS);
                if (g.Vel.X < 0) bounced = true;
                True(!outS.Detonated, "no detonation");
            }
            True(bounced, "bounced");
            Less(g.Vel.X, 0);
            Less(Math.Abs(g.Vel.X), Math.Abs(beforeVx));
            Close(Math.Abs(g.Vel.X), Math.Abs(beforeVx) * Tuning.Grenade.Restitution, 1);
        });

        Test("grenade detonates in place when fuse expires (3 steps)", () =>
        {
            var world = new MockTraceWorld(new[] { PFLOOR });
            double dt = 0.02;
            var g = Projectiles.MakeProjectile(2, ProjKind.Grenade, V3(0, 5, 0), V3(0, 0, 0), 0, 0.05);
            var outS = FreshStep();
            bool det = false; int steps = 0;
            while (!det && steps < 30)
            {
                Projectiles.StepProjectile(g, world, dt, outS);
                steps++;
                det = outS.Detonated;
            }
            True(det);
            True(!g.Alive);
            Eq(steps, 3);
        });

        Test("grenade settles flat: tiny horizontal residual zeroed", () =>
        {
            var world = new MockTraceWorld(new[] { PFLOOR });
            var g = Projectiles.MakeProjectile(2, ProjKind.Grenade, V3(0, 1.2, 0), V3(0.2, -3, 0), 0, Tuning.Grenade.Fuse);
            var outS = FreshStep();
            for (int i = 0; i < 10; i++)
            {
                Projectiles.StepProjectile(g, world, 1.0 / 60, outS);
                if (g.Vel.Y >= 0) break;
            }
            Eq(HorizontalLength(g.Vel), 0);
        });

        var NO_GEO = new MockTraceWorld(Array.Empty<Solid>());

        Test("closer player takes more splash than a farther one", () =>
        {
            var center = V3(0, 1, 0);
            var hits = Projectiles.ComputeExplosion(ProjKind.Rocket, center, 99,
                new List<PlayerCapsule> { Cap(10, 1, 1, 0), Cap(11, 2.5, 1, 0) }, NO_GEO);
            var near = hits.Find(h => h.Id == 10);
            var far = hits.Find(h => h.Id == 11);
            True(near != null && far != null, "both hit");
            Greater(near.Damage, far.Damage);
            Greater(Length(near.Impulse), Length(far.Impulse));
        });

        Test("player outside splash radius is absent", () =>
        {
            var center = V3(0, 1, 0);
            var hits = Projectiles.ComputeExplosion(ProjKind.Rocket, center, 99,
                new List<PlayerCapsule> { Cap(12, Tuning.Rocket.SplashRadius + 2, 1, 0) }, NO_GEO);
            True(hits.Find(h => h.Id == 12) == null);
        });

        Test("rocket direct hit adds directDamage on top of splash", () =>
        {
            var center = V3(0, 1, 0);
            var withDirect = Projectiles.ComputeExplosion(ProjKind.Rocket, center, 99,
                new List<PlayerCapsule> { Cap(10, 1, 1, 0) }, NO_GEO, 10);
            var splashOnly = Projectiles.ComputeExplosion(ProjKind.Rocket, center, 99,
                new List<PlayerCapsule> { Cap(10, 1, 1, 0) }, NO_GEO);
            Close(withDirect[0].Damage - splashOnly[0].Damage, Tuning.Rocket.DirectDamage, 0);
        });

        Test("owner: scaled self-damage, full self-knockback", () =>
        {
            var center = V3(0, 1, 0);
            var hits = Projectiles.ComputeExplosion(ProjKind.Rocket, center, 7,
                new List<PlayerCapsule> { Cap(7, 1, 1, 0), Cap(8, -1, 1, 0) }, NO_GEO);
            var owner = hits.Find(h => h.Id == 7);
            var stranger = hits.Find(h => h.Id == 8);
            Close(Length(owner.Impulse), Length(stranger.Impulse), 5);
            Close(owner.Damage, Math.Floor(stranger.Damage * Tuning.Rocket.SelfDamageScale + 0.5), 0);
            Less(owner.Damage, stranger.Damage);
        });

        Test("LOS: wall blocks damage but not knockback", () =>
        {
            var world = new MockTraceWorld(new[] { PWALL });
            var center = V3(4.0, 2, 0);
            var hits = Projectiles.ComputeExplosion(ProjKind.Rocket, center, 99,
                new List<PlayerCapsule> { Cap(20, 6.0, 2, 0) }, world);
            var hit = hits.Find(h => h.Id == 20);
            True(hit != null);
            Eq(hit.Damage, 0);
            Greater(Length(hit.Impulse), 0);
        });

        Test("projectilePlayerHit: detonates on a crossed player", () =>
        {
            var victim = Cap(2, 0, 1, 0);
            var ph = Projectiles.ProjectilePlayerHit(V3(0, 1, -5), V3(0, 1, 5), new List<PlayerCapsule> { victim }, 1);
            True(ph != null);
            Eq(ph.Id, 2);
            Close(ph.Point.Z, -0.55, 1);
        });

        Test("projectilePlayerHit: excludes owner + misses", () =>
        {
            var victim = Cap(2, 0, 1, 0);
            True(Projectiles.ProjectilePlayerHit(V3(2, 1, -5), V3(2, 1, 5), new List<PlayerCapsule> { victim }, 1) == null);
            True(Projectiles.ProjectilePlayerHit(V3(0, 1, -5), V3(0, 1, 5), new List<PlayerCapsule> { victim }, 2) == null);
            var near = Cap(3, 0, 1, 0);
            var far = Cap(4, 0, 1, 3);
            var ph = Projectiles.ProjectilePlayerHit(V3(0, 1, -5), V3(0, 1, 5), new List<PlayerCapsule> { far, near }, 1);
            Eq(ph.Id, 3);
        });
    }

    static void TraceWorldTests()
    {
        Suite("MockTraceWorld");

        Test("raycast hits a box face at the expected distance", () =>
        {
            var world = new MockTraceWorld(new[] { Solid.Box(5, 0, 0, 2, 2, 2) }); // x in [4,6]
            var hit = world.Raycast(V3(0, 0, 0), V3(1, 0, 0), 100);
            True(hit != null);
            Close(hit.Point.X, 4, 5);
            Close(hit.Normal.X, -1, 5);
        });

        Test("castCapsule stops short of a wall (Minkowski expansion)", () =>
        {
            var world = new MockTraceWorld(new[] { Solid.Box(5, 0, 0, 2, 2, 2) }); // face at x=4
            var hit = world.CastCapsule(V3(0, 0, 0), 0.5, 0.4, V3(10, 0, 0));
            True(hit != null);
            // capsule center stops at x = 4 - radius(0.4) = 3.6; fraction = 3.6/10.
            Close(hit.Fraction, 0.36, 2);
        });

        Test("ramp slope is walkable (normal.y > groundNormalY)", () =>
        {
            var world = new MockTraceWorld(Maps.Crate.Solids);
            // Drop a capsule onto a ramp near the center block.
            var hit = world.CastCapsule(V3(0, 4, 6), 0.5, 0.4, V3(0, -3, 0));
            True(hit != null, "hit ramp");
            Greater(hit.Normal.Y, Tuning.Movement.GroundNormalY);
        });

        Test("running up a ramp reaches the high-ground plateau", () =>
        {
            // Regression for two bugs that made ramps unusable with the Mock backend:
            //  (1) the ramp's bounding-box toe face acted as a vertical wall (shares
            //      normal.y == 0 with the side walls), so a player stopped dead at
            //      toe+radius with zero lift; and
            //  (2) even once climbing, the swept-box collider can't round the convex
            //      lip where the ramp meets the plateau, so the player wedged at the
            //      top. Fixes: reject ramp box faces on the air side of the slope
            //      plane (MockTraceWorld) + stay-on-ground/step-up (Movement).
            // MinusZ ramp: toe at z=8, rises to z=4 onto the 8x8 block (top y=3);
            // forward = -Z. Start on open floor behind the toe.
            var world = new MockTraceWorld(Maps.Crate.Solids);
            var s = Movement.CreateMoveState(V3(0, 0.92, 11), 0);
            s.Grounded = true;
            s.MoveState = MoveStateName.Ground;
            var ev = new MoveEvents();
            var input = new InputFrame { Buttons = Button.Forward | Button.Sprint, Yaw = 0 };
            for (int i = 0; i < 55; i++) Movement.StepMovement(s, input, world, Tuning.SimDt, ev);
            True(s.Pos.Z < 4, "player crested onto the plateau (past the ramp/block junction)");
            Greater(s.Pos.Y, 3.5, "player is standing up on the plateau (top y=3, center ~3.9)");
            True(s.Grounded, "player is grounded on the plateau, not wedged/airborne");
        });
    }

    static void ProtocolTests()
    {
        Suite("Protocol JSON round-trip");

        Test("input message round-trips with exact field names", () =>
        {
            var msg = new InputMsg
            {
                Seq = 7, ClientTime = 123.5, Pos = new double[] { 1, 2, 3 }, Vel = new double[] { 4, 5, 6 },
                Yaw = 0.5, Pitch = -0.25, Buttons = Button.Forward | Button.Jump, Events = EventFlag.Jumped,
            };
            string json = Protocol.Encode(msg);
            True(json.Contains("\"t\":\"input\""), "has t");
            True(json.Contains("\"clientTime\":123.5"), "camelCase field");
            var back = Protocol.Decode(json) as InputMsg;
            True(back != null, "decoded type");
            Eq(back.Seq, 7);
            Eq(back.Pos[1], 2);
            Eq(back.Buttons, Button.Forward | Button.Jump);
        });

        Test("snapshot with nested players/projectiles round-trips", () =>
        {
            var msg = new SnapshotMsg
            {
                Tick = 42, ServerTime = 9999,
                Players = new[] { new PlayerSnap { Id = 1, Pos = new double[] { 0, 1, 0 }, Vel = new double[] { 0, 0, 0 }, Yaw = 1, Pitch = 0, Anim = "run", Hp = 80, Weapon = 2 } },
                Projectiles = new[] { new ProjSnap { Id = 5, Kind = "rocket", Pos = new double[] { 1, 1, 1 }, Vel = new double[] { 25, 0, 0 } } },
            };
            string json = Protocol.Encode(msg);
            var back = Protocol.Decode(json) as SnapshotMsg;
            True(back != null);
            Eq(back.Players[0].Hp, 80);
            True(back.Players[0].Anim == "run");
            True(back.Projectiles[0].Kind == "rocket");
        });

        Test("optional fields omitted when null (hello.roomCode)", () =>
        {
            var msg = new HelloMsg { Name = "Bob" };
            string json = Protocol.Encode(msg);
            True(!json.Contains("roomCode"), "roomCode omitted");
            var back = Protocol.Decode(json) as HelloMsg;
            Eq(back.Name == "Bob" ? 1 : 0, 1);
        });

        Test("sanitizeName strips control chars and caps length", () =>
        {
            True(Protocol.SanitizeName("  hi\tthere  ") == "hithere");
            True(Protocol.SanitizeName("") == "Player");
            True(Protocol.SanitizeName(new string('x', 40)).Length == 16);
        });
    }

    static MatchTickCtx Ctx(int connected = 0, int topFrags = 0, int topPlayer = -1)
        => new MatchTickCtx { ConnectedCount = connected, TopFrags = topFrags, TopFragsPlayer = topPlayer };

    static void RunMatch(MatchState s, int n, MatchTickCtx c)
    {
        for (int i = 0; i < n; i++) Match.StepMatch(s, c, 1.0 / 30);
    }

    static void MatchTests()
    {
        Suite("FFA match reducer");
        double DT = 1.0 / 30;
        var W = Tuning.World;

        Test("starts in warmup with no winner", () =>
        {
            var s = Match.InitMatch();
            True(s.Phase == "warmup");
            Eq(s.MatchWinner, -1);
        });

        Test("stays in warmup below warmupMinPlayers", () =>
        {
            var s = Match.InitMatch();
            RunMatch(s, 5, Ctx(connected: 1));
            True(s.Phase == "warmup");
        });

        Test("goes live + emits matchStart at enough players", () =>
        {
            var s = Match.InitMatch();
            var ev = Match.StepMatch(s, Ctx(connected: W.WarmupMinPlayers), DT);
            True(s.Phase == "live");
            Eq(s.Clock, 0);
            True(ev.Exists(e => e.Type == MatchEventType.MatchStart));
        });

        Test("accumulates the clock while live", () =>
        {
            var s = Match.InitMatch();
            Match.StepMatch(s, Ctx(connected: 2), DT);
            RunMatch(s, 30, Ctx(connected: 2));
            Greater(s.Clock, 0.9);
            Less(s.Clock, 1.1);
        });

        Test("ends at frag limit, awards player, emits matchEnd", () =>
        {
            var s = Match.InitMatch();
            Match.StepMatch(s, Ctx(connected: 2), DT);
            var ev = Match.StepMatch(s, Ctx(connected: 2, topFrags: W.FragLimit, topPlayer: 7), DT);
            True(s.Phase == "matchEnd");
            Eq(s.MatchWinner, 7);
            Close(s.Clock, W.MatchEndSec, 5);
            True(ev.Exists(e => e.Type == MatchEventType.MatchEnd && e.Winner == 7));
        });

        Test("drops back to warmup when players leave mid-match", () =>
        {
            var s = Match.InitMatch();
            Match.StepMatch(s, Ctx(connected: 2), DT);
            RunMatch(s, 10, Ctx(connected: 2));
            Match.StepMatch(s, Ctx(connected: 1), DT);
            True(s.Phase == "warmup");
            Eq(s.MatchWinner, -1);
        });

        Test("resets after the matchEnd display and re-arms", () =>
        {
            var s = Match.InitMatch();
            Match.StepMatch(s, Ctx(connected: 2), DT);
            Match.StepMatch(s, Ctx(connected: 2, topFrags: W.FragLimit, topPlayer: 1), DT);
            bool sawReset = false;
            for (int i = 0; i < 10000 && s.Phase == "matchEnd"; i++)
            {
                var ev = Match.StepMatch(s, Ctx(connected: 2), DT);
                if (ev.Exists(e => e.Type == MatchEventType.Reset)) sawReset = true;
            }
            True(sawReset, "reset event");
            True(s.Phase == "warmup" || s.Phase == "live");
        });

        Test("matchEnd ignores connectedCount until timer drains", () =>
        {
            var s = Match.InitMatch();
            Match.StepMatch(s, Ctx(connected: 2), DT);
            Match.StepMatch(s, Ctx(connected: 2, topFrags: W.FragLimit, topPlayer: 1), DT);
            Match.StepMatch(s, Ctx(connected: 0), DT);
            True(s.Phase == "matchEnd");
        });
    }

    static void LagCompTests()
    {
        Suite("LagComp");
        double RADIUS = 0.4, HALF = 0.9;

        Test("rewinds to a past position: hits where the player WAS", () =>
        {
            var lc = new LagComp();
            int victim = 2;
            lc.Record(victim, V3(0, 1, 0), RADIUS, HALF, 0);
            lc.Record(victim, V3(2, 1, 0), RADIUS, HALF, 50);
            lc.Record(victim, V3(4, 1, 0), RADIUS, HALF, 100);

            var past = lc.RewindRay(1, V3(0, 1, -10), V3(0, 0, 1), 50, 0);
            True(past != null);
            Eq(past.Value.Id, victim);
            Close(past.Value.Distance, 10 - RADIUS, 1);

            var present = lc.RewindRay(1, V3(0, 1, -10), V3(0, 0, 1), 50, 100);
            True(present == null);
        });

        Test("interpolates between bracketing samples", () =>
        {
            var lc = new LagComp();
            int victim = 7;
            lc.Record(victim, V3(0, 1, 0), RADIUS, HALF, 0);
            lc.Record(victim, V3(4, 1, 0), RADIUS, HALF, 100);
            var onPath = lc.RewindRay(victim + 1, V3(2, 1, -10), V3(0, 0, 1), 50, 50);
            True(onPath != null && onPath.Value.Id == victim);
            var offPath = lc.RewindRay(victim + 1, V3(0, 1, -10), V3(0, 0, 1), 50, 50);
            True(offPath == null);
        });

        Test("excludes the shooter from its own ray", () =>
        {
            var lc = new LagComp();
            int shooter = 5;
            lc.Record(shooter, V3(0, 1, 0), RADIUS, HALF, 0);
            lc.Record(shooter, V3(0, 1, 0), RADIUS, HALF, 50);
            True(lc.RewindRay(shooter, V3(0, 1, -10), V3(0, 0, 1), 50, 25) == null);
        });

        Test("returns the nearest player through several", () =>
        {
            var lc = new LagComp();
            lc.Record(10, V3(0, 1, 0), RADIUS, HALF, 0);
            lc.Record(10, V3(0, 1, 0), RADIUS, HALF, 100);
            lc.Record(11, V3(0, 1, 5), RADIUS, HALF, 0);
            lc.Record(11, V3(0, 1, 5), RADIUS, HALF, 100);
            var hit = lc.RewindRay(1, V3(0, 1, -10), V3(0, 0, 1), 50, 50);
            True(hit != null);
            Eq(hit.Value.Id, 10);
            Close(hit.Value.Distance, 10 - RADIUS, 1);
        });

        Test("drops a removed player", () =>
        {
            var lc = new LagComp();
            lc.Record(4, V3(0, 1, 0), RADIUS, HALF, 0);
            lc.Record(4, V3(0, 1, 0), RADIUS, HALF, 50);
            True(lc.RewindRay(1, V3(0, 1, -10), V3(0, 0, 1), 50, 25) != null);
            lc.Remove(4);
            True(lc.RewindRay(1, V3(0, 1, -10), V3(0, 0, 1), 50, 25) == null);
        });
    }

    static void ValidatorTests()
    {
        Suite("MovementValidator");
        double DT = 1.0 / 30;

        Test("accepts a plausible step and updates baseline", () =>
        {
            var world = new MockTraceWorld(new[] { Floor() });
            var v = new MovementValidator(world);
            var start = V3(0, GroundedCenterY(), 0);
            v.Reset(1, start);
            var report = new MoveReport { Pos = V3(0.1, GroundedCenterY(), 0), Vel = V3(3, 0, 0), Yaw = 0, Pitch = 0 };
            var res = v.Accept(1, report, DT, 1000);
            True(res.Ok, "accepted");
            Close(res.CorrectedPos.X, 0.1, 5);
        });

        Test("rejects a teleport (displacement too large)", () =>
        {
            var world = new MockTraceWorld(new[] { Floor() });
            var v = new MovementValidator(world);
            var start = V3(0, GroundedCenterY(), 0);
            v.Reset(1, start);
            var report = new MoveReport { Pos = V3(50, GroundedCenterY(), 0), Vel = V3(0, 0, 0), Yaw = 0, Pitch = 0 };
            var res = v.Accept(1, report, DT, 1000);
            True(!res.Ok, "rejected");
            Close(res.CorrectedPos.X, 0, 5); // snapped back to baseline
        });

        Test("impulse window widens the displacement allowance", () =>
        {
            var world = new MockTraceWorld(new[] { Floor() });
            var v = new MovementValidator(world);
            v.Reset(1, V3(0, GroundedCenterY(), 0));
            v.NoteImpulse(1, 1000);
            double normalBudget = (Tuning.Movement.SprintSpeed + Tuning.Movement.SlideBoost) * DT * 1.5;
            // 3x the normal budget: rejected normally, accepted within the launch window.
            var report = new MoveReport { Pos = V3(normalBudget * 3, GroundedCenterY(), 0), Vel = V3(0, 0, 0), Yaw = 0, Pitch = 0 };
            var res = v.Accept(1, report, DT, 1000);
            True(res.Ok, "accepted under launch allowance");
        });
    }

    static SnapshotMsg Snap(double serverTime, int tick, double x)
    {
        return new SnapshotMsg
        {
            Tick = tick, ServerTime = serverTime,
            Players = new[] { new PlayerSnap { Id = 1, Pos = new[] { x, 1.0, 0.0 }, Vel = new[] { 0.0, 0, 0 }, Yaw = 0, Pitch = 0, Anim = "run", Hp = 100, Weapon = 1 } },
            Projectiles = Array.Empty<ProjSnap>(),
        };
    }

    static void SnapshotTests()
    {
        Suite("ClockSync / SnapshotBuffer");

        Test("ClockSync estimates server offset from a pong", () =>
        {
            var cs = new ClockSync();
            // ping sent at clientTime=1000, server replied serverTime=5000, now=1100 (rtt=100).
            cs.OnPong(1000, 5000, 1100);
            // offset = serverTime + rtt/2 - now = 5000 + 50 - 1100 = 3950.
            Close(cs.ServerTimeEstimate(1100), 5050, 5);
            Close(cs.RttMs, 100, 5);
        });

        Test("SnapshotBuffer interpolates between two snapshots", () =>
        {
            var buf = new SnapshotBuffer();
            buf.Insert(Snap(1000, 1, 0));
            buf.Insert(Snap(1100, 2, 10));
            var sampled = buf.Sample(1050); // halfway -> x=5
            Close(sampled.Players[0].Pos[0], 5, 4);
        });

        Test("SnapshotBuffer clamps before/after the buffer (no extrapolation)", () =>
        {
            var buf = new SnapshotBuffer();
            buf.Insert(Snap(1000, 1, 0));
            buf.Insert(Snap(1100, 2, 10));
            Close(buf.Sample(900).Players[0].Pos[0], 0, 4);   // before earliest -> clamp
            Close(buf.Sample(2000).Players[0].Pos[0], 10, 4); // after latest -> freeze
        });

        Test("SnapshotBuffer reorders out-of-order inserts", () =>
        {
            var buf = new SnapshotBuffer();
            buf.Insert(Snap(1100, 2, 10));
            buf.Insert(Snap(1000, 1, 0)); // arrives late
            Close(buf.Sample(1050).Players[0].Pos[0], 5, 4);
        });
    }
}
