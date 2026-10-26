// Task packs for the Department-vs-Single experiment: benchmarks/tasks/<id>/{task.json,SPEC.md,scaffold/,reference/,grader/,mutants/}.
// Grading never happens inside the candidate's workspace: its src/ is copied next to the hidden grader in a scratch folder.
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const repoRoot = path.resolve(import.meta.dirname, '..', '..');
export const taskDir = (id) => path.join(repoRoot, 'benchmarks', 'tasks', id);
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export async function loadTask(id) {
  const dir = taskDir(id);
  const task = JSON.parse(await readFile(path.join(dir, 'task.json'), 'utf8'));
  return { ...task, dir, spec: await readFile(path.join(dir, 'SPEC.md'), 'utf8') };
}

async function filesUnder(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(full, base));
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

/** Hash of everything that decides a score: spec, grader, reference and mutants. Stored before any model runs. */
export async function taskHash(dir) {
  const parts = [];
  for (const sub of ['SPEC.md', 'task.json', 'scaffold', 'reference', 'grader', 'mutants']) {
    const full = path.join(dir, sub);
    const files = sub.includes('.') ? [''] : await filesUnder(full);
    for (const file of files) parts.push(`${sub}/${file}:${sha256(await readFile(path.join(full, file)))}`);
  }
  return sha256(parts.join('\n'));
}

const run = (command, args, options) => new Promise((resolve) => execFile(command, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));

/** Runs the hidden grader against a folder holding `src/` and returns how many of its tests pass. */
export async function gradeSource(task, sourceRoot, { timeoutMs = 120_000 } = {}) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'aidept-grade-'));
  try {
    await cp(path.join(sourceRoot, 'src'), path.join(scratch, 'src'), { recursive: true });
    await mkdir(path.join(scratch, 'tests'), { recursive: true });
    await cp(path.join(task.dir, 'grader', task.graderFile), path.join(scratch, 'tests', task.graderFile));
    await writeFile(path.join(scratch, 'package.json'), '{"name":"grader","private":true,"type":"module"}');
    await writeFile(path.join(scratch, 'vitest.config.js'), `export default {test:{include:['tests/**/*.test.js'],maxWorkers:1,testTimeout:10000}};\n`);
    await symlink(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'junction');
    const report = path.join(scratch, 'report.json');
    await run(process.execPath, [path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=json', `--outputFile=${report}`], { cwd: scratch, timeout: timeoutMs });
    let parsed;
    try { parsed = JSON.parse(await readFile(report, 'utf8')); } catch { return { passed: 0, total: 0, failed: [], loadError: true }; }
    const cases = parsed.testResults.flatMap((f) => f.assertionResults);
    const loadError = parsed.testResults.some((f) => f.status === 'failed' && f.assertionResults.length === 0);
    return { passed: cases.filter((c) => c.status === 'passed').length, total: cases.length, failed: cases.filter((c) => c.status !== 'passed').map((c) => c.fullName), loadError };
  } finally { await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
