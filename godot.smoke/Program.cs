// Integration smoke test for the Godot authoritative server. Connects two raw
// WebSocket clients (the same JSON wire the real client uses), drives a short
// session, and asserts the full pipeline fires: joined -> opponent -> live match
// -> snapshots with both players -> pong -> projectile broadcast on shoot.
//
// Usage: dotnet run -- ws://127.0.0.1:8099   (server must already be listening)

using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

string url = args.Length > 0 ? args[0] : "ws://127.0.0.1:8099";

var alice = new Player("Alice");
var bob = new Player("Bob");

await alice.Connect(url);
await bob.Connect(url);

// Both say hello (quick match -> same room).
await alice.Send("{\"t\":\"hello\",\"name\":\"Alice\"}");
await bob.Send("{\"t\":\"hello\",\"name\":\"Bob\"}");

// Pump for ~3 seconds, sending inputs + a ping + one shoot from Alice.
var cts = new CancellationTokenSource(TimeSpan.FromSeconds(6));
var aliceRecv = alice.ReceiveLoop(cts.Token);
var bobRecv = bob.ReceiveLoop(cts.Token);

int seq = 0;
double t0 = Now();
bool shotFired = false;
while (!cts.IsCancellationRequested)
{
    seq++;
    // Report a plausible pose near a spawn so the validator accepts it.
    await alice.Send($"{{\"t\":\"input\",\"seq\":{seq},\"clientTime\":{Now()},\"pos\":[-12,1.8,-12],\"vel\":[0,0,0],\"yaw\":0,\"pitch\":0,\"buttons\":0,\"events\":0}}");
    await bob.Send($"{{\"t\":\"input\",\"seq\":{seq},\"clientTime\":{Now()},\"pos\":[12,1.8,12],\"vel\":[0,0,0],\"yaw\":0,\"pitch\":0,\"buttons\":0,\"events\":0}}");
    if (seq % 20 == 0)
        await alice.Send($"{{\"t\":\"ping\",\"clientTime\":{Now()}}}");
    // Fire a rocket once we're a second in (match should be live).
    if (!shotFired && Now() - t0 > 1500)
    {
        shotFired = true;
        await alice.Send($"{{\"t\":\"shoot\",\"seq\":1,\"weapon\":2,\"origin\":[-12,1.8,-12],\"dir\":[1,0,0],\"clientTime\":{Now()}}}");
    }
    await Task.Delay(33);
    if (alice.Got.Contains("spawn_proj") && alice.Got.Contains("snapshot") && alice.Got.Contains("pong")
        && bob.Got.Contains("snapshot") && alice.LiveSeen && bob.OpponentSeen)
        break;
}
cts.Cancel();
try { await Task.WhenAll(aliceRecv, bobRecv); } catch { }

// ---- assertions ----
int failed = 0;
void Check(bool cond, string label)
{
    Console.WriteLine($"  {(cond ? "ok  " : "FAIL")} {label}");
    if (!cond) failed++;
}

Console.WriteLine("Server smoke results:");
Check(alice.Got.Contains("joined"), "Alice received joined");
Check(bob.Got.Contains("joined"), "Bob received joined");
Check(alice.PlayerId > 0, $"Alice has a playerId ({alice.PlayerId})");
Check(bob.PlayerId > 0, $"Bob has a playerId ({bob.PlayerId})");
Check(alice.OpponentSeen, "Alice saw opponent roster");
Check(bob.OpponentSeen, "Bob saw opponent roster");
Check(alice.Got.Contains("match_state"), "Alice received match_state");
Check(alice.LiveSeen, "match went live (2 players)");
Check(alice.Got.Contains("snapshot"), "Alice received snapshots");
Check(alice.MaxPlayersInSnap >= 2, $"snapshot carried both players (max={alice.MaxPlayersInSnap})");
Check(alice.Got.Contains("pong"), "Alice received pong");
Check(alice.Got.Contains("spawn_proj"), "rocket spawn broadcast");

await alice.Close();
await bob.Close();

Console.WriteLine(failed == 0 ? "\nALL SMOKE CHECKS PASSED" : $"\n{failed} SMOKE CHECKS FAILED");
return failed == 0 ? 0 : 1;

static double Now() => (DateTime.UtcNow - DateTime.UnixEpoch).TotalMilliseconds;

class Player
{
    public readonly string Name;
    public readonly ClientWebSocket Ws = new();
    public readonly HashSet<string> Got = new();
    public int PlayerId = -1;
    public bool OpponentSeen = false;
    public bool LiveSeen = false;
    public int MaxPlayersInSnap = 0;

    public Player(string name) { Name = name; }

    public Task Connect(string url) => Ws.ConnectAsync(new Uri(url), CancellationToken.None);

    public Task Send(string s) => Ws.SendAsync(Encoding.UTF8.GetBytes(s), WebSocketMessageType.Text, true, CancellationToken.None);

    public async Task ReceiveLoop(CancellationToken ct)
    {
        var buf = new byte[64 * 1024];
        try
        {
            while (!ct.IsCancellationRequested && Ws.State == WebSocketState.Open)
            {
                var res = await Ws.ReceiveAsync(buf, ct);
                if (res.MessageType == WebSocketMessageType.Close) break;
                string text = Encoding.UTF8.GetString(buf, 0, res.Count);
                Handle(text);
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
    }

    private void Handle(string text)
    {
        try
        {
            using var doc = JsonDocument.Parse(text);
            string t = doc.RootElement.GetProperty("t").GetString();
            Got.Add(t);
            switch (t)
            {
                case "joined":
                    PlayerId = doc.RootElement.GetProperty("playerId").GetInt32();
                    break;
                case "opponent":
                    if (doc.RootElement.GetProperty("present").GetBoolean()) OpponentSeen = true;
                    break;
                case "match_state":
                    if (doc.RootElement.GetProperty("phase").GetString() == "live") LiveSeen = true;
                    break;
                case "snapshot":
                    int n = doc.RootElement.GetProperty("players").GetArrayLength();
                    if (n > MaxPlayersInSnap) MaxPlayersInSnap = n;
                    break;
            }
        }
        catch { }
    }

    public async Task Close()
    {
        try { await Ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None); } catch { }
    }
}
