// The registered pilot: build the manifest, run its assignments (resumable), report.
//   node scripts/eval-pilot.mjs build  [--out benchmarks/eval/pilot-1.manifest.json] [--seed 20261026]
//   npm run eval -- register benchmarks/eval/pilot-1.manifest.json          (locks it; nothing runs before this)
//   node scripts/eval-pilot.mjs run    benchmarks/eval/pilot-1.manifest.json [--only <taskId>] [--arm <arm>] [--limit N] [--ids a:arm:1,b:arm:2] [--variant name]
//   node scripts/eval-pilot.mjs report benchmarks/eval/pilot-1.manifest.json [--amended]
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeM0b } from '../src/evaluation/m0b.ts';
import { manifestHash, matchesRegistration, validateM0b } from '../src/evaluation/manifest.ts';
import { buildPilotManifest, rollup, runPlan, taskRecordFrom } from '../src/evaluation/pilot.ts';
import { runArm } from './lib/evalrun.mjs';
import { loadTask, repoRoot, taskHash } from './lib/evaltask.mjs';

const [command, manifestArg, ...rest] = process.argv.slice(2);
const flagSource = command === 'build' ? [manifestArg, ...rest].filter((x) => x !== undefined) : rest;
const flag = (name, fallback) => { const i = flagSource.indexOf(`--${name}`); return i >= 0 ? flagSource[i + 1] : fallback; };
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const safe = (id) => id.replace(/[^A-Za-z0-9_-]+/g, '__');

async function loadLocked(file) {
  const manifest = await read(file), regFile = file.replace(/\.json$/, '') + '.registration.json';
  const registration = await read(regFile).catch(() => null);
  if (!registration) throw new Error('Manifest chưa được đăng ký: chạy "npm run eval -- register" trước.');
  if (!matchesRegistration(manifest, registration)) throw new Error('Manifest đã bị sửa sau khi đăng ký.');
  return { manifest, hash: manifestHash(manifest) };
}

if (command === 'build') {
  const out = path.resolve(flag('out', 'benchmarks/eval/pilot-1.manifest.json')), seed = Number(flag('seed', '20261026'));
  const ids = (await readdir(path.join(repoRoot, 'benchmarks', 'tasks'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  const packs = [];
  for (const id of ids) {
    const task = await loadTask(id);
    packs.push({ id, stratum: task.stratum, signals: task.signals, initialTeamMode: task.initialTeamMode, spec: task.spec, packHash: await taskHash(task.dir) });
  }
  const codex = execFileSync(process.execPath, [path.join(repoRoot, '.tools', 'codex', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '--version'], { encoding: 'utf8', windowsHide: true }).trim();
  const manifest = buildPilotManifest(packs, { id: path.basename(out).replace(/\.manifest\.json$/, ''), seed, lockedAt: new Date().toISOString(), modelVersion: 'gpt-6-luna (medium)', cliVersions: { codex } });
  const problems = validateM0b(manifest);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ out, tasks: manifest.tasks.map((t) => `${t.id}:${t.stratum}`), assignments: manifest.assignments.length, hash: manifestHash(manifest), problems }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

const file = path.resolve(manifestArg ?? '');
const { manifest, hash } = await loadLocked(file);
// --variant keeps a rerun with changed product code apart from the registered results: same assignments, own folder.
const variant = flag('variant');
const rowsDir = path.join(repoRoot, 'test-results', 'eval-pilot', variant ? `${manifest.id}__${variant}` : manifest.id);
await mkdir(rowsDir, { recursive: true });

async function rowsFor(assignmentId) {
  const prefix = `${safe(assignmentId)}.`;
  const files = (await readdir(rowsDir)).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
  return Promise.all(files.map((f) => read(path.join(rowsDir, f))));
}
/** The latest attempt that was not an infrastructure error is the result; errors stay on disk and are listed by the report. */
const finalRow = async (id) => (await rowsFor(id)).filter((r) => !r.error).at(-1);

if (command === 'run') {
  const only = flag('only'), armOnly = flag('arm'), limit = Number(flag('limit', '1000')), ids = flag('ids')?.split(',');
  let done = 0;
  for (const assignment of manifest.assignments) {
    if ((only && assignment.taskId !== only) || (armOnly && assignment.arm !== armOnly) || (ids && !ids.includes(assignment.id))) continue;
    if (await finalRow(assignment.id)) continue;
    if (done >= limit) break;
    const attempt = (await rowsFor(assignment.id)).length + 1;
    const task = await loadTask(assignment.taskId), declared = manifest.tasks.find((t) => t.id === assignment.taskId);
    if (await taskHash(task.dir) !== declared.taskPackHash) throw new Error(`Task pack ${assignment.taskId} đã đổi sau khi đăng ký.`);
    const name = `pilot${variant ? `-${variant}` : ''}-${safe(assignment.id)}-a${attempt}`;
    console.log(JSON.stringify({ event: 'started', assignment: assignment.id, attempt }));
    const row = await runArm({ task, plan: runPlan(assignment.arm, declared), name, outDir: rowsDir });
    await writeFile(path.join(rowsDir, `${safe(assignment.id)}.a${attempt}.json`), JSON.stringify({ assignmentId: assignment.id, arm: assignment.arm, attempt, manifestHash: hash, ...row }, null, 2));
    console.log(JSON.stringify({ event: 'finished', assignment: assignment.id, status: row.status, graderPass: row.graderPass, falseReady: row.falseReady, costUsd: row.costUsd, error: row.error?.slice(0, 160) }));
    done++;
  }
  console.log(JSON.stringify({ event: 'done', ran: done }));
} else if (command === 'report') {
  const rows = [], missing = [], infra = [];
  // --amended: use the post-hoc regrade (eval-regrade.mjs). The as-run results stay on disk and are the registered ones.
  const amended = rest.includes('--amended') ? new Map((await read(path.join(rowsDir, 'amended.json'))).results.map((r) => [r.assignmentId, r.amended])) : null;
  for (const a of manifest.assignments) {
    let final = await finalRow(a.id);
    const regrade = final && amended?.get(a.id);
    if (regrade) {
      const pass = regrade.total > 0 && regrade.passed === regrade.total;
      final = { ...final, grader: { ...final.grader, passed: regrade.passed, total: regrade.total, failed: regrade.failed ?? [] }, graderPass: pass, ...(final.falseReady === null || final.falseReady === undefined ? {} : { falseReady: final.status === 'awaiting_acceptance' && !pass }) };
    }
    infra.push(...(await rowsFor(a.id)).filter((r) => r.error).map((r) => a.id));
    if (final) rows.push(final); else missing.push(a.id);
  }
  const records = rows.map((r) => taskRecordFrom(r, manifest.assignments.find((a) => a.id === r.assignmentId), hash));
  await writeFile(path.join(rowsDir, 'records.json'), JSON.stringify(records, null, 2));
  console.log(JSON.stringify({ manifest: manifest.id, provenance: manifest.provenance, complete: `${rows.length}/${manifest.assignments.length}`, missing, infrastructureErrors: infra, perArm: rollup(rows), m0b: analyzeM0b(manifest, records) }, null, 2));
} else {
  console.error('usage: node scripts/eval-pilot.mjs <build|run|report> ...');
  process.exit(2);
}
