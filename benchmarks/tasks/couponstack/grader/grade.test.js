// Hidden grader for CouponStack. It asserts only what SPEC.md decides.
import { describe, expect, it } from 'vitest';
import { createCoupons } from '../src/coupons.js';

const code = async (fn) => { try { await fn(); } catch (error) { return error?.code ?? `NO_CODE:${error?.message}`; } return 'NO_ERROR'; };
const clock = (start = 0) => { const c = { t: start, now: () => c.t }; return c; };
const COUPONS = [
  { code: 'P10', kind: 'percent', value: 10, stackable: true },
  { code: 'P50', kind: 'percent', value: 50, stackable: true },
  { code: 'F5', kind: 'fixed', value: 500, stackable: true },
  { code: 'F20', kind: 'fixed', value: 2000, stackable: true },
  { code: 'BIG', kind: 'percent', value: 30 },
  { code: 'CAP', kind: 'percent', value: 50, stackable: true, cap: 300 },
];
const make = (extra = [], start = 0) => { const c = clock(start); return { e: createCoupons({ coupons: [...COUPONS, ...extra], now: c.now }), c }; };
const lines = (...prices) => prices.map((unitPrice, i) => ({ sku: `s${i}`, unitPrice, qty: 1 }));
const order = (orderId, codes, ls = lines(10000), customer = 'ann') => ({ orderId, customer, lines: ls, codes });
const ask = (codes, ls = lines(10000), customer = 'ann') => ({ customer, lines: ls, codes });

describe('definitions', () => {
  it('rejects invalid definitions with INVALID_INPUT', async () => {
    const bad = [
      [{ code: '', kind: 'fixed', value: 5 }], [{ code: 'a', kind: 'fixed', value: 5 }, { code: 'a', kind: 'fixed', value: 6 }], [{ code: 'a', kind: 'weird', value: 5 }],
      [{ code: 'a', kind: 'percent', value: 0 }], [{ code: 'a', kind: 'percent', value: 101 }], [{ code: 'a', kind: 'percent', value: 10.5 }], [{ code: 'a', kind: 'fixed', value: 0 }],
      [{ code: 'a', kind: 'fixed', value: 5, stackable: 'yes' }], [{ code: 'a', kind: 'fixed', value: 5, minSubtotal: -1 }], [{ code: 'a', kind: 'fixed', value: 5, maxUses: 0 }],
      [{ code: 'a', kind: 'fixed', value: 5, perCustomer: 1.5 }], [{ code: 'a', kind: 'fixed', value: 5, cap: 0 }], [{ code: 'a', kind: 'fixed', value: 5, validFrom: -1 }],
      [{ code: 'a', kind: 'fixed', value: 5, validFrom: 10, validTo: 10 }], [{ code: 'a', kind: 'fixed', value: 5, validTo: 1.5 }],
    ];
    for (const coupons of bad) expect(await code(() => createCoupons({ coupons })), JSON.stringify(coupons)).toBe('INVALID_INPUT');
    expect(await code(() => createCoupons({ coupons: 'x' }))).toBe('INVALID_INPUT');
    expect(typeof createCoupons().quote).toBe('function');
    expect(await code(() => createCoupons({ coupons: [{ code: 'ok', kind: 'percent', value: 100, validFrom: 5, validTo: 6, maxUses: 1, perCustomer: 1, cap: 1, minSubtotal: 0 }] }))).toBe('NO_ERROR');
  });
  it('rejects invalid requests with INVALID_INPUT', async () => {
    const { e } = make();
    for (const request of [ask([], []), ask([], 'x'), { customer: '', lines: lines(5), codes: [] }, { lines: lines(5), codes: [] }, ask('P10'), ask([5]),
      ask([], [{ sku: '', unitPrice: 5, qty: 1 }]), ask([], [{ sku: 's', unitPrice: -1, qty: 1 }]), ask([], [{ sku: 's', unitPrice: 5, qty: 0 }]), ask([], [{ sku: 's', unitPrice: 5.5, qty: 1 }])]) {
      expect(await code(() => e.quote(request)), JSON.stringify(request)).toBe('INVALID_INPUT');
    }
    expect(await code(() => e.redeem({ orderId: '', customer: 'ann', lines: lines(5), codes: [] }))).toBe('INVALID_INPUT');
    expect(await code(() => e.redeem({ customer: 'ann', lines: lines(5), codes: [] }))).toBe('INVALID_INPUT');
  });
  it('reports duplicate and unknown codes', async () => {
    const { e } = make();
    expect(await code(() => e.quote(ask(['P10', 'P10'])))).toBe('DUPLICATE_CODE');
    expect(await code(() => e.quote(ask(['NOPE'])))).toBe('UNKNOWN_COUPON');
    expect(await code(() => e.uses('NOPE'))).toBe('UNKNOWN_COUPON');
    expect(await code(() => e.usesBy('NOPE', 'ann'))).toBe('UNKNOWN_COUPON');
  });
});

describe('pricing', () => {
  it('prices an order without codes', async () => {
    const { e } = make();
    expect(await e.quote(ask([], [{ sku: 'a', unitPrice: 1250, qty: 3 }, { sku: 'b', unitPrice: 0, qty: 2 }]))).toEqual({ subtotal: 3750, discounts: [], total: 3750 });
  });
  it('applies one percent coupon and one fixed coupon', async () => {
    const { e } = make();
    expect(await e.quote(ask(['P10']))).toEqual({ subtotal: 10000, discounts: [{ code: 'P10', amount: 1000 }], total: 9000 });
    expect(await e.quote(ask(['F5']))).toEqual({ subtotal: 10000, discounts: [{ code: 'F5', amount: 500 }], total: 9500 });
  });
  it('rounds a percent discount down', async () => {
    const { e } = make();
    expect((await e.quote(ask(['P10'], lines(999)))).discounts).toEqual([{ code: 'P10', amount: 99 }]);
    expect((await e.quote(ask(['P50'], lines(1)))).discounts).toEqual([{ code: 'P50', amount: 0 }]);
    expect((await e.quote(ask(['P50'], lines(7)))).total).toBe(4);
  });
  it('applies percent coupons before fixed ones whatever the order of the codes', async () => {
    const { e } = make();
    const a = await e.quote(ask(['F5', 'P10']));
    expect(a).toEqual({ subtotal: 10000, discounts: [{ code: 'P10', amount: 1000 }, { code: 'F5', amount: 500 }], total: 8500 });
    expect(await e.quote(ask(['P10', 'F5']))).toEqual(a);
  });
  it('applies each percent coupon to what is left, in the order of the codes', async () => {
    const { e } = make();
    expect(await e.quote(ask(['P50', 'P10']))).toEqual({ subtotal: 10000, discounts: [{ code: 'P50', amount: 5000 }, { code: 'P10', amount: 500 }], total: 4500 });
    expect(await e.quote(ask(['P10', 'P50']))).toEqual({ subtotal: 10000, discounts: [{ code: 'P10', amount: 1000 }, { code: 'P50', amount: 4500 }], total: 4500 });
  });
  it('applies fixed coupons in the order of the codes and stacks them', async () => {
    const { e } = make();
    expect(await e.quote(ask(['F20', 'F5']))).toEqual({ subtotal: 10000, discounts: [{ code: 'F20', amount: 2000 }, { code: 'F5', amount: 500 }], total: 7500 });
  });
  it('limits a coupon by its cap', async () => {
    const { e } = make([{ code: 'FC', kind: 'fixed', value: 5000, cap: 1200, stackable: true }]);
    expect((await e.quote(ask(['CAP']))).discounts).toEqual([{ code: 'CAP', amount: 300 }]);
    expect((await e.quote(ask(['FC']))).discounts).toEqual([{ code: 'FC', amount: 1200 }]);
    expect((await e.quote(ask(['CAP'], lines(400)))).discounts).toEqual([{ code: 'CAP', amount: 200 }]);
  });
  it('never takes more than what is left, so the total never goes below zero', async () => {
    const { e } = make();
    expect(await e.quote(ask(['F20'], lines(1500)))).toEqual({ subtotal: 1500, discounts: [{ code: 'F20', amount: 1500 }], total: 0 });
    expect(await e.quote(ask(['F20', 'F5'], lines(2200)))).toEqual({ subtotal: 2200, discounts: [{ code: 'F20', amount: 2000 }, { code: 'F5', amount: 200 }], total: 0 });
    expect((await e.quote(ask(['F5'], lines(0)))).discounts).toEqual([{ code: 'F5', amount: 0 }]);
  });
  it('takes a percent coupon of what the earlier coupons left, then caps it', async () => {
    const { e } = make();
    // 10000 - 50% (cap 300) = 9700, then 10% of 9700 = 970, then fixed 500.
    expect(await e.quote(ask(['CAP', 'P10', 'F5']))).toEqual({ subtotal: 10000, discounts: [{ code: 'CAP', amount: 300 }, { code: 'P10', amount: 970 }, { code: 'F5', amount: 500 }], total: 8230 });
  });
  it('leaves the engine untouched by a quote', async () => {
    const { e } = make();
    await e.quote(ask(['P10', 'F5']));
    expect(await e.uses('P10')).toBe(0);
    expect(await e.usesBy('F5', 'ann')).toBe(0);
  });
});

describe('eligibility', () => {
  it('honours validFrom and validTo as a half-open interval', async () => {
    const { e, c } = make([{ code: 'WIN', kind: 'fixed', value: 100, validFrom: 10, validTo: 20, stackable: true }]);
    c.t = 9; expect(await code(() => e.quote(ask(['WIN'])))).toBe('COUPON_NOT_ACTIVE');
    c.t = 10; expect((await e.quote(ask(['WIN']))).total).toBe(9900);
    c.t = 19; expect((await e.quote(ask(['WIN']))).total).toBe(9900);
    c.t = 20; expect(await code(() => e.quote(ask(['WIN'])))).toBe('COUPON_NOT_ACTIVE');
  });
  it('measures minSubtotal on the subtotal before any discount, and accepts exactly the minimum', async () => {
    const { e } = make([{ code: 'MIN', kind: 'fixed', value: 100, minSubtotal: 10000, stackable: true }]);
    expect(await code(() => e.quote(ask(['MIN'], lines(9999))))).toBe('MIN_SUBTOTAL');
    expect((await e.quote(ask(['MIN'], lines(10000)))).total).toBe(9900);
    expect((await e.quote(ask(['P50', 'MIN'], lines(10000)))).total).toBe(4900);
  });
  it('limits total uses and counts redemptions of all customers', async () => {
    const { e } = make([{ code: 'TWO', kind: 'fixed', value: 100, maxUses: 2, stackable: true }]);
    await e.redeem(order('o1', ['TWO'], lines(1000), 'ann'));
    await e.redeem(order('o2', ['TWO'], lines(1000), 'bob'));
    expect(await code(() => e.quote(ask(['TWO'], lines(1000), 'cy')))).toBe('COUPON_EXHAUSTED');
    expect(await code(() => e.redeem(order('o3', ['TWO'], lines(1000), 'cy')))).toBe('COUPON_EXHAUSTED');
    expect(await e.uses('TWO')).toBe(2);
  });
  it('limits uses per customer without limiting others', async () => {
    const { e } = make([{ code: 'ONCE', kind: 'fixed', value: 100, perCustomer: 1, stackable: true }]);
    await e.redeem(order('o1', ['ONCE'], lines(1000), 'ann'));
    expect(await code(() => e.redeem(order('o2', ['ONCE'], lines(1000), 'ann')))).toBe('LIMIT_REACHED');
    expect((await e.redeem(order('o3', ['ONCE'], lines(1000), 'bob'))).total).toBe(900);
    expect(await e.usesBy('ONCE', 'ann')).toBe(1);
    expect(await e.usesBy('ONCE', 'bob')).toBe(1);
    expect(await e.usesBy('ONCE', 'cy')).toBe(0);
  });
  it('reports the first ineligible coupon in the order of the codes, and the first failing rule of that coupon', async () => {
    const { e, c } = make([
      { code: 'OLD', kind: 'fixed', value: 100, validTo: 5, stackable: true },
      { code: 'RICH', kind: 'fixed', value: 100, minSubtotal: 50000, stackable: true },
    ], 10);
    expect(await code(() => e.quote(ask(['OLD', 'RICH'])))).toBe('COUPON_NOT_ACTIVE');
    expect(await code(() => e.quote(ask(['RICH', 'OLD'])))).toBe('MIN_SUBTOTAL');
    expect(c.t).toBe(10);
  });
  it('checks the rules of one coupon in the specified order', async () => {
    const { e, c } = make([{ code: 'ALL', kind: 'fixed', value: 100, maxUses: 1, perCustomer: 1, minSubtotal: 5000, validFrom: 5, stackable: true }], 10);
    await e.redeem(order('o1', ['ALL'], lines(6000), 'ann'));
    c.t = 1;
    expect(await code(() => e.quote(ask(['ALL'], lines(100), 'ann')))).toBe('COUPON_NOT_ACTIVE');
    c.t = 10;
    expect(await code(() => e.quote(ask(['ALL'], lines(100), 'ann')))).toBe('MIN_SUBTOTAL');
    expect(await code(() => e.quote(ask(['ALL'], lines(6000), 'ann')))).toBe('COUPON_EXHAUSTED');
  });
});

describe('stacking', () => {
  it('lets a non-stackable coupon stand alone and refuses it with any other code', async () => {
    const { e } = make();
    expect((await e.quote(ask(['BIG']))).total).toBe(7000);
    expect(await code(() => e.quote(ask(['BIG', 'P10'])))).toBe('NOT_STACKABLE');
    expect(await code(() => e.quote(ask(['P10', 'BIG'])))).toBe('NOT_STACKABLE');
    expect(await code(() => e.redeem(order('o1', ['BIG', 'F5'])))).toBe('NOT_STACKABLE');
    expect(await e.uses('BIG')).toBe(0);
  });
  it('lets any number of stackable coupons be combined', async () => {
    const { e } = make();
    const q = await e.quote(ask(['P10', 'P50', 'F5', 'F20', 'CAP']));
    expect(q.discounts.map((d) => d.code)).toEqual(['P10', 'P50', 'CAP', 'F5', 'F20']);
    expect(q.total).toBe(q.subtotal - q.discounts.reduce((sum, d) => sum + d.amount, 0));
  });
});

describe('redeeming', () => {
  it('prices like quote, counts one use of each coupon and returns the order id', async () => {
    const { e } = make();
    const quoted = await e.quote(ask(['P10', 'F5']));
    const redeemed = await e.redeem(order('o1', ['P10', 'F5']));
    expect(redeemed).toEqual({ orderId: 'o1', ...quoted });
    expect(await e.uses('P10')).toBe(1);
    expect(await e.uses('F5')).toBe(1);
    expect(await e.uses('P50')).toBe(0);
    expect(await e.usesBy('P10', 'ann')).toBe(1);
    expect(await e.usesBy('P10', 'bob')).toBe(0);
  });
  it('counts nothing and remembers nothing when one coupon is not eligible', async () => {
    const { e } = make([{ code: 'NEVER', kind: 'fixed', value: 100, validFrom: 100, stackable: true }]);
    expect(await code(() => e.redeem(order('o1', ['P10', 'NEVER'])))).toBe('COUPON_NOT_ACTIVE');
    expect(await e.uses('P10')).toBe(0);
    expect(await e.usesBy('P10', 'ann')).toBe(0);
    expect((await e.redeem(order('o1', ['P10']))).total).toBe(9000);
    expect(await e.uses('P10')).toBe(1);
  });
  it('returns the first result for an equal request and counts nothing a second time', async () => {
    const { e } = make();
    const first = await e.redeem(order('o1', ['P10', 'F5']));
    expect(await e.redeem(order('o1', ['P10', 'F5']))).toEqual(first);
    expect(await e.uses('P10')).toBe(1);
    expect(await e.usesBy('F5', 'ann')).toBe(1);
  });
  it('replays the first result even when the coupon has been used up or has expired since', async () => {
    const { e, c } = make([{ code: 'ONE', kind: 'fixed', value: 100, maxUses: 1, validTo: 50, stackable: true }]);
    const first = await e.redeem(order('o1', ['ONE']));
    expect(await code(() => e.redeem(order('o2', ['ONE'])))).toBe('COUPON_EXHAUSTED');
    c.t = 1000;
    expect(await e.redeem(order('o1', ['ONE']))).toEqual(first);
  });
  it('treats an equal request written with other key order and the same codes as the same order', async () => {
    const { e } = make();
    const first = await e.redeem({ orderId: 'o1', customer: 'ann', lines: [{ sku: 'a', unitPrice: 500, qty: 2 }], codes: ['P10'] });
    expect(await e.redeem({ codes: ['P10'], lines: [{ qty: 2, unitPrice: 500, sku: 'a' }], customer: 'ann', orderId: 'o1' })).toEqual(first);
    expect(await e.uses('P10')).toBe(1);
  });
  it('refuses the same order id with a different request and counts nothing', async () => {
    const { e } = make();
    await e.redeem(order('o1', ['P10']));
    expect(await code(() => e.redeem(order('o1', ['P50'])))).toBe('ORDER_CONFLICT');
    expect(await code(() => e.redeem(order('o1', ['P10'], lines(10001))))).toBe('ORDER_CONFLICT');
    expect(await code(() => e.redeem(order('o1', ['P10'], lines(10000), 'bob')))).toBe('ORDER_CONFLICT');
    expect(await code(() => e.redeem(order('o1', ['P10', 'F5'])))).toBe('ORDER_CONFLICT');
    expect(await e.uses('P50')).toBe(0);
    expect(await e.uses('P10')).toBe(1);
  });
  it('returns copies, so changing a result does not change what is remembered', async () => {
    const { e } = make();
    const first = await e.redeem(order('o1', ['P10']));
    first.total = 1; first.discounts[0].amount = 99999;
    expect((await e.redeem(order('o1', ['P10']))).total).toBe(9000);
    expect((await e.redeem(order('o1', ['P10']))).discounts[0].amount).toBe(1000);
  });
});

describe('cancelling', () => {
  it('gives every counted use back and returns the cancelled status', async () => {
    const { e } = make();
    await e.redeem(order('o1', ['P10', 'F5']));
    await e.redeem(order('o2', ['P10'], lines(500), 'bob'));
    expect(await e.cancel('o1')).toEqual({ orderId: 'o1', status: 'cancelled' });
    expect(await e.uses('P10')).toBe(1);
    expect(await e.uses('F5')).toBe(0);
    expect(await e.usesBy('P10', 'ann')).toBe(0);
    expect(await e.usesBy('P10', 'bob')).toBe(1);
  });
  it('gives nothing back a second time', async () => {
    const { e } = make();
    await e.redeem(order('o1', ['P10']));
    await e.redeem(order('o2', ['P10'], lines(500), 'bob'));
    await e.cancel('o1');
    expect(await e.cancel('o1')).toEqual({ orderId: 'o1', status: 'cancelled' });
    expect(await e.uses('P10')).toBe(1);
  });
  it('frees a place under maxUses and perCustomer', async () => {
    const { e } = make([{ code: 'ONE', kind: 'fixed', value: 100, maxUses: 1, perCustomer: 1, stackable: true }]);
    await e.redeem(order('o1', ['ONE']));
    expect(await code(() => e.redeem(order('o2', ['ONE'], lines(1000), 'bob')))).toBe('COUPON_EXHAUSTED');
    await e.cancel('o1');
    expect((await e.redeem(order('o2', ['ONE'], lines(1000), 'bob'))).total).toBe(900);
    expect(await e.uses('ONE')).toBe(1);
  });
  it('refuses unknown orders and a redemption of a cancelled order id', async () => {
    const { e } = make();
    expect(await code(() => e.cancel('nope'))).toBe('UNKNOWN_ORDER');
    await e.redeem(order('o1', ['P10']));
    await e.cancel('o1');
    expect(await code(() => e.redeem(order('o1', ['P10'])))).toBe('ORDER_CANCELLED');
    expect(await e.uses('P10')).toBe(0);
  });
  it('does not remember an order that failed, so there is nothing to cancel', async () => {
    const { e } = make();
    expect(await code(() => e.redeem(order('o1', ['NOPE'])))).toBe('UNKNOWN_COUPON');
    expect(await code(() => e.cancel('o1'))).toBe('UNKNOWN_ORDER');
  });
});
