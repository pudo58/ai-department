import { describe, expect, it } from 'vitest';
import { clampPage, pageCount, pageList, pageSlice } from '../src/client/paging.js';

describe('table paging', () => {
  it('counts pages and keeps the page in range after rows disappear', () => {
    expect(pageCount(0, 10)).toBe(1);
    expect(pageCount(10, 10)).toBe(1);
    expect(pageCount(11, 10)).toBe(2);
    expect(clampPage(3, 11, 10)).toBe(2); // the last row of page 3 was deleted
    expect(clampPage(0, 50, 10)).toBe(1);
    expect(clampPage(Number.NaN, 50, 10)).toBe(1);
  });

  it('slices the rows of one page', () => {
    const rows = Array.from({ length: 23 }, (_, i) => i);
    expect(pageSlice(rows, 1, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pageSlice(rows, 3, 10)).toEqual([20, 21, 22]);
    expect(pageSlice(rows, 9, 10)).toEqual([20, 21, 22]);
    expect(pageSlice([], 1, 10)).toEqual([]);
  });

  it('lists every page when there are few, and elides the middle when there are many', () => {
    expect(pageList(1, 1)).toEqual([1]);
    expect(pageList(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pageList(1, 20)).toEqual([1, 2, '…', 19, 20]);
    expect(pageList(10, 20)).toEqual([1, 2, '…', 9, 10, 11, '…', 19, 20]);
    expect(pageList(4, 20)).toEqual([1, 2, 3, 4, 5, '…', 19, 20]);
    expect(pageList(20, 20)).toEqual([1, 2, '…', 19, 20]);
  });
});
