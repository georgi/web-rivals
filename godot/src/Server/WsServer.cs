// Low-level WebSocket server over Godot's TcpServer + WebSocketPeer. One process
// accepts raw WS connections and exchanges JSON text frames — the same wire the
// TypeScript `ws` server used, so the protocol is unchanged. Poll() is driven once
// per frame by GameServer (single-threaded, mirroring the Node event loop).

using System;
using System.Collections.Generic;
using System.Text;
using Godot;

namespace WebRivals.Server;

public sealed class WsServer
{
    private readonly TcpServer _tcp = new();
    // Connections still completing the WS handshake.
    private readonly List<WebSocketPeer> _pending = new();
    // Fully-open connections keyed by an assigned id.
    private readonly Dictionary<int, WebSocketPeer> _peers = new();
    private int _nextId = 1;

    public Action<int> OnOpen;
    public Action<int, string> OnMessage;
    public Action<int> OnClose;

    public Error Listen(int port) => _tcp.Listen((ushort)port);

    public void Stop()
    {
        foreach (var ws in _peers.Values) ws.Close();
        _peers.Clear();
        _pending.Clear();
        _tcp.Stop();
    }

    public void Poll()
    {
        // Accept new TCP connections and start the WS handshake on each.
        while (_tcp.IsConnectionAvailable())
        {
            StreamPeerTcp conn = _tcp.TakeConnection();
            if (conn == null) continue;
            var ws = new WebSocketPeer();
            if (ws.AcceptStream(conn) == Error.Ok) _pending.Add(ws);
        }

        // Drive pending handshakes; promote to open or drop.
        for (int i = _pending.Count - 1; i >= 0; i--)
        {
            var ws = _pending[i];
            ws.Poll();
            var state = ws.GetReadyState();
            if (state == WebSocketPeer.State.Open)
            {
                _pending.RemoveAt(i);
                int id = _nextId++;
                _peers[id] = ws;
                OnOpen?.Invoke(id);
            }
            else if (state == WebSocketPeer.State.Closed)
            {
                _pending.RemoveAt(i);
            }
        }

        // Pump open connections: read inbound frames, detect closes.
        var toRemove = new List<int>();
        foreach (var kv in _peers)
        {
            var ws = kv.Value;
            ws.Poll();
            var state = ws.GetReadyState();
            if (state == WebSocketPeer.State.Open || state == WebSocketPeer.State.Closing)
            {
                while (ws.GetAvailablePacketCount() > 0)
                {
                    byte[] pkt = ws.GetPacket();
                    if (pkt == null || pkt.Length == 0) continue;
                    string text = Encoding.UTF8.GetString(pkt);
                    OnMessage?.Invoke(kv.Key, text);
                }
            }
            if (state == WebSocketPeer.State.Closed)
                toRemove.Add(kv.Key);
        }

        foreach (int id in toRemove)
        {
            _peers.Remove(id);
            OnClose?.Invoke(id);
        }
    }

    public void Send(int connId, string data)
    {
        if (_peers.TryGetValue(connId, out var ws) && ws.GetReadyState() == WebSocketPeer.State.Open)
            ws.SendText(data);
    }

    public void Close(int connId)
    {
        if (_peers.TryGetValue(connId, out var ws)) ws.Close();
    }
}
