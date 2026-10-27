const fail = (code) => Object.assign(new Error(code), { code });
const nonneg = (n) => Number.isSafeInteger(n) && n >= 0;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const orNull = (n) => n === null || positive(n);
const text = (value) => { if (typeof value !== 'string' || value === '') throw fail('INVALID_INPUT'); };
const canonical = (value) => JSON.stringify(value, (_key, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

export function createCoupons({ coupons = [], now = () => 0 } = {}) {
  if (!Array.isArray(coupons)) throw fail('INVALID_INPUT');
  const defs = new Map();
  for (const raw of coupons) {
    if (!raw || typeof raw !== 'object') throw fail('INVALID_INPUT');
    const d = { stackable: false, minSubtotal: 0, maxUses: null, perCustomer: null, validFrom: 0, validTo: null, cap: null, ...raw };
    text(d.code);
    if (defs.has(d.code)) throw fail('INVALID_INPUT');
    if (d.kind === 'percent') { if (!Number.isInteger(d.value) || d.value < 1 || d.value > 100) throw fail('INVALID_INPUT'); }
    else if (d.kind === 'fixed') { if (!positive(d.value)) throw fail('INVALID_INPUT'); }
    else throw fail('INVALID_INPUT');
    if (typeof d.stackable !== 'boolean' || !nonneg(d.minSubtotal) || !orNull(d.maxUses) || !orNull(d.perCustomer) || !orNull(d.cap) || !nonneg(d.validFrom)) throw fail('INVALID_INPUT');
    if (!(d.validTo === null || (Number.isSafeInteger(d.validTo) && d.validTo > d.validFrom))) throw fail('INVALID_INPUT');
    defs.set(d.code, d);
  }
  const counted = new Map();
  const countedBy = new Map();
  const orders = new Map();
  const by = (code, customer) => `${code}\u0000${customer}`;
  const bump = (code, customer, delta) => {
    counted.set(code, (counted.get(code) ?? 0) + delta);
    countedBy.set(by(code, customer), (countedBy.get(by(code, customer)) ?? 0) + delta);
  };
  const coupon = (code) => { text(code); const d = defs.get(code); if (!d) throw fail('UNKNOWN_COUPON'); return d; };

  const price = (request) => {
    const { customer, lines, codes = [] } = request ?? {};
    text(customer);
    if (!Array.isArray(lines) || lines.length === 0) throw fail('INVALID_INPUT');
    let subtotal = 0;
    for (const line of lines) {
      if (!line || typeof line !== 'object') throw fail('INVALID_INPUT');
      text(line.sku);
      if (!nonneg(line.unitPrice) || !positive(line.qty)) throw fail('INVALID_INPUT');
      subtotal += line.unitPrice * line.qty;
    }
    if (!Array.isArray(codes)) throw fail('INVALID_INPUT');
    for (const code of codes) text(code);
    if (new Set(codes).size !== codes.length) throw fail('DUPLICATE_CODE');
    const picked = codes.map(coupon);
    if (picked.length > 1 && picked.some((d) => !d.stackable)) throw fail('NOT_STACKABLE');
    const time = now();
    for (const d of picked) {
      if (time < d.validFrom || (d.validTo !== null && time >= d.validTo)) throw fail('COUPON_NOT_ACTIVE');
      if (subtotal < d.minSubtotal) throw fail('MIN_SUBTOTAL');
      if (d.maxUses !== null && (counted.get(d.code) ?? 0) >= d.maxUses) throw fail('COUPON_EXHAUSTED');
      if (d.perCustomer !== null && (countedBy.get(by(d.code, customer)) ?? 0) >= d.perCustomer) throw fail('LIMIT_REACHED');
    }
    let running = subtotal;
    const discounts = [];
    for (const kind of ['percent', 'fixed']) {
      for (const d of picked.filter((x) => x.kind === kind)) {
        const wanted = kind === 'percent' ? Math.floor((running * d.value) / 100) : d.value;
        const amount = Math.min(wanted, d.cap ?? Infinity, running);
        running -= amount;
        discounts.push({ code: d.code, amount });
      }
    }
    return { subtotal, discounts, total: running };
  };

  return {
    quote: (request) => price(request),
    redeem(request) {
      const { orderId, customer } = request ?? {};
      text(orderId);
      const signature = canonical({ customer, lines: request.lines, codes: request.codes ?? [] });
      const seen = orders.get(orderId);
      if (seen) {
        if (seen.status === 'cancelled') throw fail('ORDER_CANCELLED');
        if (seen.signature !== signature) throw fail('ORDER_CONFLICT');
        return structuredClone(seen.result);
      }
      const priced = price(request);
      const result = { orderId, ...priced };
      for (const { code } of priced.discounts) bump(code, customer, 1);
      orders.set(orderId, { signature, result: structuredClone(result), status: 'active', customer, codes: priced.discounts.map((d) => d.code) });
      return result;
    },
    cancel(orderId) {
      text(orderId);
      const order = orders.get(orderId);
      if (!order) throw fail('UNKNOWN_ORDER');
      if (order.status === 'active') {
        order.status = 'cancelled';
        for (const code of order.codes) bump(code, order.customer, -1);
      }
      return { orderId, status: 'cancelled' };
    },
    uses(code) { coupon(code); return counted.get(code) ?? 0; },
    usesBy(code, customer) { coupon(code); text(customer); return countedBy.get(by(code, customer)) ?? 0; },
  };
}
