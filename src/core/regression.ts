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

/**
 * What the generated test needs around its calls. TypeScript gets declared types, because a project's strict typecheck usually covers its
 * tests too and nobody may edit the file once it is locked; only the helpers a scenario uses are written, so `noUnusedLocals` stays quiet.
 */
function helpers(ts: boolean, uses: { ref: boolean; verify: boolean }): string {
  const t = (typed: string) => (ts ? typed : '');
  const lines = [
    ...(ts ? ['type Outcome = { value?: unknown; error?: any };', 'type Expected = { path?: string[]; equals?: unknown; throwsCode?: string };'] : []),
    `const outcomes = new Map${t('<string, Outcome>')}();`,
    `const got = (id${t(': string')})${t(': Outcome')} => outcomes.get(id) ?? {};`,
    `const factory = (name${t(': string')})${t(': any')} => (target${t(' as unknown as Record<string, any>')})[name];`,
    `const call = async (instance${t(': any')}, method${t(': string')}, args${t(': unknown[]')})${t(': Promise<Outcome>')} => { try { return { value: await instance[method](...args) }; } catch (error) { return { error }; } };`,
  ];
  if (uses.ref || uses.verify) lines.push(
    `const BLOCKED = new Set${t('<string>')}(['__proto__', 'prototype', 'constructor']);`,
    `const at = (value${t(': any')}, parts${t(': readonly string[]')})${t(': any')} => { for (const part of parts) { if (BLOCKED.has(part)) throw new Error('Unsafe property'); value = value == null ? undefined : value[part]; } return value; };`);
  if (uses.ref) lines.push(
    `const safe = (value${t(': unknown')})${t(': any')} => (value === undefined ? null : JSON.parse(JSON.stringify(value)));`,
    `const ref = (id${t(': string')}, parts${t(': readonly string[]')})${t(': any')} => safe(at(got(id).value, parts));`);
  if (uses.verify) lines.push(
    `const verify = (id${t(': string')}, outcome${t(': Outcome')}, expected${t(': Expected')}) => {`,
    '  const observed = outcome.error ? String(outcome.error.code ?? outcome.error.name) : at(outcome.value, expected.path ?? []);',
    "  if ('throwsCode' in expected) {",
    `    expect(outcome.error !== undefined, \`${REGRESSION_FAILURE_TAG}:\${id} phải throw\`).toBe(true);`,
    `    expect(observed, \`${REGRESSION_FAILURE_TAG}:\${id}\`).toBe(expected.throwsCode);`,
    '  } else {',
    `    expect(outcome.error, \`${REGRESSION_FAILURE_TAG}:\${id} không được throw\`).toBeUndefined();`,
    `    expect(observed, \`${REGRESSION_FAILURE_TAG}:\${id}\`).toStrictEqual(expected.equals);`,
    '  }',
    '};');
  return lines.join('\n');
}

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
  const ts = /\.m?ts$/.test(scenario.module);
  const file = `${input.dir}/${slug(path.posix.basename(scenario.module))}-${finding.id}.test.${ts ? 'ts' : 'js'}`;
  const title = regressionTitle(finding);
  // A TypeScript import names the emitted file (.js for .ts): tsc rejects a .ts extension without allowImportingTsExtensions, and Vite maps it back.
  const relative = path.posix.relative(path.posix.dirname(file), scenario.module.replace(/\\/g, '/')).replace(/\.ts$/, '.js').replace(/\.mts$/, '.mjs');
  const specifier = relative.startsWith('.') ? relative : `./${relative}`;
  const body: string[] = [];
  const argList = (args: readonly JsonValue[]) => `[${args.map(a => expr(a)).join(', ')}]`;
  body.push(`    const instance = await factory(${JSON.stringify(scenario.factory)})(...${argList(scenario.args)});`);
  for (const step of scenario.steps) {
    body.push(`    outcomes.set(${JSON.stringify(step.id)}, await call(instance, ${JSON.stringify(step.method)}, ${argList(step.args)}));`);
    if (step.expect) body.push(`    verify(${JSON.stringify(step.id)}, got(${JSON.stringify(step.id)}), ${JSON.stringify(step.expect)});`);
    else body.push(`    if (got(${JSON.stringify(step.id)}).error) throw got(${JSON.stringify(step.id)}).error;`);
  }
  const uses = { ref: JSON.stringify([scenario.args, scenario.steps.map(s => s.args)]).includes('"$ref"'), verify: scenario.steps.some(s => !!s.expect) };
  const comment = (text: string) => text.split(/\r?\n/).map(l => `// ${l}`.trimEnd());
  const rest = [
    '// Generated by AI Department from a counterexample that was reproduced on a clone of the checkpoint. Locked: a changed file is reported as edited.',
    ...comment(`Oracle: ${scenario.oracle.references.map(r => `${r.requirementId}: "${r.quote.replace(/\s+/g, ' ')}"`).join(' | ')}`),
    ...comment(`Why the expected values hold: ${scenario.oracle.explanation.replace(/\s+/g, ' ')}`),
    "import { describe, it, expect } from 'vitest';",
    `import * as target from ${JSON.stringify(specifier)};`,
    '',
    helpers(ts, uses),
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

/**
 * The manifest entry behind a confirmation this run already carried out: the test was applied and committed on top of the checkpoint the
 * person confirmed on, and nothing else has been committed since. A run stopped between that commit and the Developer's turn resumes on
 * the same transaction; any other change of checkpoint makes the confirmation stale as before.
 */
export function readAppliedReceipt(run: Run, finding: Finding, artifacts: readonly Artifact[]): RegressionManifest['entries'][number] | undefined {
  const c = finding.confirmation;
  if (c?.kind !== 'regression' || !finding.reproduction || !run.checkpoint) return;
  const hash = scenarioHash(finding.reproduction);
  const entry = readRegressionManifest(run, artifacts)?.entries.find(e => e.findingId === finding.id && e.scenarioHash === hash && e.proposalHash === c.proposalHash && e.receiptHash === c.receiptHash);
  if (!entry?.appliedFrom || entry.appliedCheckpoint !== run.checkpoint) return;
  const a = artifacts.find(a => a.title === REGRESSION_RECEIPT_TITLE && a.valid && a.contractVersion === run.contract.version && a.hash === c.receiptHash);
  if (!a || a.hash !== sha256(a.content)) return;
  try {
    const r = JSON.parse(a.content) as RegressionReceipt;
    const same = r.schemaVersion === 1 && r.findingId === finding.id && r.proposalHash === c.proposalHash && r.scenarioHash === hash && r.checkpoint === entry.appliedFrom
      && r.contractVersion === run.contract.version && r.contractHash === hashContract(run.contract) && r.configHash === replayConfigHash(run) && r.slot === run.selectedSlot
      && r.testHash === entry.fileHash && r.path === entry.path && r.testId === entry.testId;
    return same ? entry : undefined;
  } catch { return; }
}

/** A regression the run must see pass, the check it was made for, and the check that runs it now (none when no check can). */
export interface RegressionTarget { path: string; testId: string; madeFor: string; recipeId?: string; intact: boolean }

/**
 * Every regression the run knows of (the files the project holds and the ones this run applied), each with the check that runs it now:
 * the check it was made for, or the project's one Vitest check when that check was renamed or removed. The mapping is stated wherever it
 * matters, and a regression with no check at all stays a reason not to accept: an unrun regression must never pass for a passing one.
 */
export function regressionTargets(run: Run, refs: readonly RegressionRef[], artifacts: readonly Artifact[]): RegressionTarget[] {
  const all = new Map<string, Omit<RegressionTarget, 'recipeId'>>();
  for (const r of refs) all.set(r.path, { path: r.path, testId: r.testId, madeFor: r.recipeId, intact: r.intact });
  for (const e of readRegressionManifest(run, artifacts)?.entries ?? []) if (!all.has(e.path)) all.set(e.path, { path: e.path, testId: e.testId, madeFor: e.recipeId, intact: true });
  const current = regressionRecipe(run.configSnapshot);
  return [...all.values()].map(t => {
    const own = run.configSnapshot.checks.find(c => c.id === t.madeFor && c.reportPath);
    const recipeId = own?.id ?? ('recipe' in current ? current.recipe.id : undefined);
    return recipeId ? { ...t, recipeId } : t;
  });
}

/** The runner's first differing step in a replay, which the regression test must fail on. */
export function firstMismatch(replay: Pick<FindingReplay, 'observations'>): string | undefined {
  return replay.observations.find(o => o.matched === false)?.stepId;
}
