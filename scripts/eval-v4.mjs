// The v4 check: twelve live runs (3 new task packs × Department/Single × 2) with a locked protocol.
//   node node_modules/tsx/dist/cli.mjs scripts/eval-v4.mjs check                       task packs: reference passes, every seeded mutant is caught
//   node node_modules/tsx/dist/cli.mjs scripts/eval-v4.mjs lock                        writes benchmarks/eval/v4-check/protocol.json; nothing runs before this
//   node node_modules/tsx/dist/cli.mjs scripts/eval-v4.mjs run [--ids a,b] [--limit N] runs unfinished assignments in the locked order; waits for decisions in files
//   node node_modules/tsx/dist/cli.mjs scripts/eval-v4.mjs report                      aggregates rows into report.json / report.md
// A decision request is written to benchmarks/eval/v4-check/decisions/<assignment>.<round>.request.json and the runner waits for
// <assignment>.<round>.decision.json next to it. The runner never retries a model run and never edits a candidate.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../src/core/contract.ts';
import { mulberry32, shuffled } from '../src/evaluation/stats.ts';
import { LIMITS, renderReport, runAssignment, summarizeRows } from './lib/evalv4.mjs';
import { loadTask, repoRoot, sha256, taskHash } from './lib/evaltask.mjs';

const OUT = path.join(repoRoot, 'benchmarks', 'eval', 'v4-check');
const TASKS = ['ledgerhold', 'ticketflow', 'couponstack'], ARMS = ['department', 'single'], REPETITIONS = 2, SEED = 20261027;
const MODEL = 'gpt-6-luna', EFFORT = 'medium';
const ORCHESTRATOR_POLICY = [
  'Decisions are made by the orchestrating AI against the locked SPEC.md of the task, never against the hidden grader, the reference or another candidate.',
  'A contract is approved when it states the SPEC without adding or dropping behavior. A contract that cannot be approved as written may be revised only in form (labels, missing not-applicable reasons, links to steps); no expected result is added or changed. Every revision is recorded.',
  'A test correction proposal is approved only when the cited SPEC clause makes the old assertion wrong and the new one right. Otherwise it is rejected.',
  'A finding is confirmed (by its proposal hash, or by a reasoned manual review when no regression can be generated) only when its oracle quotes a SPEC clause and its expected values follow from it; findings about behavior the SPEC does not decide are disputed.',
  'The orchestrator never writes or edits code or tests for a model, never adds business rules, and never retries a run that failed or was blocked. At most two repair rounds per run.',
];
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const safe = (id) => id.replace(/[^A-Za-z0-9_-]+/g, '__');
const normalized = async (file) => (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(full)); else out.push(full);
  }
  return out;
}
/** What the product is at the moment of locking: every source file the runs execute, plus the runner itself. */
async function productSnapshot() {
  const files = [...await filesUnder(path.join(repoRoot, 'src')), ...['scripts/eval-v4.mjs', 'scripts/lib/evalv4.mjs', 'scripts/lib/evaltask.mjs', 'package.json', 'pnpm-lock.yaml'].map((f) => path.join(repoRoot, f))]
    .map((f) => path.relative(repoRoot, f).replace(/\\/g, '/')).sort();
  const entries = [];
  for (const f of files) entries.push([f, sha256(await normalized(path.join(repoRoot, f)))]);
  return { files: entries.length, sha256: sha256(entries.map(([f, h]) => `${f}:${h}`).join('\n')), entries };
}
const hashProtocol = (protocol) => { const { protocolHash: _omit, ...rest } = protocol; return sha256(canonicalJson(rest)); };

async function verifyLock() {
  const protocol = await read(path.join(OUT, 'protocol.json')).catch(() => null);
  if (!protocol) throw new Error('Chưa khóa protocol: chạy "node node_modules/tsx/dist/cli.mjs scripts/eval-v4.mjs lock" trước.');
  if (hashProtocol(protocol) !== protocol.protocolHash) throw new Error('Protocol đã bị sửa sau khi khóa.');
  const snapshot = await productSnapshot();
  if (snapshot.sha256 !== protocol.productSnapshot.sha256) {
    const locked = new Map(protocol.productSnapshot.entries), changed = snapshot.entries.filter(([f, h]) => locked.get(f) !== h).map(([f]) => f);
    throw new Error(`Sản phẩm đã đổi sau khi khóa protocol: ${changed.slice(0, 8).join(', ')}`);
  }
  for (const t of protocol.tasks) if (await taskHash((await loadTask(t.id)).dir) !== t.packHash) throw new Error(`Task pack ${t.id} đã đổi sau khi khóa.`);
  if (sha256(await normalized(path.join(OUT, 'AUDIT.md'))) !== protocol.auditHash) throw new Error('AUDIT.md đã đổi sau khi khóa.');
  return protocol;
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };

if (command === 'check') {
  let bad = 0;
  for (const id of TASKS) {
    const out = execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'eval-task-check.mjs'), id], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
    const result = JSON.parse(out.slice(out.indexOf('{')));
    console.log(JSON.stringify({ task: id, ok: result.ok, reference: result.reference, mutants: result.mutants.length, killed: result.mutants.filter((m) => m.killed).length, problems: result.problems }));
    if (!result.ok) bad++;
  }
  process.exit(bad ? 1 : 0);
} else if (command === 'lock') {
  if (await stat(path.join(OUT, 'protocol.json')).then(() => true, () => false)) throw new Error('Protocol đã được khóa; không khóa lại.');
  await mkdir(OUT, { recursive: true });
  const tasks = [];
  for (const id of TASKS) { const t = await loadTask(id); tasks.push({ id, stratum: t.stratum, signals: t.signals, packHash: await taskHash(t.dir) }); }
  const all = [];
  for (const t of tasks) for (const arm of ARMS) for (let rep = 1; rep <= REPETITIONS; rep++) all.push({ id: `${t.id}:${arm}:${rep}`, taskId: t.id, arm, repetition: rep });
  const codex = execFileSync(process.execPath, [path.join(repoRoot, '.tools', 'codex', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '--version'], { encoding: 'utf8', windowsHide: true }).trim();
  const protocol = {
    schemaVersion: 1, id: 'v4-check-1', provenance: 'synthetic', lockedAt: new Date().toISOString(), model: MODEL, effort: EFFORT, cliVersions: { codex },
    effectiveCapUsd: LIMITS.effectiveCapUsd, automaticLimitMinutes: LIMITS.automaticMs / 60000, maxDecisionRounds: LIMITS.maxDecisionRounds, maxRepairRounds: LIMITS.maxRepairRounds,
    seed: SEED, arms: ARMS, repetitions: REPETITIONS, tasks, assignments: shuffled(all, mulberry32(SEED)),
    singleMeans: 'AI Department Single mode: Planner plus one agent that writes code, tests and its own review; no independent Author or Verifier, no subagents.',
    departmentMeans: 'AI Department Verify mode with qualityPolicyVersion 4 (frozen in the run).',
    productSnapshot: await productSnapshot(), auditHash: sha256(await normalized(path.join(OUT, 'AUDIT.md'))), orchestratorPolicy: ORCHESTRATOR_POLICY,
    labels: 'Task packs, graders, mutants and orchestrator decisions are AI-generated (synthetic).',
  };
  protocol.protocolHash = hashProtocol(protocol);
  await writeFile(path.join(OUT, 'protocol.json'), JSON.stringify(protocol, null, 2));
  console.log(JSON.stringify({ locked: protocol.protocolHash, product: { files: protocol.productSnapshot.files, sha256: protocol.productSnapshot.sha256 }, order: protocol.assignments.map((a) => a.id) }, null, 2));
} else if (command === 'run') {
  const protocol = await verifyLock();
  await mkdir(path.join(OUT, 'rows'), { recursive: true }); await mkdir(path.join(OUT, 'decisions'), { recursive: true });
  const only = flag('ids')?.split(','), limit = Number(flag('limit', '1000'));
  let ran = 0;
  const log = (e) => console.log(JSON.stringify(e));
  for (const assignment of protocol.assignments) {
    if (only && !only.includes(assignment.id)) continue;
    const rowFile = path.join(OUT, 'rows', `${safe(assignment.id)}.json`);
    if (await stat(rowFile).then(() => true, () => false)) continue;
    if (ran >= limit) break;
    const task = await loadTask(assignment.taskId);
    const name = `v4check-${safe(assignment.id)}`;
    const data = path.join(repoRoot, '.data', `eval-${name}`);
    const decide = async (request) => {
      const base = path.join(OUT, 'decisions', `${safe(assignment.id)}.${request.round}`);
      await writeFile(`${base}.request.json`, JSON.stringify(request, null, 2));
      log({ event: 'needs_decision', assignment: assignment.id, kind: request.kind, round: request.round, request: `${base}.request.json`, decision: `${base}.decision.json` });
      while (true) {
        await pause(1500);
        try { return await read(`${base}.decision.json`); } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
      }
    };
    log({ event: 'started', assignment: assignment.id, at: new Date().toISOString() });
    const startedAt = new Date().toISOString();
    let row;
    try { row = await runAssignment({ task, arm: assignment.arm, name, model: protocol.model, effort: protocol.effort, data, decide, log }); }
    catch (error) { row = { arm: assignment.arm, status: 'error', error: String(error?.stack ?? error).slice(0, 2000), graderPass: false, grader: { passed: 0, total: 0, failed: [], loadError: true }, evidenceComplete: false, falseReady: false, costUsd: null, automaticMs: 0, interventions: [] }; }
    await writeFile(rowFile, JSON.stringify({ assignmentId: assignment.id, taskId: assignment.taskId, repetition: assignment.repetition, protocolHash: protocol.protocolHash, startedAt, endedAt: new Date().toISOString(), ...row }, null, 2));
    log({ event: 'finished', assignment: assignment.id, status: row.status, grader: row.grader && `${row.grader.passed}/${row.grader.total}`, evidenceComplete: row.evidenceComplete, falseReady: row.falseReady, costUsd: row.costUsd, error: row.error?.slice(0, 200) });
    ran++;
  }
  log({ event: 'done', ran });
} else if (command === 'report') {
  const protocol = await verifyLock().catch(async () => read(path.join(OUT, 'protocol.json')));
  const rows = [];
  for (const a of protocol.assignments) { const row = await read(path.join(OUT, 'rows', `${safe(a.id)}.json`)).catch(() => null); if (row) rows.push(row); }
  const adjudications = await read(path.join(OUT, 'adjudications.json')).catch(() => []);
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ protocolHash: protocol.protocolHash, complete: `${rows.length}/${protocol.assignments.length}`, perArm: summarizeRows(rows), rows }, null, 2));
  await writeFile(path.join(OUT, 'report.md'), renderReport(protocol, rows, adjudications));
  console.log(JSON.stringify({ complete: `${rows.length}/${protocol.assignments.length}`, perArm: summarizeRows(rows) }, null, 2));
} else {
  console.error('usage: node node_modules/tsx/dist/cli.mjs scripts/eval-v4.mjs <check|lock|run|report>');
  process.exit(2);
}
