// Hidden grader for Slugify. It asserts only what SPEC.md decides.
import { describe, expect, it } from 'vitest';
import { slugify } from '../src/slugify.js';

const code = (fn) => { try { fn(); } catch (error) { return error?.code ?? `NO_CODE:${error?.message}`; } return 'NO_ERROR'; };

describe('validation', () => {
  it('rejects a non-string input', () => {
    for (const input of [undefined, null, 5, {}, ['a']]) expect(code(() => slugify(input)), String(input)).toBe('INVALID_INPUT');
  });
  it('rejects an invalid maxLength or separator', () => {
    for (const maxLength of [0, -1, 1.5, '10', Number.NaN]) expect(code(() => slugify('a', { maxLength })), String(maxLength)).toBe('INVALID_INPUT');
    for (const separator of ['.', '--', '', ' ', 1]) expect(code(() => slugify('a', { separator })), String(separator)).toBe('INVALID_INPUT');
  });
});

describe('normalisation', () => {
  it('lower-cases and joins words with a separator', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('HELLO')).toBe('hello');
  });
  it('removes diacritics by decomposition', () => {
    expect(slugify('Crème Brûlée')).toBe('creme-brulee');
    expect(slugify('Åsa Öberg')).toBe('asa-oberg');
    expect(slugify('Ngô Quyền')).toBe('ngo-quyen');
    expect(slugify('Nguyễn Thị')).toBe('nguyen-thi');
  });
  it('applies compatibility decomposition (NFKD)', () => {
    expect(slugify('ﬁle №1')).toBe('file-no1');
    expect(slugify('Ａｂｃ')).toBe('abc');
  });
  it('treats non-ASCII characters that do not decompose as separators', () => {
    expect(slugify('Đà Nẵng')).toBe('a-nang');
    expect(slugify('straße')).toBe('stra-e');
    expect(slugify('日本語 text')).toBe('text');
  });
});

describe('separators', () => {
  it('collapses every run of other characters into exactly one separator', () => {
    expect(slugify('a   b')).toBe('a-b');
    expect(slugify('a - b')).toBe('a-b');
    expect(slugify('a!@#$%^&*()b')).toBe('a-b');
    expect(slugify('a--__--b')).toBe('a-b');
    expect(slugify("it's 100% fun")).toBe('it-s-100-fun');
  });
  it('keeps digits', () => {
    expect(slugify('Top 10 of 2024')).toBe('top-10-of-2024');
    expect(slugify('a1b2')).toBe('a1b2');
  });
  it('trims separators at both ends', () => {
    expect(slugify('  hello  ')).toBe('hello');
    expect(slugify('--hello--')).toBe('hello');
    expect(slugify('!!!hello???')).toBe('hello');
  });
  it('uses the chosen separator', () => {
    expect(slugify('Hello World, again', { separator: '_' })).toBe('hello_world_again');
    expect(slugify('a-b', { separator: '_' })).toBe('a_b');
    expect(slugify('a_b', { separator: '-' })).toBe('a-b');
    expect(slugify('__x__', { separator: '_' })).toBe('x');
  });
  it('never emits two separators in a row', () => {
    for (const text of ['a  -  _  b', 'x...y...z', ' - ', '__a__b__', 'é-é']) expect(slugify(text)).not.toMatch(/--|__/);
  });
});

describe('empty results', () => {
  it('returns an empty string when nothing is left', () => {
    for (const text of ['', '   ', '---', '日本語', '!!!', '___']) expect(slugify(text), JSON.stringify(text)).toBe('');
  });
});

describe('maxLength', () => {
  it('leaves a slug that fits untouched, including exactly maxLength', () => {
    expect(slugify('hello world', { maxLength: 11 })).toBe('hello-world');
    expect(slugify('hello', { maxLength: 5 })).toBe('hello');
  });
  it('cuts to maxLength characters without looking for word boundaries', () => {
    expect(slugify('hello wonderful world', { maxLength: 8 })).toBe('hello-wo');
    expect(slugify('abcdefghij', { maxLength: 4 })).toBe('abcd');
  });
  it('removes a separator left at the end by the cut', () => {
    expect(slugify('hello world', { maxLength: 6 })).toBe('hello');
    expect(slugify('ab cd', { maxLength: 3 })).toBe('ab');
    expect(slugify('a b c d', { maxLength: 4 })).toBe('a-b');
    expect(slugify('hello world', { maxLength: 6, separator: '_' })).toBe('hello');
  });
  it('uses 80 as the default maxLength', () => {
    const long = 'x'.repeat(100);
    expect(slugify(long)).toBe('x'.repeat(80));
    expect(slugify('y'.repeat(79) + ' ' + 'z'.repeat(10))).toBe('y'.repeat(79));
  });
  it('keeps a single-character limit working', () => {
    expect(slugify('a b', { maxLength: 1 })).toBe('a');
    expect(slugify('-a', { maxLength: 1 })).toBe('a');
  });
});
