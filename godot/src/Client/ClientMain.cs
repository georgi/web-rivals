// Client boot + orchestration. Wires the shared sim (movement + trace + shared
// projectile ballistics) to the Godot render shell, mouselook, and a fixed-
// timestep loop, fronted by the Lobby and driven by the server match machine in
// ONLINE play (with an OFFLINE practice sandbox fallback). Ported from
// client/src/main.ts.
//
// Fixed timestep: the sim advances in _PhysicsProcess at simHz; _Process renders
// with interpolation (Engine.GetPhysicsInterpolationFraction) so motion stays
// smooth between sim ticks.

using System;
using System.Collections.Generic;
using Godot;
using WebRivals.Shared;
using WebRivals.Shared.Sim;
using WebRivals.Client.Combat;
using WebRivals.Client.Net;
using WebRivals.Client.Render;
using WebRivals.Client.UI;
using WebRivals.Client.Audio;
using static WebRivals.Client.GodotConv;
using static WebRivals.Shared.VMath;
using Button = WebRivals.Shared.Button;

namespace WebRivals.Client;

public sealed partial class ClientMain : Node3D, IProjectileHooks
{
    private enum Mode { Lobby, Connecting, Online, Offline }

    // ---- core systems ----
    private MockTraceWorld _world;
    private PlayerMoveState _state;
    private readonly MoveEvents _events = Movement.NewEvents();
    private InputManager _input;
    private PointerLook _plc;
    private Camera3D _camera;
    private Weapons _weapons;
    private Viewmodel _viewmodel;
    private Particles _particles;
    private LocalProjectiles _projectiles;
    private Dummy _dummy;
    private RemotePlayers _remotes;
    private Hud _hud;
    private Lobby _lobby;
    private AudioManager _audio;
    private NetClient _net;

    private readonly MovementTuning _m = Tuning.Movement;

    // ---- session state ----
    private Mode _mode = Mode.Lobby;
    private int _localId = 0;
    private bool _online = false;
    private bool _frozen = false;
    private bool _localDead = false;
    private bool _offlineActive = false;
    private double _localHp = Tuning.Combat.SpawnHealth;
    private readonly Dictionary<int, string> _names = new();
    private string _myName = "Player";
    private string _lastPhase = null;
    private bool _returnToLobby = false;

    private double _connectTimeoutAccumMs = 0;
    private const double ConnectTimeoutMs = 2500;
    private LobbyChoice _pendingChoice;

    // Headless/CI auto-connect (`-- --auto`): skip the lobby and quick-match in.
    private bool _autoConnect = false;
    private string _autoName = "Bot";

    // ---- combat scratch ----
    private double _bloom = Tuning.Ar.BloomMin;
    private int _shotSeq = 0;
    private int _selfDetonationGuard = 0;
    private bool _prevReloading = false;
    private int _inputTickCounter = 0;
    private static readonly int InputEvery = Math.Max(1, (int)Math.Round((double)Tuning.World.SimHz / Tuning.World.InputHz));
    private static readonly int SelfGuardTicks = (int)Math.Round(0.35 * Tuning.World.SimHz);
    private const double MuzzleOffset = 0.4;

    // ---- interpolation ----
    private readonly Vec3 _prevEye = V3();
    private readonly Vec3 _eyeScratch = V3();
    private readonly Vec3 _interpEye = V3();
    private double _prevFov;
    private Vec3 _spawnCenter;

    public override void _Ready()
    {
        Engine.PhysicsTicksPerSecond = Tuning.World.SimHz;
        Input.UseAccumulatedInput = false;

        BuildEnvironment();

        _world = new MockTraceWorld(Maps.Crate.Solids);
        AddChild((_particles = new Particles()).Object);

        // Map mesh.
        AddChild(MapMesh.Build(Maps.Crate));

        // Camera.
        _camera = new Camera3D { Current = true, Near = 0.05f, Far = 500f, Fov = (float)_m.FovBase };
        AddChild(_camera);

        // Local player.
        var spawn = Maps.Crate.Spawns[0];
        double centerY = spawn.Pos[1] + _m.Radius + Movement.StandHalf();
        _spawnCenter = new Vec3(spawn.Pos[0], centerY, spawn.Pos[2]);
        _state = Movement.CreateMoveState(new Vec3(spawn.Pos[0], centerY, spawn.Pos[2]), spawn.Yaw);

        _input = new InputManager();
        _plc = new PointerLook { Yaw = _state.Yaw };
        _plc.OnLockChange = OnLockChange;

        _weapons = new Weapons();
        _viewmodel = new Viewmodel();
        _camera.AddChild(_viewmodel.Object);

        _dummy = new Dummy(1, new Vec3(0, 3.9, 0));
        AddChild(_dummy.Object);

        _remotes = new RemotePlayers();
        AddChild(_remotes.Object);

        _projectiles = new LocalProjectiles(_world, _particles, this);
        AddChild(_projectiles.Object);

        _audio = new AudioManager();
        AddChild(_audio);

        _hud = new Hud();
        AddChild(_hud);

        _lobby = new Lobby();
        _lobby.OnChoice = OnLobbyChoice;
        AddChild(_lobby);

        EyeOut(_prevEye);
        _prevFov = _state.Fov;

        foreach (var arg in OS.GetCmdlineUserArgs())
        {
            if (arg == "--auto") _autoConnect = true;
            else if (arg.StartsWith("--name=")) _autoName = arg.Substring("--name=".Length);
        }

        ShowLobby();
        GD.Print("[client] ready");
    }

    private void BuildEnvironment()
    {
        var env = new Godot.Environment
        {
            BackgroundMode = Godot.Environment.BGMode.Sky,
            Sky = new Sky { SkyMaterial = new ProceduralSkyMaterial
            {
                SkyTopColor = new Color(0.357f, 0.651f, 0.910f),
                SkyHorizonColor = new Color(0.918f, 0.949f, 0.980f),
                GroundHorizonColor = new Color(0.918f, 0.949f, 0.980f),
                GroundBottomColor = new Color(0.78f, 0.82f, 0.86f),
            } },
            AmbientLightSource = Godot.Environment.AmbientSource.Sky,
            AmbientLightEnergy = 1.0f,
            TonemapMode = Godot.Environment.ToneMapper.Filmic,
            TonemapExposure = 0.95f,
            SsaoEnabled = true,
            GlowEnabled = true,
            GlowIntensity = 0.5f,
            GlowBloom = 0.1f,
            FogEnabled = true,
            FogLightColor = new Color(0.902f, 0.933f, 0.969f),
            FogDensity = 0.004f,
        };
        AddChild(new WorldEnvironment { Environment = env });

        var sun = new DirectionalLight3D
        {
            LightEnergy = 1.6f,
            LightColor = new Color(1f, 0.97f, 0.925f),
            ShadowEnabled = true,
        };
        sun.RotationDegrees = new Vector3(-62, 32, 0);
        sun.LightAngularDistance = 1.0f;
        AddChild(sun);

        // Fill so shadows never crush to black (the high-key arena look).
        var fill = new DirectionalLight3D
        {
            LightEnergy = 0.35f,
            LightColor = new Color(0.78f, 0.84f, 0.92f),
            ShadowEnabled = false,
        };
        fill.RotationDegrees = new Vector3(-40, -150, 0);
        AddChild(fill);
    }

    // ---- input forwarding ----
    public override void _UnhandledInput(InputEvent e)
    {
        _input.HandleEvent(e);
        _plc.HandleEvent(e);

        if (e is InputEventMouseButton mb && mb.Pressed && mb.ButtonIndex == MouseButton.Left)
        {
            _audio.Resume();
            if (_online || _offlineActive) _plc.RequestLock();
        }
        if (e is InputEventKey k && k.Pressed && k.PhysicalKeycode == Key.Escape)
            _plc.ReleaseLock();
    }

    private void OnLockChange(bool locked)
    {
        _input.SetEnabled(locked && !_frozen && !_localDead);
    }

    // ---- fixed-timestep sim ----
    public override void _PhysicsProcess(double dt)
    {
        EyeOut(_prevEye);
        _prevFov = _state.Fov;

        bool locked = _plc.Locked;
        bool active = locked && !_frozen && !_localDead;
        _state.KnifeOut = _weapons.KnifeOut;

        if (_frozen) { _state.Vel.X = 0; _state.Vel.Y = 0; _state.Vel.Z = 0; }

        _input.Update();
        var frame = _input.BuildFrame(_plc.Yaw, _plc.Pitch);
        _state.Yaw = frame.Yaw;
        _state.Pitch = frame.Pitch;
        Movement.StepMovement(_state, frame, _world, Tuning.SimDt, _events);
        if (_events.Jumped) _input.ConsumeJump();

        if (_events.Jumped) _audio.Jump();
        if (_events.Landed) _audio.Land();
        if (_events.SlideStarted) _audio.SlideStart();

        if (!_online && _state.Pos.Y < Maps.Crate.KillY) Respawn();

        if (active)
        {
            int sel = _input.SelectedWeapon;
            if (sel != _weapons.Current)
            {
                _weapons.Select(sel);
                _viewmodel.SetWeapon(sel);
            }
            if ((_input.Buttons & Button.Reload) != 0) _weapons.StartReload();
        }

        bool triggerHeld = active && (_input.Buttons & Button.Fire) != 0;
        if (_weapons.TryFire(triggerHeld))
            FireWeapon(_weapons.Current, _state.Yaw, _state.Pitch);

        _weapons.Update(Tuning.SimDt);
        bool reloadingNow = _weapons.Reloading;
        if (reloadingNow && !_prevReloading) _audio.Reload();
        _prevReloading = reloadingNow;

        _projectiles.Update(Tuning.SimDt);
        if (_selfDetonationGuard > 0) _selfDetonationGuard--;

        _bloom = Math.Max(Tuning.Ar.BloomMin, _bloom - Tuning.Ar.BloomRecover * Tuning.SimDt);

        // Send input at inputHz (decimated from simHz).
        if (_net != null)
        {
            _inputTickCounter++;
            if (_inputTickCounter >= InputEvery && !_localDead)
            {
                _inputTickCounter = 0;
                int evFlags = 0;
                if (_events.Jumped) evFlags |= EventFlag.Jumped;
                if (_events.SlideStarted) evFlags |= EventFlag.SlideStart;
                if (_events.Landed) evFlags |= EventFlag.Landed;
                _net.SendInput(
                    new[] { _state.Pos.X, _state.Pos.Y, _state.Pos.Z },
                    new[] { _state.Vel.X, _state.Vel.Y, _state.Vel.Z },
                    _state.Yaw, _state.Pitch, _input.Buttons, evFlags);
            }
        }

        // HUD combat subset.
        var a = _weapons.Ammo();
        _hud.Update(_net != null ? _net.Hp : _localHp, WeaponName(_weapons.Current), a.Clip, a.Reserve);
        _hud.SetCrosshairBloom(_bloom / Tuning.Ar.BloomMax * 14);
    }

    // ---- per-frame render ----
    public override void _Process(double dt)
    {
        // Drive the session state machine + network pump.
        _net?.Poll(dt * 1000);
        TickSession(dt);

        double alpha = Engine.GetPhysicsInterpolationFraction();
        EyeOut(_eyeScratch);
        Lerp(_interpEye, _prevEye, _eyeScratch, alpha);
        double interpFov = LerpScalar(_prevFov, _state.Fov, alpha);
        _plc.ApplyTo(_camera, ToGd(_interpEye), interpFov);

        if (_net != null)
        {
            double nowMs = Time.GetTicksMsec();
            double renderTime = _net.ServerTime(nowMs) - Tuning.World.InterpDelayMs;
            var sampled = _net.Snapshots.Sample(renderTime);
            foreach (var opp in sampled.Players)
            {
                if (opp.Id == _localId) continue;
                _remotes.SetPresent(opp.Id, _names.TryGetValue(opp.Id, out var nm) ? nm : "Player");
                _remotes.SetPose(opp.Id, opp.Pos[0], opp.Pos[1], opp.Pos[2], opp.Yaw);
                _remotes.SetHp(opp.Id, opp.Hp);
            }
            _remotes.Update(dt);
        }

        _particles.Update(dt);
        _dummy.Update(dt);
        _viewmodel.Update(dt, Movement.HorizontalSpeed(_state), _state.Grounded);
    }

    private void TickSession(double dt)
    {
        if (_autoConnect && _mode == Mode.Lobby)
        {
            _autoConnect = false;
            OnLobbyChoice(new LobbyChoice { Name = _autoName, RoomCode = null });
        }

        if (_mode == Mode.Connecting)
        {
            _connectTimeoutAccumMs += dt * 1000;
            if (_net != null && _net.IsJoined)
            {
                EnterOnline(_pendingChoice);
            }
            else if (_connectTimeoutAccumMs >= ConnectTimeoutMs)
            {
                _net?.CloseConn();
                _net = null;
                EnterOffline();
            }
        }
        else if (_mode == Mode.Online && _returnToLobby)
        {
            TeardownSession();
            ShowLobby();
        }
    }

    // ---- lobby / session lifecycle ----

    private void ShowLobby()
    {
        _mode = Mode.Lobby;
        _plc.ReleaseLock();
        _hud.HideBanner();
        _hud.HideScoreboard();
        _lobby.Open();
    }

    private void OnLobbyChoice(LobbyChoice choice)
    {
        _pendingChoice = choice;
        _lobby.Close();
        _lobby.SetStatus("Connecting…");
        _connectTimeoutAccumMs = 0;
        string url = ResolveWsUrl();
        try
        {
            var transport = new WebSocketTransport(url);
            _net = new NetClient(transport);
            _net.Start(choice.Name, choice.RoomCode);
            _mode = Mode.Connecting;
        }
        catch (Exception e)
        {
            GD.PrintErr($"[client] connect failed: {e.Message}");
            _net = null;
            EnterOffline();
        }
    }

    private void EnterOnline(LobbyChoice choice)
    {
        _mode = Mode.Online;
        _online = true;
        _offlineActive = false;
        _localId = _net.PlayerId;
        _myName = choice.Name;
        _names[_localId] = _myName;
        _net.SetHp(Tuning.Combat.SpawnHealth);
        _localHp = Tuning.Combat.SpawnHealth;
        WireNet();
        _plc.Yaw = _state.Yaw;
        _dummy.Visible = false;
    }

    private void EnterOffline()
    {
        _mode = Mode.Offline;
        _online = false;
        _offlineActive = true;
        _localId = 0;
        _frozen = false;
        _dummy.Visible = true;
        _remotes.HideAll();
        _lobby.SetStatus("Server unreachable — offline practice");
    }

    private void TeardownSession()
    {
        if (_net != null) { _net.CloseConn(); _net = null; }
        _online = false;
        _offlineActive = false;
        _frozen = false;
        _returnToLobby = false;
        _lastPhase = null;
        _names.Clear();
        _remotes.HideAll();
        _dummy.Visible = true;
        _localDead = false;
        _hud.HideBanner();
        _projectiles.Clear();
        Respawn();
    }

    private void WireNet()
    {
        _net.OnOpponent = o =>
        {
            if (o.Id >= 0) _names[o.Id] = o.Name;
            if (o.Present) { _remotes.SetPresent(o.Id, o.Name); _dummy.Visible = false; }
            else { _remotes.SetAbsent(o.Id); _names.Remove(o.Id); }
        };

        _net.OnMatchState = ms =>
        {
            _hud.SetFrags(new List<FragEntry>(ms.Scores), _localId, _names, ms.FragLimit);
            _hud.SetRoundTimer(ms.Phase == "live" ? ms.Timer : 0);

            _frozen = ms.Phase == "matchEnd";
            if (_frozen)
            {
                _state.Vel.X = 0; _state.Vel.Y = 0; _state.Vel.Z = 0;
                _input.SetEnabled(false);
            }
            else if (_plc.Locked && !_localDead)
            {
                _input.SetEnabled(true);
            }

            if (ms.Phase != _lastPhase)
            {
                if (ms.Phase == "live") { _hud.HideScoreboard(); _hud.ShowBanner("FIGHT"); }
                else if (ms.Phase == "matchEnd")
                {
                    _hud.ShowScoreboardFFA(new List<FragEntry>(ms.Scores), _names, _localId, _myName, ms.Winner);
                    _hud.HideBanner();
                    _audio.RoundEnd(ms.Winner == _localId);
                }
            }
            _lastPhase = ms.Phase;
        };

        _net.OnRespawn = r =>
        {
            if (r.Id != _localId) return;
            VMath.Set(_state.Pos, r.Pos[0], r.Pos[1], r.Pos[2]);
            _state.Vel.X = 0; _state.Vel.Y = 0; _state.Vel.Z = 0;
            _state.Grounded = false;
            _state.MoveState = MoveStateName.Air;
            _state.CapsuleHalf = Movement.StandHalf();
            _state.Yaw = r.Yaw;
            _plc.Yaw = r.Yaw;
            _localHp = Tuning.Combat.SpawnHealth;
            _net.SetHp(_localHp);
            _localDead = false;
            if (_plc.Locked && !_frozen) _input.SetEnabled(true);
        };

        _net.OnKill = k =>
        {
            string killer = _names.TryGetValue(k.Killer, out var kn) ? kn : (k.Killer == _localId ? _myName : "Player");
            string victim = _names.TryGetValue(k.Victim, out var vn) ? vn : (k.Victim == _localId ? _myName : "Player");
            _hud.AddKill(killer, victim, k.Weapon, k.Fall);
            if (k.Killer == _localId && k.Victim != _localId) _audio.Kill();
            if (k.Victim == _localId)
            {
                _localDead = true;
                _state.Vel.X = 0; _state.Vel.Y = 0; _state.Vel.Z = 0;
                _input.SetEnabled(false);
            }
        };

        _net.OnDamage = d =>
        {
            if (d.Victim == _localId)
            {
                _localHp = d.NewHp;
                if (d.DirToSource != null)
                {
                    var worldDir = new Vec3(d.DirToSource[0], d.DirToSource[1], d.DirToSource[2]);
                    _hud.DamageFrom(ViewRelative(worldDir, _state.Yaw));
                }
                else _hud.DamageFrom(new Vec3(0, 0, -1));
            }
            else
            {
                _hud.Hitmarker();
                _audio.Hitmarker();
            }
        };

        _net.OnDetonate = det =>
        {
            if (det.Impulses == null) return;
            foreach (var imp in det.Impulses)
            {
                if (imp.Id != _localId) continue;
                if (_selfDetonationGuard > 0) continue;
                Movement.ApplyImpulse(_state, imp.Impulse[0], imp.Impulse[1], imp.Impulse[2]);
            }
        };

        _net.OnSpawnProj = sp =>
        {
            if (sp.Owner == _localId) return;
            var dir = new Vec3(sp.Vel[0], sp.Vel[1], sp.Vel[2]);
            double len = Length(dir);
            if (len < EPSILON) len = 1;
            dir.X /= len; dir.Y /= len; dir.Z /= len;
            _projectiles.Spawn(sp.Kind, new Vec3(sp.Pos[0], sp.Pos[1], sp.Pos[2]), dir, sp.Owner);
        };

        _net.OnCorrection = c =>
        {
            VMath.Set(_state.Pos, c.Pos[0], c.Pos[1], c.Pos[2]);
            VMath.Set(_state.Vel, c.Vel[0], c.Vel[1], c.Vel[2]);
        };

        _net.OnClose = () =>
        {
            _remotes.HideAll();
            _dummy.Visible = true;
            _frozen = false;
            _localDead = false;
            _returnToLobby = true;
        };
    }

    // ---- firing ----

    private void FireWeapon(int slot, double yaw, double pitch)
    {
        _audio.Shoot(slot);

        var eye = V3(); EyeOut(eye);
        var fwd = ViewForward(yaw, pitch);
        var muzzle = V3(eye.X + fwd.X * MuzzleOffset, eye.Y + fwd.Y * MuzzleOffset, eye.Z + fwd.Z * MuzzleOffset);

        if (_online && _net != null)
            _net.SendShoot(slot, new[] { eye.X, eye.Y, eye.Z }, new[] { fwd.X, fwd.Y, fwd.Z });

        if (slot == 1)
        {
            double spread = Clamp(_bloom, Tuning.Ar.BloomMin, Tuning.Ar.BloomMax);
            var dir = V3();
            Hitscan.ApplyBloom(dir, fwd, spread, _shotSeq++);
            if (_online)
            {
                var targets = _remotes.LiveTargets();
                var res = Hitscan.Resolve(eye, dir, Tuning.Ar.Range, _world, targets);
                _particles.Tracer(muzzle, res.Point);
                if (res.Kind == HitKind.World) _particles.Impact(res.Point, res.Normal);
            }
            else
            {
                var targets = new List<CapsuleTarget> { _dummy.CapsuleTarget() };
                var res = Hitscan.Resolve(eye, dir, Tuning.Ar.Range, _world, targets);
                _particles.Tracer(muzzle, res.Point);
                if (res.Kind == HitKind.Entity && res.EntityId == _dummy.Id)
                {
                    _dummy.ApplyDamage(Tuning.Ar.Damage);
                    _hud.Hitmarker();
                    _audio.Hitmarker();
                }
                else if (res.Kind == HitKind.World) _particles.Impact(res.Point, res.Normal);
            }
            _bloom = Math.Min(Tuning.Ar.BloomMax, _bloom + Tuning.Ar.BloomPerShot);
            _viewmodel.OnFire(1);
        }
        else if (slot == 2)
        {
            _projectiles.Spawn(ProjKind.Rocket, muzzle, fwd, _localId);
            if (_online) _selfDetonationGuard = SelfGuardTicks;
            _viewmodel.OnFire(2);
        }
        else if (slot == 3)
        {
            if (!_online)
            {
                var k = Tuning.Knife;
                var c = _dummy.CapsuleTarget().Center;
                var toDummy = V3(c.X - eye.X, c.Y - eye.Y, c.Z - eye.Z);
                double along = toDummy.X * fwd.X + toDummy.Y * fwd.Y + toDummy.Z * fwd.Z;
                if (along > 0 && along <= k.Range)
                {
                    double px = toDummy.X - fwd.X * along;
                    double py = toDummy.Y - fwd.Y * along;
                    double pz = toDummy.Z - fwd.Z * along;
                    double lateral = Math.Sqrt(px * px + py * py + pz * pz);
                    if (lateral <= k.HitboxHalfWidth + _dummy.Radius)
                    {
                        var dummyFwd = V3(-Math.Sin(_dummy.FacingYaw), 0, -Math.Cos(_dummy.FacingYaw));
                        double backDot = dummyFwd.X * fwd.X + dummyFwd.Z * fwd.Z;
                        bool backstab = backDot > k.BackstabDotThreshold;
                        _dummy.ApplyDamage(backstab ? k.BackstabDamage : k.Damage);
                        _hud.Hitmarker();
                        _audio.Hitmarker();
                    }
                }
            }
            _viewmodel.OnFire(3);
        }
        else if (slot == 4)
        {
            _projectiles.Spawn(ProjKind.Grenade, muzzle, fwd, _localId);
            if (_online) _selfDetonationGuard = SelfGuardTicks;
            _viewmodel.OnFire(4);
        }
    }

    private void Respawn()
    {
        Copy(_state.Pos, _spawnCenter);
        _state.Vel.X = 0; _state.Vel.Y = 0; _state.Vel.Z = 0;
        _state.Grounded = false;
        _state.MoveState = MoveStateName.Air;
        _state.CapsuleHalf = Movement.StandHalf();
        _state.PendingImpulse.X = 0; _state.PendingImpulse.Y = 0; _state.PendingImpulse.Z = 0;
        _localHp = Tuning.Combat.SpawnHealth;
        _net?.SetHp(_localHp);
    }

    // ---- IProjectileHooks ----
    public int LocalPlayerId => _localId;

    public List<CapsuleTarget> Targets()
    {
        var list = new List<CapsuleTarget>();
        if (!_online)
            list.Add(_dummy.CapsuleTarget());
        list.Add(new CapsuleTarget { Id = _localId, Center = _state.Pos, Radius = _m.Radius, HalfHeight = _state.CapsuleHalf });
        return list;
    }

    public void OnDamage(int id, double amount)
    {
        if (_online) return;
        if (id == _dummy.Id) _dummy.ApplyDamage(amount);
        else if (id == _localId) { _localHp -= amount; if (_localHp <= 0) Respawn(); }
    }

    public void OnImpulse(int id, Vec3 impulse)
    {
        if (id == _localId) Movement.ApplyImpulse(_state, impulse.X, impulse.Y, impulse.Z);
    }

    public void OnDetonate(Vec3 pos) => _audio.ExplosionAt(pos);

    // ---- helpers ----

    private void EyeOut(Vec3 outV) => Movement.EyePosition(_state, outV);

    private static Vec3 ViewForward(double yaw, double pitch)
    {
        double cp = Math.Cos(pitch);
        return V3(-Math.Sin(yaw) * cp, Math.Sin(pitch), -Math.Cos(yaw) * cp);
    }

    private static Vec3 ViewRelative(Vec3 worldDir, double yaw)
    {
        double sy = Math.Sin(yaw), cy = Math.Cos(yaw);
        double right = worldDir.X * cy - worldDir.Z * sy;
        double fwd = -worldDir.X * sy - worldDir.Z * cy;
        return V3(right, worldDir.Y, -fwd);
    }

    private static string WeaponName(int slot) => slot switch
    {
        1 => Tuning.Ar.Name,
        2 => Tuning.Rocket.Name,
        3 => Tuning.Knife.Name,
        _ => Tuning.Grenade.Name,
    };

    private static string ResolveWsUrl()
    {
        string env = OS.GetEnvironment("WS_URL");
        if (!string.IsNullOrEmpty(env)) return env;
        foreach (var arg in OS.GetCmdlineUserArgs())
            if (arg.StartsWith("--ws=")) return arg.Substring("--ws=".Length);
        return "ws://127.0.0.1:8090";
    }
}
