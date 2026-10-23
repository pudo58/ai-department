import { describe, expect, it } from 'vitest';
import { niceTicks, ROLE_COLOR } from '../src/client/MonitorCharts.js';

describe('cost chart', () => {
  it('labels the axis with round steps that cover the largest bar', () => {
    expect(niceTicks(18.513)).toEqual([0, 5, 10, 15, 20]);
    expect(niceTicks(0.0042)).toEqual([0, 0.002, 0.004, 0.006]);
    expect(niceTicks(118)).toEqual([0, 50, 100, 150]);
    expect(niceTicks(4)).toEqual([0, 1, 2, 3, 4]);
  });
  it('gives every role its own colour', () => {
    expect(new Set(Object.values(ROLE_COLOR)).size).toBe(Object.keys(ROLE_COLOR).length);
  });
});
