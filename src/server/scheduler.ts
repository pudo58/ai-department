/** Counting semaphore: bounds concurrent agents (MVP limit is three). */
export class Semaphore {
  private waiting: (() => void)[] = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async use<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try { return await task(); }
    finally { this.active--; this.waiting.shift()?.(); }
  }
}

/**
 * One task executes at a time. A task that ends in a waiting state (approval, quota, acceptance)
 * simply returns, which frees the slot for the next queued run.
 */
export class SerialQueue {
  private queue: string[] = [];
  private current: string | null = null;
  private idleWaiters: (() => void)[] = [];
  constructor(private readonly work: (runId: string) => Promise<void>) {}

  enqueue(runId: string): void {
    if (this.current === runId || this.queue.includes(runId)) return;
    this.queue.push(runId);
    void this.pump();
  }
  isQueued(runId: string): boolean { return this.queue.includes(runId); }
  dequeue(runId: string): void { this.queue = this.queue.filter((id) => id !== runId); }

  private async pump(): Promise<void> {
    if (this.current) return;
    const next = this.queue.shift();
    if (!next) { this.idleWaiters.splice(0).forEach((resolve) => resolve()); return; }
    this.current = next;
    try { await this.work(next); }
    catch { /* The worker records its own failures; the queue must keep moving. */ }
    finally { this.current = null; void this.pump(); }
  }

  /** Resolves once nothing is running or queued. Used by tests and graceful shutdown. */
  idle(): Promise<void> {
    if (!this.current && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
