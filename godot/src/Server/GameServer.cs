// Game server entry (the lobby). Accepts WebSocket connections, awaits each
// client's `hello`, allocates a Room (private by code, or quick-match into the
// first room with a free slot), and routes every later message to that player's
// room. Rooms own all authoritative game state. Ported from server/src/index.ts.
//
// Runs as a Godot Node so it can be hosted headless: `godot --headless -- --server`.

using System;
using System.Collections.Generic;
using Godot;
using WebRivals.Shared;

namespace WebRivals.Server;

public partial class GameServer : Node
{
    private readonly WsServer _ws = new();
    private readonly Random _rng = new();

    // All live rooms by id.
    private readonly Dictionary<string, Room> _rooms = new();
    // connId -> the room they belong to.
    private readonly Dictionary<int, Room> _connRoom = new();
    // connId -> whether they've sent a valid hello yet.
    private readonly HashSet<int> _joined = new();

    private double _reaperAccum = 0;
    private int _port = 8090;

    public override void _Ready()
    {
        // Headless would otherwise busy-spin the main loop; cap to a steady rate
        // well above the 30Hz tick / 20Hz snapshot cadence so polling stays prompt.
        Engine.MaxFps = 120;
        _port = ResolvePort();

        _ws.OnOpen = OnOpen;
        _ws.OnMessage = OnMessage;
        _ws.OnClose = OnClose;

        var err = _ws.Listen(_port);
        if (err != Error.Ok)
        {
            GD.PrintErr($"[server] failed to listen on :{_port} ({err})");
            return;
        }
        GD.Print($"[server] Web Rivals listening on :{_port} — sim {Tuning.World.ServerHz}Hz, snapshots {Tuning.World.SnapshotHz}Hz");
    }

    public override void _Process(double delta)
    {
        _ws.Poll();

        foreach (var room in _rooms.Values) room.Update(delta);

        // Reaper (~1Hz): destroy empty or finished rooms.
        _reaperAccum += delta;
        if (_reaperAccum >= 1.0)
        {
            _reaperAccum = 0;
            var dead = new List<string>();
            foreach (var kv in _rooms)
            {
                var room = kv.Value;
                if (room.IsEmpty || room.IsFinished)
                {
                    room.Destroy();
                    dead.Add(kv.Key);
                    GD.Print($"[server] room {kv.Key} {(room.IsFinished ? "finished" : "empty")} -> destroyed");
                }
            }
            foreach (var id in dead) _rooms.Remove(id);
        }
    }

    public override void _ExitTree() => _ws.Stop();

    private double NowMs() => Time.GetTicksMsec();

    private void OnOpen(int connId)
    {
        // Connection established; await its hello (handled in OnMessage).
    }

    private void OnMessage(int connId, string data)
    {
        var msg = Protocol.Decode(data);
        if (msg == null) return;

        if (!_joined.Contains(connId))
        {
            if (msg is not HelloMsg hello) return; // ignore anything before hello
            _joined.Add(connId);
            string name = Protocol.SanitizeName(hello.Name);

            Room room;
            try { room = AllocateRoom(hello.RoomCode); }
            catch (Exception e)
            {
                GD.PrintErr($"[server] failed to allocate room for #{connId}: {e.Message}");
                _ws.Close(connId);
                return;
            }

            bool added = room.AddPlayer(connId, connId, name);
            if (!added)
            {
                _ws.Close(connId); // filled between allocation and add (race)
                return;
            }
            _connRoom[connId] = room;
            GD.Print($"[server] {name} (#{connId}) joined room {room.Id} ({room.PlayerCount}/{Tuning.World.MaxPlayers})");

            _ws.Send(connId, Protocol.Encode(new JoinedMsg
            {
                PlayerId = connId,
                RoomId = room.Id,
                MapId = room.MapId,
                ServerTime = NowMs(),
                YouAreReady = room.PlayerCount >= Tuning.World.WarmupMinPlayers,
            }));
            // Roster AFTER joined so the client has wired its onOpponent handler.
            room.SendRosterTo(connId);
            return;
        }

        if (!_connRoom.TryGetValue(connId, out var r)) return;

        switch (msg)
        {
            case InputMsg im: r.IngestInput(connId, im); break;
            case ShootMsg sm: r.IngestShoot(connId, sm); break;
            case PingMsg pm: r.IngestPing(connId, pm); break;
        }
    }

    private void OnClose(int connId)
    {
        GD.Print($"[server] #{connId} disconnected");
        _joined.Remove(connId);
        if (_connRoom.TryGetValue(connId, out var room))
        {
            room.RemovePlayer(connId);
            _connRoom.Remove(connId);
            if (room.IsEmpty)
            {
                room.Destroy();
                _rooms.Remove(room.Id);
                GD.Print($"[server] room {room.Id} empty -> destroyed");
            }
        }
    }

    private Room AllocateRoom(string roomCode)
    {
        if (!string.IsNullOrEmpty(roomCode))
        {
            if (_rooms.TryGetValue(roomCode, out var existing))
            {
                if (!existing.IsFull) return existing;
                // Private code full — fall through to a fresh quick-match room.
            }
            else
            {
                var room = Room.Create(roomCode, Maps.DefaultMapId, _ws.Send, _ws.Close, NowMs);
                _rooms[roomCode] = room;
                return room;
            }
        }

        foreach (var room in _rooms.Values)
            if (!room.IsFull) return room;

        string code = Protocol.MakeRoomCode(_rng.NextDouble);
        while (_rooms.ContainsKey(code)) code = Protocol.MakeRoomCode(_rng.NextDouble);
        var fresh = Room.Create(code, Maps.DefaultMapId, _ws.Send, _ws.Close, NowMs);
        _rooms[code] = fresh;
        return fresh;
    }

    private int ResolvePort()
    {
        // PORT env var, else --port=NNNN on the command line, else 8090.
        string env = OS.GetEnvironment("PORT");
        if (!string.IsNullOrEmpty(env) && int.TryParse(env, out int p)) return p;
        foreach (var arg in OS.GetCmdlineUserArgs())
            if (arg.StartsWith("--port=") && int.TryParse(arg.Substring("--port=".Length), out int p2)) return p2;
        return 8090;
    }
}
