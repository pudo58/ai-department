import path from 'node:path';
import type { Artifact, Finding, ProjectProfile, Recipe, Run } from '../shared/types.js';
import type { FindingReplay, FindingReproduction, JsonValue } from '../shared/reproduction.js';
import {
  DEFAULT_REGRESSION_DIR, type PendingRegression, type RegressionManifest, type RegressionProposal, type RegressionRef, type RegressionReceipt,
} from '../shared/regression.js';
import type { TestIdentity } from '../shared/quality.js';
import { hashContract, sha256 } from './contract.js';
import { identityId } from './testids.js';
import { isSafeRelative } from './scope.js';
import { replayConfigHash, scenarioHash } from './reproduction.js';

export const REGRESSION_PROPOSAL_TITLE = 'Regression proposal';
export const REGRESSION_RECEIPT_TITLE = 'Regression receipt';
export const REGRESSION_MANIFEST_TITLE = 'Regression manifest';
export const REGRESSION_DESCRIBE = 'AI Department regression';
export const REGRESSION_FAILURE_TAG = 'AIDEPT-REG';
const HEADER = '// aidept-regression ';

export const regressionDirOf = (project: Pick<ProjectProfile, 'regressionDir'>): string => (project.regressionDir?.trim() || DEFAULT_REGRESSION_DIR).replace(/\\/g, '/').replace(/\/+$/, '');

/** Why the project cannot host generated regressions, or the one Vitest check that runs them. */
export function regressionRecipe(project: Pick<ProjectProfile, 'checks' | 'regressionDir' | 'regressionRecipe'>): { recipe: Recipe } | { unsupported: string } {
  const dir = regressionDirOf(project);
  if (!isSafeRelative(dir) || /[*?]/.test(dir)) return { unsupported: `Thư mục regression "${dir}" phải là đường dẫn tương đối nằm trong repo.` };
  const vitest = project.checks.filter(c => c.reportPath && c.command.includes('run') && c.command.some(arg => /(^|[\\/])vitest(\.m?js)?$/.test(arg)));
  const chosen = project.regressionRecipe ? vitest.filter(c => c.id === project.regressionRecipe) : vitest;
  if (!chosen.length) return { unsupported: project.regressionRecipe ? `Check "${project.regressionRecipe}" không phải check Vitest có report JSON.` : 'Project chưa có check Vitest (lệnh "vitest run" có reportPath) nên chưa sinh được test regression tự động.' };
  if (chosen.length > 1) return { unsupported: `Project có nhiều check Vitest (${chosen.map(c => c.id).join(', ')}); chọn một ở Sửa project → regressionRecipe.` };
  return { recipe: chosen[0]! };
}

const clean = (text: string, max: number): string => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').replace(/\[/g, '(').replace(/\]/g, ')').trim().slice(0, max);
const slug = (text: string): string => text.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'api';

export function regressionTitle(finding: Pick<Finding, 'id' | 'title'>): string { return `[REG-${finding.id}] ${clean(finding.title, 120)}`; }
export const regressionIdentity = (file: string, title: string): TestIdentity => ({ kind: 'json', file, titles: [REGRESSION_DESCRIBE, title] });

/** Source text of an argument: JSON, except that a reference to an earlier result becomes a lookup in this test's own record. */
function expr(value: JsonValue | { $ref: string; path?: string[] }): string {
  if (Array.isArray(value)) return `[${value.map(v => expr(v)).join(', ')}]`;
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '$ref')) { const r = value as { $ref: string; path?: string[] }; return `ref(${JSON.stringify(r.$ref)}, ${JSON.stringify(r.path ?? [])})`; }
    return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${expr(v as JsonValue)}`).join(', ')} }`;
  }
  return JSON.stringify(value) ?? 'null';
}

const HELPERS = `const BLOCKED = new Set(['__proto__', 'prototype', 'constructor']);
const outcomes = new Map();
const at = (value, parts) => { for (const part of parts) { if (BLOCKED.has(part)) throw new Error('Unsafe property'); value = value == null ? undefined : value[part]; } return value; };
const safe = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const ref = (id, parts) => safe(at(outcomes.get(id)?.value, parts));
const call = async (instance, method, args) => { try { return { value: await instance[method](...args) }; } catch (error) { return { error }; } };
const verify = (id, outcome, expected) => {
  const observed = outcome.error ? String(outcome.error.code ?? outcome.error.name) : at(outcome.value, expected.path);
  if (Object.hasOwn(expected, 'throwsCode')) {
    expect(outcome.error !== undefined, \`${REGRESSION_FAILURE_TAG}:\${id} phải throw\`).toBe(true);
    expect(observed, \`${REGRESSION_FAILURE_TAG}:\${id}\`).toBe(expected.throwsCode);
  } else {
    expect(outcome.error, \`${REGRESSION_FAILURE_TAG}:\${id} không được throw\`).toBeUndefined();
    expect(observed, \`${REGRESSION_FAILURE_TAG}:\${id}\`).toStrictEqual(expected.equals);
  }
};`;

export interface GeneratedRegression { path: string; source: string; testHash: string; title: string; identity: TestIdentity; testId: string; patch: string }

/** The same unified diff `git diff` would show for a new file, so it can be read in the UI and applied by `git apply`. */
export function newFilePatch(file: string, content: string): string {
  const text = content.endsWith('\n') ? content : `${content}\n`;
  const lines = text.slice(0, -1).split('\n');
  return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`;
}

/**
 * The regression test for one reproduced counterexample, written by code from the scenario the Verifier gave and the runner
 * replayed. It does the same calls in the same order and fails with a message that names the step that differed.
 */
export function generateRegression(input: { finding: Pick<Finding, 'id' | 'title'>; scenario: FindingReproduction; recipeId: string; dir: string }): GeneratedRegression {
  const { finding, scenario } = input;
  const extension = /\.m?ts$/.test(scenario.module) ? 'ts' : 'js';
  const file = `${input.dir}/${slug(path.posix.basename(scenario.module))}-${finding.id}.test.${extension}`;
  const title = regressionTitle(finding);
  const relative = path.posix.relative(path.posix.dirname(file), scenario.module.replace(/\\/g, '/'));
  const specifier = relative.startsWith('.') ? relative : `./${relative}`;
  const body: string[] = [];
  const argList = (args: readonly JsonValue[]) => `[${args.map(a => expr(a)).join(', ')}]`;
  body.push(`    const instance = await target[${JSON.stringify(scenario.factory)}](...${argList(scenario.args)});`);
  for (const step of scenario.steps) {
    body.push(`    outcomes.set(${JSON.stringify(step.id)}, await call(instance, ${JSON.stringify(step.method)}, ${argList(step.args)}));`);
    if (step.expect) body.push(`    verify(${JSON.stringify(step.id)}, outcomes.get(${JSON.stringify(step.id)}), ${JSON.stringify(step.expect)});`);
    else body.push(`    if (outcomes.get(${JSON.stringify(step.id)}).error) throw outcomes.get(${JSON.stringify(step.id)}).error;`);
  }
  const comment = (text: string) => text.split(/\r?\n/).map(l => `// ${l}`.trimEnd());
  const rest = [
    '// Generated by AI Department from a counterexample that was reproduced on a clone of the checkpoint. Locked: a changed file is reported as edited.',
    ...comment(`Oracle: ${scenario.oracle.references.map(r => `${r.requirementId}: "${r.quote.replace(/\s+/g, ' ')}"`).join(' | ')}`),
    ...comment(`Why the expected values hold: ${scenario.oracle.explanation.replace(/\s+/g, ' ')}`),
    "import { describe, it, expect } from 'vitest';",
    `import * as target from ${JSON.stringify(specifier)};`,
    '',
    HELPERS,
    '',
    `describe(${JSON.stringify(REGRESSION_DESCRIBE)}, () => {`,
    `  it(${JSON.stringify(title)}, async () => {`,
    ...body,
    '  });',
    '});',
    '',
  ].join('\n');
  const identity = regressionIdentity(file, title);
  const header = `${HEADER}${JSON.stringify({ v: 1, finding: finding.id, scenario: scenarioHash(scenario), recipe: input.recipeId, describe: REGRESSION_DESCRIBE, title, sha: sha256(rest) })}\n`;
  const source = header + rest;
  return { path: file, source, testHash: sha256(source), title, identity, testId: identityId(identity), patch: newFilePatch(file, source) };
}

/** Reads the header of a generated file. `intact` is false when the rest of the file no longer matches the hash in it. */
export function parseRegressionFile(file: string, raw: string): RegressionRef | undefined {
  // Git on Windows may check the file out with CRLF line endings; the text is the same text, so it is hashed as LF.
  const source = raw.replace(/\r\n/g, '\n');
  const lineEnd = source.indexOf('\n');
  const first = lineEnd < 0 ? source : source.slice(0, lineEnd);
  if (!first.startsWith(HEADER)) return;
  try {
    const h = JSON.parse(first.slice(HEADER.length)) as { v?: number; finding?: string; scenario?: string; recipe?: string; describe?: string; title?: string; sha?: string };
    if (h.v !== 1 || !h.finding || !h.scenario || !h.recipe || !h.describe || !h.title || !h.sha) return;
    const identity = regressionIdentity(file, h.title);
    return { path: file, recipeId: h.recipe, testId: identityId(identity), identity, findingId: h.finding, scenarioHash: h.scenario, intact: lineEnd >= 0 && sha256(source.slice(lineEnd + 1)) === h.sha };
  } catch { return; }
}

export function scanRegressions(files: readonly { path: string; content: string }[]): RegressionRef[] {
  return files.flatMap(f => { const ref = parseRegressionFile(f.path.replace(/\\/g, '/'), f.content); return ref ? [ref] : []; });
}

/** The proposals a person can act on right now: bound to this checkpoint, contract, configuration and slot. */
export function readRegressionProposals(run: Run, artifacts: readonly Artifact[]): PendingRegression[] {
  const latest = new Map<string, PendingRegression>();
  for (const a of artifacts) {
    if (a.title !== REGRESSION_PROPOSAL_TITLE || !a.valid || a.contractVersion !== run.contract.version || a.hash !== sha256(a.content)) continue;
    try {
      const p = JSON.parse(a.content) as RegressionProposal;
      if (p.schemaVersion !== 1 || p.checkpoint !== run.checkpoint || a.checkpoint !== run.checkpoint || p.contractVersion !== run.contract.version || p.slot !== run.selectedSlot
        || p.contractHash !== hashContract(run.contract) || p.configHash !== replayConfigHash(run)) continue;
      latest.set(`${p.findingId}:${p.scenarioHash}`, { ...p, id: a.id, hash: a.hash });
    } catch { /* an unreadable proposal is not something to confirm */ }
  }
  return [...latest.values()];
}
export const regressionFor = (proposals: readonly PendingRegression[], finding: Pick<Finding, 'id' | 'reproduction'>): PendingRegression | undefined =>
  finding.reproduction ? proposals.find(p => p.findingId === finding.id && p.scenarioHash === scenarioHash(finding.reproduction!)) : undefined;

/** A proposal can be confirmed only if the runner saw the failure it describes: the test failed on its own assertion. */
export const regressionReady = (p: RegressionProposal): boolean => !p.unsupported && !!p.patch && !!p.path && p.trial?.status === 'failed_as_expected';

export function readRegressionReceipt(run: Run, finding: Finding, proposal: PendingRegression, artifacts: readonly Artifact[]): { receipt: RegressionReceipt; hash: string } | undefined {
  if (!finding.confirmation || finding.confirmation.kind !== 'regression' || finding.confirmation.proposalHash !== proposal.hash) return;
  const a = artifacts.filter(a => a.title === REGRESSION_RECEIPT_TITLE && a.valid && a.contractVersion === run.contract.version && a.hash === finding.confirmation!.receiptHash).at(-1);
  if (!a || a.hash !== sha256(a.content)) return;
  try {
    const r = JSON.parse(a.content) as RegressionReceipt;
    const same = r.schemaVersion === 1 && r.findingId === finding.id && r.proposalId === proposal.id && r.proposalHash === proposal.hash && !!finding.reproduction && r.scenarioHash === scenarioHash(finding.reproduction)
      && r.checkpoint === run.checkpoint && r.contractVersion === run.contract.version && r.contractHash === hashContract(run.contract) && r.configHash === replayConfigHash(run) && r.slot === run.selectedSlot
      && r.testHash === proposal.testHash && r.path === proposal.path && r.testId === proposal.testId;
    return same ? { receipt: r, hash: a.hash } : undefined;
  } catch { return; }
}

export function readRegressionManifest(run: Run, artifacts: readonly Artifact[]): RegressionManifest | undefined {
  const a = artifacts.filter(a => a.title === REGRESSION_MANIFEST_TITLE && a.valid && a.contractVersion === run.contract.version).at(-1);
  if (!a || a.hash !== sha256(a.content)) return;
  try {
    const m = JSON.parse(a.content) as RegressionManifest;
    return m.schemaVersion === 1 && m.contractHash === hashContract(run.contract) && m.slot === run.selectedSlot && Array.isArray(m.entries) ? m : undefined;
  } catch { return; }
}

/** The runner's first differing step in a replay, which the regression test must fail on. */
export function firstMismatch(replay: Pick<FindingReplay, 'observations'>): string | undefined {
  return replay.observations.find(o => o.matched === false)?.stepId;
}
