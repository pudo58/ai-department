// Hidden grader for Versions. It asserts only what SPEC.md decides.
import { describe, expect, it } from 'vitest';
import { compareVersions, maxVersion, parseVersion, sortVersions } from '../src/versions.js';

const code = (fn) => { try { fn(); } catch (error) { return error?.code ?? `NO_CODE:${error?.message}`; } return 'NO_ERROR'; };

describe('parseVersion', () => {
  it('parses the three numbers and empty arrays', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
    expect(parseVersion('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0, prerelease: [], build: [] });
    expect(parseVersion('10.20.30')).toMatchObject({ major: 10, minor: 20, patch: 30 });
  });
  it('accepts one leading v or V', () => {
    expect(parseVersion('v1.2.3').major).toBe(1);
    expect(parseVersion('V2.0.0').major).toBe(2);
  });
  it('turns numeric prerelease identifiers into numbers and keeps the others as strings', () => {
    expect(parseVersion('1.0.0-alpha.1').prerelease).toEqual(['alpha', 1]);
    expect(parseVersion('1.0.0-0.3.7').prerelease).toEqual([0, 3, 7]);
    expect(parseVersion('1.0.0-x-y.z').prerelease).toEqual(['x-y', 'z']);
    expect(parseVersion('1.0.0-1a.0').prerelease).toEqual(['1a', 0]);
  });
  it('keeps build identifiers as strings', () => {
    expect(parseVersion('1.0.0+001').build).toEqual(['001']);
    expect(parseVersion('1.0.0+build.5').build).toEqual(['build', '5']);
    const both = parseVersion('1.0.0-rc.1+exp.sha.5114f85');
    expect(both.prerelease).toEqual(['rc', 1]);
    expect(both.build).toEqual(['exp', 'sha', '5114f85']);
  });
  it('rejects anything that is not a version with INVALID_VERSION', () => {
    const bad = ['', '1', '1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03', '1.2.3-', '1.2.3-01', '1.2.3-a..b', '1.2.3+', '1.2.3+a..b', ' 1.2.3', '1.2.3 ', 'vv1.2.3', '1.2.x', '-1.2.3', '1.2.3-a_b', 'a.b.c'];
    for (const text of bad) expect(code(() => parseVersion(text)), JSON.stringify(text)).toBe('INVALID_VERSION');
    for (const value of [undefined, null, 5, {}]) expect(code(() => parseVersion(value)), String(value)).toBe('INVALID_VERSION');
  });
  it('allows numeric prerelease 0 but not leading zeros', () => {
    expect(parseVersion('1.0.0-0').prerelease).toEqual([0]);
    expect(code(() => parseVersion('1.0.0-00'))).toBe('INVALID_VERSION');
    expect(code(() => parseVersion('1.0.0-alpha.01'))).toBe('INVALID_VERSION');
  });
});

describe('compareVersions', () => {
  it('compares major, minor and patch numerically, not as text', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
  it('puts a prerelease below the same version without one', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.1-alpha', '1.0.0')).toBe(1);
  });
  it('follows the semver precedence example chain', () => {
    const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(compareVersions(chain[i], chain[i + 1]), `${chain[i]} < ${chain[i + 1]}`).toBe(-1);
      expect(compareVersions(chain[i + 1], chain[i])).toBe(1);
    }
  });
  it('compares numeric prerelease identifiers as numbers and puts them below alphanumeric ones', () => {
    expect(compareVersions('1.0.0-2', '1.0.0-10')).toBe(-1);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-1')).toBe(1);
    expect(compareVersions('1.0.0-1a', '1.0.0-2')).toBe(1);
  });
  it('compares alphanumeric identifiers in ASCII order, so uppercase comes first', () => {
    expect(compareVersions('1.0.0-B', '1.0.0-a')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-a-b', '1.0.0-a')).toBe(1);
  });
  it('lets the longer prerelease win when the shared identifiers are equal', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.0')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.1.2', '1.0.0-alpha.1')).toBe(1);
  });
  it('ignores build metadata and a leading v', () => {
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
    expect(compareVersions('1.0.0+zzz', '1.0.0')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('V1.2.4', 'v1.2.3')).toBe(1);
    expect(compareVersions('1.0.0-rc.1+x', '1.0.0-rc.1+y')).toBe(0);
  });
  it('throws INVALID_VERSION for an invalid operand on either side', () => {
    expect(code(() => compareVersions('1.0', '1.0.0'))).toBe('INVALID_VERSION');
    expect(code(() => compareVersions('1.0.0', 'nope'))).toBe('INVALID_VERSION');
  });
});

describe('sortVersions', () => {
  it('sorts ascending and returns the original strings', () => {
    const list = ['v1.10.0', '1.2.0', '1.2.0-rc.1', '0.9.9', '1.2.0-alpha', '2.0.0+build'];
    expect(sortVersions(list)).toEqual(['0.9.9', '1.2.0-alpha', '1.2.0-rc.1', '1.2.0', 'v1.10.0', '2.0.0+build']);
  });
  it('does not change the input and returns a new array', () => {
    const list = ['2.0.0', '1.0.0'];
    const copy = [...list];
    const sorted = sortVersions(list);
    expect(list).toEqual(copy);
    expect(sorted).not.toBe(list);
  });
  it('is stable for versions of equal precedence', () => {
    expect(sortVersions(['1.0.0+b', 'v1.0.0', '1.0.0+a', '0.1.0'])).toEqual(['0.1.0', '1.0.0+b', 'v1.0.0', '1.0.0+a']);
    expect(sortVersions(['1.0.0+a', '1.0.0+b'])).toEqual(['1.0.0+a', '1.0.0+b']);
  });
  it('handles empty and single-element lists, and throws for an invalid entry', () => {
    expect(sortVersions([])).toEqual([]);
    expect(sortVersions(['1.0.0'])).toEqual(['1.0.0']);
    expect(code(() => sortVersions(['1.0.0', 'bad']))).toBe('INVALID_VERSION');
  });
});

describe('maxVersion', () => {
  it('returns the original string of the highest version', () => {
    expect(maxVersion(['1.0.0', 'v2.1.0', '2.0.9', '2.1.0-rc.1'])).toBe('v2.1.0');
    expect(maxVersion(['1.0.0-beta', '1.0.0-alpha'])).toBe('1.0.0-beta');
  });
  it('returns the first of several equal maxima', () => {
    expect(maxVersion(['1.0.0+b', '1.0.0+a', 'v1.0.0'])).toBe('1.0.0+b');
    expect(maxVersion(['0.1.0', 'v1.0.0', '1.0.0+x'])).toBe('v1.0.0');
  });
  it('returns null for an empty list and throws for an invalid entry', () => {
    expect(maxVersion([])).toBeNull();
    expect(code(() => maxVersion(['1.0.0', '1']))).toBe('INVALID_VERSION');
  });
});
