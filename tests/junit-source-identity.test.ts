import { describe, expect, it } from 'vitest';
import { parseJUnit, summarizeCheck } from '../src/core/checks.js';
import { identityId } from '../src/core/testids.js';
import type { Recipe } from '../src/shared/types.js';

const recipe = { id: 'test', command: ['node', '--test'], required: true, timeoutMs: 1000, reportPath: '.aidept-report.xml' } as Recipe;
const WIN = 'C:\\Users\\me\\.data\\workspaces\\run_x-A';
const green = { exitCode: 0, log: '', incomplete: false, durationMs: 1, checkpoint: 'cp' };

/** What `node --test --test-reporter=junit` writes: a file-level test with no suite, and one suite per describe block. */
const xml = (root = WIN) => `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="plain top-level test" time="0.1" classname="test" file="${root}\\tests\\a.test.mjs"/>
	<testsuite name="Library groups renders by film" time="3" disabled="0" errors="0" tests="2" failures="0" skipped="0">
		<testcase name="[R-1][C-1] grouped &amp; counted" time="0.3" classname="Library groups renders by film" file="${root}\\tests\\library.test.mjs"/>
		<testsuite name="when the source fails" time="1" tests="1">
			<testcase name="[R-4][C-8] stays reachable" time="0.2" classname="when the source fails" file="${root}\\tests\\library.test.mjs"/>
		</testsuite>
	</testsuite>
	<testsuite name="empty suite" tests="0"/>
	<testcase name="after the empty suite" time="0.1" classname="test" file="${root}\\tests\\b.test.mjs"/>
</testsuites>`;

describe('a node:test JUnit report meets the tests a source binding locked', () => {
  it('names each test by its file and describe titles, as the source binding does', () => {
    const { tests } = parseJUnit(xml());
    expect(tests.map(t => t.identity)).toEqual([
      { kind: 'json', file: `${WIN}\\tests\\a.test.mjs`, titles: ['plain top-level test'] },
      { kind: 'json', file: `${WIN}\\tests\\library.test.mjs`, titles: ['Library groups renders by film', '[R-1][C-1] grouped & counted'] },
      { kind: 'json', file: `${WIN}\\tests\\library.test.mjs`, titles: ['Library groups renders by film', 'when the source fails', '[R-4][C-8] stays reachable'] },
      { kind: 'json', file: `${WIN}\\tests\\b.test.mjs`, titles: ['after the empty suite'] },
    ]);
  });

  it.each([['a Windows workspace', WIN], ['a Docker workspace', '/workspace']])('finds every locked test, relative to %s, with no test missing', (_n, root) => {
    const locked = [
      identityId({ kind: 'json', file: 'tests/library.test.mjs', titles: ['Library groups renders by film', '[R-1][C-1] grouped & counted'] }),
      identityId({ kind: 'json', file: 'tests/library.test.mjs', titles: ['Library groups renders by film', 'when the source fails', '[R-4][C-8] stays reachable'] }),
    ];
    const report = xml(root).replace(/\\tests\\/g, root === WIN ? '\\tests\\' : '/tests/');
    const check = summarizeCheck({ runId: 'r', id: 'c', recipe, checkpoint: 'cp', contractVersion: 1, lockedTestIds: locked, structuredIds: true, reportRoot: root }, [{ ...green, report }]);
    expect((check.issues ?? []).filter(i => i.kind === 'test_missing')).toEqual([]);
    expect(check.status).toBe('passed');
    expect(check.testIds).toEqual(expect.arrayContaining(locked));
  });

  it('still reports a locked test that the run did not execute', () => {
    const locked = [identityId({ kind: 'json', file: 'tests/library.test.mjs', titles: ['Library groups renders by film', 'never written'] })];
    const check = summarizeCheck({ runId: 'r', id: 'c', recipe, checkpoint: 'cp', contractVersion: 1, lockedTestIds: locked, structuredIds: true, reportRoot: WIN }, [{ ...green, report: xml() }]);
    expect((check.issues ?? []).map(i => i.kind)).toContain('test_missing');
  });

  it('keeps the classname identity for a reporter that names no file', () => {
    const { tests } = parseJUnit('<testsuites><testsuite name="s"><testcase name="t" classname="e2e/x.spec.ts"/></testsuite></testsuites>');
    expect(tests[0]!.identity).toEqual({ kind: 'junit', className: 'e2e/x.spec.ts', name: 't' });
  });
});
