// NetClient: the single seam between the client and the authoritative server.
// Owns the live Transport, the protocol codec, clock sync, and the snapshot
// buffer. Ported from client/src/net/connection.ts.
//
// Authority: movement is client-authoritative (we SEND pos/vel each tick, react
// only to a Correction); damage is server-authoritative; rockets/grenades are
// reconciled cosmetically while own self-knockback stays predicted.

using System;
using Godot;
using WebRivals.Shared;

namespace WebRivals.Client.Net;

public sealed class NetClient
{
    public readonly ClockSync Clock = new();
    public readonly SnapshotBuffer Snapshots = new();

    private int _playerId = -1;
    private string _mapId = "";
    private bool _connected = false;
    private bool _joined = false;
    private double _hp = Tuning.Combat.SpawnHealth;
    private double _lastSnapServerTime = double.NegativeInfinity;

    private readonly ITransport _transport;
    private string _pendingName = "";
    private string _pendingRoomCode = null;
    private int _inputSeq = 0;
    private int _shootSeq = 0;
    private double _pingAccumMs = 0;
    private const double PING_INTERVAL_MS = 2000;

    // ---- event hooks ----
    public Action<DamageMsg> OnDamage = _ => { };
    public Action<KillMsg> OnKill = _ => { };
    public Action<MatchStateMsg> OnMatchState = _ => { };
    public Action<RespawnMsg> OnRespawn = _ => { };
    public Action<OpponentMsg> OnOpponent = _ => { };
    public Action<SpawnProjMsg> OnSpawnProj = _ => { };
    public Action<DetonateMsg> OnDetonate = _ => { };
    public Action<CorrectionMsg> OnCorrection = _ => { };
    public Action OnClose = () => { };
    public Action OnJoined = () => { };

    public NetClient(ITransport transport)
    {
        _transport = transport;
        _transport.OnMessage = HandleMessage;
        _transport.OnOpen = HandleOpen;
        _transport.OnClose = HandleClose;
    }

    public void Start(string name, string roomCode)
    {
        _pendingName = name;
        _pendingRoomCode = roomCode;
        if (_transport.IsOpen) HandleOpen();
    }

    /// <summary>Pump the transport + ping cadence. Call once per frame.</summary>
    public void Poll(double frameDtMs)
    {
        _transport.Poll();
        if (_connected)
        {
            _pingAccumMs += frameDtMs;
            if (_pingAccumMs >= PING_INTERVAL_MS)
            {
                _pingAccumMs = 0;
                SendPing();
            }
        }
    }

    private void HandleOpen()
    {
        if (_connected) return;
        _connected = true;
        _transport.Send(Protocol.Encode(new HelloMsg { Name = _pendingName, RoomCode = _pendingRoomCode }));
        SendPing();
        _pingAccumMs = 0;
    }

    private void HandleClose()
    {
        _connected = false;
        _joined = false;
        OnClose();
    }

    public void CloseConn() => _transport.Close();

    // ---- outgoing ----

    public void SendInput(double[] pos, double[] vel, double yaw, double pitch, int buttons, int events)
    {
        if (!_joined) return;
        _transport.Send(Protocol.Encode(new InputMsg
        {
            Seq = ++_inputSeq,
            ClientTime = ClientTime(),
            Pos = pos, Vel = vel, Yaw = yaw, Pitch = pitch, Buttons = buttons, Events = events,
        }));
    }

    public void SendShoot(int weapon, double[] origin, double[] dir)
    {
        if (!_joined) return;
        _transport.Send(Protocol.Encode(new ShootMsg
        {
            Seq = ++_shootSeq, Weapon = weapon, Origin = origin, Dir = dir, ClientTime = ServerNow(),
        }));
    }

    private void SendPing()
    {
        if (!_connected) return;
        _transport.Send(Protocol.Encode(new PingMsg { ClientTime = ClientTime() }));
    }

    // ---- incoming ----

    private void HandleMessage(string data)
    {
        var msg = Protocol.Decode(data);
        if (msg == null) return;

        switch (msg)
        {
            case JoinedMsg j:
                _playerId = j.PlayerId;
                _mapId = j.MapId;
                _joined = true;
                OnJoined();
                break;
            case SnapshotMsg s:
                Snapshots.Insert(s);
                if (s.ServerTime > _lastSnapServerTime) _lastSnapServerTime = s.ServerTime;
                break;
            case PongMsg p:
                Clock.OnPong(p.ClientTime, p.ServerTime, ClientTime());
                break;
            case DamageMsg d:
                if (d.Victim == _playerId) _hp = d.NewHp;
                OnDamage(d);
                break;
            case SpawnProjMsg sp:
                OnSpawnProj(sp);
                break;
            case DetonateMsg det:
                OnDetonate(det);
                break;
            case KillMsg k:
                OnKill(k);
                break;
            case MatchStateMsg ms:
                OnMatchState(ms);
                break;
            case RespawnMsg r:
                OnRespawn(r);
                break;
            case OpponentMsg o:
                OnOpponent(o);
                break;
            case CorrectionMsg c:
                OnCorrection(c);
                break;
        }
    }

    // ---- accessors ----
    public bool IsConnected => _connected && _joined;
    public bool IsJoined => _joined;
    public int PlayerId => _playerId;
    public string MapId => _mapId;
    public double Hp => _hp;
    public void SetHp(double hp) => _hp = hp;

    public double SnapshotAgeMs(double nowMs)
        => double.IsNegativeInfinity(_lastSnapServerTime) ? double.PositiveInfinity : ServerTime(nowMs) - _lastSnapServerTime;

    private double ClientTime() => Time.GetTicksMsec();
    private double ServerNow() => Clock.ServerTimeEstimate(ClientTime());
    public double ServerTime(double nowMs) => Clock.ServerTimeEstimate(nowMs);
}
