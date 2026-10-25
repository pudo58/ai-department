import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveHostCommand } from '../src/runtime/hostcommand.js';
import { LocalRuntime } from '../src/runtime/local.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { Store } from '../src/server/store.js';
import { profile } from './helpers.js';

/**
 * REAL Codex on THIS machine, spends real ChatGPT quota, no container isolation. Needs the CLI under
 * .tools/codex (npm install --prefix .tools/codex @openai/codex) and a prior `codex login`.
 *   AIDEPT_LIVE_E2E=1 npx vitest run tests/live.e2e.test.ts
 */
const enabled = process.env.AIDEPT_LIVE_E2E === '1';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const host = (cwd: string, argv: string[]) => { const [exe, ...args] = resolveHostCommand(argv); return execFileSync(exe!, args, { cwd, encoding: 'utf8' }); };

function buggyRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidept-live-repo-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', private: true, type: 'module', devDependencies: { vitest: '3.2.4' } }, null, 2));
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.aidept-report.json\n');
  writeFileSync(path.join(dir, 'src', 'sum.ts'), '/** Sum of the integers from 1 to n, inclusive. */\nexport function sumTo(n: number): number {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n');
  host(dir, ['npm', 'install', '--package-lock-only', '--no-audit', '--no-fund']);
  git(dir, 'init', '-q'); git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}

describe.skipIf(!enabled)('live Codex agent, local runtime', () => {
  it('fixes an off-by-one bug end to end with red/green evidence', async () => {
    const source = buggyRepo();
    const headBefore = git(source, 'rev-parse', 'HEAD');
    const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-live-data-'));
    const store = new Store(':memory:');
    store.projects.put(profile({
      repository: source, executionMode: 'local', setupCommand: ['npm', 'ci', '--no-audit', '--no-fund'],
      checks: [{ id: 'test', command: ['npx', 'vitest', 'run', '--reporter=json', '--outputFile=.aidept-report.json'], required: true, timeoutMs: 180_000, reportPath: '.aidept-report.json' }],
    }));
    const orchestrator = new Orchestrator(store, () => new LocalRuntime({ dataDir }));
    const run = orchestrator.createRun({
      projectId: 'prj_test', title: 'Sửa sumTo bỏ sót n', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [], taskKind: 'bugfix',
      originalRequirement: 'sumTo(n) trong src/sum.ts phải trả về tổng các số nguyên từ 1 đến n, bao gồm n. Hiện tại nó bỏ sót n. sumTo(0) phải là 0. Chỉ sửa trong src và tests.',
    });
    const dump = () => {
      const d = orchestrator.detail(run.id);
      // What each agent attempt actually did: its messages and the shell commands it ran (with their outcome).
      const trace = d.artifacts.filter((a) => a.kind === 'raw').map((a) => {
        const lines = a.content.split('\n').flatMap((l) => { try { return [JSON.parse(l) as { type?: string; item?: Record<string, unknown> }]; } catch { return []; } });
        const items = lines.filter((e) => e.type === 'item.completed').map((e) => e.item!);
        return `# ${a.title}\n${items.map((i) => i.type === 'command_execution' ? `  $ ${String(i.command).slice(0, 140)} -> ${String(i.status)} ${String(i.aggregated_output ?? '').slice(0, 160).replace(/\n/g, ' ')}` : `  [${String(i.type)}] ${String(i.text ?? i.path ?? '').slice(0, 200).replace(/\n/g, ' ')}`).join('\n')}`;
      }).join('\n');
      const contract = d.run.contract.requirements.map((r) => `${r.id}${r.manual ? ' (manual)' : ''}: ${r.text}`).join('\n');
      return `${d.run.status}: ${d.run.blocker}\nCONTRACT\n${contract}\n${d.events.map((e) => `${e.type}: ${e.message}`).join('\n')}\n${d.attempts.map((a) => `${a.role}/${a.status} ${a.error ?? ''}`).join('\n')}\nTRACE\n${trace}`;
    };

    orchestrator.startRun(run.id); await orchestrator.idle();
    expect(orchestrator.detail(run.id).run.status, dump()).toBe('awaiting_approval');
    orchestrator.approveContract(run.id, { contractHash: orchestrator.detail(run.id).contractReview.contractHash, acknowledgeWarnings: true }); await orchestrator.idle();

    const detail = orchestrator.detail(run.id);
    console.log(dump());
    console.log(`Chi phí: ${detail.budget.spentUsd.toFixed(4)} USD${detail.budget.estimated ? ' (ước tính)' : ''}\nDiff:\n${detail.artifacts.filter((a) => a.kind === 'diff' && a.valid).at(-1)?.content}`);
    expect(detail.run.status, dump()).toBe('awaiting_acceptance');
    expect(detail.completion.ready).toBe(true);
    // Process or scope rules are manual criteria; every behavioural one must be backed by a passing test.
    expect(detail.matrix.filter((r) => !r.manual).every((r) => r.status === 'verified')).toBe(true);
    expect(detail.matrix.some((r) => r.status === 'verified')).toBe(true);
    expect(git(source, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(source, 'status', '--porcelain')).toBe('');

    await orchestrator.acceptRun(run.id);
    expect(git(source, 'rev-parse', `refs/heads/aidept/${run.id}-A`)).toBe(detail.run.checkpoint);
    console.log(`Branch đã giao: aidept/${run.id}-A trong ${source}`);
  }, 40 * 60_000);
});
