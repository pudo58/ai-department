// Hidden grader for KeyedCharges. It asserts only what SPEC.md decides.
import { describe, expect, it } from 'vitest';
import { createCharges } from '../src/charges.js';

const code = async (fn) => { try { await fn(); } catch (error) { return error?.code ?? `NO_CODE:${error?.message}`; } return 'NO_ERROR'; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const clock = (start = 0) => { const c = { t: start, now: () => c.t }; return c; };
const make = (options = {}) => createCharges({ accounts: { alice: 100, bob: 50 }, ...options });
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, code: error.code, error }));

describe('validation and basics', () => {
  it('rejects invalid options with INVALID_INPUT', async () => {
    for (const options of [{ ttl: 0 }, { ttl: 1.5 }, { ttl: -3 }, { accounts: { a: -1 } }, { accounts: { a: 1.5 } }]) {
      expect(await code(() => createCharges(options)), JSON.stringify(options)).toBe('INVALID_INPUT');
    }
  });
  it('validates charge input before authorize is reached', async () => {
    const calls = [];
    const s = make({ authorize: async (input) => { calls.push(input); return true; } });
    for (const key of ['', 5, undefined]) expect(await code(() => s.charge({ key, account: 'alice', amount: 1 })), String(key)).toBe('INVALID_INPUT');
    for (const amount of [0, -1, 1.5, '3', undefined]) expect(await code(() => s.charge({ key: 'k', account: 'alice', amount })), String(amount)).toBe('INVALID_AMOUNT');
    expect(await code(() => s.charge({ key: 'k', account: 'nobody', amount: 1 }))).toBe('UNKNOWN_ACCOUNT');
    expect(calls).toEqual([]);
    expect(await s.balance('alice')).toBe(100);
  });
  it('reports balances and deposits, with the specified errors', async () => {
    const s = make();
    expect(await s.balance('alice')).toBe(100);
    expect(await s.deposit({ account: 'alice', amount: 25 })).toBe(125);
    expect(await s.balance('alice')).toBe(125);
    expect(await code(() => s.balance('nobody'))).toBe('UNKNOWN_ACCOUNT');
    expect(await code(() => s.deposit({ account: 'nobody', amount: 5 }))).toBe('UNKNOWN_ACCOUNT');
    expect(await code(() => s.deposit({ account: 'alice', amount: 0 }))).toBe('INVALID_AMOUNT');
    expect(await code(() => s.deposit({ account: 'alice', amount: 2.5 }))).toBe('INVALID_AMOUNT');
  });
});

describe('charging', () => {
  it('returns the specified result and a unique chargeId per charge', async () => {
    const s = make();
    const a = await s.charge({ key: 'k1', account: 'alice', amount: 30 });
    const b = await s.charge({ key: 'k2', account: 'alice', amount: 20 });
    expect(Object.keys(a).sort()).toEqual(['account', 'amount', 'balance', 'chargeId', 'key', 'replayed']);
    expect(a).toMatchObject({ key: 'k1', account: 'alice', amount: 30, balance: 70, replayed: false });
    expect(b).toMatchObject({ balance: 50, replayed: false });
    expect(typeof a.chargeId).toBe('string');
    expect(a.chargeId).not.toBe(b.chargeId);
    expect(await s.balance('alice')).toBe(50);
  });
  it('allows spending the whole balance and refuses to go below zero, changing nothing', async () => {
    const s = make();
    expect((await s.charge({ key: 'all', account: 'bob', amount: 50 })).balance).toBe(0);
    expect(await code(() => s.charge({ key: 'more', account: 'bob', amount: 1 }))).toBe('INSUFFICIENT_FUNDS');
    expect(await s.balance('bob')).toBe(0);
  });
});

describe('idempotency by key', () => {
  it('replays the original result with the original balance, without charging again', async () => {
    const s = make();
    const first = await s.charge({ key: 'k', account: 'alice', amount: 30 });
    await s.deposit({ account: 'alice', amount: 50 });
    const again = await s.charge({ key: 'k', account: 'alice', amount: 30 });
    expect(again).toEqual({ ...first, replayed: true });
    expect(again.balance).toBe(70);
    expect(await s.balance('alice')).toBe(120);
    const third = await s.charge({ key: 'k', account: 'alice', amount: 30 });
    expect(third.chargeId).toBe(first.chargeId);
  });
  it('replays even when the account could no longer afford the charge', async () => {
    const s = make();
    const first = await s.charge({ key: 'k', account: 'bob', amount: 50 });
    expect(await s.charge({ key: 'k', account: 'bob', amount: 50 })).toEqual({ ...first, replayed: true });
  });
  it('rejects the same key with another account or amount while live, changing nothing', async () => {
    const s = make();
    await s.charge({ key: 'k', account: 'alice', amount: 30 });
    expect(await code(() => s.charge({ key: 'k', account: 'alice', amount: 31 }))).toBe('IDEMPOTENCY_MISMATCH');
    expect(await code(() => s.charge({ key: 'k', account: 'bob', amount: 30 }))).toBe('IDEMPOTENCY_MISMATCH');
    expect(await s.balance('alice')).toBe(70);
    expect(await s.balance('bob')).toBe(50);
  });
  it('keeps a key live until exactly t + ttl, then treats it as a new charge', async () => {
    const c = clock(5);
    const s = make({ ttl: 10, now: c.now });
    const first = await s.charge({ key: 'k', account: 'alice', amount: 10 });
    c.t = 14;
    expect(await s.charge({ key: 'k', account: 'alice', amount: 10 })).toEqual({ ...first, replayed: true });
    expect(await code(() => s.charge({ key: 'k', account: 'alice', amount: 11 }))).toBe('IDEMPOTENCY_MISMATCH');
    c.t = 15;
    const second = await s.charge({ key: 'k', account: 'alice', amount: 10 });
    expect(second.replayed).toBe(false);
    expect(second.chargeId).not.toBe(first.chargeId);
    expect(await s.balance('alice')).toBe(80);
  });
  it('allows a different payload for an expired key and then replays the new record', async () => {
    const c = clock(0);
    const s = make({ ttl: 10, now: c.now });
    const first = await s.charge({ key: 'k', account: 'alice', amount: 10 });
    c.t = 10;
    const second = await s.charge({ key: 'k', account: 'bob', amount: 20 });
    expect(second).toMatchObject({ account: 'bob', amount: 20, balance: 30, replayed: false });
    c.t = 12;
    expect(await s.charge({ key: 'k', account: 'bob', amount: 20 })).toEqual({ ...second, replayed: true });
    expect(second.chargeId).not.toBe(first.chargeId);
  });
  it('does not extend a key by replaying it', async () => {
    const c = clock(0);
    const s = make({ ttl: 10, now: c.now });
    const first = await s.charge({ key: 'k', account: 'alice', amount: 10 });
    c.t = 9;
    expect((await s.charge({ key: 'k', account: 'alice', amount: 10 })).replayed).toBe(true);
    c.t = 10;
    const fresh = await s.charge({ key: 'k', account: 'alice', amount: 10 });
    expect(fresh.replayed).toBe(false);
    expect(fresh.chargeId).not.toBe(first.chargeId);
  });
  it('never consumes a key by a failure: insufficient funds', async () => {
    const s = make();
    expect(await code(() => s.charge({ key: 'k', account: 'bob', amount: 80 }))).toBe('INSUFFICIENT_FUNDS');
    await s.deposit({ account: 'bob', amount: 40 });
    const ok = await s.charge({ key: 'k', account: 'bob', amount: 80 });
    expect(ok).toMatchObject({ replayed: false, balance: 10 });
  });
  it('lets a failed key be reused with a different account and amount', async () => {
    const s = make();
    expect(await code(() => s.charge({ key: 'k', account: 'bob', amount: 500 }))).toBe('INSUFFICIENT_FUNDS');
    const ok = await s.charge({ key: 'k', account: 'alice', amount: 5 });
    expect(ok).toMatchObject({ account: 'alice', amount: 5, replayed: false });
  });
});

describe('authorize', () => {
  it('is called once per new attempt with key, account and amount, and never for a replay', async () => {
    const calls = [];
    const s = make({ authorize: async (input) => { calls.push(input); return true; } });
    await s.charge({ key: 'k', account: 'alice', amount: 5 });
    await s.charge({ key: 'k', account: 'alice', amount: 5 });
    await code(() => s.charge({ key: 'k', account: 'alice', amount: 6 }));
    expect(calls).toEqual([{ key: 'k', account: 'alice', amount: 5 }]);
  });
  it('declines on any result other than true, moving no money and keeping the key free', async () => {
    let verdict = false;
    const s = make({ authorize: async () => verdict });
    expect(await code(() => s.charge({ key: 'k', account: 'alice', amount: 5 }))).toBe('DECLINED');
    verdict = 'yes';
    expect(await code(() => s.charge({ key: 'k', account: 'alice', amount: 5 }))).toBe('DECLINED');
    expect(await s.balance('alice')).toBe(100);
    verdict = true;
    expect((await s.charge({ key: 'k', account: 'bob', amount: 7 })).replayed).toBe(false);
  });
  it('propagates a rejection unchanged and moves no money', async () => {
    const boom = Object.assign(new Error('gateway down'), { code: 'GATEWAY' });
    const s = make({ authorize: async () => { throw boom; } });
    const outcome = await settle(s.charge({ key: 'k', account: 'alice', amount: 5 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe(boom);
    expect(await s.balance('alice')).toBe(100);
  });
  it('measures key lifetime from the moment the money moved, not from when the call started', async () => {
    const c = clock(0);
    const gate = deferred();
    const s = make({ ttl: 100, now: c.now, authorize: () => gate.promise });
    const pending = s.charge({ key: 'k', account: 'alice', amount: 10 });
    await tick();
    c.t = 50;
    gate.resolve(true);
    const first = await pending;
    c.t = 149;
    expect((await s.charge({ key: 'k', account: 'alice', amount: 10 })).chargeId).toBe(first.chargeId);
    c.t = 150;
    expect((await s.charge({ key: 'k', account: 'alice', amount: 10 })).replayed).toBe(false);
  });
});

describe('concurrency', () => {
  const gated = () => {
    const gates = new Map();
    const authorize = ({ key }) => { const g = deferred(); gates.set(key, g); return g.promise; };
    return { authorize, gates };
  };
  it('never overdraws: the attempt whose authorization finishes first is charged first', async () => {
    const { authorize, gates } = gated();
    const s = make({ authorize });
    const first = settle(s.charge({ key: 'k1', account: 'alice', amount: 60 }));
    const second = settle(s.charge({ key: 'k2', account: 'alice', amount: 60 }));
    await tick();
    gates.get('k2').resolve(true);
    await tick();
    gates.get('k1').resolve(true);
    const [a, b] = await Promise.all([first, second]);
    expect(b.ok).toBe(true);
    expect(b.value.balance).toBe(40);
    expect(a).toMatchObject({ ok: false, code: 'INSUFFICIENT_FUNDS' });
    expect(await s.balance('alice')).toBe(40);
  });
  it('lets both concurrent charges through when the balance covers them', async () => {
    const { authorize, gates } = gated();
    const s = make({ authorize });
    const first = s.charge({ key: 'k1', account: 'alice', amount: 60 });
    const second = s.charge({ key: 'k2', account: 'alice', amount: 40 });
    await tick();
    gates.get('k1').resolve(true); gates.get('k2').resolve(true);
    const [a, b] = await Promise.all([first, second]);
    expect(a.balance).toBe(40);
    expect(b.balance).toBe(0);
  });
  it('checks the balance only after authorization finishes', async () => {
    const { authorize, gates } = gated();
    const s = make({ authorize });
    const pending = s.charge({ key: 'k', account: 'bob', amount: 60 });
    await tick();
    await s.deposit({ account: 'bob', amount: 20 });
    gates.get('k').resolve(true);
    expect(await pending).toMatchObject({ balance: 10, replayed: false });
  });
  it('treats concurrent same-key calls as one attempt that every caller observes', async () => {
    let calls = 0;
    const gate = deferred();
    const s = make({ authorize: () => { calls++; return gate.promise; } });
    const first = s.charge({ key: 'k', account: 'alice', amount: 30 });
    await tick();
    const joiner = s.charge({ key: 'k', account: 'alice', amount: 30 });
    const another = s.charge({ key: 'k', account: 'alice', amount: 30 });
    await tick();
    gate.resolve(true);
    const [a, b, c] = await Promise.all([first, joiner, another]);
    expect(calls).toBe(1);
    expect(a.replayed).toBe(false);
    expect(b).toEqual({ ...a, replayed: true });
    expect(c).toEqual({ ...a, replayed: true });
    expect(await s.balance('alice')).toBe(70);
  });
  it('gives every caller the same error code when the shared attempt fails, and frees the key', async () => {
    for (const [verdict, expected] of [[false, 'DECLINED']]) {
      const gate = deferred();
      let calls = 0;
      const s = make({ authorize: () => { calls++; return calls === 1 ? gate.promise : Promise.resolve(true); } });
      const first = settle(s.charge({ key: 'k', account: 'alice', amount: 30 }));
      await tick();
      const joiner = settle(s.charge({ key: 'k', account: 'alice', amount: 30 }));
      gate.resolve(verdict);
      const [a, b] = await Promise.all([first, joiner]);
      expect(a).toMatchObject({ ok: false, code: expected });
      expect(b).toMatchObject({ ok: false, code: expected });
      expect(calls).toBe(1);
      const retry = await s.charge({ key: 'k', account: 'alice', amount: 30 });
      expect(retry.replayed).toBe(false);
      expect(calls).toBe(2);
    }
  });
  it('shares an insufficient-funds outcome too', async () => {
    const gate = deferred();
    const s = make({ authorize: () => gate.promise });
    const first = settle(s.charge({ key: 'k', account: 'bob', amount: 90 }));
    await tick();
    const joiner = settle(s.charge({ key: 'k', account: 'bob', amount: 90 }));
    gate.resolve(true);
    const [a, b] = await Promise.all([first, joiner]);
    expect(a.code).toBe('INSUFFICIENT_FUNDS');
    expect(b.code).toBe('INSUFFICIENT_FUNDS');
    expect(await s.balance('bob')).toBe(50);
  });
  it('rejects a mismatching joiner at once without disturbing the attempt in flight', async () => {
    const gate = deferred();
    const s = make({ authorize: () => gate.promise });
    const first = s.charge({ key: 'k', account: 'alice', amount: 30 });
    await tick();
    expect(await code(() => s.charge({ key: 'k', account: 'alice', amount: 31 }))).toBe('IDEMPOTENCY_MISMATCH');
    expect(await code(() => s.charge({ key: 'k', account: 'bob', amount: 30 }))).toBe('IDEMPOTENCY_MISMATCH');
    gate.resolve(true);
    expect(await first).toMatchObject({ amount: 30, balance: 70, replayed: false });
    expect(await s.balance('bob')).toBe(50);
  });
  it('does not make deposit or balance wait for a charge in flight', async () => {
    const gate = deferred();
    const s = make({ authorize: () => gate.promise });
    const pending = s.charge({ key: 'k', account: 'alice', amount: 30 });
    await tick();
    expect(await s.balance('alice')).toBe(100);
    expect(await s.deposit({ account: 'alice', amount: 5 })).toBe(105);
    gate.resolve(true);
    expect((await pending).balance).toBe(75);
  });
  it('runs different keys on different accounts independently', async () => {
    const { authorize, gates } = gated();
    const s = make({ authorize });
    const a = s.charge({ key: 'ka', account: 'alice', amount: 100 });
    const b = s.charge({ key: 'kb', account: 'bob', amount: 50 });
    await tick();
    gates.get('kb').resolve(true);
    expect((await b).balance).toBe(0);
    gates.get('ka').resolve(true);
    expect((await a).balance).toBe(0);
  });
  it('replays a finished in-flight attempt afterwards', async () => {
    const gate = deferred();
    const s = make({ authorize: () => gate.promise });
    const first = s.charge({ key: 'k', account: 'alice', amount: 30 });
    await tick();
    gate.resolve(true);
    const done = await first;
    expect(await s.charge({ key: 'k', account: 'alice', amount: 30 })).toEqual({ ...done, replayed: true });
  });
});
