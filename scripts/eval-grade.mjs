// node scripts/eval-grade.mjs <taskId> <workspaceDir>   — prints the hidden-grader result for a finished workspace.
import { gradeSource, loadTask } from './lib/evaltask.mjs';

const [id, workspace] = process.argv.slice(2);
if (!id || !workspace) { console.error('usage: node scripts/eval-grade.mjs <taskId> <workspaceDir>'); process.exit(2); }
const result = await gradeSource(await loadTask(id), workspace);
console.log(JSON.stringify({ task: id, workspace, ...result }, null, 2));
process.exit(result.total > 0 && result.passed === result.total ? 0 : 1);
