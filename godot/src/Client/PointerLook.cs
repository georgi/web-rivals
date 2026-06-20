// Mouselook with mouse capture. Owns yaw/pitch; ApplyTo() drives the Camera3D
// from the sim's eye position. Ported from client/src/camera.ts. The sim's yaw
// convention (yaw=0 looks toward -Z) matches a Godot camera with euler order YXZ.

using System;
using Godot;
using WebRivals.Shared;

namespace WebRivals.Client;

public sealed class PointerLook
{
    public double Yaw = 0;
    public double Pitch = 0;
    public double Sensitivity = 0.0022; // radians per device pixel

    private static readonly double PitchLimit = 85 * VMath.DEG2RAD;

    private bool _locked = false;
    public Action<bool> OnLockChange;

    public bool Locked => _locked;

    public void RequestLock()
    {
        Godot.Input.MouseMode = Godot.Input.MouseModeEnum.Captured;
        SetLocked(true);
    }

    public void ReleaseLock()
    {
        Godot.Input.MouseMode = Godot.Input.MouseModeEnum.Visible;
        SetLocked(false);
    }

    private void SetLocked(bool v)
    {
        if (_locked == v) return;
        _locked = v;
        OnLockChange?.Invoke(v);
    }

    /// <summary>Feed mouse-motion events; only applied while captured.</summary>
    public void HandleEvent(InputEvent e)
    {
        // The user pressing Esc releases capture; reflect that.
        if (Godot.Input.MouseMode != Godot.Input.MouseModeEnum.Captured && _locked)
            SetLocked(false);

        if (e is InputEventMouseMotion mm && _locked)
        {
            Yaw -= mm.Relative.X * Sensitivity;
            Pitch -= mm.Relative.Y * Sensitivity;
            if (Pitch > PitchLimit) Pitch = PitchLimit;
            else if (Pitch < -PitchLimit) Pitch = -PitchLimit;
        }
    }

    /// <summary>Position the camera at the eye, orient from yaw/pitch, set FOV.</summary>
    public void ApplyTo(Camera3D camera, Vector3 eye, double fovDeg)
    {
        camera.Position = eye;
        camera.RotationOrder = EulerOrder.Yxz;
        camera.Rotation = new Vector3((float)Pitch, (float)Yaw, 0);
        if (Math.Abs(camera.Fov - fovDeg) > 0.001)
            camera.Fov = (float)fovDeg;
    }
}
