// Keyboard/mouse -> protocol Button bitfield + buffered jump edge. The sim
// consumes InputFrame; this layer owns the 100ms jump buffer. Ported from
// client/src/input.ts. Continuous state is polled from Godot's Input each frame;
// discrete events (weapon select, wheel) come through HandleEvent.

using Godot;
using WebRivals.Shared;
using WebRivals.Shared.Sim;
using Button = WebRivals.Shared.Button;

namespace WebRivals.Client;

public sealed class InputManager
{
    public int SelectedWeapon = 1;

    private int _buttonState = 0;
    private bool _enabled = true;

    private double _lastJumpPress = double.NegativeInfinity;
    private bool _jumpConsumed = true;
    private bool _prevJumpHeld = false;
    private readonly double _bufferMs = Tuning.Movement.InputBufferTime * 1000;

    public int Buttons => _buttonState;

    public void SetEnabled(bool on)
    {
        _enabled = on;
        if (!on)
        {
            _buttonState = 0;
            _jumpConsumed = true;
        }
    }

    /// <summary>Poll continuous key/mouse state into the button bitfield + jump
    /// buffer edge. Call once per simulation tick before BuildFrame.</summary>
    public void Update()
    {
        if (!_enabled)
        {
            _buttonState = 0;
            return;
        }

        int b = 0;
        if (Down(Key.W) || Down(Key.Up)) b |= Button.Forward;
        if (Down(Key.S) || Down(Key.Down)) b |= Button.Back;
        if (Down(Key.A) || Down(Key.Left)) b |= Button.Left;
        if (Down(Key.D) || Down(Key.Right)) b |= Button.Right;
        if (Down(Key.Shift)) b |= Button.Sprint;
        if (Down(Key.Ctrl) || Down(Key.C)) b |= Button.Crouch;
        if (Down(Key.R)) b |= Button.Reload;
        if (Down(Key.Space)) b |= Button.Jump;
        if (Godot.Input.IsMouseButtonPressed(MouseButton.Left)) b |= Button.Fire;
        if (Godot.Input.IsMouseButtonPressed(MouseButton.Right)) b |= Button.AltFire;

        // Jump edge -> arm the buffer.
        bool jumpHeld = (b & Button.Jump) != 0;
        if (jumpHeld && !_prevJumpHeld)
        {
            _lastJumpPress = Now();
            _jumpConsumed = false;
        }
        _prevJumpHeld = jumpHeld;

        _buttonState = b;
    }

    /// <summary>Discrete inputs: weapon select 1..4 and mouse-wheel cycling.</summary>
    public void HandleEvent(InputEvent e)
    {
        if (!_enabled) return;
        if (e is InputEventKey k && k.Pressed && !k.Echo)
        {
            switch (k.PhysicalKeycode)
            {
                case Key.Key1: SelectedWeapon = 1; break;
                case Key.Key2: SelectedWeapon = 2; break;
                case Key.Key3: SelectedWeapon = 3; break;
                case Key.Key4: SelectedWeapon = 4; break;
            }
        }
        else if (e is InputEventMouseButton mb && mb.Pressed)
        {
            if (mb.ButtonIndex == MouseButton.WheelDown)
                SelectedWeapon = ((SelectedWeapon - 1 + 1 + 4) % 4) + 1;
            else if (mb.ButtonIndex == MouseButton.WheelUp)
                SelectedWeapon = ((SelectedWeapon - 1 - 1 + 4) % 4) + 1;
        }
    }

    public InputFrame BuildFrame(double yaw, double pitch)
    {
        bool jump = false;
        if (_enabled && !_jumpConsumed)
            jump = Now() - _lastJumpPress <= _bufferMs;
        return new InputFrame { Buttons = _enabled ? _buttonState : 0, Yaw = yaw, Pitch = pitch, Jump = jump };
    }

    public void ConsumeJump() => _jumpConsumed = true;

    private static bool Down(Key key) => Godot.Input.IsPhysicalKeyPressed(key);
    private static double Now() => Time.GetTicksMsec();
}
