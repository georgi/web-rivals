// Network transport abstraction (PRD §3.3). All client networking goes through
// the Transport interface so the WebSocket implementation can be swapped for
// WebRTC later without touching call sites. DelayedTransport wraps any inner
// transport to inject latency + packet loss; ALL M3 networked testing runs
// through it (100ms / 2% loss) and unit tests drive it with a fake scheduler.

export interface Transport {
  send(data: string): void;
  onMessage(cb: (data: string) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: () => void): void;
  readonly isOpen: boolean;
  close(): void;
}

/**
 * Wraps a browser WebSocket. Sends issued before the socket opens are queued
 * and flushed on open. Lifecycle/message events are forwarded to the registered
 * callbacks. This is the only place that touches the WebSocket global, so the
 * rest of the client stays transport-agnostic.
 */
export class WebSocketTransport implements Transport {
  private readonly ws: WebSocket;
  private readonly sendQueue: string[] = [];
  private messageCb: ((data: string) => void) | null = null;
  private openCb: (() => void) | null = null;
  private closeCb: (() => void) | null = null;

  constructor(url: string) {
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      // Flush anything that piled up before the connection was ready.
      for (let i = 0; i < this.sendQueue.length; i++) ws.send(this.sendQueue[i]);
      this.sendQueue.length = 0;
      if (this.openCb) this.openCb();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.messageCb) this.messageCb(String(ev.data));
    };
    ws.onclose = () => {
      if (this.closeCb) this.closeCb();
    };
    // A socket error is followed by a close event; surface it as a close so
    // callers have a single teardown path.
    ws.onerror = () => {
      /* close handler does the teardown */
    };
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(data: string): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.sendQueue.push(data);
    }
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
    this.ws.close();
  }
}

export interface DelayOptions {
  delayMs: number;
  jitterMs: number;
  dropRate: number;
  /** Defaults to Math.random; tests inject a seeded generator. */
  rng?: () => number;
  /** Defaults to setTimeout; tests inject a fake scheduler/clock. */
  schedule?: (fn: () => void, ms: number) => void;
}

/**
 * Wraps an inner Transport, delaying BOTH outgoing send() and delivered inbound
 * messages by delayMs +/- jitterMs and dropping dropRate of each independently.
 * Open/close are passed through delayed as well so ordering stays consistent
 * with the data path. The scheduler and rng are injectable for deterministic
 * tests; defaults are setTimeout / Math.random for production use.
 */
export class DelayedTransport implements Transport {
  private readonly inner: Transport;
  private readonly delayMs: number;
  private readonly jitterMs: number;
  private readonly dropRate: number;
  private readonly rng: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  private messageCb: ((data: string) => void) | null = null;
  private openCb: (() => void) | null = null;
  private closeCb: (() => void) | null = null;

  constructor(inner: Transport, opts: DelayOptions) {
    this.inner = inner;
    this.delayMs = opts.delayMs;
    this.jitterMs = opts.jitterMs;
    this.dropRate = opts.dropRate;
    this.rng = opts.rng ?? Math.random;
    this.schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));

    // Inbound: a delivered message from the inner transport is itself dropped /
    // delayed before reaching our consumer.
    inner.onMessage((data) => {
      if (this.dropped()) return;
      this.schedule(() => {
        if (this.messageCb) this.messageCb(data);
      }, this.latency());
    });
    inner.onOpen(() => {
      this.schedule(() => {
        if (this.openCb) this.openCb();
      }, this.latency());
    });
    inner.onClose(() => {
      this.schedule(() => {
        if (this.closeCb) this.closeCb();
      }, this.latency());
    });
  }

  /** delayMs perturbed by +/- jitterMs, clamped at 0 so we never go negative. */
  private latency(): number {
    const jitter = (this.rng() * 2 - 1) * this.jitterMs;
    const ms = this.delayMs + jitter;
    return ms < 0 ? 0 : ms;
  }

  private dropped(): boolean {
    if (this.dropRate <= 0) return false;
    if (this.dropRate >= 1) return true;
    return this.rng() < this.dropRate;
  }

  get isOpen(): boolean {
    return this.inner.isOpen;
  }

  send(data: string): void {
    if (this.dropped()) return;
    this.schedule(() => this.inner.send(data), this.latency());
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
    this.inner.close();
  }
}
