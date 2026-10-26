// node scripts/eval-task-check.mjs <taskId>
// A task may enter the experiment only if its reference passes every grader test and every seeded mutant fails at least one.
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gradeSource, loadTask, taskHash } from './lib/evaltask.mjs';

const id = process.argv[2];
if (!id) { console.error('usage: node scripts/eval-task-check.mjs <taskId>'); process.exit(2); }
const task = await loadTask(id);
const problems = [];

const reference = await gradeSource(task, path.join(task.dir, 'reference'));
if (reference.loadError || reference.total === 0) problems.push('Grader không chạy được trên reference.');
else if (reference.passed !== reference.total) problems.push(`Reference chỉ đạt ${reference.passed}/${reference.total}: ${reference.failed.slice(0, 5).join('; ')}`);

const mutants = [];
const files = (await readdir(path.join(task.dir, 'mutants')).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
if (files.length < (task.minMutants ?? 5)) problems.push(`Cần ít nhất ${task.minMutants ?? 5} mutant, có ${files.length}.`);
for (const file of files) {
  const mutant = JSON.parse(await readFile(path.join(task.dir, 'mutants', file), 'utf8'));
  const scratch = await mkdtemp(path.join(tmpdir(), 'aidept-mutant-'));
  try {
    await cp(path.join(task.dir, 'reference', 'src'), path.join(scratch, 'src'), { recursive: true });
    const target = path.join(scratch, mutant.file);
    const source = await readFile(target, 'utf8');
    if (!source.includes(mutant.find)) { problems.push(`${mutant.id}: đoạn cần thay không có trong reference.`); continue; }
    await writeFile(target, source.replace(mutant.find, mutant.replace));
    const result = await gradeSource(task, scratch);
    const killed = result.loadError || result.passed < result.total;
    mutants.push({ id: mutant.id, description: mutant.description, killed, failedTests: result.failed.length });
    if (!killed) problems.push(`${mutant.id}: grader không phát hiện mutant này.`);
  } finally { await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

console.log(JSON.stringify({ task: id, ok: problems.length === 0, taskHash: await taskHash(task.dir), reference: { passed: reference.passed, total: reference.total }, mutants, problems }, null, 2));
process.exit(problems.length ? 1 : 0);
