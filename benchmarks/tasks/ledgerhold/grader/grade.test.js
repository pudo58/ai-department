// Hidden grader for LedgerHold. It asserts only what SPEC.md decides.
import { describe, expect, it } from 'vitest';
import { createLedger } from '../src/ledger.js';

const code = async (fn) => { try { await fn(); } catch (error) { return error?.code ?? `NO_CODE:${error?.message}`; } return 'NO_ERROR'; };
const clock = (start = 0) => { const c = { t: start, now: () => c.t }; return c; };
const make = (config = {}, start = 0) => {
  const c = clock(start), l = createLedger({ now: c.now, holdTtl: 60, ...config });
  l.open('a'); l.open('b');
  return { l, c };
};
const funded = async (amount = 1000, config = {}, start = 0) => { const env = make(config, start); await env.l.deposit('a', amount, 'seed'); return env; };

describe('options, accounts and validation', () => {
  it('rejects an invalid holdTtl with INVALID_INPUT and accepts the defaults', async () => {
    for (const holdTtl of [0, -1, 1.5, '60', null]) expect(await code(() => createLedger({ holdTtl })), String(holdTtl)).toBe('INVALID_INPUT');
    expect(typeof createLedger().open).toBe('function');
  });
  it('opens an account with zero funds and refuses to open it twice', async () => {
    const l = createLedger();
    expect(await l.open('x')).toEqual({ total: 0, held: 0, available: 0 });
    expect(await code(() => l.open('x'))).toBe('ACCOUNT_EXISTS');
    expect(await l.balance('x')).toEqual({ total: 0, held: 0, available: 0 });
  });
  it('rejects bad names, keys and amounts with the specified codes', async () => {
    const { l } = make();
    for (const name of ['', 5, undefined]) expect(await code(() => l.open(name)), String(name)).toBe('INVALID_INPUT');
    for (const key of ['', 5, undefined]) expect(await code(() => l.deposit('a', 10, key)), String(key)).toBe('INVALID_INPUT');
    for (const amount of [0, -5, 1.5, '10', undefined, Number.MAX_SAFE_INTEGER + 1]) expect(await code(() => l.deposit('a', amount, 'k')), String(amount)).toBe('INVALID_AMOUNT');
    expect(await code(() => l.deposit('nope', 10, 'k2'))).toBe('UNKNOWN_ACCOUNT');
    expect(await code(() => l.balance('nope'))).toBe('UNKNOWN_ACCOUNT');
    expect(await code(() => l.getHold('h99'))).toBe('UNKNOWN_HOLD');
    expect(await code(() => l.capture('h99', 5, 'k3'))).toBe('UNKNOWN_HOLD');
    expect(await code(() => l.release('h99', 'k4'))).toBe('UNKNOWN_HOLD');
  });
  it('does not change anything when a deposit is refused', async () => {
    const { l } = make();
    expect(await code(() => l.deposit('a', 0, 'k'))).toBe('INVALID_AMOUNT');
    expect(await l.balance('a')).toEqual({ total: 0, held: 0, available: 0 });
  });
});

describe('balances and holds', () => {
  it('adds deposits to total and available and returns the view', async () => {
    const { l } = make();
    expect(await l.deposit('a', 500, 'd1')).toEqual({ total: 500, held: 0, available: 500 });
    expect(await l.deposit('a', 250, 'd2')).toEqual({ total: 750, held: 0, available: 750 });
    expect(await l.balance('b')).toEqual({ total: 0, held: 0, available: 0 });
  });
  it('reserves available funds and returns the hold with its expiry', async () => {
    const { l } = await funded(1000, {}, 10);
    const hold = await l.hold('a', 300, 'h-a');
    expect(hold).toEqual({ holdId: 'h1', amount: 300, expiresAt: 70 });
    expect(await l.balance('a')).toEqual({ total: 1000, held: 300, available: 700 });
    expect(await l.getHold('h1')).toEqual({ holdId: 'h1', account: 'a', amount: 300, status: 'active' });
  });
  it('allows a hold of exactly the available funds and refuses one cent more', async () => {
    const { l } = await funded(1000);
    expect(await code(() => l.hold('a', 1001, 'k1'))).toBe('INSUFFICIENT_FUNDS');
    expect((await l.hold('a', 1000, 'k2')).amount).toBe(1000);
    expect(await code(() => l.hold('a', 1, 'k3'))).toBe('INSUFFICIENT_FUNDS');
    expect(await l.balance('a')).toEqual({ total: 1000, held: 1000, available: 0 });
  });
  it('numbers holds in creation order and advances the counter only for holds that were created', async () => {
    const { l } = await funded(1000);
    expect((await l.hold('a', 100, 'k1')).holdId).toBe('h1');
    expect(await code(() => l.hold('a', 5000, 'k2'))).toBe('INSUFFICIENT_FUNDS');
    expect(await code(() => l.hold('nope', 5, 'k3'))).toBe('UNKNOWN_ACCOUNT');
    expect((await l.hold('a', 100, 'k4')).holdId).toBe('h2');
    expect((await l.hold('a', 100, 'k5')).holdId).toBe('h3');
  });
  it('lets a hold stop counting exactly at createdAt + holdTtl', async () => {
    const { l, c } = await funded(1000, {}, 100);
    await l.hold('a', 400, 'k1');
    c.t = 159;
    expect(await l.balance('a')).toEqual({ total: 1000, held: 400, available: 600 });
    expect((await l.getHold('h1')).status).toBe('active');
    c.t = 160;
    expect(await l.balance('a')).toEqual({ total: 1000, held: 0, available: 1000 });
    expect((await l.getHold('h1')).status).toBe('expired');
  });
  it('frees the funds of an expired hold for a new hold at the same moment', async () => {
    const { l, c } = await funded(1000);
    await l.hold('a', 1000, 'k1');
    expect(await code(() => l.hold('a', 1, 'k2'))).toBe('INSUFFICIENT_FUNDS');
    c.t = 60;
    expect((await l.hold('a', 1000, 'k3')).holdId).toBe('h2');
  });
  it('only counts the active holds of the account itself', async () => {
    const { l } = await funded(1000);
    await l.deposit('b', 50, 'db');
    await l.hold('a', 600, 'k1');
    expect(await l.balance('b')).toEqual({ total: 50, held: 0, available: 50 });
    expect((await l.hold('b', 50, 'k2')).amount).toBe(50);
  });
});

describe('capture and release', () => {
  it('spends from the hold, closes it and gives the rest back at once', async () => {
    const { l } = await funded(1000);
    await l.hold('a', 400, 'h1k');
    expect(await l.capture('h1', 150, 'c1')).toEqual({ total: 850, held: 0, available: 850 });
    expect(await l.getHold('h1')).toEqual({ holdId: 'h1', account: 'a', amount: 400, status: 'captured' });
  });
  it('allows capturing exactly the hold amount and refuses more', async () => {
    const { l } = await funded(1000);
    await l.hold('a', 400, 'k1');
    expect(await code(() => l.capture('h1', 401, 'c1'))).toBe('OVER_CAPTURE');
    expect(await l.balance('a')).toEqual({ total: 1000, held: 400, available: 600 });
    expect(await l.capture('h1', 400, 'c2')).toEqual({ total: 600, held: 0, available: 600 });
  });
  it('refuses to capture or release a hold that already expired', async () => {
    const { l, c } = await funded(1000);
    await l.hold('a', 400, 'k1');
    await l.hold('a', 100, 'k2');
    c.t = 60;
    expect(await code(() => l.capture('h1', 10, 'c1'))).toBe('HOLD_EXPIRED');
    expect(await code(() => l.release('h2', 'r1'))).toBe('HOLD_EXPIRED');
    expect(await l.balance('a')).toEqual({ total: 1000, held: 0, available: 1000 });
  });
  it('refuses a second capture or a release of a closed hold', async () => {
    const { l } = await funded(1000);
    await l.hold('a', 400, 'k1');
    await l.hold('a', 300, 'k2');
    await l.capture('h1', 100, 'c1');
    expect(await code(() => l.capture('h1', 100, 'c2'))).toBe('HOLD_CLOSED');
    expect(await code(() => l.release('h1', 'r1'))).toBe('HOLD_CLOSED');
    await l.release('h2', 'r2');
    expect(await code(() => l.capture('h2', 10, 'c3'))).toBe('HOLD_CLOSED');
    expect(await code(() => l.release('h2', 'r3'))).toBe('HOLD_CLOSED');
    expect(await l.balance('a')).toEqual({ total: 900, held: 0, available: 900 });
  });
  it('releases without spending and reports the released status', async () => {
    const { l } = await funded(1000);
    await l.hold('a', 400, 'k1');
    expect(await l.release('h1', 'r1')).toEqual({ total: 1000, held: 0, available: 1000 });
    expect((await l.getHold('h1')).status).toBe('released');
  });
  it('keeps a captured hold captured after its time is up', async () => {
    const { l, c } = await funded(1000);
    await l.hold('a', 400, 'k1');
    await l.capture('h1', 400, 'c1');
    c.t = 5000;
    expect((await l.getHold('h1')).status).toBe('captured');
    expect(await code(() => l.release('h1', 'r1'))).toBe('HOLD_CLOSED');
  });
  it('reports an expired hold as expired, never as captured or released', async () => {
    const { l, c } = await funded(1000);
    await l.hold('a', 400, 'k1');
    c.t = 61;
    expect((await l.getHold('h1')).status).toBe('expired');
  });
});

describe('transfers', () => {
  it('moves available funds and returns both views', async () => {
    const { l } = await funded(1000);
    expect(await l.transfer('a', 'b', 300, 't1')).toEqual({ from: { total: 700, held: 0, available: 700 }, to: { total: 300, held: 0, available: 300 } });
  });
  it('cannot move held funds, but can move the rest', async () => {
    const { l } = await funded(1000);
    await l.hold('a', 800, 'k1');
    expect(await code(() => l.transfer('a', 'b', 201, 't1'))).toBe('INSUFFICIENT_FUNDS');
    expect((await l.transfer('a', 'b', 200, 't2')).from).toEqual({ total: 800, held: 800, available: 0 });
  });
  it('can move funds again once the hold expired or was released', async () => {
    const { l, c } = await funded(1000);
    await l.hold('a', 800, 'k1');
    c.t = 60;
    expect((await l.transfer('a', 'b', 1000, 't1')).from.total).toBe(0);
  });
  it('refuses the same account and unknown accounts without changing anything', async () => {
    const { l } = await funded(1000);
    expect(await code(() => l.transfer('a', 'a', 10, 't1'))).toBe('SAME_ACCOUNT');
    expect(await code(() => l.transfer('a', 'nope', 10, 't2'))).toBe('UNKNOWN_ACCOUNT');
    expect(await code(() => l.transfer('nope', 'a', 10, 't3'))).toBe('UNKNOWN_ACCOUNT');
    expect(await l.balance('a')).toEqual({ total: 1000, held: 0, available: 1000 });
  });
  it('allows a transfer of exactly the available funds', async () => {
    const { l } = await funded(1000);
    expect((await l.transfer('a', 'b', 1000, 't1')).to.total).toBe(1000);
    expect(await code(() => l.transfer('a', 'b', 1, 't2'))).toBe('INSUFFICIENT_FUNDS');
  });
});

describe('idempotency keys', () => {
  it('applies a call once and replays its first result for the same key and arguments', async () => {
    const { l } = make();
    const first = await l.deposit('a', 100, 'k');
    expect(await l.deposit('a', 100, 'k')).toEqual(first);
    expect(await l.balance('a')).toEqual({ total: 100, held: 0, available: 100 });
  });
  it('replays the remembered result, not the current balances, even after time and other operations', async () => {
    const { l, c } = make();
    const first = await l.deposit('a', 100, 'k');
    await l.deposit('a', 900, 'other');
    c.t = 1000;
    expect(await l.deposit('a', 100, 'k')).toEqual({ total: 100, held: 0, available: 100 });
    expect(first).toEqual({ total: 100, held: 0, available: 100 });
    expect(await l.balance('a')).toEqual({ total: 1000, held: 0, available: 1000 });
  });
  it('does not create a second hold when a hold is replayed', async () => {
    const { l } = await funded(1000);
    const first = await l.hold('a', 400, 'hk');
    expect(await l.hold('a', 400, 'hk')).toEqual(first);
    expect(await l.balance('a')).toEqual({ total: 1000, held: 400, available: 600 });
    expect((await l.hold('a', 100, 'next')).holdId).toBe('h2');
  });
  it('replays a capture, a release and a transfer without applying them again', async () => {
    const { l } = await funded(1000);
    await l.hold('a', 400, 'k1');
    await l.hold('a', 100, 'k2');
    const captured = await l.capture('h1', 300, 'c1');
    expect(await l.capture('h1', 300, 'c1')).toEqual(captured);
    const released = await l.release('h2', 'r1');
    expect(await l.release('h2', 'r1')).toEqual(released);
    const moved = await l.transfer('a', 'b', 200, 't1');
    expect(await l.transfer('a', 'b', 200, 't1')).toEqual(moved);
    expect(await l.balance('a')).toEqual({ total: 500, held: 0, available: 500 });
    expect(await l.balance('b')).toEqual({ total: 200, held: 0, available: 200 });
  });
  it('rejects a key reused with other arguments or another method, and applies nothing', async () => {
    const { l } = make();
    await l.deposit('a', 100, 'k');
    expect(await code(() => l.deposit('a', 101, 'k'))).toBe('KEY_REUSED');
    expect(await code(() => l.deposit('b', 100, 'k'))).toBe('KEY_REUSED');
    expect(await code(() => l.hold('a', 100, 'k'))).toBe('KEY_REUSED');
    expect(await code(() => l.transfer('a', 'b', 50, 'k'))).toBe('KEY_REUSED');
    expect(await l.balance('a')).toEqual({ total: 100, held: 0, available: 100 });
    expect(await l.balance('b')).toEqual({ total: 0, held: 0, available: 0 });
  });
  it('does not use up the key of a call that failed', async () => {
    const { l } = make();
    expect(await code(() => l.hold('a', 100, 'k'))).toBe('INSUFFICIENT_FUNDS');
    await l.deposit('a', 500, 'fund');
    expect((await l.hold('a', 100, 'k')).holdId).toBe('h1');
    expect(await code(() => l.transfer('a', 'zzz', 10, 'k2'))).toBe('UNKNOWN_ACCOUNT');
    expect((await l.deposit('a', 1, 'k2')).total).toBe(501);
  });
  it('returns copies, so changing a result does not change what is remembered', async () => {
    const { l } = make();
    const first = await l.deposit('a', 100, 'k');
    first.total = 999;
    expect(await l.deposit('a', 100, 'k')).toEqual({ total: 100, held: 0, available: 100 });
  });
});

describe('sequences that mix the rules', () => {
  it('keeps the books balanced through hold, partial capture, transfer, release and expiry', async () => {
    const { l, c } = await funded(1000);
    await l.hold('a', 500, 'k1');
    await l.transfer('a', 'b', 500, 't1');
    expect(await code(() => l.transfer('a', 'b', 1, 't2'))).toBe('INSUFFICIENT_FUNDS');
    await l.capture('h1', 200, 'c1');
    expect(await l.balance('a')).toEqual({ total: 300, held: 0, available: 300 });
    await l.hold('a', 300, 'k2');
    c.t = 60;
    expect(await l.balance('a')).toEqual({ total: 300, held: 0, available: 300 });
    expect((await l.transfer('a', 'b', 300, 't3')).from).toEqual({ total: 0, held: 0, available: 0 });
    expect(await l.balance('b')).toEqual({ total: 800, held: 0, available: 800 });
  });
  it('treats two accounts independently when both hold and capture', async () => {
    const { l } = await funded(1000);
    await l.deposit('b', 200, 'db');
    await l.hold('a', 100, 'k1');
    await l.hold('b', 200, 'k2');
    await l.capture('h2', 50, 'c2');
    expect(await l.balance('a')).toEqual({ total: 1000, held: 100, available: 900 });
    expect(await l.balance('b')).toEqual({ total: 150, held: 0, available: 150 });
  });
});
