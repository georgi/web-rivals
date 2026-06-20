// The combat HUD: center crosshair (gap grows with bloom), health, ammo, weapon
// name, hitmarker, live frag table, match timer, banner, kill feed, directional
// damage flashes, and the match-end scoreboard. Ported from client/src/ui/hud.ts
// to Godot Control nodes.

using System;
using System.Collections.Generic;
using Godot;
using WebRivals.Shared;

namespace WebRivals.Client.UI;

public sealed partial class Hud : CanvasLayer
{
    private Crosshair _crosshair;
    private Label _healthNum;
    private ColorRect _healthFill;
    private Label _ammo;
    private Label _weaponName;
    private Label _timer;
    private Label _frags;
    private Label _banner;
    private Label _bannerSub;
    private VBoxContainer _killFeed;
    private readonly ColorRect[] _dmg = new ColorRect[4]; // front, back, left, right
    private Control _scoreboard;
    private Label _sbResult;
    private Label _sbScore;

    private double _lastHp = double.NaN;
    private int _lastClip = int.MinValue;
    private int _lastReserve = int.MinValue;
    private string _lastWeapon = "";
    private int _lastTimer = int.MinValue;

    private static readonly Color White = new(0.96f, 0.97f, 0.98f);

    public Hud()
    {
        Layer = 10;
        BuildUi();
    }

    private void BuildUi()
    {
        // Crosshair (center).
        _crosshair = new Crosshair { AnchorLeft = 0.5f, AnchorTop = 0.5f, AnchorRight = 0.5f, AnchorBottom = 0.5f };
        _crosshair.Position = new Vector2(-16, -16);
        _crosshair.CustomMinimumSize = new Vector2(32, 32);
        AddChild(_crosshair);

        // Health (bottom-left).
        var healthBg = new ColorRect { Color = new Color(0, 0, 0, 0.35f), Size = new Vector2(180, 22), Position = new Vector2(28, 0) };
        healthBg.SetAnchorsPreset(Control.LayoutPreset.BottomLeft);
        healthBg.Position = new Vector2(28, -54);
        _healthFill = new ColorRect { Color = new Color(0.27f, 0.83f, 0.35f), Size = new Vector2(180, 22) };
        healthBg.AddChild(_healthFill);
        _healthNum = MakeLabel("100", 22, HorizontalAlignment.Center);
        _healthNum.Size = new Vector2(180, 22);
        healthBg.AddChild(_healthNum);
        AddChild(healthBg);

        // Ammo (bottom-right).
        _ammo = MakeLabel("30 / 240", 24, HorizontalAlignment.Right);
        _ammo.SetAnchorsPreset(Control.LayoutPreset.BottomRight);
        _ammo.Position = new Vector2(-220, -54);
        _ammo.Size = new Vector2(192, 28);
        AddChild(_ammo);

        // Weapon name (top-center).
        _weaponName = MakeLabel("Assault Rifle", 20, HorizontalAlignment.Center);
        _weaponName.SetAnchorsPreset(Control.LayoutPreset.CenterTop);
        _weaponName.Position = new Vector2(-150, 56);
        _weaponName.Size = new Vector2(300, 26);
        AddChild(_weaponName);

        // Timer (top-center, above weapon name).
        _timer = MakeLabel("", 28, HorizontalAlignment.Center);
        _timer.SetAnchorsPreset(Control.LayoutPreset.CenterTop);
        _timer.Position = new Vector2(-100, 18);
        _timer.Size = new Vector2(200, 32);
        AddChild(_timer);

        // Frag table (top-right).
        _frags = MakeLabel("", 16, HorizontalAlignment.Right);
        _frags.SetAnchorsPreset(Control.LayoutPreset.TopRight);
        _frags.Position = new Vector2(-220, 16);
        _frags.Size = new Vector2(200, 200);
        AddChild(_frags);

        // Banner (center).
        _banner = MakeLabel("", 64, HorizontalAlignment.Center);
        _banner.SetAnchorsPreset(Control.LayoutPreset.Center);
        _banner.Position = new Vector2(-400, -120);
        _banner.Size = new Vector2(800, 80);
        _banner.Visible = false;
        AddChild(_banner);
        _bannerSub = MakeLabel("", 24, HorizontalAlignment.Center);
        _bannerSub.SetAnchorsPreset(Control.LayoutPreset.Center);
        _bannerSub.Position = new Vector2(-400, -40);
        _bannerSub.Size = new Vector2(800, 30);
        _bannerSub.Visible = false;
        AddChild(_bannerSub);

        // Kill feed (top-right, below frag table).
        _killFeed = new VBoxContainer();
        _killFeed.SetAnchorsPreset(Control.LayoutPreset.TopRight);
        _killFeed.Position = new Vector2(-340, 220);
        _killFeed.Size = new Vector2(320, 200);
        _killFeed.Alignment = BoxContainer.AlignmentMode.End;
        AddChild(_killFeed);

        // Directional damage flashes (screen edges).
        _dmg[0] = EdgeRect(Control.LayoutPreset.TopWide, new Vector2(0, 60));     // front -> top
        _dmg[1] = EdgeRect(Control.LayoutPreset.BottomWide, new Vector2(0, 60));  // back -> bottom
        _dmg[2] = EdgeRect(Control.LayoutPreset.LeftWide, new Vector2(60, 0));    // left
        _dmg[3] = EdgeRect(Control.LayoutPreset.RightWide, new Vector2(60, 0));   // right
        foreach (var d in _dmg) AddChild(d);

        // Scoreboard overlay (center).
        _scoreboard = new Control { Visible = false };
        _scoreboard.SetAnchorsPreset(Control.LayoutPreset.FullRect);
        var sbBg = new ColorRect { Color = new Color(0.03f, 0.04f, 0.06f, 0.78f) };
        sbBg.SetAnchorsPreset(Control.LayoutPreset.FullRect);
        _scoreboard.AddChild(sbBg);
        _sbResult = MakeLabel("VICTORY", 56, HorizontalAlignment.Center);
        _sbResult.SetAnchorsPreset(Control.LayoutPreset.CenterTop);
        _sbResult.Position = new Vector2(-400, 120);
        _sbResult.Size = new Vector2(800, 70);
        _scoreboard.AddChild(_sbResult);
        _sbScore = MakeLabel("", 26, HorizontalAlignment.Center);
        _sbScore.SetAnchorsPreset(Control.LayoutPreset.CenterTop);
        _sbScore.Position = new Vector2(-300, 210);
        _sbScore.Size = new Vector2(600, 360);
        _scoreboard.AddChild(_sbScore);
        AddChild(_scoreboard);
    }

    private static Label MakeLabel(string text, int size, HorizontalAlignment align)
    {
        var l = new Label { Text = text, HorizontalAlignment = align };
        l.AddThemeFontSizeOverride("font_size", size);
        l.AddThemeColorOverride("font_color", White);
        l.AddThemeColorOverride("font_outline_color", new Color(0, 0, 0, 0.7f));
        l.AddThemeConstantOverride("outline_size", 4);
        return l;
    }

    private static ColorRect EdgeRect(Control.LayoutPreset preset, Vector2 size)
    {
        var r = new ColorRect { Color = new Color(1, 0.15f, 0.15f, 0f) };
        r.SetAnchorsPreset(preset);
        if (size.X > 0) r.CustomMinimumSize = new Vector2(size.X, 0);
        if (size.Y > 0) r.CustomMinimumSize = new Vector2(0, size.Y);
        r.MouseFilter = Control.MouseFilterEnum.Ignore;
        return r;
    }

    // ---- public API ----

    public void Update(double hp, string weaponName, int clip, int reserve)
    {
        if (hp != _lastHp)
        {
            _lastHp = hp;
            int h = Math.Max(0, (int)Math.Round(hp));
            _healthNum.Text = h.ToString();
            _healthFill.Size = new Vector2(180 * Math.Clamp(h, 0, 100) / 100f, 22);
            float hue = Math.Clamp(h / 100f, 0, 1) * 0.333f; // green->red (0.333..0)
            _healthFill.Color = Color.FromHsv(hue, 0.7f, 0.85f);
        }
        if (clip != _lastClip || reserve != _lastReserve)
        {
            _lastClip = clip; _lastReserve = reserve;
            _ammo.Text = $"{clip} / {reserve}";
        }
        if (weaponName != _lastWeapon)
        {
            _lastWeapon = weaponName;
            _weaponName.Text = weaponName;
        }
    }

    public void Hitmarker()
    {
        _crosshair.Hit = true;
        _crosshair.QueueRedraw();
        var t = GetTree().CreateTimer(0.12);
        t.Timeout += () => { _crosshair.Hit = false; _crosshair.QueueRedraw(); };
    }

    public void SetCrosshairBloom(double spreadPx)
    {
        _crosshair.SetGap((float)(4 + Math.Max(0, spreadPx)));
    }

    public void SetFrags(List<FragEntry> scores, int localId, Dictionary<int, string> names, int fragLimit)
    {
        var ranked = new List<FragEntry>(scores);
        ranked.Sort((p, q) => q.Frags != p.Frags ? q.Frags - p.Frags : p.Id - q.Id);
        int leader = ranked.Count > 0 ? ranked[0].Frags : 0;
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"{leader} / {fragLimit}");
        foreach (var s in ranked)
        {
            string name = s.Id == localId ? "You" : (names.TryGetValue(s.Id, out var n) ? n : $"P{s.Id}");
            sb.AppendLine($"{name}  {s.Frags}");
        }
        _frags.Text = sb.ToString();
    }

    public void SetRoundTimer(double seconds)
    {
        int s = Math.Max(0, (int)Math.Ceiling(seconds));
        if (s == _lastTimer) return;
        _lastTimer = s;
        if (s <= 0) { _timer.Text = ""; return; }
        _timer.Text = s >= 60 ? $"{s / 60}:{(s % 60):D2}" : s.ToString();
        _timer.AddThemeColorOverride("font_color", s <= 10 ? new Color(1f, 0.4f, 0.3f) : White);
    }

    public void ShowBanner(string text, string sub = "")
    {
        _banner.Text = text;
        _banner.Visible = true;
        _bannerSub.Text = sub;
        _bannerSub.Visible = !string.IsNullOrEmpty(sub);
        var t = GetTree().CreateTimer(1.1);
        t.Timeout += () => { _banner.Visible = false; _bannerSub.Visible = false; };
    }

    public void HideBanner()
    {
        _banner.Visible = false;
        _bannerSub.Visible = false;
    }

    public void AddKill(string killer, string victim, int weaponSlot, bool fall)
    {
        string glyph = weaponSlot switch { 1 => "»", 2 => "✺", 3 => "†", 4 => "◉", _ => "•" };
        string text = fall ? $"{victim} fell" : $"{killer}  {glyph}  {victim}";
        var row = MakeLabel(text, 16, HorizontalAlignment.Right);
        _killFeed.AddChild(row);
        while (_killFeed.GetChildCount() > 4)
            _killFeed.GetChild(0).QueueFree();
        var t = GetTree().CreateTimer(4.0);
        t.Timeout += () => { if (IsInstanceValid(row)) row.QueueFree(); };
    }

    public void DamageFrom(Vec3 dir)
    {
        double fwd = -dir.Z;
        double right = dir.X;
        int quad;
        if (Math.Abs(fwd) >= Math.Abs(right)) quad = fwd >= 0 ? 0 : 1;
        else quad = right >= 0 ? 3 : 2;
        var node = _dmg[quad];
        node.Color = new Color(1, 0.15f, 0.15f, 0.45f);
        var tween = CreateTween();
        tween.TweenProperty(node, "color:a", 0.0f, 0.65);
    }

    public void ShowScoreboardFFA(List<FragEntry> scores, Dictionary<int, string> names, int localId, string myName, int winnerId)
    {
        var ranked = new List<FragEntry>(scores);
        ranked.Sort((p, q) => q.Frags != p.Frags ? q.Frags - p.Frags : p.Id - q.Id);
        bool isDraw = winnerId == -1;
        bool youWon = !isDraw && winnerId == localId;
        _sbResult.Text = isDraw ? "DRAW" : youWon ? "VICTORY" : "DEFEAT";
        _sbResult.AddThemeColorOverride("font_color", youWon ? new Color(0.4f, 0.9f, 0.45f) : (isDraw ? White : new Color(1f, 0.4f, 0.4f)));
        var sb = new System.Text.StringBuilder();
        for (int i = 0; i < ranked.Count; i++)
        {
            var s = ranked[i];
            string name = s.Id == localId ? myName : (names.TryGetValue(s.Id, out var n) ? n : $"P{s.Id}");
            string crown = s.Id == winnerId ? "* " : "";
            sb.AppendLine($"{i + 1}.  {crown}{name}    {s.Frags}");
        }
        _sbScore.Text = sb.ToString();
        _scoreboard.Visible = true;
        var t = GetTree().CreateTimer(5.0);
        t.Timeout += () => _scoreboard.Visible = false;
    }

    public void HideScoreboard() => _scoreboard.Visible = false;

    // ---- crosshair custom-draw control ----
    private sealed partial class Crosshair : Control
    {
        private float _gap = 4;
        public bool Hit = false;

        public void SetGap(float g)
        {
            float q = Mathf.Round(g);
            if (Mathf.IsEqualApprox(q, _gap)) return;
            _gap = q;
            QueueRedraw();
        }

        public override void _Draw()
        {
            Vector2 c = new(16, 16);
            var col = new Color(1, 1, 1, 0.9f);
            float len = 6, w = 2;
            // Center dot.
            DrawRect(new Rect2(c - new Vector2(1, 1), new Vector2(2, 2)), col);
            // Four ticks, offset by the bloom gap.
            DrawRect(new Rect2(c + new Vector2(-w / 2, -_gap - len), new Vector2(w, len)), col); // top
            DrawRect(new Rect2(c + new Vector2(-w / 2, _gap), new Vector2(w, len)), col);          // bottom
            DrawRect(new Rect2(c + new Vector2(-_gap - len, -w / 2), new Vector2(len, w)), col);   // left
            DrawRect(new Rect2(c + new Vector2(_gap, -w / 2), new Vector2(len, w)), col);          // right
            if (Hit)
            {
                var hc = new Color(1f, 0.3f, 0.3f, 0.95f);
                foreach (var d in new[] { new Vector2(-10, -10), new Vector2(10, -10), new Vector2(-10, 10), new Vector2(10, 10) })
                    DrawRect(new Rect2(c + d - new Vector2(1.5f, 1.5f), new Vector2(3, 3)), hc);
            }
        }
    }
}
