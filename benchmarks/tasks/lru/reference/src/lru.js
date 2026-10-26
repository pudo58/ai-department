function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function createLru({ capacity, onEvict } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity <= 0 || (onEvict !== undefined && typeof onEvict !== 'function')) throw fail('INVALID_INPUT');
  const map = new Map();
  const cache = {
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      if (map.size > capacity) {
        const [oldestKey, oldestValue] = map.entries().next().value;
        map.delete(oldestKey);
        if (onEvict) onEvict(oldestKey, oldestValue);
      }
      return cache;
    },
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    peek: (key) => map.get(key),
    has: (key) => map.has(key),
    delete: (key) => map.delete(key),
    get size() { return map.size; },
    keys: () => [...map.keys()].reverse(),
    clear() { map.clear(); },
  };
  return cache;
}
