// Authoritative FFA game room. One Room == one match. The room owns the
// authoritative state for damage (HP), ammo, fire cooldowns, and server-side
// projectiles; movement stays CLIENT-authoritative and the room only sanity-checks
// it (MovementValidator) and snaps offenders back (Correction). Ported from
// server/src/room.ts. Engine-free: talks to sockets through delegates.

using System;
using System.Collections.Generic;
using WebRivals.Shared;
using WebRivals.Shared.Sim;
using static WebRivals.Shared.VMath;

namespace WebRivals.Server;

public sealed class Room
{
    private static readonly double SERVER_DT = 1.0 / Tuning.World.ServerHz;
    private static readonly int[] TICKS_PER_SNAPSHOT_PATTERN = { 2, 1 };
    private static readonly int MAX_PLAYERS = Tuning.World.MaxPlayers;

    private static readonly double CAP_RADIUS = Tuning.Movement.Radius;
    private static readonly double CAP_HALF = Tuning.Movement.StandHeight / 2 - Tuning.Movement.Radius;

    private struct WeaponConfig
    {
        public double FireInterval;
        public bool UsesClip;
        public int MagSize;
        public int Reserve;
    }

    private static Dictionary<int, WeaponConfig> WeaponConfigs() => new()
    {
        { 1, new WeaponConfig { FireInterval = Tuning.Ar.FireInterval, UsesClip = true, MagSize = Tuning.Ar.MagSize, Reserve = Tuning.Ar.ReserveAmmo } },
        { 2, new WeaponConfig { FireInterval = Tuning.Rocket.FireInterval, UsesClip = true, MagSize = Tuning.Rocket.MagSize, Reserve = Tuning.Rocket.ReserveAmmo } },
        { 3, new WeaponConfig { FireInterval = Tuning.Knife.SwingTime, UsesClip = false, MagSize = 0, Reserve = 0 } },
        { 4, new WeaponConfig { FireInterval = 0, UsesClip = false, MagSize = Tuning.Grenade.Count, Reserve = 0 } },
    };

    private sealed class PlayerAmmo { public int Clip; public int Reserve; }

    private sealed class RoomPlayer
    {
        public int Id;
        public int ConnId;
        public string Name;
        public Vec3 Pos;
        public Vec3 Vel;
        public double Yaw;
        public double Pitch;
        public int Buttons;
        public string Anim;
        public double Hp;
        public int Weapon;
        public Dictionary<int, PlayerAmmo> Ammo;
        public Dictionary<int, double> Cooldowns;
        public bool Alive;
        public int LastSeq;
        public int Frags;
        public double RespawnTimer;
    }

    public readonly string Id;
    public readonly string MapId;

    private readonly MapData _map;
    private readonly MockTraceWorld _world;
    private readonly MovementValidator _validator;
    private readonly LagComp _lagcomp;
    private readonly Dictionary<int, WeaponConfig> _cfg = WeaponConfigs();

    private readonly Dictionary<int, RoomPlayer> _players = new();
    private readonly List<Projectile> _projectiles = new();
    private int _nextProjId = 1;

    private int _tick = 0;
    private int _snapAccum = 0;
    private int _snapCountdown = 0;
    private bool _destroyed = false;
    private double _tickAccum = 0; // drives the fixed-step tick from variable frame dt

    private readonly MatchState _match = Match.InitMatch();
    private bool _frozen = false;
    private string _lastSentPhase = null;
    private int _matchStateAccum = 0;

    private readonly ProjectileStep _stepOut = new() { Detonated = false, Point = V3() };
    private readonly List<PlayerCapsule> _capsScratch = new();

    private readonly Action<int, string> _send;   // (connId, data)
    private readonly Action<int> _closeConn;       // (connId)
    private readonly Func<double> _clock;          // ms

    private double Now() => _clock();

    public Room(string id, string mapId, MapData map, Action<int, string> send, Action<int> closeConn, Func<double> clock)
    {
        Id = id;
        MapId = mapId;
        _map = map;
        _world = new MockTraceWorld(map.Solids);
        _validator = new MovementValidator(_world);
        _lagcomp = new LagComp();
        _send = send;
        _closeConn = closeConn;
        _clock = clock;
    }

    public static Room Create(string id, string mapId, Action<int, string> send, Action<int> closeConn, Func<double> clock)
        => new Room(id, mapId, Maps.GetMap(mapId), send, closeConn, clock);

    public int PlayerCount => _players.Count;
    public bool IsFull => _players.Count >= MAX_PLAYERS;
    public bool IsEmpty => _players.Count == 0;
    public bool IsFinished => false;
    public MatchState MatchStateRef => _match;
    public bool HasPlayer(int id) => _players.ContainsKey(id);

    // ---- membership ----

    public bool AddPlayer(int connId, int id, string name)
    {
        if (IsFull) return false;

        var spawn = PickSpawn();
        var pos = FromTuple(spawn.Pos);

        var player = new RoomPlayer
        {
            Id = id,
            ConnId = connId,
            Name = name,
            Pos = pos,
            Vel = new Vec3(0, 0, 0),
            Yaw = spawn.Yaw * Math.PI / 180,
            Pitch = 0,
            Buttons = 0,
            Anim = "idle",
            Hp = Tuning.Combat.SpawnHealth,
            Weapon = 1,
            Ammo = FreshAmmo(),
            Cooldowns = new Dictionary<int, double> { { 1, 0 }, { 2, 0 }, { 3, 0 }, { 4, 0 } },
            Alive = true,
            LastSeq = 0,
            Frags = 0,
            RespawnTimer = 0,
        };
        _players[id] = player;

        _validator.Reset(id, pos);
        _lagcomp.Record(id, Center(pos), CAP_RADIUS, CAP_HALF, Now());

        foreach (var other in _players.Values)
        {
            if (other.Id == id) continue;
            SendTo(other, new OpponentMsg { Present = true, Name = player.Name, Id = player.Id });
        }

        BroadcastMatchState();
        return true;
    }

    public void SendRosterTo(int id)
    {
        if (!_players.TryGetValue(id, out var player)) return;
        foreach (var other in _players.Values)
        {
            if (other.Id == id) continue;
            SendTo(player, new OpponentMsg { Present = true, Name = other.Name, Id = other.Id });
        }
    }

    public void RemovePlayer(int id)
    {
        if (!_players.TryGetValue(id, out var player)) return;

        foreach (var other in _players.Values)
        {
            if (other.Id == id) continue;
            SendTo(other, new OpponentMsg { Present = false, Name = player.Name, Id = id });
        }

        _players.Remove(id);
        _validator.Reset(id, new Vec3(0, 0, 0));
        _lagcomp.Remove(id);
        _world.RemoveEntity(id);
        BroadcastMatchState();
    }

    private Dictionary<int, PlayerAmmo> FreshAmmo() => new()
    {
        { 1, new PlayerAmmo { Clip = _cfg[1].MagSize, Reserve = _cfg[1].Reserve } },
        { 2, new PlayerAmmo { Clip = _cfg[2].MagSize, Reserve = _cfg[2].Reserve } },
        { 3, new PlayerAmmo { Clip = 0, Reserve = 0 } },
        { 4, new PlayerAmmo { Clip = _cfg[4].MagSize, Reserve = 0 } },
    };

    // ---- message ingest ----

    public void IngestInput(int id, InputMsg msg)
    {
        if (!_players.TryGetValue(id, out var player)) return;
        if (msg.Seq <= player.LastSeq) return;
        double dt = SERVER_DT;
        double now = Now();

        var report = new MoveReport
        {
            Pos = FromTuple(msg.Pos),
            Vel = FromTuple(msg.Vel),
            Yaw = msg.Yaw,
            Pitch = msg.Pitch,
        };
        var result = _validator.Accept(id, report, dt, now);

        player.Pos = result.CorrectedPos;
        player.Vel = result.CorrectedVel;
        if (!result.Ok)
        {
            SendTo(player, new CorrectionMsg { Pos = ToTuple(result.CorrectedPos), Vel = ToTuple(result.CorrectedVel), Seq = msg.Seq });
        }

        player.Yaw = msg.Yaw;
        player.Pitch = msg.Pitch;
        player.Buttons = msg.Buttons;
        player.LastSeq = msg.Seq;
        player.Anim = AnimFromVel(player.Vel, msg.Buttons);

        const int LAUNCH_BIT = 1 << 3;
        if ((msg.Events & LAUNCH_BIT) != 0) _validator.NoteImpulse(id, now);
    }

    public void IngestShoot(int id, ShootMsg msg)
    {
        if (_frozen) return;
        if (!_players.TryGetValue(id, out var shooter) || !shooter.Alive) return;

        int weapon = msg.Weapon;
        if (!_cfg.TryGetValue(weapon, out var cfg)) return;

        if (shooter.Cooldowns[weapon] > 1e-4) return;

        var ammo = shooter.Ammo[weapon];
        if (cfg.UsesClip)
        {
            if (ammo.Clip <= 0) return;
        }
        else if (weapon == 4)
        {
            if (ammo.Clip <= 0) return;
        }

        if (cfg.UsesClip || weapon == 4) ammo.Clip -= 1;
        shooter.Cooldowns[weapon] = cfg.FireInterval;

        var origin = FromTuple(msg.Origin);
        var dir = new Vec3(0, 0, 0);
        Normalize(dir, FromTuple(msg.Dir));

        if (weapon == 1)
            ResolveHitscan(shooter, origin, dir, msg.ClientTime);
        else if (weapon == 2)
            SpawnProjectile(ProjKind.Rocket, shooter, origin, dir, Tuning.Rocket.ProjSpeed, 0);
        else if (weapon == 4)
            SpawnProjectile(ProjKind.Grenade, shooter, origin, dir, Tuning.Grenade.ProjSpeed, Tuning.Grenade.Fuse);
    }

    public void IngestPing(int id, PingMsg msg)
    {
        if (!_players.TryGetValue(id, out var player)) return;
        SendTo(player, new PongMsg { ClientTime = msg.ClientTime, ServerTime = Now() });
    }

    // ---- shot resolution ----

    private void ResolveHitscan(RoomPlayer shooter, Vec3 origin, Vec3 dir, double clientTime)
    {
        double range = Tuning.Ar.Range;
        double t = clientTime - Tuning.World.InterpDelayMs;

        var hit = _lagcomp.RewindRay(shooter.Id, origin, dir, range, t);
        if (hit == null) return;

        var occ = _world.Raycast(origin, dir, hit.Value.Distance);
        if (occ != null && occ.Fraction < 1)
        {
            double wallDist = occ.Fraction * hit.Value.Distance;
            if (wallDist < hit.Value.Distance - 1e-3) return;
        }

        if (!_players.TryGetValue(hit.Value.Id, out var victim) || !victim.Alive) return;
        ApplyDamage(victim, Tuning.Ar.Damage, shooter.Id, 1);
    }

    private void SpawnProjectile(ProjKind kind, RoomPlayer owner, Vec3 origin, Vec3 dir, double speed, double fuse)
    {
        var vel = new Vec3(dir.X * speed, dir.Y * speed, dir.Z * speed);
        int id = _nextProjId++;
        var proj = Projectiles.MakeProjectile(id, kind, origin, vel, owner.Id, fuse);
        _projectiles.Add(proj);
        Broadcast(new SpawnProjMsg { Id = id, Kind = KindStr(kind), Owner = owner.Id, Pos = ToTuple(origin), Vel = ToTuple(vel) });
    }

    // ---- damage / death ----

    private void ApplyDamage(RoomPlayer victim, double amount, int source, int weapon, bool fall = false)
    {
        if (amount <= 0 || !victim.Alive) return;
        victim.Hp -= amount;
        if (victim.Hp < 0) victim.Hp = 0;

        RoomPlayer attacker = source >= 0 && _players.TryGetValue(source, out var a) ? a : null;
        double[] dirToSource = attacker != null ? DirBetween(victim.Pos, attacker.Pos) : null;

        Broadcast(new DamageMsg { Victim = victim.Id, Amount = amount, NewHp = victim.Hp, Source = source, Weapon = weapon, DirToSource = dirToSource });

        if (victim.Hp <= 0)
        {
            victim.Alive = false;
            victim.RespawnTimer = Tuning.World.RespawnDelaySec;
            if (source >= 0 && source != victim.Id && _players.TryGetValue(source, out var killer))
                killer.Frags += 1;
            Broadcast(new KillMsg { Killer = source, Victim = victim.Id, Weapon = weapon, Fall = fall });
        }
    }

    private double[] DirBetween(Vec3 from, Vec3 to)
    {
        var d = new Vec3(to.X - from.X, to.Y - from.Y, to.Z - from.Z);
        Normalize(d, d);
        return ToTuple(d);
    }

    // ---- the authoritative loop (driven by GameServer each frame) ----

    public void Update(double frameDt)
    {
        if (_destroyed) return;
        _tickAccum += frameDt;
        // Clamp catch-up so a long frame doesn't spiral.
        double maxAccum = Tuning.World.MaxCatchupMs / 1000.0;
        if (_tickAccum > maxAccum) _tickAccum = maxAccum;
        while (_tickAccum >= SERVER_DT)
        {
            TickOnce();
            _tickAccum -= SERVER_DT;
        }
    }

    public void TickOnce()
    {
        if (_destroyed) return;
        double dt = SERVER_DT;
        double now = Now();
        _tick++;

        foreach (var p in _players.Values)
            foreach (int slot in new[] { 1, 2, 3, 4 })
                if (p.Cooldowns[slot] > 0)
                {
                    p.Cooldowns[slot] -= dt;
                    if (p.Cooldowns[slot] < 0) p.Cooldowns[slot] = 0;
                }

        if (!_frozen)
        {
            StepProjectiles(dt, now);

            foreach (var p in _players.Values)
                if (p.Alive && p.Pos.Y < _map.KillY)
                    ApplyDamage(p, p.Hp, -1, 0, true);

            foreach (var p in _players.Values)
            {
                if (p.Alive) continue;
                p.RespawnTimer -= dt;
                if (p.RespawnTimer <= 0) RespawnPlayer(p);
            }
        }

        foreach (var p in _players.Values)
            _lagcomp.Record(p.Id, Center(p.Pos), CAP_RADIUS, CAP_HALF, now);

        StepMatchMachine(dt);
        MaybeBroadcastMatchState();

        if (_snapCountdown <= 0)
        {
            SendSnapshot(now);
            _snapCountdown = TICKS_PER_SNAPSHOT_PATTERN[_snapAccum % TICKS_PER_SNAPSHOT_PATTERN.Length];
            _snapAccum++;
        }
        _snapCountdown--;
    }

    private void StepMatchMachine(double dt)
    {
        int topFrags = 0;
        int topFragsPlayer = -1;
        foreach (var p in _players.Values)
        {
            if (p.Frags > topFrags || (p.Frags == topFrags && topFragsPlayer >= 0 && p.Id < topFragsPlayer))
            {
                if (p.Frags > topFrags)
                {
                    topFrags = p.Frags;
                    topFragsPlayer = p.Id;
                }
                else if (p.Frags == topFrags && p.Frags > 0)
                {
                    topFragsPlayer = Math.Min(topFragsPlayer, p.Id);
                }
            }
            else if (topFragsPlayer < 0 && p.Frags > 0)
            {
                topFrags = p.Frags;
                topFragsPlayer = p.Id;
            }
        }

        var ctx = new MatchTickCtx { ConnectedCount = _players.Count, TopFrags = topFrags, TopFragsPlayer = topFragsPlayer };
        var events = Match.StepMatch(_match, ctx, dt);
        foreach (var ev in events)
        {
            switch (ev.Type)
            {
                case MatchEventType.MatchStart:
                    _frozen = false;
                    break;
                case MatchEventType.MatchEnd:
                    _frozen = true;
                    break;
                case MatchEventType.Reset:
                    foreach (var p in _players.Values)
                    {
                        p.Frags = 0;
                        RespawnPlayer(p);
                    }
                    _frozen = false;
                    break;
            }
        }
    }

    private void RespawnPlayer(RoomPlayer p)
    {
        var spawn = PickSpawn();
        var pos = FromTuple(spawn.Pos);
        p.Pos = pos;
        p.Vel = new Vec3(0, 0, 0);
        p.Yaw = spawn.Yaw * Math.PI / 180;
        p.Pitch = 0;
        p.Hp = Tuning.Combat.SpawnHealth;
        p.Alive = true;
        p.RespawnTimer = 0;
        p.Weapon = 1;
        p.Ammo = FreshAmmo();
        p.Cooldowns = new Dictionary<int, double> { { 1, 0 }, { 2, 0 }, { 3, 0 }, { 4, 0 } };
        p.Anim = "idle";
        _validator.Reset(p.Id, pos);
        _lagcomp.Record(p.Id, Center(pos), CAP_RADIUS, CAP_HALF, Now());
        SendTo(p, new RespawnMsg { Id = p.Id, Pos = ToTuple(pos), Yaw = p.Yaw });
    }

    private SpawnPoint PickSpawn()
    {
        var spawns = _map.Spawns;
        var best = spawns[0];
        double bestScore = double.NegativeInfinity;
        foreach (var s in spawns)
        {
            double nearest = double.PositiveInfinity;
            foreach (var p in _players.Values)
            {
                if (!p.Alive) continue;
                double dx = p.Pos.X - s.Pos[0];
                double dz = p.Pos.Z - s.Pos[2];
                double d2 = dx * dx + dz * dz;
                if (d2 < nearest) nearest = d2;
            }
            if (nearest > bestScore)
            {
                bestScore = nearest;
                best = s;
            }
        }
        return best;
    }

    private void StepProjectiles(double dt, double now)
    {
        if (_projectiles.Count == 0) return;
        var caps = BuildCapsules();

        for (int i = _projectiles.Count - 1; i >= 0; i--)
        {
            var proj = _projectiles[i];
            var segStart = new Vec3(proj.Pos.X, proj.Pos.Y, proj.Pos.Z);
            Projectiles.StepProjectile(proj, _world, dt, _stepOut);

            Vec3 segEnd = _stepOut.Detonated ? _stepOut.Point : proj.Pos;

            int directHitId = -1;
            Vec3 center = null;
            if (proj.Kind == ProjKind.Rocket)
            {
                var ph = Projectiles.ProjectilePlayerHit(segStart, segEnd, caps, proj.OwnerId);
                if (ph != null)
                {
                    directHitId = ph.Id;
                    center = ph.Point;
                }
            }

            if (center == null && !_stepOut.Detonated) continue;
            if (center == null) center = new Vec3(_stepOut.Point.X, _stepOut.Point.Y, _stepOut.Point.Z);

            var hits = Projectiles.ComputeExplosion(proj.Kind, center, proj.OwnerId, caps, _world, directHitId);

            var impulses = new List<ImpulseEntry>();
            foreach (var hit in hits)
            {
                if (!_players.TryGetValue(hit.Id, out var target)) continue;
                if (hit.Damage > 0 && target.Alive)
                {
                    int weapon = proj.Kind == ProjKind.Rocket ? 2 : 4;
                    ApplyDamage(target, hit.Damage, proj.OwnerId, weapon);
                }
                if (hit.Impulse.X != 0 || hit.Impulse.Y != 0 || hit.Impulse.Z != 0)
                {
                    impulses.Add(new ImpulseEntry { Id = hit.Id, Impulse = ToTuple(hit.Impulse) });
                    _validator.NoteImpulse(hit.Id, now);
                }
            }

            Broadcast(new DetonateMsg { Id = proj.Id, Pos = ToTuple(center), Kind = KindStr(proj.Kind), Impulses = impulses.ToArray() });
            _projectiles.RemoveAt(i);
        }
    }

    private List<PlayerCapsule> BuildCapsules()
    {
        _capsScratch.Clear();
        foreach (var p in _players.Values)
        {
            if (!p.Alive) continue;
            _capsScratch.Add(new PlayerCapsule { Id = p.Id, Center = Center(p.Pos), Radius = CAP_RADIUS, HalfHeight = CAP_HALF });
        }
        return _capsScratch;
    }

    private Vec3 Center(Vec3 pos) => new Vec3(pos.X, pos.Y, pos.Z);

    private void SendSnapshot(double now)
    {
        var players = new List<PlayerSnap>();
        foreach (var p in _players.Values)
        {
            bool frozen = _frozen;
            players.Add(new PlayerSnap
            {
                Id = p.Id,
                Pos = ToTuple(p.Pos),
                Vel = frozen ? new double[] { 0, 0, 0 } : ToTuple(p.Vel),
                Yaw = p.Yaw,
                Pitch = p.Pitch,
                Anim = frozen ? "idle" : p.Anim,
                Hp = p.Hp,
                Weapon = p.Weapon,
            });
        }
        var projectiles = new List<ProjSnap>();
        foreach (var proj in _projectiles)
            projectiles.Add(new ProjSnap { Id = proj.Id, Kind = KindStr(proj.Kind), Pos = ToTuple(proj.Pos), Vel = ToTuple(proj.Vel) });

        Broadcast(new SnapshotMsg { Tick = _tick, ServerTime = now, Players = players.ToArray(), Projectiles = projectiles.ToArray() });
    }

    private void BroadcastMatchState()
    {
        _lastSentPhase = _match.Phase;
        _matchStateAccum = 0;
        Broadcast(MatchStateMsgBuild());
    }

    private MatchStateMsg MatchStateMsgBuild()
    {
        var scores = new List<FragEntry>();
        foreach (var p in _players.Values) scores.Add(new FragEntry { Id = p.Id, Frags = p.Frags });
        return new MatchStateMsg
        {
            Phase = _match.Phase,
            Timer = Math.Max(0, _match.Phase == "matchEnd" ? Math.Ceiling(_match.Clock) : Math.Floor(_match.Clock)),
            FragLimit = Tuning.World.FragLimit,
            Scores = scores.ToArray(),
            Winner = _match.MatchWinner,
        };
    }

    private void MaybeBroadcastMatchState()
    {
        bool changed = _match.Phase != _lastSentPhase;
        _matchStateAccum++;
        bool heartbeat = _matchStateAccum >= Tuning.World.ServerHz;
        if (changed || heartbeat) BroadcastMatchState();
    }

    // ---- transport ----

    private void Broadcast(Message msg)
    {
        string data = Protocol.Encode(msg);
        foreach (var p in _players.Values) RawSend(p, data);
    }

    private void SendTo(RoomPlayer player, Message msg) => RawSend(player, Protocol.Encode(msg));

    private void RawSend(RoomPlayer player, string data)
    {
        try { _send(player.ConnId, data); } catch { /* dead socket; close handler evicts */ }
    }

    public void Destroy()
    {
        if (_destroyed) return;
        _destroyed = true;
        foreach (var p in _players.Values)
        {
            try { _closeConn(p.ConnId); } catch { }
        }
        _players.Clear();
        _projectiles.Clear();
    }

    private static string KindStr(ProjKind k) => k == ProjKind.Rocket ? "rocket" : "grenade";

    private static string AnimFromVel(Vec3 vel, int buttons)
    {
        const int SLIDE = 1 << 6;
        if ((buttons & SLIDE) != 0) return "slide";
        bool grounded = Math.Abs(vel.Y) < 0.5;
        if (!grounded) return "air";
        double speed = Math.Sqrt(vel.X * vel.X + vel.Z * vel.Z);
        return speed > 0.5 ? "run" : "idle";
    }
}
