// The landing panel: callsign, FIND MATCH (quick match), CREATE PRIVATE ROOM
// (generated code), JOIN WITH CODE. Ported from client/src/ui/lobby.ts. Instead
// of resolving a Promise, it fires OnChoice when the player commits.

using System;
using Godot;
using WebRivals.Shared;
using Button = Godot.Button;

namespace WebRivals.Client.UI;

public struct LobbyChoice
{
    public string Name;
    public string RoomCode; // null => quick match
}

public sealed partial class Lobby : CanvasLayer
{
    public Action<LobbyChoice> OnChoice;

    private LineEdit _nameInput;
    private LineEdit _joinInput;
    private Label _status;
    private Label _codeLabel;
    private Control _root;
    private readonly Random _rng = new();

    private const string NameFile = "user://callsign.txt";

    public Lobby()
    {
        Layer = 20;
        BuildUi();
    }

    private void BuildUi()
    {
        _root = new Control();
        _root.SetAnchorsPreset(Control.LayoutPreset.FullRect);
        AddChild(_root);

        var dim = new ColorRect { Color = new Color(0.04f, 0.05f, 0.07f, 0.72f) };
        dim.SetAnchorsPreset(Control.LayoutPreset.FullRect);
        _root.AddChild(dim);

        var panel = new PanelContainer();
        panel.SetAnchorsPreset(Control.LayoutPreset.Center);
        panel.CustomMinimumSize = new Vector2(420, 0);
        panel.Position = new Vector2(-210, -230);
        _root.AddChild(panel);

        var vb = new VBoxContainer();
        vb.AddThemeConstantOverride("separation", 12);
        panel.AddChild(vb);

        vb.AddChild(Heading("WEB RIVALS", 40));
        vb.AddChild(SubLabel("Instant arena FPS — movement is the game."));

        vb.AddChild(SubLabel("Callsign"));
        _nameInput = new LineEdit { PlaceholderText = "Player", MaxLength = 16, Text = LoadName() };
        _nameInput.CustomMinimumSize = new Vector2(0, 36);
        _nameInput.TextSubmitted += _ => Commit(null);
        vb.AddChild(_nameInput);

        var findBtn = new Button { Text = "FIND MATCH" };
        findBtn.CustomMinimumSize = new Vector2(0, 44);
        findBtn.Pressed += () => Commit(null);
        vb.AddChild(findBtn);

        vb.AddChild(SubLabel("— or play with a friend —"));

        var createBtn = new Button { Text = "CREATE PRIVATE ROOM" };
        createBtn.Pressed += OnCreate;
        vb.AddChild(createBtn);

        _codeLabel = SubLabel("");
        _codeLabel.Visible = false;
        vb.AddChild(_codeLabel);

        var joinRow = new HBoxContainer();
        _joinInput = new LineEdit { PlaceholderText = "CODE", MaxLength = 5 };
        _joinInput.SizeFlagsHorizontal = Control.SizeFlags.ExpandFill;
        _joinInput.TextChanged += t => _joinInput.Text = NormalizeCode(t);
        joinRow.AddChild(_joinInput);
        var joinBtn = new Button { Text = "JOIN" };
        joinBtn.Pressed += () => { var c = NormalizeCode(_joinInput.Text); if (c.Length == 5) Commit(c); };
        joinRow.AddChild(joinBtn);
        vb.AddChild(joinRow);

        _status = SubLabel("");
        vb.AddChild(_status);
    }

    private static Label Heading(string text, int size)
    {
        var l = new Label { Text = text, HorizontalAlignment = HorizontalAlignment.Center };
        l.AddThemeFontSizeOverride("font_size", size);
        return l;
    }

    private static Label SubLabel(string text)
    {
        var l = new Label { Text = text, HorizontalAlignment = HorizontalAlignment.Center };
        l.AddThemeColorOverride("font_color", new Color(0.8f, 0.84f, 0.9f));
        return l;
    }

    public void Open()
    {
        _root.Visible = true;
        _codeLabel.Visible = false;
        SetStatus("");
        _nameInput.GrabFocus();
        _nameInput.SelectAll();
    }

    public void Close() => _root.Visible = false;

    public void SetStatus(string text) => _status.Text = text;

    private void Commit(string roomCode)
    {
        string name = Protocol.SanitizeName(_nameInput.Text);
        _nameInput.Text = name;
        SaveName(name);
        SetStatus("Connecting…");
        var choice = new LobbyChoice { Name = name, RoomCode = string.IsNullOrEmpty(roomCode) ? null : roomCode.ToUpperInvariant() };
        OnChoice?.Invoke(choice);
    }

    private void OnCreate()
    {
        string code = Protocol.MakeRoomCode(_rng.NextDouble);
        _codeLabel.Text = $"Share this code, then FIND MATCH joins it: {code}";
        _codeLabel.Visible = true;
        _joinInput.Text = code;
    }

    private static string NormalizeCode(string raw)
    {
        var sb = new System.Text.StringBuilder();
        foreach (char ch in raw.ToUpperInvariant())
            if (ch >= 'A' && ch <= 'Z' && sb.Length < 5) sb.Append(ch);
        return sb.ToString();
    }

    private static string LoadName()
    {
        try
        {
            if (FileAccess.FileExists(NameFile))
            {
                using var f = FileAccess.Open(NameFile, FileAccess.ModeFlags.Read);
                return f?.GetAsText()?.Trim() ?? "";
            }
        }
        catch { }
        return "";
    }

    private static void SaveName(string name)
    {
        try
        {
            using var f = FileAccess.Open(NameFile, FileAccess.ModeFlags.Write);
            f?.StoreString(name);
        }
        catch { }
    }
}
