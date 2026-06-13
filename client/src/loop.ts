// Fixed-timestep accumulator loop (PRD §3.2, §8). The sim advances in fixed
// `dt` steps for determinism; render is called once per animation frame with an
// interpolation `alpha` (0..1) so motion stays smooth between sim ticks even
// when the display refresh and the sim rate disagree.
//
// Frame delta is clamped to `maxCatchupMs` so a backgrounded tab (huge dt on
// return) does not trigger a spiral-of-death catch-up; it just drops time.

export interface SimLoop {
  start(): void;
  stop(): void;
}

export function createLoop(opts: {
  dt: number; // fixed sim step in seconds
  maxCatchupMs: number; // clamp on a single frame's elapsed time
  step: () => void; // advance the sim one fixed tick
  render: (alpha: number) => void; // draw, interpolated by alpha in [0,1)
}): SimLoop {
  const stepMs = opts.dt * 1000;
  let accumulator = 0;
  let last = 0;
  let rafId = 0;
  let running = false;

  const frame = (now: number): void => {
    if (!running) return;
    rafId = requestAnimationFrame(frame);

    let elapsed = now - last;
    last = now;
    if (elapsed > opts.maxCatchupMs) elapsed = opts.maxCatchupMs;
    accumulator += elapsed;

    while (accumulator >= stepMs) {
      opts.step();
      accumulator -= stepMs;
    }

    opts.render(accumulator / stepMs);
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      accumulator = 0;
      last = performance.now();
      rafId = requestAnimationFrame(frame);
    },
    stop(): void {
      running = false;
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    },
  };
}
