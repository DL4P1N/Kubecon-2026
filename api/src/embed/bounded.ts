import type { Embedder, EmbedKind } from "./embedder.js";

/** Thrown by BoundedEmbedder when its run slots and its wait queue are both full. */
export class EmbedderBusyError extends Error {
  override name = "EmbedderBusyError";
  constructor() {
    super("embedder busy");
  }
}

/**
 * Caps the work an embedder does at once. The e5 model runs in the API pod on a small CPU
 * budget, so unbounded concurrent calls from public routes would starve the process.
 * At most `maxRunning` calls run, `maxQueued` more wait in FIFO order, and any further call
 * fails at once with EmbedderBusyError.
 */
export class BoundedEmbedder implements Embedder {
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly inner: Embedder,
    private readonly maxRunning = 2,
    private readonly maxQueued = 16,
  ) {}

  get provider(): string {
    return this.inner.provider;
  }

  get dims(): number {
    return this.inner.dims;
  }

  async warm(): Promise<void> {
    await (this.inner as { warm?: () => Promise<void> }).warm?.();
  }

  async embed(text: string, kind?: EmbedKind): Promise<number[]> {
    if (this.running < this.maxRunning) {
      this.running++;
    } else if (this.waiters.length < this.maxQueued) {
      // The releasing call hands its slot over, so `running` stays unchanged.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      throw new EmbedderBusyError();
    }
    try {
      return await this.inner.embed(text, kind);
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.running--;
    }
  }
}
