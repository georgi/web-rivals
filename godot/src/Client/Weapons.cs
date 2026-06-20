// Per-slot weapon state: switch/reload/fire-cooldown timers and ammo bookkeeping.
// PURE LOGIC. Ported from client/src/weapons/weapon-state.ts. All timings/ammo
// come from Tuning (single source of truth).

using System.Collections.Generic;
using WebRivals.Shared;

namespace WebRivals.Client;

public struct AmmoView { public int Clip; public int Reserve; }

public sealed class Weapons
{
    private sealed class SlotState
    {
        public int Slot;
        public double FireInterval;
        public bool Auto;
        public bool UsesClip;
        public int MagSize;
        public double ReloadTime;
        public int Clip;
        public int Reserve;
        public double Cooldown;
        public double RegenTimer;
    }

    public int Current = 1;

    private readonly Dictionary<int, SlotState> _slots;
    private double _switchTimer = 0;
    private double _reloadTimer = 0;
    private int _reloadingSlot = -1; // -1 = none
    private bool _prevTrigger = false;

    public Weapons()
    {
        _slots = new Dictionary<int, SlotState>
        {
            { 1, ArState() },
            { 2, RocketState() },
            { 3, KnifeState() },
            { 4, GrenadeState() },
        };
    }

    private static SlotState ArState() => new()
    {
        Slot = 1, FireInterval = Tuning.Ar.FireInterval, Auto = true, UsesClip = true,
        MagSize = Tuning.Ar.MagSize, ReloadTime = Tuning.Ar.ReloadTime,
        Clip = Tuning.Ar.MagSize, Reserve = Tuning.Ar.ReserveAmmo, Cooldown = Tuning.Ar.FireInterval, RegenTimer = 0,
    };

    private static SlotState RocketState() => new()
    {
        Slot = 2, FireInterval = Tuning.Rocket.FireInterval, Auto = false, UsesClip = true,
        MagSize = Tuning.Rocket.MagSize, ReloadTime = Tuning.Rocket.ReloadTime,
        Clip = Tuning.Rocket.MagSize, Reserve = Tuning.Rocket.ReserveAmmo, Cooldown = Tuning.Rocket.FireInterval, RegenTimer = 0,
    };

    private static SlotState KnifeState() => new()
    {
        Slot = 3, FireInterval = Tuning.Knife.SwingTime, Auto = false, UsesClip = false,
        MagSize = 0, ReloadTime = 0, Clip = 0, Reserve = 0, Cooldown = Tuning.Knife.SwingTime, RegenTimer = 0,
    };

    private static SlotState GrenadeState() => new()
    {
        Slot = 4, FireInterval = 0, Auto = false, UsesClip = false,
        MagSize = Tuning.Grenade.Count, ReloadTime = 0, Clip = Tuning.Grenade.Count, Reserve = 0, Cooldown = 0, RegenTimer = 0,
    };

    private SlotState Slot(int s) => _slots[s];

    public bool Switching => _switchTimer > 0;
    public bool Reloading => _reloadingSlot != -1;
    public bool KnifeOut => Current == 3;

    public void Update(double dt)
    {
        if (_switchTimer > 0)
        {
            _switchTimer -= dt;
            if (_switchTimer < 0) _switchTimer = 0;
        }

        if (_reloadingSlot != -1)
        {
            _reloadTimer -= dt;
            if (_reloadTimer <= 0)
            {
                CompleteReload(_reloadingSlot);
                _reloadTimer = 0;
                _reloadingSlot = -1;
            }
        }

        foreach (int k in new[] { 1, 2, 3, 4 })
        {
            var st = _slots[k];
            if (st.Cooldown < st.FireInterval)
            {
                st.Cooldown += dt;
                if (st.Cooldown > st.FireInterval) st.Cooldown = st.FireInterval;
            }
        }

        var nade = _slots[4];
        if (nade.RegenTimer > 0)
        {
            nade.RegenTimer -= dt;
            if (nade.RegenTimer <= 0)
            {
                nade.RegenTimer = 0;
                if (nade.Clip < nade.MagSize)
                {
                    nade.Clip += 1;
                    if (nade.Clip < nade.MagSize) nade.RegenTimer = Tuning.Grenade.RegenTime;
                }
            }
        }
    }

    public void Select(int slot)
    {
        if (slot == Current) return;
        Current = slot;
        _switchTimer = Tuning.Combat.SwitchTime;
        if (_reloadingSlot != -1)
        {
            _reloadTimer = 0;
            _reloadingSlot = -1;
        }
    }

    public void StartReload()
    {
        var st = Slot(Current);
        if (!st.UsesClip) return;
        if (_reloadingSlot == st.Slot) return;
        if (st.Clip >= st.MagSize) return;
        if (st.Reserve <= 0) return;
        if (Switching) return;
        _reloadingSlot = st.Slot;
        _reloadTimer = st.ReloadTime;
    }

    private void CompleteReload(int slot)
    {
        var st = _slots[slot];
        int need = st.MagSize - st.Clip;
        int moved = System.Math.Min(need, st.Reserve);
        st.Clip += moved;
        st.Reserve -= moved;
    }

    public bool TryFire(bool triggerHeld)
    {
        bool rising = triggerHeld && !_prevTrigger;
        _prevTrigger = triggerHeld;

        var st = Slot(Current);
        if (Switching) return false;
        if (_reloadingSlot == st.Slot) return false;

        if (st.Auto)
        {
            if (!triggerHeld) return false;
        }
        else
        {
            if (!rising) return false;
        }

        if (st.Cooldown < st.FireInterval - VMath.EPSILON) return false;

        if (st.UsesClip)
        {
            if (st.Clip <= 0) return false;
        }
        else if (st.Slot == 4)
        {
            if (st.Clip <= 0) return false;
        }

        st.Cooldown = 0;
        if (st.UsesClip)
        {
            st.Clip -= 1;
            if (st.Clip == 0 && st.Reserve > 0 && st.Slot == Current) StartReload();
        }
        else if (st.Slot == 4)
        {
            st.Clip -= 1;
            if (st.RegenTimer <= 0 && st.Clip < st.MagSize) st.RegenTimer = Tuning.Grenade.RegenTime;
        }

        return true;
    }

    public AmmoView Ammo(int slot = -1)
    {
        var st = Slot(slot == -1 ? Current : slot);
        return new AmmoView { Clip = st.Clip, Reserve = st.Reserve };
    }
}
