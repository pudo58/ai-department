import { describe, expect, it } from 'vitest';
import { folderName, formatCommandLine, parseCommandLine } from '../src/client/argv.js';

describe('command lines in the project form', () => {
  it('splits a plain command line, keeping quoted spaces together', () => {
    expect(parseCommandLine('npm ci')).toEqual(['npm', 'ci']);
    expect(parseCommandLine('  npm   run dev -- --port 3000 ')).toEqual(['npm', 'run', 'dev', '--', '--port', '3000']);
    expect(parseCommandLine('node "my server.mjs" \'a b\'')).toEqual(['node', 'my server.mjs', 'a b']);
    expect(parseCommandLine('echo ""')).toEqual(['echo', '']);
    expect(parseCommandLine('')).toEqual([]);
  });

  it('still accepts a JSON array and rejects broken input with a message', () => {
    expect(parseCommandLine('["npm", "ci"]')).toEqual(['npm', 'ci']);
    expect(parseCommandLine('[]')).toEqual([]);
    expect(() => parseCommandLine('["npm", 1]')).toThrow(/mảng các chuỗi/);
    expect(() => parseCommandLine('[npm')).toThrow(/JSON/);
    expect(() => parseCommandLine('node "unclosed')).toThrow(/dấu nháy/);
  });

  it('formats argv back into the same command line', () => {
    for (const argv of [['npm', 'ci'], ['node', 'my server.mjs'], ['echo', ''], ['say', 'he said "hi"']]) {
      expect(parseCommandLine(formatCommandLine(argv))).toEqual(argv);
    }
    expect(formatCommandLine(['npm', 'run', 'dev'])).toBe('npm run dev');
  });

  it('takes the folder name from Windows and POSIX paths', () => {
    expect(folderName('C:\\Users\\me\\Desktop\\customer-portal')).toBe('customer-portal');
    expect(folderName('C:\\Users\\me\\portal\\')).toBe('portal');
    expect(folderName('/home/me/app/')).toBe('app');
    expect(folderName('')).toBe('');
  });
});
