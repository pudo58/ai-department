// Hidden grader for KeyedRunner. It asserts only what SPEC.md decides.
import { describe, expect, it } from 'vitest';
import { createRunner } from '../src/runner.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error, code: error?.code }));
const sync = (fn) => { try { fn(); } catch (error) { return error?.code ?? `NO_CODE:${error?.message}`; } return 'NO_ERROR'; };

/** A task whose fn records its start in `log` and finishes when the test says so. */
const job = (log, name) => { const d = deferred(); return { name, ...d, fn: () => { log.push(name); return d.promise; } }; };

describe('validation', () => {
  it('rejects an invalid concurrency with INVALID_INPUT', () => {
    for (const concurrency of [0, -1, 1.5, '2', Number.NaN]) expect(sync(() => createRunner({ concurrency })), String(concurrency)).toBe('INVALID_INPUT');
  });
  it('turns invalid run arguments into rejected promises, never throws, and queues nothing', async () => {
    const r = createRunner({ concurrency: 1 });
    for (const [key, fn] of [['', () => 1], [5, () => 1], [undefined, () => 1], ['k', 'not a function'], ['k', undefined]]) {
      let promise;
      expect(sync(() => { promise = r.run(key, fn); }), String(key)).toBe('NO_ERROR');
      expect((await settle(promise)).code).toBe('INVALID_INPUT');
    }
    expect(r.stats()).toEqual({ running: 0, queued: 0 });
  });
});

describe('results', () => {
  it('passes the value, the same error object, plain values and synchronous throws through', async () => {
    const r = createRunner();
    expect(await r.run('a', async () => 7)).toBe(7);
    expect(await r.run('a', () => 'plain')).toBe('plain');
    const boom = new Error('boom');
    const failed = await settle(r.run('a', async () => { throw boom; }));
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe(boom);
    const thrown = new Error('sync');
    const sync1 = await settle(r.run('a', () => { throw thrown; }));
    expect(sync1.error).toBe(thrown);
    expect(r.stats()).toEqual({ running: 0, queued: 0 });
  });
  it('frees the slot after a synchronous throw', async () => {
    const r = createRunner({ concurrency: 1 });
    await settle(r.run('a', () => { throw new Error('x'); }));
    const log = [];
    const next = job(log, 'next');
    const p = r.run('b', next.fn);
    expect(log).toEqual(['next']);
    next.resolve(1);
    await p;
  });
});

describe('concurrency limit and start timing', () => {
  it('calls fn synchronously inside run when a slot and the key are free', () => {
    const r = createRunner({ concurrency: 2 });
    const log = [];
    const a = job(log, 'a');
    r.run('ka', a.fn);
    expect(log).toEqual(['a']);
    expect(r.stats()).toEqual({ running: 1, queued: 0 });
  });
  it('defaults to a concurrency of 2', async () => {
    const r = createRunner();
    const log = [];
    const jobs = ['a', 'b', 'c'].map((n) => job(log, n));
    jobs.forEach((j) => r.run(`k-${j.name}`, j.fn));
    expect(log).toEqual(['a', 'b']);
    expect(r.stats()).toEqual({ running: 2, queued: 1 });
  });
  it('never runs more than the limit and starts waiting tasks as slots free up', async () => {
    const r = createRunner({ concurrency: 2 });
    const log = [];
    const jobs = ['a', 'b', 'c', 'd'].map((n) => job(log, n));
    const done = jobs.map((j) => r.run(`k-${j.name}`, j.fn));
    expect(log).toEqual(['a', 'b']);
    jobs[0].resolve('A');
    expect(await done[0]).toBe('A');
    expect(log).toEqual(['a', 'b', 'c']);
    expect(r.stats()).toEqual({ running: 2, queued: 1 });
    jobs[1].resolve('B'); jobs[2].resolve('C');
    await done[1]; await done[2];
    expect(log).toEqual(['a', 'b', 'c', 'd']);
    jobs[3].resolve('D');
    expect(await done[3]).toBe('D');
    expect(r.stats()).toEqual({ running: 0, queued: 0 });
  });
});

describe('per-key ordering', () => {
  it('runs one task of a key at a time, in call order', async () => {
    const r = createRunner({ concurrency: 5 });
    const log = [];
    const jobs = ['a1', 'a2', 'a3'].map((n) => job(log, n));
    const done = jobs.map((j) => r.run('a', j.fn));
    expect(log).toEqual(['a1']);
    expect(r.stats()).toEqual({ running: 1, queued: 2 });
    jobs[0].resolve(1); await done[0];
    expect(log).toEqual(['a1', 'a2']);
    jobs[1].resolve(2); await done[1];
    expect(log).toEqual(['a1', 'a2', 'a3']);
    jobs[2].resolve(3); await done[2];
  });
  it('keeps running a key after one of its tasks failed', async () => {
    const r = createRunner({ concurrency: 3 });
    const log = [];
    const first = job(log, 'first'), second = job(log, 'second');
    const p1 = settle(r.run('a', first.fn));
    const p2 = settle(r.run('a', second.fn));
    first.reject(new Error('nope'));
    expect((await p1).ok).toBe(false);
    expect(log).toEqual(['first', 'second']);
    second.resolve('fine');
    expect(await p2).toMatchObject({ ok: true, value: 'fine' });
  });
  it('lets different keys run together', async () => {
    const r = createRunner({ concurrency: 3 });
    const log = [];
    const jobs = ['a', 'b', 'c'].map((n) => job(log, n));
    jobs.forEach((j) => r.run(`k-${j.name}`, j.fn));
    expect(log).toEqual(['a', 'b', 'c']);
  });
});

describe('fair scheduling', () => {
  it('does not let a task waiting for its key block another key from a free slot', async () => {
    const r = createRunner({ concurrency: 2 });
    const log = [];
    const a1 = job(log, 'a1'), a2 = job(log, 'a2'), b1 = job(log, 'b1');
    r.run('a', a1.fn); r.run('a', a2.fn);
    r.run('b', b1.fn);
    expect(log).toEqual(['a1', 'b1']);
    expect(r.stats()).toEqual({ running: 2, queued: 1 });
  });
  it('skips queued tasks whose key is busy and starts the oldest startable one', async () => {
    const r = createRunner({ concurrency: 2 });
    const log = [];
    const a1 = job(log, 'a1'), b1 = job(log, 'b1'), a2 = job(log, 'a2'), c1 = job(log, 'c1');
    r.run('a', a1.fn); const pb = r.run('b', b1.fn); r.run('a', a2.fn); r.run('c', c1.fn);
    expect(log).toEqual(['a1', 'b1']);
    b1.resolve(1); await pb;
    expect(log).toEqual(['a1', 'b1', 'c1']);
    expect(r.stats()).toEqual({ running: 2, queued: 1 });
  });
  it('lets the next task of a key that just finished go before a younger task of another key', async () => {
    const r = createRunner({ concurrency: 2 });
    const log = [];
    const a1 = job(log, 'a1'), b1 = job(log, 'b1'), a2 = job(log, 'a2'), c1 = job(log, 'c1');
    const pa = r.run('a', a1.fn); r.run('b', b1.fn); r.run('a', a2.fn); r.run('c', c1.fn);
    expect(log).toEqual(['a1', 'b1']);
    a1.resolve(1); await pa;
    expect(log).toEqual(['a1', 'b1', 'a2']);
    expect(r.stats()).toEqual({ running: 2, queued: 1 });
  });
  it('starts the oldest queued task first when several are startable', async () => {
    const r = createRunner({ concurrency: 1 });
    const log = [];
    const x = job(log, 'x'), y = job(log, 'y'), z = job(log, 'z'), w = job(log, 'w');
    const px = r.run('kx', x.fn); r.run('ky', y.fn); r.run('kz', z.fn); r.run('kw', w.fn);
    x.resolve(0); await px;
    expect(log).toEqual(['x', 'y']);
    y.resolve(0); await tick();
    expect(log).toEqual(['x', 'y', 'z']);
    z.resolve(0); await tick();
    expect(log).toEqual(['x', 'y', 'z', 'w']);
  });
  it('starts the oldest startable task even when a later one belongs to the key that just freed up', async () => {
    const r = createRunner({ concurrency: 1 });
    const log = [];
    const a1 = job(log, 'a1'), b1 = job(log, 'b1'), a2 = job(log, 'a2');
    const p = r.run('a', a1.fn); r.run('b', b1.fn); r.run('a', a2.fn);
    a1.resolve(0); await p;
    expect(log).toEqual(['a1', 'b1']);
  });
});

describe('slot release before settlement', () => {
  it('has released the slot and started the next task when the awaited promise resolves', async () => {
    const r = createRunner({ concurrency: 1 });
    const log = [];
    const a = job(log, 'a'), b = job(log, 'b');
    const pa = r.run('ka', a.fn);
    r.run('kb', b.fn);
    a.resolve('done');
    await pa;
    expect(r.stats()).toEqual({ running: 1, queued: 0 });
    expect(log).toEqual(['a', 'b']);
  });
  it('does the same for a rejected task', async () => {
    const r = createRunner({ concurrency: 1 });
    const log = [];
    const a = job(log, 'a'), b = job(log, 'b');
    const pa = settle(r.run('ka', a.fn));
    r.run('kb', b.fn);
    a.reject(new Error('bad'));
    await pa;
    expect(r.stats()).toEqual({ running: 1, queued: 0 });
    expect(log).toEqual(['a', 'b']);
  });
  it('reports an idle runner to a caller that awaits the last task', async () => {
    const r = createRunner({ concurrency: 2 });
    const a = job([], 'a');
    const pa = r.run('k', a.fn);
    a.resolve(1);
    await pa;
    expect(r.stats()).toEqual({ running: 0, queued: 0 });
  });
});

describe('cancellation with a signal', () => {
  it('rejects at once with CANCELLED and never calls fn when the signal is already aborted', async () => {
    const r = createRunner({ concurrency: 1 });
    const controller = new AbortController();
    controller.abort();
    const log = [];
    const outcome = await settle(r.run('k', job(log, 'x').fn, { signal: controller.signal }));
    expect(outcome.code).toBe('CANCELLED');
    expect(log).toEqual([]);
    expect(r.stats()).toEqual({ running: 0, queued: 0 });
  });
  it('removes a queued task, rejects it promptly, and never calls its fn', async () => {
    const r = createRunner({ concurrency: 1 });
    const log = [];
    const a = job(log, 'a'), b = job(log, 'b'), c = job(log, 'c');
    const controller = new AbortController();
    r.run('ka', a.fn);
    const pb = settle(r.run('kb', b.fn, { signal: controller.signal }));
    const pc = r.run('kc', c.fn);
    expect(r.stats()).toEqual({ running: 1, queued: 2 });
    controller.abort();
    const outcome = await pb;
    expect(outcome.code).toBe('CANCELLED');
    expect(r.stats()).toEqual({ running: 1, queued: 1 });
    a.resolve(0); await tick();
    expect(log).toEqual(['a', 'c']);
    c.resolve('C');
    expect(await pc).toBe('C');
  });
  it('does not affect a task that has already started', async () => {
    const r = createRunner({ concurrency: 1 });
    const log = [];
    const a = job(log, 'a');
    const controller = new AbortController();
    const pa = settle(r.run('ka', a.fn, { signal: controller.signal }));
    controller.abort();
    await tick();
    expect(r.stats()).toEqual({ running: 1, queued: 0 });
    a.resolve('still fine');
    expect(await pa).toMatchObject({ ok: true, value: 'still fine' });
  });
});

describe('stats and drain', () => {
  it('counts running and queued tasks', async () => {
    const r = createRunner({ concurrency: 2 });
    const jobs = [1, 2, 3, 4].map((n) => job([], `j${n}`));
    jobs.forEach((j, i) => r.run(i < 3 ? `k${i}` : 'k0', j.fn));
    expect(r.stats()).toEqual({ running: 2, queued: 2 });
  });
  it('resolves promptly when idle', async () => {
    const r = createRunner();
    await r.drain();
  });
  it('waits for running and queued tasks, and for tasks submitted while draining', async () => {
    const r = createRunner({ concurrency: 1 });
    const log = [];
    const a = job(log, 'a'), b = job(log, 'b'), late = job(log, 'late');
    r.run('ka', a.fn); r.run('kb', b.fn);
    let drained = false;
    const drain = r.drain().then(() => { drained = true; });
    a.resolve(1); await tick();
    expect(drained).toBe(false);
    r.run('klate', late.fn);
    b.resolve(2); await tick();
    expect(drained).toBe(false);
    expect(log).toEqual(['a', 'b', 'late']);
    late.resolve(3);
    await drain;
    expect(drained).toBe(true);
    expect(r.stats()).toEqual({ running: 0, queued: 0 });
  });
  it('does not resolve while the only task is still running with an empty queue', async () => {
    const r = createRunner();
    const a = job([], 'a');
    const pa = r.run('k', a.fn);
    let drained = false;
    const drain = r.drain().then(() => { drained = true; });
    await tick(); await tick();
    expect(drained).toBe(false);
    a.resolve(1); await pa; await drain;
    expect(drained).toBe(true);
  });
  it('never rejects, whatever the tasks do', async () => {
    const r = createRunner({ concurrency: 2 });
    const a = job([], 'a');
    const pa = settle(r.run('k', a.fn));
    const drain = r.drain();
    a.reject(new Error('fail'));
    await pa;
    await expect(drain).resolves.toBeUndefined();
  });
  it('resolves once the only queued task is cancelled and the running one finishes', async () => {
    const r = createRunner({ concurrency: 1 });
    const a = job([], 'a'), b = job([], 'b');
    const controller = new AbortController();
    r.run('ka', a.fn);
    const pb = settle(r.run('kb', b.fn, { signal: controller.signal }));
    const drain = r.drain();
    controller.abort(); await pb;
    a.resolve(1);
    await drain;
  });
});

describe('randomised workload', () => {
  it('keeps every invariant over many tasks, keys and uneven durations', async () => {
    const limit = 3, r = createRunner({ concurrency: limit });
    const active = new Set(), startedOrder = new Map(), finishedOrder = new Map();
    let running = 0, maxRunning = 0, violation = null, seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    const submissions = [];
    for (let i = 0; i < 40; i++) {
      const key = `k${next() % 5}`, rounds = next() % 4, fail = next() % 7 === 0;
      submissions.push(r.run(key, async () => {
        if (active.has(key)) violation = `key ${key} ran twice at once`;
        active.add(key); running++; maxRunning = Math.max(maxRunning, running);
        (startedOrder.get(key) ?? startedOrder.set(key, []).get(key)).push(i);
        for (let n = 0; n < rounds; n++) await tick();
        active.delete(key); running--;
        (finishedOrder.get(key) ?? finishedOrder.set(key, []).get(key)).push(i);
        if (fail) throw new Error(`task ${i}`);
        return i;
      }).then((v) => v, (e) => e.message));
    }
    await r.drain();
    const results = await Promise.all(submissions);
    expect(violation).toBeNull();
    expect(maxRunning).toBeLessThanOrEqual(limit);
    expect(maxRunning).toBeGreaterThan(1);
    expect(results).toHaveLength(40);
    for (const [key, order] of startedOrder) expect(order, key).toEqual([...order].sort((a, b) => a - b));
    expect([...startedOrder.values()].flat().length).toBe(40);
    expect(r.stats()).toEqual({ running: 0, queued: 0 });
  });
});
