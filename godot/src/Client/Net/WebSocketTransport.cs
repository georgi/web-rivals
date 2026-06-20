// Client network transport over Godot's WebSocketPeer. Poll() must be pumped once
// per frame by the owner (NetClient). Sends issued before the socket opens are
// queued and flushed on open. Ported in spirit from client/src/net/transport.ts.

using System;
using System.Collections.Generic;
using System.Text;
using Godot;

namespace WebRivals.Client.Net;

public interface ITransport
{
    void Send(string data);
    void Poll();
    bool IsOpen { get; }
    void Close();
    Action<string> OnMessage { get; set; }
    Action OnOpen { get; set; }
    Action OnClose { get; set; }
}

public sealed class WebSocketTransport : ITransport
{
    private readonly WebSocketPeer _ws = new();
    private readonly List<string> _sendQueue = new();
    private WebSocketPeer.State _lastState = WebSocketPeer.State.Closed;
    private bool _opened = false;
    private bool _closedFired = false;
    private bool _connecting = false;

    public Action<string> OnMessage { get; set; }
    public Action OnOpen { get; set; }
    public Action OnClose { get; set; }

    public WebSocketTransport(string url)
    {
        var err = _ws.ConnectToUrl(url);
        if (err != Error.Ok) throw new Exception($"WebSocket connect failed: {err}");
        _connecting = true;
    }

    public bool IsOpen => _ws.GetReadyState() == WebSocketPeer.State.Open;

    public void Poll()
    {
        if (!_connecting) return;
        _ws.Poll();
        var state = _ws.GetReadyState();

        if (state == WebSocketPeer.State.Open && !_opened)
        {
            _opened = true;
            foreach (var s in _sendQueue) _ws.SendText(s);
            _sendQueue.Clear();
            OnOpen?.Invoke();
        }

        if (state == WebSocketPeer.State.Open || state == WebSocketPeer.State.Closing)
        {
            while (_ws.GetAvailablePacketCount() > 0)
            {
                byte[] pkt = _ws.GetPacket();
                if (pkt == null || pkt.Length == 0) continue;
                OnMessage?.Invoke(Encoding.UTF8.GetString(pkt));
            }
        }

        if (state == WebSocketPeer.State.Closed && !_closedFired)
        {
            _closedFired = true;
            _connecting = false;
            OnClose?.Invoke();
        }

        _lastState = state;
    }

    public void Send(string data)
    {
        if (_ws.GetReadyState() == WebSocketPeer.State.Open) _ws.SendText(data);
        else _sendQueue.Add(data);
    }

    public void Close() => _ws.Close();
}
