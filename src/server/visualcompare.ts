import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { comparePng } from '../core/visual.js';

type Result = ReturnType<typeof comparePng>;
export class VisualComparator {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (r: Result) => void; reject: (e: Error) => void }>();
  private sequence = 0;
  private failure?: Error;
  constructor() {
    const source = new URL('./visual-worker.ts', import.meta.url);
    const dev = existsSync(source);
    const bootstrap = dev ? `import { register } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)}; register(); await import(${JSON.stringify(source.href)});` : '';
    this.worker = new Worker(dev ? new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`) : new URL('./visual-worker.mjs', import.meta.url), { execArgv: [] });
    this.worker.on('message', ({ id, result, error }: { id: number; result: Result; error?: string }) => {
      const waiting = this.pending.get(id); this.pending.delete(id);
      if (error) waiting?.reject(new Error(error)); else waiting?.resolve(result);
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', () => this.fail(new Error('Worker so ảnh đã dừng.')));
  }
  private fail(error: Error) { this.failure = error; for (const entry of this.pending.values()) entry.reject(error); this.pending.clear(); }
  compare(reference: Buffer, actual: Buffer, threshold: number): Promise<Result> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, reference, actual, threshold }); });
  }
  async close(): Promise<void> { this.fail(new Error('Đã dừng so ảnh.')); await this.worker.terminate(); }
}
