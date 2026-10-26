// node scripts/eval-regrade.mjs <manifest.json>
// Grades the finished pilot workspaces again with post-hoc grader amendments (benchmarks/eval/amendments/<manifest id>/<task>.grade.test.js),
// after checking that each amended grader still passes the reference and still catches every seeded mutant. The registered pack is not touched.
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gradeSource, loadTask, repoRoot } from './lib/evaltask.mjs';

const file = path.resolve(process.argv[2] ?? '');
const manifest = JSON.parse(await readFile(file, 'utf8'));
const dir = path.join(repoRoot, 'benchmarks', 'eval', 'amendments', manifest.id);
const rowsDir = path.join(repoRoot, 'test-results', 'eval-pilot', manifest.id);
const safe = (id) => id.replace(/[^A-Za-z0-9_-]+/g, '__');
const amendments = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.grade.test.js')).map((f) => f.replace('.grade.test.js', ''));

const verified = {};
for (const id of amendments) {
  const task = { ...(await loadTask(id)), graderPath: path.join(dir, `${id}.grade.test.js`) };
  const problems = [];
  const ref = await gradeSource(task, path.join(task.dir, 'reference'));
  if (ref.total === 0 || ref.passed !== ref.total) problems.push(`reference ${ref.passed}/${ref.total}`);
  for (const f of (await readdir(path.join(task.dir, 'mutants'))).filter((x) => x.endsWith('.json'))) {
    const mutant = JSON.parse(await readFile(path.join(task.dir, 'mutants', f), 'utf8'));
    const scratch = await mkdtemp(path.join(tmpdir(), 'aidept-amend-'));
    try {
      await cp(path.join(task.dir, 'reference', 'src'), path.join(scratch, 'src'), { recursive: true });
      const target = path.join(scratch, mutant.file);
      let source = await readFile(target, 'utf8');
      for (const e of mutant.edits ?? [{ find: mutant.find, replace: mutant.replace }]) source = source.replace(e.find, e.replace);
      await writeFile(target, source);
      const result = await gradeSource(task, scratch);
      if (!(result.loadError || result.passed < result.total)) problems.push(`mutant ${mutant.id} no longer caught`);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  verified[id] = { ok: problems.length === 0, problems };
}

const out = [];
for (const a of manifest.assignments) {
  const files = (await readdir(rowsDir)).filter((f) => f.startsWith(`${safe(a.id)}.a`) && f.endsWith('.json')).sort();
  const rows = (await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(rowsDir, f), 'utf8'))))).filter((r) => !r.error);
  const row = rows.at(-1);
  if (!row) continue;
  const base = { assignmentId: a.id, task: a.taskId, arm: a.arm, asRun: row.grader };
  if (!amendments.includes(a.taskId) || !verified[a.taskId].ok) { out.push({ ...base, amended: row.grader, changed: false }); continue; }
  const name = `pilot-${safe(a.id)}-a${row.attempt ?? files.length}`;
  const data = path.join(repoRoot, '.data', `eval-${name}`);
  const workspace = row.arm === 'native-full' ? path.join(data, 'work') : path.join(data, 'workspaces', `${row.runId}-A`);
  const task = { ...(await loadTask(a.taskId)), graderPath: path.join(dir, `${a.taskId}.grade.test.js`) };
  const amended = await gradeSource(task, workspace);
  out.push({ ...base, amended: { passed: amended.passed, total: amended.total, failed: amended.failed }, changed: amended.passed !== row.grader.passed });
}
await writeFile(path.join(rowsDir, 'amended.json'), JSON.stringify({ verified, results: out }, null, 2));
console.log(JSON.stringify({ verified, changed: out.filter((r) => r.changed).map((r) => `${r.assignmentId}: ${r.asRun.passed}/${r.asRun.total} -> ${r.amended.passed}/${r.amended.total}`) }, null, 2));
