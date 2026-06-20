// Map data. The crate arena, ported verbatim from shared/src/map-crate.json.
// Both client (mesh + collider) and server (collider + projectiles) consume this
// so there is no second copy of the geometry anywhere.

using System.Collections.Generic;

namespace WebRivals.Shared;

public static class Maps
{
    public const string DefaultMapId = "crate";

    public static readonly MapData Crate = BuildCrate();

    public static readonly Dictionary<string, MapData> All = new()
    {
        { "crate", Crate },
    };

    public static MapData GetMap(string id)
        => All.TryGetValue(id, out var m) ? m : Crate;

    private static MapData BuildCrate()
    {
        var m = new MapData { KillY = -10 };

        // Floor
        m.Solids.Add(Solid.Box(0, -0.5, 0, 30, 1, 30));

        // Perimeter walls
        m.Solids.Add(Solid.Box(0, 3, 15.5, 32, 6, 1));
        m.Solids.Add(Solid.Box(0, 3, -15.5, 32, 6, 1));
        m.Solids.Add(Solid.Box(15.5, 3, 0, 1, 6, 32));
        m.Solids.Add(Solid.Box(-15.5, 3, 0, 1, 6, 32));

        // Center high-ground block + the four ramps onto it
        m.Solids.Add(Solid.Box(0, 1.5, 0, 8, 3, 8));
        m.Solids.Add(Solid.Ramp(0, 1.5, 6, 6, 3, 4, RampDir.MinusZ));
        m.Solids.Add(Solid.Ramp(0, 1.5, -6, 6, 3, 4, RampDir.PlusZ));
        m.Solids.Add(Solid.Ramp(6, 1.5, 0, 4, 3, 6, RampDir.MinusX));
        m.Solids.Add(Solid.Ramp(-6, 1.5, 0, 4, 3, 6, RampDir.PlusX));

        // Scattered crates
        m.Solids.Add(Solid.Box(-7, 1, 7, 2, 2, 2));
        m.Solids.Add(Solid.Box(7, 1, -7, 2, 2, 2));
        m.Solids.Add(Solid.Box(-11, 1, 0, 3, 2, 4));
        m.Solids.Add(Solid.Box(11, 1, 0, 3, 2, 4));

        // Corner cover (L-shaped pairs)
        m.Solids.Add(Solid.Box(-12, 2, -9.5, 4, 4, 0.5));
        m.Solids.Add(Solid.Box(-9.5, 2, -12, 0.5, 4, 4));
        m.Solids.Add(Solid.Box(12, 2, 9.5, 4, 4, 0.5));
        m.Solids.Add(Solid.Box(9.5, 2, 12, 0.5, 4, 4));

        // Spawns
        m.Spawns.Add(new SpawnPoint(-12, 1, -12, 225));
        m.Spawns.Add(new SpawnPoint(12, 1, 12, 45));
        m.Spawns.Add(new SpawnPoint(12, 1, -12, 135));
        m.Spawns.Add(new SpawnPoint(-12, 1, 12, 315));
        m.Spawns.Add(new SpawnPoint(0, 1, 13, 0));
        m.Spawns.Add(new SpawnPoint(0, 1, -13, 180));

        return m;
    }
}
