// DelayedTransport tests (vitest, node, no real timers). A FakeTransport records
// outbound sends and lets the test push inbound messages; a manual scheduler
// holds a queue of {fn, due} that advance(ms) drains in order; a seeded RNG
// makes drop + jitter deterministic. We assert delivery delay, jitter bounds,
// full drop, full pass-through, and that send() is delayed identically.

import { describe, it, expect } from 'vitest';
import { DelayedTransport, type Transport } from './transport';

// ---- Test doubles ----------------------------------------------------------

// Records sends and exposes a hook to simulate inbound messages / lifecycle.
class FakeTransport implements Transport {
  readonly sent: string[] = [];
  isOpen = false;
  closed = false;
  private messageCb: ((data: string) => void) | null = null;
  private openCb: (() => void) | null = null;
  private closeCb: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }
  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.closed = true;
  }

  // Drive the inner side from the test.
  pushMessage(data: string): void {
    this.messageCb?.(data);
  }
  pushOpen(): void {
    this.openCb?.();
  }
  pushClose(): void {
    this.closeCb?.();
  }
}

// Deterministic scheduler: schedule() enqueues, advance(ms) fires everything due
// by the new clock time, in ascending due order. Returns a now() for assertions.
class FakeScheduler {
  private clock = 0;
  private seq = 0;
  private queue: { fn: () => void; due: number; order: number }[] = [];

  readonly schedule = (fn: () => void, ms: number): void => {
    this.queue.push({ fn, due: this.clock + ms, order: this.seq++ });
  };

  advance(ms: number): void {
    const target = this.clock + ms;
    // Fire repeatedly so callbacks that schedule further work are handled too.
    for (;;) {
      const next = this.queue
        .filter((e) => e.due <= target)
        .sort((a, b) => a.due - b.due || a.order - b.order)[0];
      if (!next) break;
      this.queue.splice(this.queue.indexOf(next), 1);
      this.clock = next.due;
      next.fn();
    }
    this.clock = target;
  }

  get now(): number {
    return this.clock;
  }
  get pending(): number {
    return this.queue.length;
  }
}

// Seeded RNG (mulberry32) -> reproducible drop + jitter draws.
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A constant RNG is the simplest way to pin jitter exactly: rng()=0.5 -> jitter
// term (0.5*2-1)=0, so latency == delayMs with no jitter contribution.
const half = () => 0.5;

// ---- Inbound delivery ------------------------------------------------------

describe('DelayedTransport inbound', () => {
  it('delivers a message after exactly delayMs (no jitter)', () => {
    const inner = new FakeTransport();
    const sched = new FakeScheduler();
    const dt = new DelayedTransport(inner, {
      delayMs: 100,
      jitterMs: 0,
      dropRate: 0,
      rng: half,
      schedule: sched.schedule,
    });

    const got: string[] = [];
    dt.onMessage((d) => got.push(d));

    inner.pushMessage('hi');
    expect(got).toEqual([]); // not yet
    sched.advance(99);
    expect(got).toEqual([]); // still pending
    sched.advance(1);
    expect(got).toEqual(['hi']); // fires at 100ms
  });

  it('keeps jitter within +/- jitterMs of delayMs', () => {
    const inner = new FakeTransport();
    const sched = new FakeScheduler();
    // Record the scheduled delay by spying through a wrapping scheduler.
    const delays: number[] = [];
    const recording = (fn: () => void, ms: number) => {
      delays.push(ms);
      sched.schedule(fn, ms);
    };
    const dt = new DelayedTransport(inner, {
      delayMs: 100,
      jitterMs: 30,
      dropRate: 0,
      rng: seededRng(12345),
      schedule: recording,
    });
    dt.onMessage(() => {});

    for (let i = 0; i < 500; i++) inner.pushMessage('m' + i);

    expect(delays.length).toBe(500);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(70); // 100 - 30
      expect(d).toBeLessThanOrEqual(130); // 100 + 30
    }
    // Sanity: jitter actually varies (not all pinned to 100).
    const distinct = new Set(delays.map((d) => Math.round(d)));
    expect(distinct.size).toBeGreaterThan(10);
  });

  it('latency never goes negative even when jitter exceeds delay', () => {
    const inner = new FakeTransport();
    const sched = new FakeScheduler();
    const delays: number[] = [];
    const recording = (fn: () => void, ms: number) => {
      delays.push(ms);
      sched.schedule(fn, ms);
    };
    const dt = new DelayedTransport(inner, {
      delayMs: 10,
      jitterMs: 50, // can drive raw latency below zero
      dropRate: 0,
      rng: seededRng(7),
      schedule: recording,
    });
    dt.onMessage(() => {});
    for (let i = 0; i < 500; i++) inner.pushMessage('x');
    for (const d of delays) expect(d).toBeGreaterThanOrEqual(0);
  });

  it('dropRate=1 delivers nothing', () => {
    const inner = new FakeTransport();
    const sched = new FakeScheduler();
    const dt = new DelayedTransport(inner, {
      delayMs: 100,
      jitterMs: 10,
      dropRate: 1,
      rng: seededRng(1),
      schedule: sched.schedule,
    });
    const got: string[] = [];
    dt.onMessage((d) => got.push(d));

    for (let i = 0; i < 100; i++) inner.pushMessage('drop' + i);
    expect(sched.pending).toBe(0); // nothing even scheduled
    sched.advance(10_000);
    expect(got).toEqual([]);
  });

  it('dropRate=0 delivers everything in order', () => {
    const inner = new FakeTransport();
    const sched = new FakeScheduler();
    const dt = new DelayedTransport(inner, {
      delayMs: 50,
      jitterMs: 0, // fixed delay -> FIFO preserved
      dropRate: 0,
      rng: seededRng(99),
      schedule: sched.schedule,
    });
    const got: string[] = [];
    dt.onMessage((d) => got.push(d));

    const expected: string[] = [];
    for (let i = 0; i < 100; i++) {
      expected.push('m' + i);
      inner.pushMessage('m' + i);
    }
    sched.advance(50);
    expect(got).toEqual(expected);
  });
});

// ---- Outbound send ---------------------------------------------------------

describe('DelayedTransport send', () => {
  it('delays send() to the inner transport by delayMs', () => {
    const inner = new FakeTransport();
    const sched = new FakeScheduler();
    const dt = new DelayedTransport(inner, {
      delayMs: 100,
      jitterMs: 0,
      dropRate: 0,
      rng: half,
      schedule: sched.schedule,
    });

    dt.send('ping');
    expect(inner.sent).toEqual([]); // not yet at inner
    sched.advance(100);
    expect(inner.sent).toEqual(['ping']);
  });

  it('drops sends when dropRate=1 and passes all when dropRate=0', () => {
    // dropRate=1
    {
      const inner = new FakeTransport();
      const sched = new FakeScheduler();
      const dt = new DelayedTransport(inner, {
        delayMs: 10,
        jitterMs: 0,
        dropRate: 1,
        rng: seededRng(3),
        schedule: sched.schedule,
      });
      for (let i = 0; i < 50; i++) dt.send('s' + i);
      sched.advance(1000);
      expect(inner.sent).toEqual([]);
    }
    // dropRate=0
    {
      const inner = new FakeTransport();
      const sched = new FakeScheduler();
      const dt = new DelayedTransport(inner, {
        delayMs: 10,
        jitterMs: 0,
        dropRate: 0,
        rng: seededRng(3),
        schedule: sched.schedule,
      });
      const expected: string[] = [];
      for (let i = 0; i < 50; i++) {
        expected.push('s' + i);
        dt.send('s' + i);
      }
      sched.advance(10);
      expect(inner.sent).toEqual(expected);
    }
  });

  it('keeps send jitter within +/- jitterMs', () => {
    const inner = new FakeTransport();
    const sched = new FakeScheduler();
    const delays: number[] = [];
    const recording = (fn: () => void, ms: number) => {
      delays.push(ms);
      sched.schedule(fn, ms);
    };
    const dt = new DelayedTransport(inner, {
      delayMs: 100,
      jitterMs: 20,
      dropRate: 0,
      rng: seededRng(42),
      schedule: recording,
    });
    for (let i = 0; i < 500; i++) dt.send('s');
    expect(delays.length).toBe(500);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(80);
      expect(d).toBeLessThanOrEqual(120);
    }
  });

  it('approximates dropRate over many sends', () => {
    const inner = new FakeTransport();
    const sched = new FakeScheduler();
    const dt = new DelayedTransport(inner, {
      delayMs: 0,
      jitterMs: 0,
      dropRate: 0.5,
      rng: seededRng(2024),
      schedule: sched.schedule,
    });
    const N = 5000;
    for (let i = 0; i < N; i++) dt.send('s');
    sched.advance(1);
    const delivered = inner.sent.length;
    // ~50% with comfortable tolerance for the seeded stream.
    expect(delivered).toBeGreaterThan(N * 0.4);
    expect(delivered).toBeLessThan(N * 0.6);
  });
});

// ---- Lifecycle pass-through ------------------------------------------------

describe('DelayedTransport lifecycle', () => {
  it('passes open/close through, delayed', () => {
    const inner = new FakeTransport();
    const sched = new FakeScheduler();
    const dt = new DelayedTransport(inner, {
      delayMs: 100,
      jitterMs: 0,
      dropRate: 0,
      rng: half,
      schedule: sched.schedule,
    });
    let opened = 0;
    let closed = 0;
    dt.onOpen(() => opened++);
    dt.onClose(() => closed++);

    inner.pushOpen();
    inner.pushClose();
    expect(opened).toBe(0);
    expect(closed).toBe(0);
    sched.advance(100);
    expect(opened).toBe(1);
    expect(closed).toBe(1);
  });

  it('isOpen and close() proxy the inner transport', () => {
    const inner = new FakeTransport();
    const sched = new FakeScheduler();
    const dt = new DelayedTransport(inner, {
      delayMs: 0,
      jitterMs: 0,
      dropRate: 0,
      schedule: sched.schedule,
    });
    expect(dt.isOpen).toBe(false);
    inner.isOpen = true;
    expect(dt.isOpen).toBe(true);

    dt.close();
    expect(inner.closed).toBe(true);
  });
});
