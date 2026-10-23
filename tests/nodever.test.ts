import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNodeTestCommand, nodeTestProblem, parseNodeVersion, planNodeTest, stripsTypes } from '../src/core/nodever.js';
import { detectStack } from '../src/core/stackdetect.js';

const v = (text: string) => parseNodeVersion(text)!;
const JUNIT = ['node', '--test', '--test-reporter=junit', '--test-reporter-destination=.aidept-report.xml'];

describe('node --test and the Node version', () => {
  it('parses versions and knows when .ts runs natively', () => {
    expect(v('v18.20.4')).toEqual({ major: 18, minor: 20, patch: 4 });
    expect(parseNodeVersion('nonsense')).toBeUndefined();
    expect(['v22.17.0', 'v23.5.0', 'v20.0.0'].map((s) => stripsTypes(v(s)))).toEqual([false, false, false]);
    expect(['v22.18.0', 'v23.6.0', 'v24.11.0'].map((s) => stripsTypes(v(s)))).toEqual([true, true, true]);
  });

  it('only concerns commands that start with node --test', () => {
    expect(isNodeTestCommand(['node', '--test', 'a.js'])).toBe(true);
    expect(isNodeTestCommand(['C:\\Program Files\\nodejs\\node.exe', '--test'])).toBe(true);
    expect(isNodeTestCommand(['npm', 'test'])).toBe(false);
    expect(nodeTestProblem(['npx', 'jest', '--test'], v('v18.0.0'))).toBeUndefined();
  });

  it('explains why Node 18 cannot run the reported "Could not find *.spec.ts" command', () => {
    const problem = nodeTestProblem([...JUNIT, 'backend/src/answers/*.spec.ts'], v('v18.19.0'));
    expect(problem).toMatch(/v18\.19\.0 quá cũ/);
    expect(problem).toMatch(/Node 21/);
  });

  it('needs Node 22.18 to run .ts files and stays quiet when the version is fine or unknown', () => {
    expect(nodeTestProblem(['node', '--test', 'tests/a.test.ts'], v('v22.12.0'))).toMatch(/\.ts/);
    expect(nodeTestProblem(['node', '--test', 'tests/a.test.ts'], v('v24.11.0'))).toBeUndefined();
    expect(nodeTestProblem(['node', '--test', 'tests/*.test.cjs'], v('v22.1.0'))).toBeUndefined();
    expect(nodeTestProblem([...JUNIT, 'tests/*.test.ts'], undefined)).toBeUndefined();
  });

  it('falls back to the Node running AI Department when PATH has an old one, and refuses when neither works', () => {
    const command = [...JUNIT, 'tests/*.test.cjs'];
    const fallback = planNodeTest(command, v('v18.0.0'), v('v24.11.0'), 'C:\\node24\\node.exe');
    expect(fallback.problem).toBeUndefined();
    expect(fallback.command[0]).toBe('C:\\node24\\node.exe');
    expect(fallback.command.slice(1)).toEqual(command.slice(1));
    expect(fallback.note).toMatch(/v18\.0\.0/);

    const none = planNodeTest(command, v('v18.0.0'), v('v20.0.0'), 'x');
    expect(none.problem).toMatch(/quá cũ/);
    expect(none.command).toEqual(command);

    const fine = planNodeTest(command, v('v24.0.0'), v('v24.0.0'), 'x');
    expect(fine).toEqual({ command });
  });
});

describe('detector and the Node version', () => {
  const repo = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidept-nodever-'));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), content);
    }
    return dir;
  };
  const pkg = (extra: Record<string, unknown>) => JSON.stringify({ name: 'demo', ...extra });

  it('does not recommend node --test on Node 18 and says why', async () => {
    const d = await detectStack(repo({ 'package.json': pkg({}), 'src/a.spec.ts': '' }), v('v18.20.0'));
    const test = d.checks.find((c) => c.id === 'test')!;
    expect(test.recommended).toBe(false);
    expect(test.reason).toMatch(/quá cũ/);
    expect(d.notes.join(' ')).toMatch(/Không gợi ý "node --test"/);
  });

  it('still recommends node --test on a new Node, and when the version is unknown', async () => {
    const dir = repo({ 'package.json': pkg({}), 'tests/a.test.cjs': '' });
    expect((await detectStack(dir, v('v24.11.0'))).checks.find((c) => c.id === 'test')!.recommended).toBe(true);
    expect((await detectStack(dir)).checks.find((c) => c.id === 'test')!.recommended).toBe(true);
  });

  it('suggests Jest or Vitest with a report when the repo has spec files and the runner but no test script', async () => {
    const jest = await detectStack(repo({ 'package.json': pkg({ devDependencies: { jest: '29' } }), 'src/a.spec.ts': '' }), v('v18.20.0'));
    expect(jest.checks.find((c) => c.id === 'test')!.command).toEqual(['npx', 'jest', '--json', '--outputFile=.aidept-report.json']);
    const vitest = await detectStack(repo({ 'package.json': pkg({ devDependencies: { vitest: '3' } }), 'src/a.spec.ts': '' }));
    expect(vitest.checks.find((c) => c.id === 'test')!.command.slice(0, 3)).toEqual(['npx', 'vitest', 'run']);
  });
});
