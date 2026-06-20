using Godot;
using System;
using WebRivals.Server;

namespace WebRivals;

// Entry point. Picks the role from the command line:
//   godot --headless -- --server     -> run the authoritative game server
//   godot                            -> run the client (default)
// The client lives in its own scene so the heavy 3D tree only builds for players.
public partial class Bootstrap : Node
{
    public override void _Ready()
    {
        bool server = false;
        foreach (var arg in OS.GetCmdlineUserArgs())
            if (arg == "--server") server = true;

        if (server)
        {
            GD.Print("[boot] starting in SERVER mode");
            AddChild(new GameServer());
        }
        else
        {
            GD.Print("[boot] starting in CLIENT mode");
            // Swap to the client scene on the next idle frame (ChangeSceneToFile
            // can't run while the current scene is still initializing).
            CallDeferred(nameof(LoadClient));
        }
    }

    private void LoadClient()
    {
        var err = GetTree().ChangeSceneToFile("res://scenes/Client.tscn");
        if (err != Error.Ok)
            GD.PrintErr($"[boot] failed to load client scene: {err}");
    }
}
