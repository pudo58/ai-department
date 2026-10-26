// AMENDED (after the pilot ran) hidden grader for PulseGraph: two assertions that the SPEC leaves open now accept either code.
// Hidden grader for PulseGraph. It asserts only what SPEC.md decides: not the first sequence/nextSequence/nextToken value,
// not the return value of cancel, not the retry time of a lease expiry, and not error precedence between unrelated faults.
import { describe, expect, it } from 'vitest';
import { createScheduler, restoreScheduler } from '../src/scheduler.js';

const code = async (fn) => { try { await fn(); } catch (error) { return error?.code ?? `NO_CODE:${error?.message}`; } return 'NO_ERROR'; };
const make = (options) => createScheduler(options);
const submit = async (s, id, extra = {}) => s.submit({ id, ...extra });
const claim = async (s, worker = 'w1', leaseFor = 100) => s.claim({ worker, leaseFor });
const finish = async (s, job, result) => s.complete({ id: job.id, worker: job.worker, token: job.token, result });
const failIt = async (s, job, error = 'boom') => s.fail({ id: job.id, worker: job.worker, token: job.token, error });
const status = async (s, id) => (await s.get(id)).status;
const roundTrip = async (s) => restoreScheduler(JSON.parse(JSON.stringify(await s.snapshot())));

describe('input validation', () => {
  it('rejects invalid scheduler options with INVALID_INPUT', async () => {
    for (const options of [{ now: -1 }, { now: 1.5 }, { retryBase: 0 }, { retryBase: 1.5 }, { maxAttempts: 0 }, { maxAttempts: -2 }, { now: Number.NaN }]) {
      expect(await code(() => createScheduler(options)), JSON.stringify(options)).toBe('INVALID_INPUT');
    }
  });
  it('rejects invalid ids and priorities with INVALID_INPUT', async () => {
    const s = make();
    for (const input of [{ id: '' }, { id: 7 }, {}, { id: 'a', priority: 1.5 }, { id: 'a', priority: '1' }, { id: 'a', priority: Number.MAX_SAFE_INTEGER + 2 }]) {
      expect(await code(() => s.submit(input)), JSON.stringify(input)).toBe('INVALID_INPUT');
    }
    expect(await code(() => s.get('a'))).toBe('UNKNOWN_JOB');
  });
  it('rejects a repeated id forever with JOB_EXISTS, even after the job is finished', async () => {
    const s = make();
    await submit(s, 'a');
    expect(await code(() => submit(s, 'a'))).toBe('JOB_EXISTS');
    await finish(s, await claim(s));
    expect(await code(() => submit(s, 'a'))).toBe('JOB_EXISTS');
  });
  it('rejects self, duplicate and unknown dependencies with the specified codes', async () => {
    const s = make();
    await submit(s, 'a');
    // A job that lists itself is both a self-reference and a reference to a job that does not exist yet, so the SPEC allows either code.
    expect(['INVALID_DEPENDENCIES', 'UNKNOWN_DEPENDENCY']).toContain(await code(() => submit(s, 'b', { dependsOn: ['b'] })));
    expect(await code(() => submit(s, 'b', { dependsOn: ['a', 'a'] }))).toBe('INVALID_DEPENDENCIES');
    expect(await code(() => submit(s, 'b', { dependsOn: ['nope'] }))).toBe('UNKNOWN_DEPENDENCY');
    expect(await code(() => s.get('b'))).toBe('UNKNOWN_JOB');
  });
  it('validates claim, fail and advance inputs', async () => {
    const s = make({ now: 5 });
    await submit(s, 'a');
    for (const input of [{ worker: '', leaseFor: 5 }, { worker: 'w', leaseFor: 0 }, { worker: 'w', leaseFor: 1.5 }, { worker: 'w', leaseFor: -1 }, { leaseFor: 5 }]) {
      expect(await code(() => s.claim(input)), JSON.stringify(input)).toBe('INVALID_INPUT');
    }
    const job = await claim(s);
    expect(await code(() => failIt(s, job, ''))).toBe('INVALID_INPUT');
    for (const time of [-1, 4, 5.5]) {
      expect(await code(() => s.advance(time)), String(time)).toBe('INVALID_TIME');
    }
    expect((await s.snapshot()).now).toBe(5);
    expect(await status(s, 'a')).toBe('leased');
  });
  it('rejects unknown ids for cancel and terminal jobs with JOB_TERMINAL', async () => {
    const s = make();
    expect(await code(() => s.cancel('ghost'))).toBe('UNKNOWN_JOB');
    await submit(s, 'a');
    await finish(s, await claim(s));
    expect(await code(() => s.cancel('a'))).toBe('JOB_TERMINAL');
  });
});

describe('job views', () => {
  it('has exactly the specified fields on a fresh job and starts at the scheduler time', async () => {
    const s = make({ now: 7 });
    const view = await submit(s, 'a', { priority: 3 });
    expect(Object.keys(view).sort()).toEqual(['attempt', 'availableAt', 'dependsOn', 'id', 'priority', 'sequence', 'status']);
    expect(view).toMatchObject({ id: 'a', dependsOn: [], priority: 3, status: 'ready', attempt: 0, availableAt: 7 });
    expect(Number.isSafeInteger(view.sequence)).toBe(true);
  });
  it('gives later submissions a larger sequence', async () => {
    const s = make();
    const a = await submit(s, 'a'), b = await submit(s, 'b');
    expect(b.sequence).toBeGreaterThan(a.sequence);
  });
  it('shows lease fields only while leased and result/lastError only when present', async () => {
    const s = make({ now: 3 });
    await submit(s, 'a');
    const leased = await claim(s, 'w1', 10);
    expect(Object.keys(leased).sort()).toEqual(['attempt', 'availableAt', 'dependsOn', 'id', 'leaseUntil', 'priority', 'sequence', 'status', 'token', 'worker']);
    expect(leased).toMatchObject({ status: 'leased', worker: 'w1', attempt: 1, leaseUntil: 13 });
    await finish(s, leased, { ok: true });
    const done = await s.get('a');
    expect(Object.keys(done).sort()).toEqual(['attempt', 'availableAt', 'dependsOn', 'id', 'priority', 'result', 'sequence', 'status']);
    expect(done.result).toEqual({ ok: true });
  });
  it('reports lastError after a failure and clears it after a later success', async () => {
    const s = make();
    await submit(s, 'a');
    const first = await claim(s);
    const failed = await failIt(s, first, 'disk full');
    expect(failed).toMatchObject({ status: 'ready', lastError: 'disk full' });
    expect('worker' in failed || 'token' in failed || 'leaseUntil' in failed).toBe(false);
    await s.advance(100);
    const second = await claim(s);
    await finish(s, second, 1);
    const done = await s.get('a');
    expect('lastError' in done).toBe(false);
    expect(done.result).toBe(1);
  });
  it('returns detached views and detached results', async () => {
    const s = make();
    await submit(s, 'dep');
    const b = await submit(s, 'b', { dependsOn: ['dep'] });
    b.dependsOn.push('hacked');
    b.status = 'done';
    expect((await s.get('b')).dependsOn).toEqual(['dep']);
    expect(await status(s, 'b')).toBe('waiting');
    const job = await claim(s);
    const payload = { items: [1, 2] };
    await finish(s, job, payload);
    payload.items.push(3);
    const stored = await s.get('dep');
    expect(stored.result).toEqual({ items: [1, 2] });
    stored.result.items.push(9);
    expect((await s.get('dep')).result).toEqual({ items: [1, 2] });
  });
});

describe('dependencies and blocking', () => {
  it('waits for unfinished dependencies and becomes ready when all are done', async () => {
    const s = make();
    await submit(s, 'a'); await submit(s, 'b');
    await submit(s, 'c', { dependsOn: ['a', 'b'] });
    expect(await status(s, 'c')).toBe('waiting');
    await finish(s, await claim(s));
    expect(await status(s, 'c')).toBe('waiting');
    await finish(s, await claim(s));
    expect(await status(s, 'c')).toBe('ready');
    expect((await claim(s)).id).toBe('c');
  });
  it('is ready immediately when its dependencies are already done', async () => {
    const s = make();
    await submit(s, 'a');
    await finish(s, await claim(s));
    expect((await submit(s, 'b', { dependsOn: ['a'] })).status).toBe('ready');
  });
  it('blocks dependents transitively when a dependency dies, naming the first failed dependency', async () => {
    const s = make({ maxAttempts: 1 });
    await submit(s, 'a'); await submit(s, 'ok');
    await submit(s, 'b', { dependsOn: ['ok', 'a'] });
    await submit(s, 'c', { dependsOn: ['b'] });
    await failIt(s, await claim(s, 'w', 10));
    expect(await status(s, 'a')).toBe('dead');
    expect(await s.get('b')).toMatchObject({ status: 'blocked', blockedBy: 'a' });
    expect(await s.get('c')).toMatchObject({ status: 'blocked', blockedBy: 'b' });
    expect('blockedBy' in (await s.get('a'))).toBe(false);
  });
  it('blocks a new job at once when a dependency is already unsuccessful, using dependsOn order', async () => {
    const s = make();
    await submit(s, 'x'); await submit(s, 'y');
    await s.cancel('x'); await s.cancel('y');
    expect(await submit(s, 'z', { dependsOn: ['y', 'x'] })).toMatchObject({ status: 'blocked', blockedBy: 'y' });
    expect(await submit(s, 'w', { dependsOn: ['z'] })).toMatchObject({ status: 'blocked', blockedBy: 'z' });
  });
  it('cancels a waiting or ready job and blocks its descendants', async () => {
    const s = make();
    await submit(s, 'a');
    await submit(s, 'b', { dependsOn: ['a'] });
    await submit(s, 'c', { dependsOn: ['b'] });
    await s.cancel('a');
    expect(await status(s, 'a')).toBe('cancelled');
    expect(await s.get('b')).toMatchObject({ status: 'blocked', blockedBy: 'a' });
    expect(await s.get('c')).toMatchObject({ status: 'blocked', blockedBy: 'b' });
    expect(await claim(s)).toBeNull();
  });
  it('cancels a leased job, invalidating its lease', async () => {
    const s = make();
    await submit(s, 'a');
    await submit(s, 'b', { dependsOn: ['a'] });
    const lease = await claim(s);
    await s.cancel('a');
    expect(await status(s, 'a')).toBe('cancelled');
    expect(await code(() => finish(s, lease))).toBe('LEASE_LOST');
    expect(await code(() => s.renew({ id: 'a', worker: lease.worker, token: lease.token, leaseFor: 5 }))).toBe('LEASE_LOST');
    expect(await status(s, 'b')).toBe('blocked');
  });
  it('does not unblock anything when a job is cancelled after it completed (JOB_TERMINAL)', async () => {
    const s = make();
    await submit(s, 'a');
    await submit(s, 'b', { dependsOn: ['a'] });
    await finish(s, await claim(s));
    expect(await code(() => s.cancel('a'))).toBe('JOB_TERMINAL');
    expect(await status(s, 'b')).toBe('ready');
  });
});

describe('claiming', () => {
  it('returns null when nothing is ready', async () => {
    const s = make();
    expect(await claim(s)).toBeNull();
    await submit(s, 'a'); await submit(s, 'b', { dependsOn: ['a'] });
    await claim(s);
    expect(await claim(s)).toBeNull();
  });
  it('orders by priority descending, then submission order', async () => {
    const s = make();
    await submit(s, 'low', { priority: -5 });
    await submit(s, 'first', { priority: 2 });
    await submit(s, 'second', { priority: 2 });
    await submit(s, 'top', { priority: 9 });
    await submit(s, 'zero');
    const order = [];
    for (;;) { const job = await claim(s); if (!job) break; order.push(job.id); }
    expect(order).toEqual(['top', 'first', 'second', 'zero', 'low']);
  });
  it('breaks priority ties by submission order, not by id', async () => {
    const s = make();
    await submit(s, 'z'); await submit(s, 'a'); await submit(s, 'm');
    expect([(await claim(s)).id, (await claim(s)).id, (await claim(s)).id]).toEqual(['z', 'a', 'm']);
  });
  it('increments the attempt and issues fencing tokens that start at 1 and rise on every claim', async () => {
    const s = make();
    await submit(s, 'a'); await submit(s, 'b');
    const a = await claim(s, 'w1'), b = await claim(s, 'w2');
    expect(a.token).toBe(1);
    expect(b.token).toBe(2);
    expect(a.attempt).toBe(1);
    await failIt(s, a);
    await s.advance(100);
    const again = await claim(s, 'w3');
    expect(again).toMatchObject({ id: 'a', attempt: 2 });
    expect(again.token).toBe(3);
  });
  it('leases until now + leaseFor', async () => {
    const s = make({ now: 20 });
    await submit(s, 'a');
    expect((await claim(s, 'w', 15)).leaseUntil).toBe(35);
  });
});

describe('leases, renewal and expiry', () => {
  it('requires the matching worker and token for renew, complete and fail', async () => {
    const s = make();
    await submit(s, 'a');
    const lease = await claim(s, 'w1', 10);
    const wrongWorker = { id: 'a', worker: 'w2', token: lease.token };
    const wrongToken = { id: 'a', worker: 'w1', token: lease.token + 1 };
    for (const who of [wrongWorker, wrongToken]) {
      expect(await code(() => s.renew({ ...who, leaseFor: 5 }))).toBe('LEASE_LOST');
      expect(await code(() => s.complete({ ...who, result: 1 }))).toBe('LEASE_LOST');
      expect(await code(() => s.fail({ ...who, error: 'x' }))).toBe('LEASE_LOST');
    }
    expect(await status(s, 'a')).toBe('leased');
    // An unknown id is also a lease that is not current, so the SPEC allows either code.
    expect(['UNKNOWN_JOB', 'LEASE_LOST']).toContain(await code(() => s.complete({ id: 'ghost', worker: 'w', token: 1, result: 1 })));
  });
  it('renew never shortens a lease and keeps the token', async () => {
    const s = make();
    await submit(s, 'a');
    const lease = await claim(s, 'w1', 10);
    const same = await s.renew({ id: 'a', worker: 'w1', token: lease.token, leaseFor: 3 });
    expect(same.leaseUntil).toBe(10);
    const longer = await s.renew({ id: 'a', worker: 'w1', token: lease.token, leaseFor: 25 });
    expect(longer).toMatchObject({ leaseUntil: 25, token: lease.token, worker: 'w1' });
    expect(await code(() => s.renew({ id: 'a', worker: 'w1', token: lease.token, leaseFor: 0 }))).toBe('INVALID_INPUT');
  });
  it('renew measures from the current time', async () => {
    const s = make();
    await submit(s, 'a');
    const lease = await claim(s, 'w1', 10);
    await s.advance(8);
    expect((await s.renew({ id: 'a', worker: 'w1', token: lease.token, leaseFor: 10 })).leaseUntil).toBe(18);
  });
  it('expires a lease exactly at its deadline, before advance returns', async () => {
    const s = make();
    await submit(s, 'a');
    const lease = await claim(s, 'w1', 10);
    expect(await s.advance(9)).toEqual({ now: 9, expired: [] });
    expect(await status(s, 'a')).toBe('leased');
    expect(await s.advance(10)).toEqual({ now: 10, expired: ['a'] });
    expect(await s.get('a')).toMatchObject({ status: 'ready', lastError: 'LEASE_EXPIRED', attempt: 1 });
    expect(await code(() => finish(s, lease))).toBe('LEASE_LOST');
  });
  it('advances time even when nothing expires, and allows advancing to the same time', async () => {
    const s = make({ now: 4 });
    expect(await s.advance(4)).toEqual({ now: 4, expired: [] });
    expect(await s.advance(50)).toEqual({ now: 50, expired: [] });
    expect((await s.snapshot()).now).toBe(50);
  });
  it('reports expired jobs by deadline first, then submission order', async () => {
    const s = make();
    await submit(s, 'a'); await submit(s, 'b'); await submit(s, 'c');
    await claim(s, 'w', 10);
    await claim(s, 'w', 5);
    await claim(s, 'w', 10);
    expect(await s.advance(10)).toEqual({ now: 10, expired: ['b', 'a', 'c'] });
  });
  it('does not expire leases when a job is claimed', async () => {
    const s = make();
    await submit(s, 'a'); await submit(s, 'b');
    const first = await claim(s, 'w1', 5);
    await s.advance(4);
    await claim(s, 'w2', 5);
    expect(await status(s, first.id)).toBe('leased');
  });
  it('kills a job whose lease keeps expiring once the attempt limit is reached, blocking its descendants', async () => {
    const s = make({ maxAttempts: 1 });
    await submit(s, 'a'); await submit(s, 'b', { dependsOn: ['a'] });
    await claim(s, 'w', 5);
    await s.advance(5);
    expect(await s.get('a')).toMatchObject({ status: 'dead', lastError: 'LEASE_EXPIRED' });
    expect(await s.get('b')).toMatchObject({ status: 'blocked', blockedBy: 'a' });
  });
});

describe('retries', () => {
  it('schedules retries at now + retryBase * 2^(attempt-1) and kills the job on the last attempt', async () => {
    const s = make({ retryBase: 3, maxAttempts: 3 });
    await submit(s, 'a');
    const first = await failIt(s, await claim(s));
    expect(first).toMatchObject({ status: 'ready', attempt: 1, availableAt: 3 });
    expect(await claim(s)).toBeNull();
    await s.advance(2);
    expect(await claim(s)).toBeNull();
    await s.advance(3);
    const second = await failIt(s, await claim(s));
    expect(second).toMatchObject({ status: 'ready', attempt: 2, availableAt: 3 + 6 });
    await s.advance(9);
    const third = await failIt(s, await claim(s));
    expect(third).toMatchObject({ status: 'dead', attempt: 3, lastError: 'boom' });
    expect(await claim(s)).toBeNull();
  });
  it('uses the default backoff of 2 and 3 attempts', async () => {
    const s = make();
    await submit(s, 'a');
    expect(await failIt(s, await claim(s))).toMatchObject({ availableAt: 2 });
    await s.advance(2);
    expect(await failIt(s, await claim(s))).toMatchObject({ availableAt: 6 });
    await s.advance(6);
    expect((await failIt(s, await claim(s))).status).toBe('dead');
  });
  it('lets other ready jobs run while a retry waits', async () => {
    const s = make();
    await submit(s, 'a', { priority: 5 }); await submit(s, 'b');
    await failIt(s, await claim(s));
    expect((await claim(s)).id).toBe('b');
  });
  it('blocks descendants when the last attempt fails', async () => {
    const s = make({ maxAttempts: 1 });
    await submit(s, 'a'); await submit(s, 'b', { dependsOn: ['a'] });
    await failIt(s, await claim(s));
    expect(await s.get('b')).toMatchObject({ status: 'blocked', blockedBy: 'a' });
  });
});

describe('snapshot and restore', () => {
  it('has exactly the specified top-level fields and lists jobs in submission order', async () => {
    const s = make({ now: 2, retryBase: 5, maxAttempts: 4 });
    await submit(s, 'z'); await submit(s, 'a', { dependsOn: ['z'] });
    const snap = await s.snapshot();
    expect(Object.keys(snap).sort()).toEqual(['jobs', 'maxAttempts', 'nextSequence', 'nextToken', 'now', 'retryBase', 'schemaVersion']);
    expect(snap).toMatchObject({ schemaVersion: 1, now: 2, retryBase: 5, maxAttempts: 4 });
    expect(snap.jobs.map((j) => j.id)).toEqual(['z', 'a']);
    expect(snap.jobs[0]).toMatchObject({ id: 'z', status: 'ready', attempt: 0, availableAt: 2 });
    expect(typeof snap.jobs[0].sequence).toBe('number');
    expect(snap.nextSequence).toBeGreaterThan(snap.jobs[1].sequence);
  });
  it('returns a detached snapshot', async () => {
    const s = make();
    await submit(s, 'a');
    const snap = await s.snapshot();
    snap.jobs[0].status = 'done';
    snap.jobs.push({ id: 'ghost' });
    snap.now = 99;
    expect(await status(s, 'a')).toBe('ready');
    expect((await s.snapshot()).jobs).toHaveLength(1);
    expect((await s.snapshot()).now).toBe(0);
  });
  it('restores time, options, order, dependencies, results and errors after a JSON clone', async () => {
    const s = make({ now: 10, retryBase: 3, maxAttempts: 2 });
    await submit(s, 'a', { priority: 9 }); await submit(s, 'b', { dependsOn: ['a'], priority: 4 }); await submit(s, 'c', { priority: 1 });
    const a = await claim(s, 'w', 50);
    expect(a.id).toBe('a');
    await finish(s, a, { n: 1 });
    const b = await claim(s, 'w', 50);
    expect(b.id).toBe('b');
    await failIt(s, b, 'bad');
    const restored = await roundTrip(s);
    expect(await restored.snapshot()).toEqual(await s.snapshot());
    expect(await restored.get('a')).toMatchObject({ status: 'done', result: { n: 1 } });
    expect(await restored.get('b')).toMatchObject({ status: 'ready', lastError: 'bad', attempt: 1, availableAt: 13, dependsOn: ['a'], priority: 4 });
    expect(await restored.get('c')).toMatchObject({ status: 'ready', priority: 1 });
    expect(await code(() => restored.advance(9))).toBe('INVALID_TIME');
  });
  it('keeps leases and the retry schedule working after restore', async () => {
    const s = make({ now: 0 });
    await submit(s, 'a'); await submit(s, 'b');
    const a = await claim(s, 'w1', 10);
    await failIt(s, await claim(s, 'w2', 10), 'x');
    const restored = await roundTrip(s);
    expect(await restored.get('a')).toMatchObject({ status: 'leased', worker: 'w1', token: a.token, leaseUntil: 10 });
    expect(await claim(restored)).toBeNull();
    await restored.advance(2);
    expect((await claim(restored)).id).toBe('b');
    const done = await restored.complete({ id: 'a', worker: 'w1', token: a.token, result: 'ok' });
    expect(done.status).toBe('done');
  });
  it('expires restored leases at their deadline', async () => {
    const s = make();
    await submit(s, 'a');
    await claim(s, 'w1', 10);
    const restored = await roundTrip(s);
    expect(await restored.advance(10)).toEqual({ now: 10, expired: ['a'] });
  });
  it('never repeats a fencing token after restore', async () => {
    const s = make();
    await submit(s, 'a'); await submit(s, 'b'); await submit(s, 'c');
    const seen = [(await claim(s)).token, (await claim(s)).token];
    const restored = await roundTrip(s);
    const next = (await claim(restored)).token;
    expect(seen).not.toContain(next);
    expect(next).toBeGreaterThan(Math.max(...seen));
  });
  it('continues submission order after restore', async () => {
    const s = make();
    await submit(s, 'a');
    const restored = await roundTrip(s);
    const b = await submit(restored, 'b');
    expect(b.sequence).toBeGreaterThan((await restored.get('a')).sequence);
    expect((await claim(restored)).id).toBe('a');
  });
  it('preserves terminal history, so finished ids stay taken and blocked jobs stay blocked', async () => {
    const s = make({ maxAttempts: 1 });
    await submit(s, 'a'); await submit(s, 'b', { dependsOn: ['a'] }); await submit(s, 'c');
    await failIt(s, await claim(s));
    await s.cancel('c');
    const restored = await roundTrip(s);
    expect(await restored.get('a')).toMatchObject({ status: 'dead' });
    expect(await restored.get('b')).toMatchObject({ status: 'blocked', blockedBy: 'a' });
    expect(await code(() => restored.submit({ id: 'a' }))).toBe('JOB_EXISTS');
    expect(await code(() => restored.cancel('c'))).toBe('JOB_TERMINAL');
  });
  it('keeps the original and the restored scheduler independent', async () => {
    const s = make();
    await submit(s, 'a'); await submit(s, 'b');
    const restored = await roundTrip(s);
    await finish(restored, await claim(restored));
    await submit(restored, 'only-restored');
    expect(await status(s, 'a')).toBe('ready');
    expect(await code(() => s.get('only-restored'))).toBe('UNKNOWN_JOB');
    const fromOriginal = await claim(s);
    expect(fromOriginal.id).toBe('a');
  });
});
