// Procedural SFX. The TS original synthesizes every sound from the Web Audio
// graph at runtime; here we bake compact procedural clips into AudioStreamWAV at
// startup and play them 2D (own weapons / UI) or 3D (world explosions). Audio is
// strictly non-critical — methods are safe no-ops on any failure. Public surface
// mirrors client/src/audio.ts.

using System;
using System.Collections.Generic;
using Godot;
using WebRivals.Shared;
using static WebRivals.Client.GodotConv;

namespace WebRivals.Client.Audio;

public sealed partial class AudioManager : Node
{
    private const int Rate = 22050;
    private readonly Dictionary<string, AudioStreamWav> _clips = new();
    private readonly Random _rng = new(12345);
    private float _masterVolume = 0.6f;
    private bool _headless = false;

    public override void _Ready()
    {
        // No audio device under the headless/dummy driver (server, CI) — skip it
        // entirely. Audio is strictly non-critical, so this never affects gameplay.
        _headless = DisplayServer.GetName() == "headless";
        if (_headless) return;
        try { BakeClips(); }
        catch (Exception e) { GD.PrintErr($"[audio] bake failed (non-fatal): {e.Message}"); }
    }

    // ---- public API (mirrors audio.ts) ----
    public void Resume() { }

    public void SetMasterVolume(double v)
    {
        _masterVolume = (float)Math.Clamp(v, 0, 1);
        // Drive the Master bus so every player scales together.
        int bus = AudioServer.GetBusIndex("Master");
        AudioServer.SetBusVolumeDb(bus, _masterVolume <= 0.0001f ? -80f : Mathf.LinearToDb(_masterVolume));
    }

    public void UpdateListener(Vec3 pos, Vec3 fwd, Vec3 up) { /* Godot uses the active Camera3D */ }

    public void Shoot(int slot) => Play2D(slot switch { 1 => "ar", 2 => "rocket", 3 => "knife", _ => "grenade" });
    public void Reload() => Play2D("reload");
    public void Hitmarker() => Play2D("hitmarker");
    public void Jump() => Play2D("jump");
    public void Land() => Play2D("land");
    public void SlideStart() => Play2D("slide");
    public void Kill() => Play2D("kill");
    public void RoundEnd(bool youWon) => Play2D(youWon ? "win" : "lose");
    public void ExplosionAt(Vec3 pos) => Play3D("explosion", pos);

    // ---- playback ----

    private void Play2D(string name)
    {
        if (_headless || !_clips.TryGetValue(name, out var clip)) return;
        var p = new AudioStreamPlayer { Stream = clip, Autoplay = false };
        AddChild(p);
        p.Play();
        FreeAfter(p, 3.0);
    }

    private void Play3D(string name, Vec3 pos)
    {
        if (_headless || !_clips.TryGetValue(name, out var clip)) return;
        var p = new AudioStreamPlayer3D { Stream = clip, Position = ToGd(pos), UnitSize = 6f, MaxDistance = 40f };
        AddChild(p);
        p.Play();
        FreeAfter(p, 3.0);
    }

    // Free on the MAIN thread via a scene-tree timer. Using the player's Finished
    // signal would fire on the audio mixer thread and crash on node teardown.
    private void FreeAfter(Node p, double seconds)
    {
        var t = GetTree().CreateTimer(seconds);
        t.Timeout += () => { if (IsInstanceValid(p)) p.QueueFree(); };
    }

    // ---- baking ----

    private void BakeClips()
    {
        _clips["ar"] = Wav(Mix(Noise(0.08, 4000, 1200, 0.4), Blip(0.06, 220, 90, 0.18, Wave.Square)));
        _clips["rocket"] = Wav(Mix(NoiseBand(0.4, 300, 1400, 0.5), Blip(0.3, 180, 90, 0.22, Wave.Sine)));
        _clips["knife"] = Wav(NoiseBand(0.16, 800, 3500, 0.35));
        _clips["grenade"] = Wav(Mix(Blip(0.1, 200, 80, 0.26, Wave.Triangle), Noise(0.05, 600, 600, 0.14)));
        _clips["jump"] = Wav(Blip(0.08, 320, 560, 0.14, Wave.Triangle));
        _clips["land"] = Wav(Mix(Blip(0.12, 160, 70, 0.22, Wave.Sine), Noise(0.06, 500, 500, 0.12)));
        _clips["slide"] = Wav(NoiseBand(0.3, 2600, 700, 0.3));
        _clips["hitmarker"] = Wav(Blip(0.05, 2400, 2600, 0.3, Wave.Square));
        _clips["kill"] = Wav(Mix(Blip(0.04, 900, 1300, 0.32, Wave.Square), Blip(0.14, 1300, 500, 0.22, Wave.Square)));
        _clips["reload"] = Wav(Mix(Noise(0.03, 1800, 1800, 0.22), Offset(Noise(0.04, 1200, 1200, 0.28), 0.08)));
        _clips["explosion"] = Wav(Mix(NoiseBand(0.5, 2000, 200, 0.9), Blip(0.45, 120, 40, 0.7, Wave.Sine)));
        _clips["win"] = Wav(Arp(new[] { 523.25, 659.25, 783.99, 1046.5 }, 0.1, 0.18, 0.24));
        _clips["lose"] = Wav(Blip(0.5, 440, 150, 0.26, Wave.Saw));
    }

    private enum Wave { Sine, Square, Triangle, Saw }

    private float[] Blip(double dur, double f0, double f1, double peak, Wave wave)
    {
        int n = (int)(Rate * (dur + 0.02));
        var outBuf = new float[n];
        double phase = 0;
        for (int i = 0; i < n; i++)
        {
            double t = (double)i / Rate;
            double frac = Math.Min(1, t / dur);
            double freq = f0 * Math.Pow(Math.Max(1, f1) / f0, frac); // exp pitch ramp
            phase += freq / Rate;
            double s = Osc(wave, phase);
            outBuf[i] = (float)(s * peak * Env(t, dur, 0.005));
        }
        return outBuf;
    }

    private float[] Arp(double[] freqs, double step, double dur, double peak)
    {
        int total = (int)(Rate * (step * freqs.Length + dur));
        var outBuf = new float[total];
        for (int k = 0; k < freqs.Length; k++)
        {
            var note = Blip(dur, freqs[k], freqs[k], peak, Wave.Triangle);
            int off = (int)(Rate * step * k);
            for (int i = 0; i < note.Length && off + i < total; i++) outBuf[off + i] += note[i];
        }
        return outBuf;
    }

    private float[] Noise(double dur, double cutStart, double cutEnd, double peak)
        => NoiseInternal(dur, cutStart, cutEnd, peak, false);

    private float[] NoiseBand(double dur, double cutStart, double cutEnd, double peak)
        => NoiseInternal(dur, cutStart, cutEnd, peak, true);

    private float[] NoiseInternal(double dur, double cutStart, double cutEnd, double peak, bool band)
    {
        int n = (int)(Rate * (dur + 0.02));
        var outBuf = new float[n];
        double lp = 0;
        for (int i = 0; i < n; i++)
        {
            double t = (double)i / Rate;
            double frac = Math.Min(1, t / dur);
            double cut = cutStart * Math.Pow(Math.Max(1, cutEnd) / Math.Max(1, cutStart), frac);
            double a = Math.Clamp(cut / Rate, 0, 1);
            double w = _rng.NextDouble() * 2 - 1;
            lp += a * (w - lp); // one-pole lowpass with sweeping cutoff
            double s = band ? (w - lp) : lp; // band-ish = highpass residual, else lowpass
            outBuf[i] = (float)(s * peak * Env(t, dur, 0.005));
        }
        return outBuf;
    }

    private static double Osc(Wave w, double phase)
    {
        double p = phase - Math.Floor(phase);
        return w switch
        {
            Wave.Sine => Math.Sin(p * Math.PI * 2),
            Wave.Square => p < 0.5 ? 1 : -1,
            Wave.Triangle => 4 * Math.Abs(p - 0.5) - 1,
            _ => 2 * p - 1, // saw
        };
    }

    private static double Env(double t, double dur, double attack)
    {
        if (t >= dur) return 0;
        if (t < attack) return t / attack;
        double d = (t - attack) / Math.Max(0.0001, dur - attack);
        return Math.Exp(-4 * d); // exponential-ish decay
    }

    private static float[] Mix(params float[][] parts)
    {
        int n = 0;
        foreach (var p in parts) n = Math.Max(n, p.Length);
        var outBuf = new float[n];
        foreach (var p in parts)
            for (int i = 0; i < p.Length; i++) outBuf[i] += p[i];
        return outBuf;
    }

    private static float[] Offset(float[] buf, double seconds)
    {
        int off = (int)(Rate * seconds);
        var outBuf = new float[buf.Length + off];
        for (int i = 0; i < buf.Length; i++) outBuf[off + i] = buf[i];
        return outBuf;
    }

    private static AudioStreamWav Wav(float[] samples)
    {
        var data = new byte[samples.Length * 2];
        for (int i = 0; i < samples.Length; i++)
        {
            int v = (int)Math.Clamp(samples[i] * 32767f, -32768, 32767);
            data[i * 2] = (byte)(v & 0xFF);
            data[i * 2 + 1] = (byte)((v >> 8) & 0xFF);
        }
        return new AudioStreamWav
        {
            Format = AudioStreamWav.FormatEnum.Format16Bits,
            MixRate = Rate,
            Stereo = false,
            Data = data,
        };
    }
}
