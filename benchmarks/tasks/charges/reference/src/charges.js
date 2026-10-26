function fail(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}
const isSafeInt = (v) => Number.isSafeInteger(v);

export function createCharges({ accounts = {}, ttl = 1000, now = () => 0, authorize } = {}) {
  if (!isSafeInt(ttl) || ttl <= 0 || Object.values(accounts).some((v) => !isSafeInt(v) || v < 0)) throw fail('INVALID_INPUT');
  const balances = new Map(Object.entries(accounts));
  const records = new Map();
  const inflight = new Map();
  let counter = 0;

  const known = (account) => {
    if (!balances.has(account)) throw fail('UNKNOWN_ACCOUNT', String(account));
  };
  const positive = (amount) => {
    if (!isSafeInt(amount) || amount <= 0) throw fail('INVALID_AMOUNT');
  };

  return {
    async balance(account) {
      known(account);
      return balances.get(account);
    },
    async deposit({ account, amount } = {}) {
      positive(amount);
      known(account);
      balances.set(account, balances.get(account) + amount);
      return balances.get(account);
    },
    charge(input) {
      const { key, account, amount } = input ?? {};
      try {
        if (typeof key !== 'string' || key.length === 0) throw fail('INVALID_INPUT', 'key');
        positive(amount);
        known(account);
        const record = records.get(key);
        if (record && now() < record.at + ttl) {
          if (record.result.account !== account || record.result.amount !== amount) throw fail('IDEMPOTENCY_MISMATCH');
          return Promise.resolve({ ...record.result, replayed: true });
        }
        const flight = inflight.get(key);
        if (flight) {
          if (flight.account !== account || flight.amount !== amount) throw fail('IDEMPOTENCY_MISMATCH');
          return flight.promise.then((result) => ({ ...result, replayed: true }));
        }
      } catch (error) {
        return Promise.reject(error);
      }
      const entry = { account, amount, promise: null };
      inflight.set(key, entry);
      const run = async () => {
        try {
          if (authorize) {
            const approved = await authorize({ key, account, amount });
            if (approved !== true) throw fail('DECLINED');
          }
          const current = balances.get(account);
          if (current < amount) throw fail('INSUFFICIENT_FUNDS');
          balances.set(account, current - amount);
          const at = now();
          const result = { chargeId: `c${++counter}`, key, account, amount, balance: current - amount, replayed: false };
          records.set(key, { result, at });
          return { ...result };
        } finally {
          inflight.delete(key);
        }
      };
      entry.promise = run();
      return entry.promise;
    },
  };
}
