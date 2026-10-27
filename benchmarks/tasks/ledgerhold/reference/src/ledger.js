const fail = (code) => Object.assign(new Error(code), { code });
const isInt = (n) => Number.isSafeInteger(n);

export function createLedger({ now = () => 0, holdTtl = 60 } = {}) {
  if (!isInt(holdTtl) || holdTtl <= 0) throw fail('INVALID_INPUT');
  const accounts = new Map();
  const holds = new Map();
  const remembered = new Map();
  let counter = 0;

  const text = (value) => { if (typeof value !== 'string' || value === '') throw fail('INVALID_INPUT'); };
  const money = (value) => { if (!isInt(value) || value <= 0) throw fail('INVALID_AMOUNT'); };
  const account = (name) => { text(name); const found = accounts.get(name); if (!found) throw fail('UNKNOWN_ACCOUNT'); return found; };
  const active = (hold) => hold.state === 'open' && now() < hold.createdAt + holdTtl;
  const status = (hold) => (hold.state !== 'open' ? hold.state : active(hold) ? 'active' : 'expired');
  const view = (name) => {
    const held = [...holds.values()].filter((h) => h.account === name && active(h)).reduce((sum, h) => sum + h.amount, 0);
    const { total } = accounts.get(name);
    return { total, held, available: total - held };
  };
  const openHold = (holdId) => {
    text(holdId);
    const hold = holds.get(holdId);
    if (!hold) throw fail('UNKNOWN_HOLD');
    if (hold.state !== 'open') throw fail('HOLD_CLOSED');
    if (!active(hold)) throw fail('HOLD_EXPIRED');
    return hold;
  };
  // A key is spent only by a call that succeeds; a failed call leaves it free.
  const once = (method, key, args, run) => {
    text(key);
    const signature = JSON.stringify([method, args]);
    const seen = remembered.get(key);
    if (seen) {
      if (seen.signature !== signature) throw fail('KEY_REUSED');
      return structuredClone(seen.result);
    }
    const result = run();
    remembered.set(key, { signature, result: structuredClone(result) });
    return structuredClone(result);
  };

  return {
    open(name) {
      text(name);
      if (accounts.has(name)) throw fail('ACCOUNT_EXISTS');
      accounts.set(name, { total: 0 });
      return view(name);
    },
    deposit(name, amount, key) {
      return once('deposit', key, [name, amount], () => { const a = account(name); money(amount); a.total += amount; return view(name); });
    },
    hold(name, amount, key) {
      return once('hold', key, [name, amount], () => {
        account(name); money(amount);
        if (view(name).available < amount) throw fail('INSUFFICIENT_FUNDS');
        const holdId = `h${++counter}`;
        holds.set(holdId, { holdId, account: name, amount, createdAt: now(), state: 'open' });
        return { holdId, amount, expiresAt: now() + holdTtl };
      });
    },
    capture(holdId, amount, key) {
      return once('capture', key, [holdId, amount], () => {
        const hold = openHold(holdId); money(amount);
        if (amount > hold.amount) throw fail('OVER_CAPTURE');
        hold.state = 'captured';
        accounts.get(hold.account).total -= amount;
        return view(hold.account);
      });
    },
    release(holdId, key) {
      return once('release', key, [holdId], () => { const hold = openHold(holdId); hold.state = 'released'; return view(hold.account); });
    },
    transfer(from, to, amount, key) {
      return once('transfer', key, [from, to, amount], () => {
        text(from); text(to);
        if (from === to) throw fail('SAME_ACCOUNT');
        const source = account(from), target = account(to); money(amount);
        if (view(from).available < amount) throw fail('INSUFFICIENT_FUNDS');
        source.total -= amount; target.total += amount;
        return { from: view(from), to: view(to) };
      });
    },
    balance(name) { account(name); return view(name); },
    getHold(holdId) {
      text(holdId);
      const hold = holds.get(holdId);
      if (!hold) throw fail('UNKNOWN_HOLD');
      return { holdId, account: hold.account, amount: hold.amount, status: status(hold) };
    },
  };
}
