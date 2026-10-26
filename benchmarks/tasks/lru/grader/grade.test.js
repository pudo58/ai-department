// Hidden grader for LruCache. It asserts only what SPEC.md decides.
import { describe, expect, it } from 'vitest';
import { createLru } from '../src/lru.js';

const code = (fn) => { try { fn(); } catch (error) { return error?.code ?? `NO_CODE:${error?.message}`; } return 'NO_ERROR'; };

describe('validation', () => {
  it('rejects an invalid capacity or onEvict', () => {
    for (const capacity of [undefined, 0, -1, 1.5, '2', Number.NaN]) expect(code(() => createLru({ capacity })), String(capacity)).toBe('INVALID_INPUT');
    expect(code(() => createLru())).toBe('INVALID_INPUT');
    expect(code(() => createLru({ capacity: 2, onEvict: 'nope' }))).toBe('INVALID_INPUT');
    expect(code(() => createLru({ capacity: 2, onEvict: undefined }))).toBe('NO_ERROR');
  });
});

describe('basic operations', () => {
  it('stores and returns values, undefined for a missing key', () => {
    const c = createLru({ capacity: 3 });
    c.set('a', 1).set('b', 2);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBe(2);
    expect(c.get('zzz')).toBeUndefined();
    expect(c.size).toBe(2);
  });
  it('returns the cache itself from set so calls chain', () => {
    const c = createLru({ capacity: 2 });
    expect(c.set('a', 1)).toBe(c);
  });
  it('replaces the value of an existing key without growing', () => {
    const c = createLru({ capacity: 2 });
    c.set('a', 1).set('a', 2);
    expect(c.get('a')).toBe(2);
    expect(c.size).toBe(1);
  });
  it('compares keys like a Map: strict equality, NaN equal to NaN', () => {
    const c = createLru({ capacity: 5 });
    const object = {};
    c.set(1, 'number').set('1', 'string').set(object, 'object').set(Number.NaN, 'nan');
    expect(c.get(1)).toBe('number');
    expect(c.get('1')).toBe('string');
    expect(c.get(object)).toBe('object');
    expect(c.get({})).toBeUndefined();
    expect(c.get(Number.NaN)).toBe('nan');
  });
  it('can store undefined, and has tells it from a missing key', () => {
    const c = createLru({ capacity: 2 });
    c.set('u', undefined);
    expect(c.has('u')).toBe(true);
    expect(c.has('missing')).toBe(false);
    expect(c.get('u')).toBeUndefined();
    expect(c.size).toBe(1);
  });
  it('deletes and reports whether the key was present', () => {
    const c = createLru({ capacity: 2 });
    c.set('a', 1);
    expect(c.delete('a')).toBe(true);
    expect(c.delete('a')).toBe(false);
    expect(c.has('a')).toBe(false);
    expect(c.size).toBe(0);
  });
  it('clears everything', () => {
    const c = createLru({ capacity: 3 });
    c.set('a', 1).set('b', 2);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.keys()).toEqual([]);
    expect(c.get('a')).toBeUndefined();
  });
  it('has a read-only size property', () => {
    const c = createLru({ capacity: 3 });
    c.set('a', 1);
    expect(typeof c.size).toBe('number');
    try { c.size = 99; } catch { /* strict mode may throw */ }
    expect(c.size).toBe(1);
  });
});

describe('recency and eviction', () => {
  it('evicts the least recently used entry when a new key exceeds the capacity', () => {
    const c = createLru({ capacity: 2 });
    c.set('a', 1).set('b', 2).set('c', 3);
    expect(c.has('a')).toBe(false);
    expect(c.keys()).toEqual(['c', 'b']);
    expect(c.size).toBe(2);
  });
  it('lists keys from the most to the least recently used', () => {
    const c = createLru({ capacity: 4 });
    c.set('a', 1).set('b', 2).set('c', 3);
    expect(c.keys()).toEqual(['c', 'b', 'a']);
  });
  it('returns a new array from keys', () => {
    const c = createLru({ capacity: 2 });
    c.set('a', 1);
    const keys = c.keys();
    keys.push('hacked');
    expect(c.keys()).toEqual(['a']);
  });
  it('refreshes an entry on get', () => {
    const c = createLru({ capacity: 2 });
    c.set('a', 1).set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(c.keys()).toEqual(['c', 'a']);
  });
  it('refreshes an entry when its value is replaced, and evicts nothing', () => {
    const evicted = [];
    const c = createLru({ capacity: 2, onEvict: (k) => evicted.push(k) });
    c.set('a', 1).set('b', 2);
    c.set('a', 10);
    expect(evicted).toEqual([]);
    expect(c.keys()).toEqual(['a', 'b']);
    c.set('c', 3);
    expect(evicted).toEqual(['b']);
  });
  it('does not refresh on peek or has', () => {
    const c = createLru({ capacity: 2 });
    c.set('a', 1).set('b', 2);
    expect(c.peek('a')).toBe(1);
    expect(c.has('a')).toBe(true);
    expect(c.keys()).toEqual(['b', 'a']);
    c.set('c', 3);
    expect(c.has('a')).toBe(false);
  });
  it('peek returns undefined for a missing key', () => {
    expect(createLru({ capacity: 1 }).peek('x')).toBeUndefined();
  });
  it('does not refresh when get misses', () => {
    const c = createLru({ capacity: 2 });
    c.set('a', 1).set('b', 2);
    c.get('nope');
    expect(c.keys()).toEqual(['b', 'a']);
  });
  it('works with a capacity of one', () => {
    const c = createLru({ capacity: 1 });
    c.set('a', 1).set('b', 2);
    expect(c.keys()).toEqual(['b']);
    expect(c.get('a')).toBeUndefined();
  });
  it('frees room by delete without evicting', () => {
    const evicted = [];
    const c = createLru({ capacity: 2, onEvict: (k) => evicted.push(k) });
    c.set('a', 1).set('b', 2);
    c.delete('a');
    c.set('c', 3);
    expect(evicted).toEqual([]);
    expect(c.keys()).toEqual(['c', 'b']);
  });
});

describe('onEvict', () => {
  it('is called once per eviction with the removed key and value, in order', () => {
    const calls = [];
    const c = createLru({ capacity: 2, onEvict: (key, value) => calls.push([key, value]) });
    c.set('a', 1).set('b', 2).set('c', 3).set('d', 4);
    expect(calls).toEqual([['a', 1], ['b', 2]]);
  });
  it('is called after the removal, so size is already back to the capacity', () => {
    const seen = [];
    let cache;
    cache = createLru({ capacity: 2, onEvict: (key) => seen.push({ key, size: cache.size, has: cache.has(key), keys: cache.keys() }) });
    cache.set('a', 1).set('b', 2).set('c', 3);
    expect(seen).toEqual([{ key: 'a', size: 2, has: false, keys: ['c', 'b'] }]);
  });
  it('is not called by delete, clear or replacing a value', () => {
    const calls = [];
    const c = createLru({ capacity: 3, onEvict: (key) => calls.push(key) });
    c.set('a', 1).set('b', 2);
    c.set('a', 3);
    c.delete('b');
    c.clear();
    expect(calls).toEqual([]);
  });
  it('reports the entry the eviction removed after a get changed the order', () => {
    const calls = [];
    const c = createLru({ capacity: 2, onEvict: (key, value) => calls.push([key, value]) });
    c.set('a', 1).set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect(calls).toEqual([['b', 2]]);
  });
});
