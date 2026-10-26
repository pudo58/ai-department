# LruCache — a bounded least-recently-used cache

Implement `src/lru.js` exporting `createLru({ capacity, onEvict } = {})`. All methods are synchronous.

1. `capacity` must be a positive safe integer and `onEvict`, if given, a function. Otherwise `createLru` throws an `Error` whose `code` is `INVALID_INPUT`.
2. `set(key, value)` stores the value under `key` and marks `key` as the most recently used. Keys are compared like `Map` keys (strict equality, with `NaN` equal to `NaN`). It returns the cache itself so calls can be chained. Setting an existing key replaces its value and never evicts anything.
3. When `set` adds a new key and the cache then holds more than `capacity` entries, the least recently used entry is removed, and `onEvict(key, value)` is called once for it with the removed key and its value. `onEvict` is called after the removal is complete (so `size` is already back to `capacity` inside the callback) and is called for no other reason: not for `delete`, `clear`, or replacing a value.
4. `get(key)` returns the value, or `undefined` if the key is absent, and marks the key as the most recently used when it is present.
5. `peek(key)` returns the value like `get` but does not change the recency order. `has(key)` returns a boolean and does not change the order either.
6. `delete(key)` removes the key and returns `true`, or returns `false` if it was absent.
7. `size` is a read-only property with the number of entries. `keys()` returns a new array of the keys from the most recently used to the least recently used. `clear()` removes every entry without calling `onEvict`.
8. A stored value may be any value, including `undefined`; `has` tells it apart from a missing key.

Keep the source compact, use the public API in tests, and do not add behavior beyond this contract.
