// Per-slot weapon state: switch/reload/fire-cooldown timers and ammo bookkeeping.
// PURE LOGIC — no THREE, no DOM. The integration layer drives update()/tryFire()
// each tick and reads ammo()/switching/reloading for the HUD + viewmodel.
// All timings/ammo come from TUNING (single source of truth, PRD §4).

import { TUNING, EPSILON } from '@rivals/shared';
import type { WeaponSlot } from '@rivals/shared';

export interface AmmoView {
  clip: number;
  reserve: number;
}

// Internal per-slot runtime. AR/rocket use clip+reserve; knife has no ammo;
// grenade tracks a count that regenerates on a timer instead of reloading.
interface SlotState {
  slot: WeaponSlot;
  /** seconds between shots */
  fireInterval: number;
  /** full-auto (AR) vs semi (everything else). */
  auto: boolean;
  /** AR/rocket use a clip; knife/grenade do not. */
  usesClip: boolean;
  magSize: number;
  reloadTime: number;
  clip: number;
  reserve: number;
  /** time since last shot for this slot; starts ready. */
  cooldown: number;
  /** grenade-only: remaining seconds until the next grenade regenerates (<=0 = idle). */
  regenTimer: number;
}

function arState(): SlotState {
  const w = TUNING.ar;
  return {
    slot: 1,
    fireInterval: w.fireInterval,
    auto: true,
    usesClip: true,
    magSize: w.magSize,
    reloadTime: w.reloadTime,
    clip: w.magSize,
    reserve: w.reserveAmmo,
    cooldown: w.fireInterval,
    regenTimer: 0,
  };
}

function rocketState(): SlotState {
  const w = TUNING.rocket;
  return {
    slot: 2,
    fireInterval: w.fireInterval,
    auto: false,
    usesClip: true,
    magSize: w.magSize,
    reloadTime: w.reloadTime,
    clip: w.magSize,
    reserve: w.reserveAmmo,
    cooldown: w.fireInterval,
    regenTimer: 0,
  };
}

function knifeState(): SlotState {
  const w = TUNING.knife;
  return {
    slot: 3,
    fireInterval: w.swingTime,
    auto: false,
    usesClip: false,
    magSize: 0,
    reloadTime: 0,
    clip: 0,
    reserve: 0,
    cooldown: w.swingTime,
    regenTimer: 0,
  };
}

function grenadeState(): SlotState {
  const w = TUNING.grenade;
  return {
    slot: 4,
    // Throw is gated by the regen economy, not a per-shot cooldown; keep a tiny
    // interval so a single press throws exactly one (semi, rising-edge).
    fireInterval: 0,
    auto: false,
    usesClip: false,
    magSize: w.count,
    reloadTime: 0,
    clip: w.count, // current carried count
    reserve: 0,
    cooldown: 0,
    regenTimer: 0,
  };
}

export class Weapons {
  current: WeaponSlot = 1;

  private readonly slots: Record<WeaponSlot, SlotState>;

  // Switch block: tryFire() is false until this hits 0 after a select().
  private switchTimer = 0;
  // Reload block for the CURRENT slot (AR/rocket); applies to that slot only.
  private reloadTimer = 0;
  private reloadingSlot: WeaponSlot | null = null;

  // Rising-edge tracking for semi weapons: previous trigger held-state.
  private prevTrigger = false;

  constructor() {
    this.slots = {
      1: arState(),
      2: rocketState(),
      3: knifeState(),
      4: grenadeState(),
    };
  }

  private slot(s: WeaponSlot): SlotState {
    return this.slots[s];
  }

  get switching(): boolean {
    return this.switchTimer > 0;
  }

  get reloading(): boolean {
    return this.reloadingSlot !== null;
  }

  get knifeOut(): boolean {
    return this.current === 3;
  }

  /** Advance all timers: switch block, reload, per-slot fire cooldowns, grenade regen. */
  update(dt: number): void {
    if (this.switchTimer > 0) {
      this.switchTimer -= dt;
      if (this.switchTimer < 0) this.switchTimer = 0;
    }

    if (this.reloadingSlot !== null) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.completeReload(this.reloadingSlot);
        this.reloadTimer = 0;
        this.reloadingSlot = null;
      }
    }

    // Fire cooldowns for every slot tick down even when not selected, so a quick
    // swap back doesn't grant a free shot beyond the weapon's cadence.
    for (const k of [1, 2, 3, 4] as WeaponSlot[]) {
      const st = this.slots[k];
      if (st.cooldown < st.fireInterval) {
        st.cooldown += dt;
        if (st.cooldown > st.fireInterval) st.cooldown = st.fireInterval;
      }
    }

    // Grenade regen: 8s after a throw, restore one grenade up to count.
    const nade = this.slots[4];
    if (nade.regenTimer > 0) {
      nade.regenTimer -= dt;
      if (nade.regenTimer <= 0) {
        nade.regenTimer = 0;
        if (nade.clip < nade.magSize) {
          nade.clip += 1;
          // If still not full (count>1 in future tuning), queue the next one.
          if (nade.clip < nade.magSize) nade.regenTimer = TUNING.grenade.regenTime;
        }
      }
    }
  }

  /** Set current immediately and start a switchTime block where tryFire()==false. */
  select(slot: WeaponSlot): void {
    if (slot === this.current) return;
    this.current = slot;
    this.switchTimer = TUNING.combat.switchTime;
    // Swapping away cancels an in-progress reload (Quake/CS convention).
    if (this.reloadingSlot !== null) {
      this.reloadTimer = 0;
      this.reloadingSlot = null;
    }
  }

  /** Begin a reload for the current AR/rocket if it has room and spare ammo. */
  startReload(): void {
    const st = this.slot(this.current);
    if (!st.usesClip) return; // knife/grenade don't reload
    if (this.reloadingSlot === st.slot) return; // already reloading this slot
    if (st.clip >= st.magSize) return; // full
    if (st.reserve <= 0) return; // nothing to load
    if (this.switching) return; // can't reload mid-swap
    this.reloadingSlot = st.slot;
    this.reloadTimer = st.reloadTime;
  }

  private completeReload(slot: WeaponSlot): void {
    const st = this.slots[slot];
    const need = st.magSize - st.clip;
    const moved = Math.min(need, st.reserve);
    st.clip += moved;
    st.reserve -= moved;
  }

  /**
   * Try to fire with the given trigger state. Returns true and COMMITS the shot
   * (decrements ammo, restarts cooldown) iff allowed. AR is full-auto (fires on
   * any held frame past cooldown); slots 2/3/4 are semi (rising edge only).
   */
  tryFire(triggerHeld: boolean): boolean {
    const rising = triggerHeld && !this.prevTrigger;
    this.prevTrigger = triggerHeld;

    const st = this.slot(this.current);

    // Gate: can't fire while switching or while reloading THIS slot.
    if (this.switching) return false;
    if (this.reloadingSlot === st.slot) return false;

    // Trigger discipline.
    if (st.auto) {
      if (!triggerHeld) return false;
    } else {
      if (!rising) return false;
    }

    // Cooldown (EPSILON tolerance so a frame landing exactly on the interval
    // boundary is allowed to fire — float accumulation must not eat a shot).
    if (st.cooldown < st.fireInterval - EPSILON) return false;

    // Ammo.
    if (st.usesClip) {
      if (st.clip <= 0) return false;
    } else if (st.slot === 4) {
      if (st.clip <= 0) return false; // out of grenades
    }
    // knife (slot 3) has no ammo gate.

    // Commit.
    st.cooldown = 0;
    if (st.usesClip) {
      st.clip -= 1;
      // Convenience auto-reload when the clip empties (PRD-friendly QoL).
      if (st.clip === 0 && st.reserve > 0 && st.slot === this.current) {
        this.startReload();
      }
    } else if (st.slot === 4) {
      st.clip -= 1;
      // Start the regen clock if it isn't already running.
      if (st.regenTimer <= 0 && st.clip < st.magSize) {
        st.regenTimer = TUNING.grenade.regenTime;
      }
    }

    return true;
  }

  /** Ammo snapshot for the HUD. Grenade reports clip=count, reserve=0. */
  ammo(slot: WeaponSlot = this.current): AmmoView {
    const st = this.slot(slot);
    return { clip: st.clip, reserve: st.reserve };
  }
}
