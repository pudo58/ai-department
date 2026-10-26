// Hidden grader for Ranges. It asserts only what SPEC.md decides.
import { describe, expect, it } from 'vitest';
import { contains, gaps, mergeRanges, totalLength } from '../src/ranges.js';

const code = (fn) => { try { fn(); } catch (error) { return error?.code ?? `NO_CODE:${error?.message}`; } return 'NO_ERROR'; };
const BAD_RANGES = [[1], [1, 2, 3], [2, 1], [1.5, 2], ['1', 2], [undefined, 2], 'range', null, [Number.MAX_SAFE_INTEGER + 2, Number.MAX_SAFE_INTEGER + 3]];

describe('validation', () => {
  it('rejects a non-array list and malformed ranges in every function', () => {
    for (const fn of [mergeRanges, totalLength]) {
      expect(code(() => fn('nope')), fn.name).toBe('INVALID_RANGE');
      expect(code(() => fn(undefined)), fn.name).toBe('INVALID_RANGE');
      for (const bad of BAD_RANGES) expect(code(() => fn([[1, 2], bad])), `${fn.name} ${JSON.stringify(bad)}`).toBe('INVALID_RANGE');
    }
    for (const bad of BAD_RANGES) {
      expect(code(() => contains([bad], 1)), JSON.stringify(bad)).toBe('INVALID_RANGE');
      expect(code(() => gaps([bad], [0, 5])), JSON.stringify(bad)).toBe('INVALID_RANGE');
      expect(code(() => gaps([], bad)), `bounds ${JSON.stringify(bad)}`).toBe('INVALID_RANGE');
    }
    expect(code(() => contains('x', 1))).toBe('INVALID_RANGE');
  });
  it('rejects a non-integer n in contains', () => {
    for (const n of [1.5, '1', undefined, null, Number.NaN]) expect(code(() => contains([[0, 5]], n)), String(n)).toBe('INVALID_RANGE');
  });
  it('accepts a single-point range and an empty list', () => {
    expect(code(() => mergeRanges([[3, 3]]))).toBe('NO_ERROR');
    expect(code(() => mergeRanges([]))).toBe('NO_ERROR');
  });
});

describe('mergeRanges', () => {
  it('returns an empty list for an empty list', () => {
    expect(mergeRanges([])).toEqual([]);
  });
  it('merges overlapping ranges', () => {
    expect(mergeRanges([[1, 5], [3, 8]])).toEqual([[1, 8]]);
    expect(mergeRanges([[1, 10], [2, 3]])).toEqual([[1, 10]]);
  });
  it('merges ranges that share an endpoint', () => {
    expect(mergeRanges([[1, 3], [3, 6]])).toEqual([[1, 6]]);
  });
  it('merges adjacent ranges (next integer) but not ranges with a gap', () => {
    expect(mergeRanges([[1, 3], [4, 6]])).toEqual([[1, 6]]);
    expect(mergeRanges([[4, 6], [1, 3]])).toEqual([[1, 6]]);
    expect(mergeRanges([[1, 3], [5, 6]])).toEqual([[1, 3], [5, 6]]);
  });
  it('sorts the result by start and handles unsorted input', () => {
    expect(mergeRanges([[10, 12], [1, 2], [5, 6], [3, 4]])).toEqual([[1, 6], [10, 12]]);
    expect(mergeRanges([[20, 30], [0, 5], [10, 15]])).toEqual([[0, 5], [10, 15], [20, 30]]);
  });
  it('chains merges across several ranges', () => {
    expect(mergeRanges([[1, 2], [3, 4], [5, 6], [7, 8]])).toEqual([[1, 8]]);
    expect(mergeRanges([[8, 9], [1, 4], [3, 7]])).toEqual([[1, 9]]);
  });
  it('keeps the larger end when a later range is inside an earlier one', () => {
    expect(mergeRanges([[1, 100], [2, 3], [50, 60], [101, 102]])).toEqual([[1, 102]]);
  });
  it('handles duplicates, single points and negative numbers', () => {
    expect(mergeRanges([[5, 5], [5, 5]])).toEqual([[5, 5]]);
    expect(mergeRanges([[-5, -1], [0, 3]])).toEqual([[-5, 3]]);
    expect(mergeRanges([[-10, -8], [-3, -1]])).toEqual([[-10, -8], [-3, -1]]);
  });
  it('does not change the input and returns new arrays', () => {
    const input = [[5, 8], [1, 3], [2, 4]];
    const copy = JSON.parse(JSON.stringify(input));
    const out = mergeRanges(input);
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
    out[0][0] = 999;
    expect(input).toEqual(copy);
    const single = [[1, 2]];
    const result = mergeRanges(single);
    expect(result[0]).not.toBe(single[0]);
  });
  it('leaves nothing mergeable in the result', () => {
    const result = mergeRanges([[1, 2], [10, 11], [3, 4], [12, 13], [20, 21]]);
    for (let i = 0; i < result.length - 1; i++) expect(result[i + 1][0]).toBeGreaterThan(result[i][1] + 1);
  });
});

describe('totalLength', () => {
  it('counts distinct integers, closed on both ends', () => {
    expect(totalLength([])).toBe(0);
    expect(totalLength([[5, 5]])).toBe(1);
    expect(totalLength([[1, 3]])).toBe(3);
    expect(totalLength([[-2, 2]])).toBe(5);
  });
  it('counts overlapping integers once', () => {
    expect(totalLength([[1, 5], [3, 8]])).toBe(8);
    expect(totalLength([[1, 10], [2, 3], [4, 4]])).toBe(10);
    expect(totalLength([[1, 3], [4, 6]])).toBe(6);
    expect(totalLength([[1, 3], [5, 6]])).toBe(5);
  });
});

describe('contains', () => {
  it('is inclusive on both ends', () => {
    const list = [[1, 3], [10, 12]];
    for (const n of [1, 2, 3, 10, 11, 12]) expect(contains(list, n), String(n)).toBe(true);
    for (const n of [0, 4, 9, 13, -5]) expect(contains(list, n), String(n)).toBe(false);
  });
  it('works on unsorted and overlapping lists and on an empty list', () => {
    expect(contains([[50, 60], [1, 100], [5, 6]], 99)).toBe(true);
    expect(contains([], 0)).toBe(false);
    expect(contains([[7, 7]], 7)).toBe(true);
  });
});

describe('gaps', () => {
  it('returns the uncovered stretches inside the bounds', () => {
    expect(gaps([[3, 4], [8, 9]], [0, 10])).toEqual([[0, 2], [5, 7], [10, 10]]);
  });
  it('returns the whole bounds when nothing is covered', () => {
    expect(gaps([], [2, 6])).toEqual([[2, 6]]);
    expect(gaps([[20, 30]], [2, 6])).toEqual([[2, 6]]);
  });
  it('returns an empty list when everything is covered', () => {
    expect(gaps([[0, 10]], [2, 6])).toEqual([]);
    expect(gaps([[0, 4], [5, 10]], [2, 6])).toEqual([]);
  });
  it('is closed at both bounds', () => {
    expect(gaps([[1, 9]], [0, 10])).toEqual([[0, 0], [10, 10]]);
    expect(gaps([[0, 0], [10, 10]], [0, 10])).toEqual([[1, 9]]);
    expect(gaps([], [5, 5])).toEqual([[5, 5]]);
    expect(gaps([[5, 5]], [5, 5])).toEqual([]);
  });
  it('ignores ranges outside the bounds and clips ranges that cross them', () => {
    expect(gaps([[-10, 2], [8, 20]], [0, 10])).toEqual([[3, 7]]);
    expect(gaps([[-5, -1], [11, 15]], [0, 10])).toEqual([[0, 10]]);
  });
  it('handles unsorted, overlapping and adjacent input', () => {
    expect(gaps([[7, 8], [1, 3], [2, 5], [4, 6]], [0, 10])).toEqual([[0, 0], [9, 10]]);
    expect(gaps([[3, 3], [5, 5], [7, 7]], [3, 7])).toEqual([[4, 4], [6, 6]]);
  });
  it('does not change its input', () => {
    const list = [[5, 6], [1, 2]];
    const copy = JSON.parse(JSON.stringify(list));
    gaps(list, [0, 10]);
    expect(list).toEqual(copy);
  });
});
