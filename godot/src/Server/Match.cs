// The PURE FFA deathmatch reducer. No I/O, no engine, no networking. Ported from
// server/src/match.ts. StepMatch takes the current state plus a per-tick aggregate
// and mutates the state, returning the events the Room must act on.
//
// Phases: warmup (<2 players) -> live (>=2, clock counts up) -> matchEnd
// (scoreboard for matchEndSec) -> reset -> warmup.

using System.Collections.Generic;
using WebRivals.Shared;

namespace WebRivals.Server;

public sealed class MatchState
{
    public string Phase = "warmup"; // "warmup" | "live" | "matchEnd"
    public double Clock = 0;
    public int MatchWinner = -1;
}

public struct MatchTickCtx
{
    public int ConnectedCount;
    public int TopFrags;
    public int TopFragsPlayer; // lowest id on ties, -1 if none
}

public enum MatchEventType { MatchStart, MatchEnd, Reset }

public struct MatchEvent
{
    public MatchEventType Type;
    public int Winner; // for MatchEnd
}

public static class Match
{
    private static WorldTuning W => Tuning.World;

    public static MatchState InitMatch() => new MatchState { Phase = "warmup", Clock = 0, MatchWinner = -1 };

    /// <summary>Advance the match by dt against this tick's aggregate. Mutates
    /// state and returns the events produced this tick (0 or 1).</summary>
    public static List<MatchEvent> StepMatch(MatchState state, MatchTickCtx ctx, double dt)
    {
        var events = new List<MatchEvent>();

        switch (state.Phase)
        {
            case "warmup":
                if (ctx.ConnectedCount >= W.WarmupMinPlayers)
                {
                    state.Phase = "live";
                    state.Clock = 0;
                    state.MatchWinner = -1;
                    events.Add(new MatchEvent { Type = MatchEventType.MatchStart });
                }
                break;

            case "live":
                state.Clock += dt;
                if (ctx.ConnectedCount < W.WarmupMinPlayers)
                {
                    state.Phase = "warmup";
                    break;
                }
                bool reachedLimit = ctx.TopFragsPlayer >= 0 && ctx.TopFrags >= W.FragLimit;
                bool reachedCap = W.MatchTimeCapSec > 0 && state.Clock > W.MatchTimeCapSec;
                if (reachedLimit || reachedCap)
                {
                    state.MatchWinner = ctx.TopFragsPlayer;
                    state.Phase = "matchEnd";
                    state.Clock = W.MatchEndSec;
                    events.Add(new MatchEvent { Type = MatchEventType.MatchEnd, Winner = ctx.TopFragsPlayer });
                }
                break;

            case "matchEnd":
                state.Clock -= dt;
                if (state.Clock <= 0)
                {
                    state.Phase = "warmup";
                    state.Clock = 0;
                    state.MatchWinner = -1;
                    events.Add(new MatchEvent { Type = MatchEventType.Reset });
                }
                break;
        }

        return events;
    }
}
