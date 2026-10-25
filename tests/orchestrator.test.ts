import { describe, expect, it } from 'vitest';
import { green, red, report, setupLegacy as setup } from './helpers.js';

describe('Single workflow', () => {
  it('plans, waits for contract approval, builds, and reaches acceptance with real evidence', async () => {
    const { orchestrator, create, drive, store } = setup({ check: () => green });
    const run = create();
    orchestrator.startRun(run.id); await orchestrator.idle();
    expect(store.runs.get(run.id)!.status).toBe('awaiting_approval');
    expect(store.runs.get(run.id)!.baseSha).toBe('fake-base');
    orchestrator.approveContract(run.id, { contractHash: orchestrator.detail(run.id).contractReview.contractHash, acknowledgeWarnings: true }); await orchestrator.idle();

    const detail = orchestrator.detail(run.id);
    expect(detail.run.status).toBe('awaiting_acceptance');
    expect(detail.completion).toEqual({ ready: true, reasons: [] });
    expect(detail.matrix[0]).toMatchObject({ requirementId: 'R-1', status: 'verified' });
    expect(detail.artifacts.some((a) => a.kind === 'raw')).toBe(true);
    expect(detail.artifacts.some((a) => a.kind === 'reuse')).toBe(true);
    expect(detail.attempts.map((a) => a.role)).toEqual(['planner', 'developer']);

    const done = await orchestrator.acceptRun(run.id);
    expect(done.status).toBe('completed');
    expect(Date.parse(done.followupUntil!) - Date.parse(done.acceptedAt!)).toBe(7 * 86_400_000);
    void drive;
  });

  it('never presents a simulated run as verified', async () => {
    const { orchestrator, create, drive } = setup();
    const run = await drive(create({ provider: 'fake' }));
    expect(run.status).toBe('blocked');
    expect(run.blocker).toMatch(/chưa hoàn tất|mô phỏng/i);
    await expect(orchestrator.acceptRun(run.id)).rejects.toThrow();
  });

  it('tells a simulated run that it stops at the checks and how to run for real; a real run keeps the usual message', async () => {
    const { create, drive } = setup();
    const simulated = await drive(create({ provider: 'fake' }));
    expect(simulated.blocker).toMatch(/Check "test" không chạy thật vì đây là chạy mô phỏng: .*tạo task mới và chọn "Chạy thật · theo vai của project"/);
    const real = await drive(create());
    expect(real.blocker).toMatch(/Check "test" chưa hoàn tất \(timeout, thiếu report hoặc môi trường không chạy thật\)/);
    expect(real.blocker).not.toMatch(/mô phỏng/);
  });

  it('retries a failing check once and records a pass-after-fail as flaky, not passed', async () => {
    const { orchestrator, create, drive } = setup({ check: (_e, call) => (call === 1 ? red : green) });
    const run = await drive(create());
    const detail = orchestrator.detail(run.id);
    expect(detail.checks[0]).toMatchObject({ status: 'flaky' });
    expect(detail.checks[0]!.attempts).toHaveLength(2);
    expect(detail.run.status).toBe('blocked');
    expect(detail.completion.reasons.join(' ')).toMatch(/flaky/);

    // Quarantine alone cannot turn a flaky check into evidence for the requirement.
    orchestrator.quarantineCheck(run.id, detail.checks[0]!.id, 'Phụ thuộc đồng hồ; xem lại khi có fake timer');
    const after = orchestrator.detail(run.id);
    expect(after.matrix[0]!.status).toBe('unverified');
    expect(after.completion.ready).toBe(false);
  });

  it('repairs after a persistent failure, at most twice, then stops', async () => {
    const { orchestrator, create, drive, runtime } = setup({ check: () => red });
    const run = await drive(create());
    const detail = orchestrator.detail(run.id);
    expect(detail.run.status).toBe('failed');
    expect(detail.attempts.filter((a) => a.role === 'developer')).toHaveLength(3);
    expect(detail.run.repairCount).toBe(2);
    expect(runtime.calls.filter((c) => c.startsWith('check:'))).toHaveLength(6);
  });

  it('succeeds on a repair round and counts it', async () => {
    const { orchestrator, create, drive } = setup({ check: (_e, call) => (call <= 2 ? red : green) });
    const run = await drive(create());
    const detail = orchestrator.detail(run.id);
    expect(detail.run.status).toBe('awaiting_acceptance');
    expect(detail.run.repairCount).toBe(1);
    expect(detail.attempts.filter((a) => a.stage === 'repair')).toHaveLength(1);
  });

  it('rejects patches that touch protected files and reverts the workspace', async () => {
    const { orchestrator, create, drive, runtime } = setup({ files: ['src/ok.ts', 'package.json'], check: () => green });
    const run = await drive(create());
    const detail = orchestrator.detail(run.id);
    expect(detail.run.status).toBe('blocked');
    expect(detail.run.checkpoint).toBeNull();
    expect(detail.run.blocker).toMatch(/package\.json/);
    expect(runtime.calls.filter((c) => c.startsWith('revert'))).toHaveLength(3);
    expect(detail.artifacts.filter((a) => a.title.startsWith('Patch bị từ chối') && !a.valid)).toHaveLength(3);
    expect(runtime.calls.some((c) => c.startsWith('check:'))).toBe(false);
  });

  it('blocks instead of overspending the stage budget', async () => {
    const { orchestrator, create, drive } = setup({ check: () => green });
    const run = await drive(create({ budgetUsd: 0.015 }));
    expect(run.status).toBe('blocked');
    expect(run.blocker).toMatch(/Hết ngân sách/);
    expect(orchestrator.detail(run.id).budget.spentUsd).toBeLessThanOrEqual(0.02);
  });
});

describe('contract versions', () => {
  it('a revised contract strands all earlier evidence until re-approved and rebuilt', async () => {
    const { orchestrator, create, drive } = setup({ check: () => green });
    const run = await drive(create());
    expect(orchestrator.detail(run.id).completion.ready).toBe(true);

    const c = run.contract;
    orchestrator.reviseContract(run.id, { ...c, requirements: [{ ...c.requirements[0]!, text: 'Yêu cầu đã đổi.' }] });
    const stale = orchestrator.detail(run.id);
    const next = run.contract.version + 1;
    expect(stale.run.contract.version).toBe(next);
    expect(stale.run.status).toBe('awaiting_approval');
    expect(stale.checks.every((x) => !x.valid)).toBe(true);
    expect(stale.completion.ready).toBe(false);

    orchestrator.approveContract(run.id, { contractHash: orchestrator.detail(run.id).contractReview.contractHash, acknowledgeWarnings: true }); await orchestrator.idle();
    const rebuilt = orchestrator.detail(run.id);
    expect(rebuilt.run.status).toBe('awaiting_acceptance');
    expect(rebuilt.checks.filter((x) => x.valid && x.contractVersion === next)).toHaveLength(1);
  });

  it('an identical contract does not bump the version', async () => {
    const { orchestrator, create } = setup();
    const run = create();
    expect(orchestrator.reviseContract(run.id, { ...run.contract }).contract.version).toBe(1);
  });
});

describe('Team modes', () => {
  it('clarify records independent interpretations that never saw the contract', async () => {
    const { orchestrator, create, drive } = setup({ check: () => green });
    const run = await drive(create({ mode: 'clarify' }));
    const detail = orchestrator.detail(run.id);
    expect(detail.run.interpretations).toHaveLength(2);
    expect(detail.run.interpretations.every((i) => !i.contractSeen)).toBe(true);
    expect(detail.attempts.filter((a) => a.independence?.independent)).toHaveLength(2);
  });

  it('verify locks Author tests, keeps the Developer out of them, and gates findings', async () => {
    let verifierCalls = 0;
    const { orchestrator, create, drive, store } = setup({
      check: () => green,
      files: (e) => (e.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts']),
      reply: (e) => {
        if (e.role !== 'verifier') return undefined;
        verifierCalls++;
        const findings = verifierCalls === 1 ? [
          { category: 'behavior', severity: 'blocker', title: 'Retry tạo đơn thứ hai', location: 'src/order.ts:12', evidence: 'Hai request đồng thời tạo hai đơn', suggestion: 'Dùng idempotency key' },
          { category: 'design', severity: 'major', title: 'Ý kiến phong cách', location: 'src/order.ts', evidence: 'Không thích tên biến', suggestion: '' },
        ] : [];
        return `ok\n\`\`\`json\n${JSON.stringify({ decision: findings.length ? 'block' : 'pass', findings })}\n\`\`\``;
      },
    });
    const run = await drive(create({ mode: 'verify', budgetUsd: 10 }));
    let detail = orchestrator.detail(run.id);
    expect(detail.attempts.map((a) => a.role)).toEqual(['planner', 'author', 'developer', 'verifier']);
    expect(detail.artifacts.find((a) => a.kind === 'acceptance')?.title).toMatch(/Author/);
    // A design "major" with no D-code, rule or precedent is demoted; only the behavior blocker holds.
    expect(detail.findings.map((f) => f.severity).sort()).toEqual(['blocker', 'minor']);
    expect(detail.run.status).toBe('blocked');
    expect(detail.completion.reasons.join(' ')).toMatch(/1 finding blocker/);

    const blocker = detail.findings.find((f) => f.severity === 'blocker')!;
    orchestrator.confirmFinding(run.id, blocker.id);
    orchestrator.repairFindings(run.id); await orchestrator.idle();
    detail = orchestrator.detail(run.id);
    expect(store.findings.get(blocker.id)!.status).toBe('resolved');
    expect(detail.run.status).toBe('awaiting_acceptance');
    expect(detail.attempts.filter((a) => a.role === 'developer' && a.stage === 'verify')).toHaveLength(1);
  });

  it('a simulated Verify run gets past the Author step: the simulated Author writes a test file', async () => {
    const { orchestrator, create, drive } = setup();
    const run = await drive(create({ mode: 'verify', budgetUsd: 10 }));
    const detail = orchestrator.detail(run.id);
    expect(detail.attempts.map((a) => a.role).slice(0, 3)).toEqual(['planner', 'author', 'developer']);
    expect(detail.events.map((e) => e.type)).not.toContain('author.retry');
    expect(detail.run.blocker ?? '').not.toMatch(/Author chỉ được thêm file test/);
    expect(JSON.parse(detail.artifacts.find((a) => a.kind === 'acceptance')!.content)).toEqual({ paths: ['src/simulated.test.ts'] });
  });

  it('the Developer cannot modify tests the Author locked', async () => {
    const { orchestrator, create, drive } = setup({ check: () => green, files: () => ['tests/order.test.ts'] });
    const run = await drive(create({ mode: 'verify', budgetUsd: 10 }));
    expect(run.status).toBe('blocked');
    expect(orchestrator.detail(run.id).run.blocker).toMatch(/được bảo vệ/);
  });

  it('compare keeps the candidate that passes and drops the one that fails', async () => {
    const { orchestrator, create, drive } = setup({ check: (e) => (e.slot === 'A' ? red : green) });
    const run = await drive(create({ mode: 'compare', budgetUsd: 10 }));
    const detail = orchestrator.detail(run.id);
    expect(detail.run.selectedSlot).toBe('B');
    expect(detail.run.status).toBe('awaiting_acceptance');
    expect(detail.run.branch).toBe(`aidept/${run.id}-B`);
    expect(detail.events.some((e) => e.type === 'compare.select')).toBe(true);
  });

  it('compare completes nothing when both candidates fail', async () => {
    const { orchestrator, create, drive } = setup({ check: () => red });
    const run = await drive(create({ mode: 'compare', budgetUsd: 10 }));
    expect(run.status).toBe('blocked');
    expect(run.blocker).toMatch(/Cả hai phương án đều trượt/);
    void orchestrator;
  });
});

describe('escalation', () => {
  it('refuses a mode change that has no money behind it, accepts one with approved budget, keeps full history', async () => {
    const { orchestrator, create, drive } = setup({ check: () => red });
    const run = await drive(create({ budgetUsd: 0.05 }));
    expect(run.status).toBe('failed');
    expect(() => orchestrator.escalate(run.id, 'compare', 'Hướng hiện tại bế tắc')).toThrow(/ngân sách/);
    expect(() => orchestrator.escalate(run.id, 'compare', 'quá tay', 0.5)).toThrow(/trần/);
    orchestrator.escalate(run.id, 'compare', 'Hướng hiện tại bế tắc', 0.15); await orchestrator.idle();
    const after = orchestrator.detail(run.id).run;
    expect(after.initialMode).toBe('single');
    expect(after.mode).toBe('compare');
    expect(after.escalations).toHaveLength(1);
    expect(after.usage.length).toBeGreaterThan(2);
  });
});

describe('red/green validation', () => {
  const baseFails = (e: { ref: string }) => (e.ref === 'base' ? red : green);
  it('accepts a bugfix whose test fails on base and passes on the candidate', async () => {
    const { orchestrator, create, drive } = setup({ files: ['src/fix.ts', 'tests/fix.test.ts'], check: baseFails });
    const run = await drive(create({ taskKind: 'bugfix' }));
    expect(orchestrator.detail(run.id).run.status).toBe('awaiting_acceptance');
  });
  it('rejects a bugfix whose test already passes on base', async () => {
    const { orchestrator, create, drive } = setup({ files: ['src/fix.ts', 'tests/fix.test.ts'], check: () => green });
    const run = await drive(create({ taskKind: 'bugfix' }));
    expect(run.status).toBe('blocked');
    expect(orchestrator.detail(run.id).run.blocker).toMatch(/không phải bằng chứng bugfix/i);
  });
  it('treats a collection error on base as not a valid red test', async () => {
    const collectionError = { exitCode: 1, incomplete: false, log: '', report: { testResults: [{ name: 'x.test.ts', status: 'failed', assertionResults: [] }] } };
    const { create, drive } = setup({ files: ['src/fix.ts', 'tests/fix.test.ts'], check: (e) => (e.ref === 'base' ? collectionError : green) });
    const run = await drive(create({ taskKind: 'bugfix' }));
    expect(run.status).toBe('blocked');
  });
});

describe('control and recovery', () => {
  it('stop interrupts a running agent and parks the run as paused', async () => {
    const { orchestrator, create, store } = setup({ delayMs: 5000, check: () => green });
    const run = create();
    orchestrator.startRun(run.id);
    await new Promise((r) => setTimeout(r, 50));
    orchestrator.stopRun(run.id); await orchestrator.idle();
    expect(store.runs.get(run.id)!.status).toBe('paused');
    expect(store.attempts.list(run.id)[0]!.status).toBe('interrupted');
  });

  it('startup recovery marks orphaned attempts interrupted and pauses their runs', async () => {
    const { orchestrator, create, store } = setup();
    const run = create();
    store.runs.put({ ...run, status: 'running' });
    store.attempts.put({ id: 'att_x', runId: run.id, slot: 'A', role: 'developer', stage: 'implement', provider: 'codex', model: 'm', status: 'running', startedAt: new Date().toISOString(), checkpoint: null, contractVersion: 1 });
    await orchestrator.recover();
    expect(store.runs.get(run.id)!.status).toBe('paused');
    expect(store.attempts.get('att_x')!.status).toBe('interrupted');
  });

  it('a quota error parks the run for a person instead of switching provider', async () => {
    const { orchestrator, store, create } = setup({ throwOnAgent: () => new Error('429 rate limit exceeded') });
    const run = create();
    orchestrator.startRun(run.id); await orchestrator.idle();
    const parked = store.runs.get(run.id)!;
    expect(parked.status).toBe('blocked');
    expect(parked.blocker).toMatch(/quota/i);
  });

  it('live providers require an approved project policy', () => {
    const { create } = setup({}, { approved: false });
    expect(() => create({ provider: 'codex' })).toThrow(/policy/);
    expect(create({ provider: 'fake' }).provider).toBe('fake');
  });

  it('records human time and keeps unfinished runs in the totals', async () => {
    const { orchestrator, create } = setup();
    const run = create();
    orchestrator.addHumanMinutes(run.id, 'review', 12);
    const timer = orchestrator.startTimer(run.id, 'approval');
    orchestrator.stopTimer(run.id, timer.id);
    const detail = orchestrator.detail(run.id);
    expect(detail.run.humanTime).toHaveLength(2);
    expect(detail.run.humanTime[0]!.durationMs).toBe(12 * 60_000);
    void report;
  });
});

describe('paths outside the allowed modules', () => {
  it('asks about exactly the files that need approval, then continues once a person allows them', async () => {
    const { orchestrator, create, drive } = setup({ files: ['src/a.ts', 'worker/crawler.ts', 'worker/run.ts'], check: () => green });
    const run = await drive(create());
    expect(run.status).toBe('blocked');
    expect(orchestrator.detail(run.id).pendingPaths).toEqual(['worker/crawler.ts', 'worker/run.ts']);

    orchestrator.approvePaths(run.id, ['worker'], true); await orchestrator.idle();
    const detail = orchestrator.detail(run.id);
    expect(detail.run.approvedPaths).toEqual(['worker']);
    expect(detail.run.status, detail.run.blocker ?? '').toBe('awaiting_acceptance');
    expect(detail.pendingPaths).toEqual([]);
    expect(detail.events.some((e) => e.type === 'scope.approved')).toBe(true);
  });

  it('never lets protected files be approved, directly or through a parent directory', async () => {
    const { orchestrator, create, drive } = setup({ files: ['worker/package.json'], check: () => green });
    const run = await drive(create());
    expect(run.status).toBe('blocked');
    // A protected file is not "pending": there is nothing a person can approve.
    expect(orchestrator.detail(run.id).pendingPaths).toEqual([]);
    expect(() => orchestrator.approvePaths(run.id, ['package.json'])).toThrow(/được bảo vệ/);
    orchestrator.approvePaths(run.id, ['worker'], true); await orchestrator.idle();
    const after = orchestrator.detail(run.id);
    expect(after.run.status).toBe('blocked');
    expect(after.run.blocker).toMatch(/worker\/package\.json.*được bảo vệ/);
  });

  it('rejects malformed approvals and approvals in the wrong state', async () => {
    const { orchestrator, create, drive } = setup({ files: ['worker/a.ts'], check: () => green });
    const run = await drive(create());
    for (const bad of [[], ['../outside'], ['/etc'], ['C:\\x'], ['wor*ker']]) expect(() => orchestrator.approvePaths(run.id, bad as string[])).toThrow();
    const fresh = create();
    orchestrator.startRun(fresh.id);
    await orchestrator.idle();
    orchestrator.approveContract(fresh.id, { contractHash: orchestrator.detail(fresh.id).contractReview.contractHash, acknowledgeWarnings: true });
    expect(() => orchestrator.approvePaths(fresh.id, ['worker'])).toThrow(/đang chờ người dùng/);
    await orchestrator.idle();
  });
});

describe('running again', () => {
  it('"Chạy tiếp" after a failed candidate tries again instead of re-reporting the old failure', async () => {
    const { orchestrator, create, drive } = setup({ check: (_e, call) => (call <= 6 ? red : green) });
    const run = await drive(create());
    expect(run.status).toBe('failed');
    orchestrator.startRun(run.id); await orchestrator.idle();
    const detail = orchestrator.detail(run.id);
    expect(detail.run.status, detail.run.blocker ?? '').toBe('awaiting_acceptance');
    expect(detail.attempts.filter((a) => a.role === 'developer').length).toBeGreaterThan(3);
  });
});

describe('re-running checks only', () => {
  it('refuses states and setups where a recheck makes no sense', async () => {
    const { orchestrator, create, store } = setup({ check: () => green });
    const fresh = create();
    expect(() => orchestrator.recheck(fresh.id)).toThrow(/đang chờ người dùng/); // draft
    const run = create();
    orchestrator.startRun(run.id); await orchestrator.idle();
    store.runs.put({ ...store.runs.get(run.id)!, status: 'blocked', checkpoint: null });
    expect(() => orchestrator.recheck(run.id)).toThrow(/checkpoint/);
    store.runs.put({ ...store.runs.get(run.id)!, checkpoint: 'abc', mode: 'compare' });
    expect(() => orchestrator.recheck(run.id)).toThrow(/Compare/);
    store.runs.put({ ...store.runs.get(run.id)!, mode: 'single' });
    store.projects.put({ ...store.projects.get('prj_test')!, approved: false });
    expect(() => orchestrator.recheck(run.id)).toThrow(/duyệt lại policy/);
  });

  it('re-checks the existing checkpoint without calling any agent and can finish the run', async () => {
    let phase = 'broken';
    const { orchestrator, create, drive, runtime } = setup({ check: () => (phase === 'broken' ? { ...green, report: undefined, incomplete: true } : green) });
    const run = await drive(create());
    expect(run.status).toBe('blocked');
    const agentCalls = () => runtime.calls.filter((c) => c.startsWith('agent:')).length;
    const before = agentCalls();
    const reverts = () => runtime.calls.filter((c) => c === 'revert:A').length;
    const revertsBefore = reverts();
    phase = 'fixed';
    orchestrator.recheck(run.id); await orchestrator.idle();
    expect(orchestrator.detail(run.id).run.status).toBe('awaiting_acceptance');
    expect(agentCalls()).toBe(before);
    // Half-finished edits from a stopped attempt must not leak into the measured tree.
    expect(reverts()).toBeGreaterThan(revertsBefore);
    expect(runtime.calls.lastIndexOf('revert:A')).toBeLessThan(runtime.calls.lastIndexOf('check:test:candidate'));
  });
});

describe('Author step runs once', () => {
  it('does not run the Author again on resume when it wrote no tests', async () => {
    const { orchestrator, create, drive, runtime } = setup({
      files: (e) => (e.role === 'author' ? [] : ['src/order.ts']),
      check: () => red,
    });
    const run = await drive(create({ mode: 'verify', budgetUsd: 10 }));
    const authors = () => runtime.calls.filter((c) => c.startsWith('agent:author')).length;
    expect(authors()).toBe(1);
    expect(orchestrator.detail(run.id).events.some((e) => e.type === 'author.empty')).toBe(true);
    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.startRun(run.id); await orchestrator.idle();
    expect(authors()).toBe(1);
  });
});

describe('Author writing outside the allowed modules', () => {
  const authorFiles = (e: { role: string }) => (e.role === 'author' ? ['worker/shop.acceptance.test.ts'] : ['src/order.ts']);

  it('blocks, offers the paths for approval like a Developer patch, and continues once they are approved', async () => {
    const { orchestrator, create, drive, store } = setup({ files: authorFiles, check: () => green });
    const run = await drive(create({ mode: 'verify', budgetUsd: 10 }));
    let detail = orchestrator.detail(run.id);
    expect(detail.run.status).toBe('blocked');
    expect(detail.run.blocker).toMatch(/Author chỉ được thêm file test.*worker\/shop\.acceptance\.test\.ts/);
    expect(detail.pendingPaths).toEqual(['worker/shop.acceptance.test.ts']);
    expect(detail.artifacts.some((a) => a.title === 'Patch bị từ chối (Author)' && !a.valid)).toBe(true);

    orchestrator.approvePaths(run.id, ['worker'], true); await orchestrator.idle();
    detail = orchestrator.detail(run.id);
    expect(detail.run.blocker ?? '').not.toMatch(/Author chỉ được/);
    expect(detail.attempts.some((a) => a.role === 'developer')).toBe(true);
    void store;
  });

  it('a blocked run without a checkpoint picks up the project\'s widened modules on resume; one with a checkpoint keeps its snapshot', async () => {
    const { orchestrator, create, drive, store } = setup({ files: authorFiles, check: () => green });
    const run = await drive(create({ mode: 'verify', budgetUsd: 10 }));
    expect(orchestrator.detail(run.id).run.blocker).toMatch(/Author chỉ được/);
    expect(store.runs.get(run.id)!.checkpoint).toBeNull();

    const project = store.projects.get('prj_test')!;
    project.modules = ['**']; project.version += 1;
    store.projects.put(project);
    orchestrator.resumeRun(run.id); await orchestrator.idle();
    const after = orchestrator.detail(run.id);
    expect(after.run.configSnapshot.modules).toEqual(['**']);
    expect(after.run.blocker ?? '').not.toMatch(/Author chỉ được/);
    expect(after.events.some((e) => e.type === 'config.refreshed')).toBe(true);
    expect(after.attempts.some((a) => a.role === 'developer')).toBe(true);
  });
});

describe('Author writing a non-test file', () => {
  it('is reverted and asked once more with the file named; a second slip blocks with a clear message', async () => {
    let authorCalls = 0;
    const prompts: string[] = [];
    const { orchestrator, create, drive } = setup({
      files: (e) => (e.role === 'author' ? (++authorCalls === 1 ? ['worker/discovery.acceptance.md'] : ['tests/discovery.test.ts']) : ['src/order.ts']),
      reply: (e) => { if (e.role === 'author') prompts.push(e.prompt); return undefined; },
      check: () => green,
    }, { modules: ['**'] });
    const run = await drive(create({ mode: 'verify', budgetUsd: 10 }));
    const detail = orchestrator.detail(run.id);
    expect(authorCalls).toBe(2);
    expect(prompts[0]).not.toContain('discovery.acceptance.md');
    expect(prompts[1]).toContain('worker/discovery.acceptance.md');
    expect(detail.events.some((e) => e.type === 'author.retry')).toBe(true);
    expect(detail.run.blocker ?? '').not.toMatch(/Author chỉ được/);
    expect(detail.attempts.some((a) => a.role === 'developer')).toBe(true);

    let again = 0;
    const second = setup({ files: (e) => (e.role === 'author' ? (++again, ['notes/plan.md']) : ['src/order.ts']), check: () => green }, { modules: ['**'] });
    const blocked = await second.drive(second.create({ mode: 'verify', budgetUsd: 10 }));
    expect(again).toBe(2);
    expect(second.orchestrator.detail(blocked.id).run.blocker).toMatch(/Author chỉ được thêm file test.*notes\/plan\.md/);
  });
});

describe('evidence that is not evidence', () => {
  it('a test check whose report lists no test at all is not "passed": the run says the check ran nothing', async () => {
    const { orchestrator, create, drive } = setup({ check: () => ({ exitCode: 0, incomplete: false, log: 'ℹ tests 0', report: report([]) }) });
    const run = await drive(create());
    const detail = orchestrator.detail(run.id);
    expect(detail.checks.at(-1)).toMatchObject({ status: 'incomplete', counts: { passed: 0, failed: 0, skipped: 0 } });
    expect(detail.run.status).toBe('blocked');
    expect(detail.run.blocker).toMatch(/không chạy test nào/);
    expect(detail.completion.reasons.join(' ')).toMatch(/không chạy test nào/);
  });

  it('files a Verifier or Planner leaves behind are reverted and never reach a checkpoint', async () => {
    const { orchestrator, create, drive, runtime } = setup({
      check: () => green,
      files: (e) => (e.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts']),
      strayFiles: (e) => (e.role === 'verifier' ? ['verifier-test-results/profile/cache.bin'] : e.role === 'planner' ? ['notes.md'] : undefined),
    });
    const run = await drive(create({ mode: 'verify', budgetUsd: 10 }));
    const detail = orchestrator.detail(run.id);
    const cleaned = detail.events.filter((e) => e.type === 'workspace.cleaned').map((e) => e.message).join('\n');
    expect(cleaned).toMatch(/Planner.*notes\.md/);
    expect(cleaned).toMatch(/Verifier.*verifier-test-results/);
    expect(detail.artifacts.filter((a) => a.kind === 'diff').map((a) => a.content).join('\n')).not.toMatch(/notes\.md|verifier-test-results/);
    expect(runtime.calls.filter((c) => c.startsWith('revert')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('blocker that explains what would change it', () => {
  it('an old zero-test "passed" result and untagged requirements give one actionable reason, not one line per requirement', async () => {
    const { evaluateCompletion } = await import('../src/core/completion.js');
    const { approveContract } = await import('../src/core/contract.js');
    const { create } = setup();
    const run = create();
    run.provider = 'codex'; run.checkpoint = 'cp1';
    run.contract = approveContract({ ...run.contract, requirements: [{ id: 'R-1', text: 'a', required: true, manual: false }, { id: 'R-2', text: 'b', required: true, manual: false }, { id: 'R-3', text: 'giao diện', required: true, manual: true }] });
    const check = { id: 'c', runId: run.id, recipeId: 'test', checkpoint: 'cp1', contractVersion: run.contract.version, status: 'passed' as const, attempts: [], testIds: [], missingTestIds: [], required: true, requirementIds: [], quarantined: false, valid: true, createdAt: '', counts: { passed: 0, failed: 0, skipped: 0 } };
    const budget = { capUsd: 10, spentUsd: 0, estimated: false, phases: { prepare: { allocatedUsd: 0, spentUsd: 0 }, implement: { allocatedUsd: 0, spentUsd: 0 }, repair: { allocatedUsd: 0, spentUsd: 0 }, verify: { allocatedUsd: 0, spentUsd: 0 } } };
    const { reasons, ready } = evaluateCompletion(run, [check], [], budget);
    expect(ready).toBe(false);
    expect(reasons).toContain('Check "test" không chạy test nào: lệnh check hoặc mẫu file không khớp test của repo.');
    const req = reasons.filter((r) => /R-1/.test(r));
    expect(req).toHaveLength(1);
    expect(req[0]).toMatch(/2 yêu cầu chưa có test nào xác minh \(R-1, R-2\).*Chạy tiếp sẽ không đổi kết quả.*Thủ công/);
    expect(reasons.join(' ')).not.toMatch(/R-3/); // manual requirements wait for a person, not for tests
  });
});

describe('provider capacity errors', () => {
  it('a model at capacity parks the run as blocked with a wait-and-resume message, not as failed', async () => {
    let calls = 0;
    const { orchestrator, create } = setup({ check: () => green, throwOnAgent: () => (++calls === 1 ? new Error('Selected model is at capacity. Please try a different model.') : undefined) });
    const run = create();
    orchestrator.startRun(run.id); await orchestrator.idle();
    const blocked = orchestrator.detail(run.id).run;
    expect(blocked.status).toBe('blocked');
    expect(blocked.blocker).toMatch(/quá tải.*Chạy tiếp/);
    orchestrator.resumeRun(run.id); await orchestrator.idle();
    expect(orchestrator.detail(run.id).run.status).toBe('awaiting_approval');
  });
});

describe('creating setup files in a new project', () => {
  it('scope: a protected setup file may be created only when scaffolding is on and it was not in the base', async () => {
    const { classifyPath, DEFAULT_PROTECTED } = await import('../src/core/scope.js');
    const base = { modules: ['**'], protectedPaths: DEFAULT_PROTECTED };
    const empty = { ...base, scaffold: { baseFiles: new Set<string>() } };
    expect(classifyPath('package.json', base)).toBe('protected');
    expect(classifyPath('package.json', empty)).toBe('allowed');
    expect(classifyPath('package-lock.json', empty)).toBe('allowed');
    expect(classifyPath('tsconfig.app.json', empty)).toBe('allowed');
    expect(classifyPath('vite.config.ts', empty)).toBe('allowed');
    expect(classifyPath('package.json', { ...base, scaffold: { baseFiles: new Set(['package.json']) } })).toBe('protected');
    expect(classifyPath('.npmrc', empty)).toBe('protected'); // registry settings are never scaffolded
    expect(classifyPath('.github/workflows/ci.yml', empty)).toBe('protected');
    expect(classifyPath('tests/locked.test.ts', { ...empty, lockedPaths: ['tests/locked.test.ts'] })).toBe('protected');
    expect(classifyPath('package.json', { ...empty, modules: ['src'] })).toBe('needs_approval'); // still subject to modules
  });

  it('a project that opted in lets the Developer create package.json and tsconfig; one that did not is blocked', async () => {
    const files = () => ['package.json', 'package-lock.json', 'tsconfig.json', 'src/App.tsx'];
    const prompts: string[] = [];
    const on = setup({ files, check: () => green, reply: (e) => { if (e.role === 'developer') prompts.push(e.prompt); return undefined; } }, { allowScaffold: true, modules: ['**'] });
    const ok = await on.drive(on.create());
    expect(on.orchestrator.detail(ok.id).run.status).toBe('awaiting_acceptance');
    expect(prompts[0]).toContain('TẠO MỚI các file thiết lập');

    const off = setup({ files, check: () => green, reply: (e) => { if (e.role === 'developer') prompts.push(e.prompt); return undefined; } }, { modules: ['**'] });
    const blocked = await off.drive(off.create());
    expect(off.orchestrator.detail(blocked.id).run.blocker).toMatch(/package\.json: file được bảo vệ/);
    expect(prompts.at(-1)).not.toContain('TẠO MỚI các file thiết lập');

    const existing = setup({ files, check: () => green, baseFiles: ['package.json'] }, { allowScaffold: true, modules: ['**'] });
    const kept = await existing.drive(existing.create());
    expect(existing.orchestrator.detail(kept.id).run.blocker).toMatch(/package\.json: file được bảo vệ/);
    expect(existing.orchestrator.detail(kept.id).run.blocker).not.toMatch(/tsconfig\.json/);
  });
});
