// Wire protocol. JSON over WS, ported from shared/src/protocol.ts. Field names
// match the TS protocol exactly so the C# server stays wire-compatible with the
// original TypeScript client (and vice-versa). Vec3 tuples are double[3] arrays.

using System;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WebRivals.Shared;

/// <summary>Continuous input button bitfield.</summary>
public static class Button
{
    public const int Forward = 1 << 0;
    public const int Back = 1 << 1;
    public const int Left = 1 << 2;
    public const int Right = 1 << 3;
    public const int Jump = 1 << 4;
    public const int Sprint = 1 << 5;
    public const int Crouch = 1 << 6; // slide trigger
    public const int Fire = 1 << 7;
    public const int AltFire = 1 << 8;
    public const int Reload = 1 << 9;
}

/// <summary>One-shot edges reported alongside continuous button state.</summary>
public static class EventFlag
{
    public const int Jumped = 1 << 0;
    public const int SlideStart = 1 << 1;
    public const int Landed = 1 << 2;
}

// ---------------- messages ----------------

public abstract class Message
{
    [JsonPropertyName("t")] public string T { get; set; }
}

// ---- Client -> Server ----

public sealed class HelloMsg : Message
{
    [JsonPropertyName("name")] public string Name { get; set; }
    [JsonPropertyName("roomCode")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string RoomCode { get; set; }
    public HelloMsg() { T = "hello"; }
}

public sealed class InputMsg : Message
{
    [JsonPropertyName("seq")] public int Seq { get; set; }
    [JsonPropertyName("clientTime")] public double ClientTime { get; set; }
    [JsonPropertyName("pos")] public double[] Pos { get; set; }
    [JsonPropertyName("vel")] public double[] Vel { get; set; }
    [JsonPropertyName("yaw")] public double Yaw { get; set; }
    [JsonPropertyName("pitch")] public double Pitch { get; set; }
    [JsonPropertyName("buttons")] public int Buttons { get; set; }
    [JsonPropertyName("events")] public int Events { get; set; }
    public InputMsg() { T = "input"; }
}

public sealed class ShootMsg : Message
{
    [JsonPropertyName("seq")] public int Seq { get; set; }
    [JsonPropertyName("weapon")] public int Weapon { get; set; }
    [JsonPropertyName("origin")] public double[] Origin { get; set; }
    [JsonPropertyName("dir")] public double[] Dir { get; set; }
    [JsonPropertyName("clientTime")] public double ClientTime { get; set; }
    public ShootMsg() { T = "shoot"; }
}

public sealed class PingMsg : Message
{
    [JsonPropertyName("clientTime")] public double ClientTime { get; set; }
    public PingMsg() { T = "ping"; }
}

// ---- Server -> Client ----

public sealed class JoinedMsg : Message
{
    [JsonPropertyName("playerId")] public int PlayerId { get; set; }
    [JsonPropertyName("roomId")] public string RoomId { get; set; }
    [JsonPropertyName("mapId")] public string MapId { get; set; }
    [JsonPropertyName("serverTime")] public double ServerTime { get; set; }
    [JsonPropertyName("youAreReady")] public bool YouAreReady { get; set; }
    public JoinedMsg() { T = "joined"; }
}

public sealed class PlayerSnap
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("pos")] public double[] Pos { get; set; }
    [JsonPropertyName("vel")] public double[] Vel { get; set; }
    [JsonPropertyName("yaw")] public double Yaw { get; set; }
    [JsonPropertyName("pitch")] public double Pitch { get; set; }
    [JsonPropertyName("anim")] public string Anim { get; set; }
    [JsonPropertyName("hp")] public double Hp { get; set; }
    [JsonPropertyName("weapon")] public int Weapon { get; set; }
}

public sealed class ProjSnap
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("kind")] public string Kind { get; set; }
    [JsonPropertyName("pos")] public double[] Pos { get; set; }
    [JsonPropertyName("vel")] public double[] Vel { get; set; }
}

public sealed class SnapshotMsg : Message
{
    [JsonPropertyName("tick")] public int Tick { get; set; }
    [JsonPropertyName("serverTime")] public double ServerTime { get; set; }
    [JsonPropertyName("players")] public PlayerSnap[] Players { get; set; }
    [JsonPropertyName("projectiles")] public ProjSnap[] Projectiles { get; set; }
    public SnapshotMsg() { T = "snapshot"; }
}

public sealed class CorrectionMsg : Message
{
    [JsonPropertyName("pos")] public double[] Pos { get; set; }
    [JsonPropertyName("vel")] public double[] Vel { get; set; }
    [JsonPropertyName("seq")] public int Seq { get; set; }
    public CorrectionMsg() { T = "correction"; }
}

public sealed class DamageMsg : Message
{
    [JsonPropertyName("victim")] public int Victim { get; set; }
    [JsonPropertyName("amount")] public double Amount { get; set; }
    [JsonPropertyName("newHp")] public double NewHp { get; set; }
    [JsonPropertyName("source")] public int Source { get; set; }
    [JsonPropertyName("weapon")] public int Weapon { get; set; }
    [JsonPropertyName("dirToSource")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double[] DirToSource { get; set; }
    public DamageMsg() { T = "damage"; }
}

public sealed class SpawnProjMsg : Message
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("kind")] public string Kind { get; set; }
    [JsonPropertyName("owner")] public int Owner { get; set; }
    [JsonPropertyName("pos")] public double[] Pos { get; set; }
    [JsonPropertyName("vel")] public double[] Vel { get; set; }
    public SpawnProjMsg() { T = "spawn_proj"; }
}

public sealed class ImpulseEntry
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("impulse")] public double[] Impulse { get; set; }
}

public sealed class DetonateMsg : Message
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("pos")] public double[] Pos { get; set; }
    [JsonPropertyName("kind")] public string Kind { get; set; }
    [JsonPropertyName("impulses")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public ImpulseEntry[] Impulses { get; set; }
    public DetonateMsg() { T = "detonate"; }
}

public sealed class KillMsg : Message
{
    [JsonPropertyName("killer")] public int Killer { get; set; }
    [JsonPropertyName("victim")] public int Victim { get; set; }
    [JsonPropertyName("weapon")] public int Weapon { get; set; }
    [JsonPropertyName("fall")] public bool Fall { get; set; }
    public KillMsg() { T = "kill"; }
}

public sealed class FragEntry
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("frags")] public int Frags { get; set; }
}

public sealed class MatchStateMsg : Message
{
    [JsonPropertyName("phase")] public string Phase { get; set; }
    [JsonPropertyName("timer")] public double Timer { get; set; }
    [JsonPropertyName("fragLimit")] public int FragLimit { get; set; }
    [JsonPropertyName("scores")] public FragEntry[] Scores { get; set; }
    [JsonPropertyName("winner")] public int Winner { get; set; }
    public MatchStateMsg() { T = "match_state"; }
}

public sealed class RespawnMsg : Message
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("pos")] public double[] Pos { get; set; }
    [JsonPropertyName("yaw")] public double Yaw { get; set; }
    public RespawnMsg() { T = "respawn"; }
}

public sealed class PongMsg : Message
{
    [JsonPropertyName("clientTime")] public double ClientTime { get; set; }
    [JsonPropertyName("serverTime")] public double ServerTime { get; set; }
    public PongMsg() { T = "pong"; }
}

public sealed class OpponentMsg : Message
{
    [JsonPropertyName("present")] public bool Present { get; set; }
    [JsonPropertyName("name")] public string Name { get; set; }
    [JsonPropertyName("id")] public int Id { get; set; }
    public OpponentMsg() { T = "opponent"; }
}

public static class Protocol
{
    private static readonly JsonSerializerOptions Opts = new()
    {
        IncludeFields = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string Encode(Message msg) => JsonSerializer.Serialize(msg, msg.GetType(), Opts);

    /// <summary>Parse a frame and return the concrete Message subclass, or null
    /// if the frame is malformed / unknown.</summary>
    public static Message Decode(string data)
    {
        try
        {
            using var doc = JsonDocument.Parse(data);
            if (!doc.RootElement.TryGetProperty("t", out var tEl)) return null;
            string t = tEl.GetString();
            return t switch
            {
                "hello" => JsonSerializer.Deserialize<HelloMsg>(data, Opts),
                "input" => JsonSerializer.Deserialize<InputMsg>(data, Opts),
                "shoot" => JsonSerializer.Deserialize<ShootMsg>(data, Opts),
                "ping" => JsonSerializer.Deserialize<PingMsg>(data, Opts),
                "joined" => JsonSerializer.Deserialize<JoinedMsg>(data, Opts),
                "snapshot" => JsonSerializer.Deserialize<SnapshotMsg>(data, Opts),
                "correction" => JsonSerializer.Deserialize<CorrectionMsg>(data, Opts),
                "damage" => JsonSerializer.Deserialize<DamageMsg>(data, Opts),
                "spawn_proj" => JsonSerializer.Deserialize<SpawnProjMsg>(data, Opts),
                "detonate" => JsonSerializer.Deserialize<DetonateMsg>(data, Opts),
                "kill" => JsonSerializer.Deserialize<KillMsg>(data, Opts),
                "match_state" => JsonSerializer.Deserialize<MatchStateMsg>(data, Opts),
                "respawn" => JsonSerializer.Deserialize<RespawnMsg>(data, Opts),
                "pong" => JsonSerializer.Deserialize<PongMsg>(data, Opts),
                "opponent" => JsonSerializer.Deserialize<OpponentMsg>(data, Opts),
                _ => null,
            };
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Sanitize a display name: trim, strip control chars, cap at 16.</summary>
    public static string SanitizeName(string raw)
    {
        if (raw == null) raw = "";
        var sb = new StringBuilder(raw.Length);
        foreach (char c in raw)
            if (c >= 0x20 && c != 0x7F) sb.Append(c);
        string cleaned = sb.ToString().Trim();
        if (cleaned.Length > 16) cleaned = cleaned.Substring(0, 16);
        return cleaned.Length > 0 ? cleaned : "Player";
    }

    private const string RoomCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O

    /// <summary>5-letter room code from a seeded RNG (rng returns [0,1)).</summary>
    public static string MakeRoomCode(Func<double> rng)
    {
        var sb = new StringBuilder(5);
        for (int i = 0; i < 5; i++)
            sb.Append(RoomCodeAlphabet[(int)Math.Floor(rng() * RoomCodeAlphabet.Length)]);
        return sb.ToString();
    }
}
