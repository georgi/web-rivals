// Procedural articulated humanoid — the blocky body shared by the networked
// opponent and the practice dummy. Limbs hang from shoulder/hip pivot groups so a
// single X-rotation swings each. Drives a speed-scaled contralateral walk/run
// cycle, a subtle idle breath, and a tucked airborne pose. Ported from
// client/src/entities/humanoid.ts.

using System;
using Godot;
using WebRivals.Shared;

namespace WebRivals.Client.Render;

public sealed class Humanoid
{
    public readonly Node3D Object;

    private readonly Node3D _torso;
    private readonly Node3D _lArm, _rArm, _lLeg, _rLeg;

    private double _phase = 0;
    private double _time = 0;
    private double _amp = 0;
    private double _air = 0;

    private const double StepPerM = 1.35;
    private static readonly double RunRef = Tuning.Movement.SprintSpeed;
    private const double MoveEps = 0.4;
    private const double MaxLeg = 0.85;
    private const double MaxArm = 0.55;
    private const double ArmRest = 0.06;
    private const double BreatheHz = 1.4;

    public Humanoid(Material mat)
    {
        Object = new Node3D();

        _torso = new Node3D();
        _torso.AddChild(BoxMeshNode(mat, 0.5f, 0.7f, 0.28f, new Vector3(0, 0.15f, 0)));   // torso
        _torso.AddChild(BoxMeshNode(mat, 0.34f, 0.34f, 0.34f, new Vector3(0, 0.68f, 0))); // head

        _lArm = Limb(mat, 0.16f, 0.6f, 0.18f, -0.37f, 0.48f);
        _rArm = Limb(mat, 0.16f, 0.6f, 0.18f, 0.37f, 0.48f);
        _torso.AddChild(_lArm);
        _torso.AddChild(_rArm);

        _lLeg = Limb(mat, 0.2f, 0.7f, 0.22f, -0.13f, -0.2f);
        _rLeg = Limb(mat, 0.2f, 0.7f, 0.22f, 0.13f, -0.2f);

        Object.AddChild(_torso);
        Object.AddChild(_lLeg);
        Object.AddChild(_rLeg);
    }

    private static MeshInstance3D BoxMeshNode(Material mat, float w, float h, float d, Vector3 pos)
    {
        var mi = new MeshInstance3D { Mesh = new BoxMesh { Size = new Vector3(w, h, d) }, MaterialOverride = mat, Position = pos };
        mi.CastShadow = GeometryInstance3D.ShadowCastingSetting.On;
        return mi;
    }

    private static Node3D Limb(Material mat, float w, float h, float d, float x, float pivotY)
    {
        var pivot = new Node3D { Position = new Vector3(x, pivotY, 0) };
        pivot.AddChild(BoxMeshNode(mat, w, h, d, new Vector3(0, -h / 2, 0)));
        return pivot;
    }

    public void Update(double dt, double speed, bool grounded)
    {
        _time += dt;

        bool moving = speed > MoveEps;
        if (moving) _phase += speed * dt * StepPerM;

        double targetAmp = moving ? Math.Min(speed / RunRef, 1) : 0;
        _amp = VMath.Damp(_amp, targetAmp, 9, dt);
        _air = VMath.Damp(_air, grounded ? 0 : 1, 10, dt);

        double swing = Math.Sin(_phase);
        double legA = swing * MaxLeg * _amp;
        double armA = -swing * MaxArm * _amp;

        const double legAir = 0.7;
        const double armAir = -0.5;

        double a = _air;
        _lLeg.Rotation = new Vector3((float)(legA * (1 - a) + legAir * a), 0, 0);
        _rLeg.Rotation = new Vector3((float)(-legA * (1 - a) + legAir * 0.4 * a), 0, 0);
        _lArm.Rotation = new Vector3((float)((ArmRest + armA) * (1 - a) + armAir * a), 0, 0);
        _rArm.Rotation = new Vector3((float)((ArmRest - armA) * (1 - a) + armAir * a), 0, 0);

        double stillness = (1 - _amp) * (1 - _air);
        double breath = Math.Sin(_time * BreatheHz * Math.PI * 2);
        _torso.Position = new Vector3(0, (float)(breath * 0.012 * stillness), 0);
        _torso.Rotation = new Vector3((float)(breath * 0.02 * stillness), 0, 0);
    }
}
