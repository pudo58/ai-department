import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ContractReview, Run, TaskContract } from '../src/shared/types.js';
import { approveContract, hashContract, initialContract, isApproved, reviewContract, reviseContract, validateContract } from '../src/core/contract.js';
import { ContractProposalSchema, parseOutput } from '../src/core/outputs.js';
import { contractText, PROMPTS } from '../src/core/prompts.js';
import { renderReportMarkdown } from '../src/core/report.js';
import { buildApp } from '../src/server/app.js';
import { green, report, setup } from './helpers.js';

function fullContract(): TaskContract {
  return {
    ...initialContract('Tạo đúng một đơn cho mỗi yêu cầu.'),
    requirements: [
      { id: 'R-1', text: 'Tạo đúng một đơn.', required: true, manual: false, kind: 'expected' },
      { id: 'R-2', text: 'Không tạo thêm đơn khi retry cùng khóa.', required: true, manual: false, kind: 'forbidden' },
    ],
    acceptanceExamples: ['Hai lần gọi cùng khóa k1 trả cùng một đơn.'],
  };
}
const codes = (c: TaskContract) => reviewContract(c).warnings.map((w) => w.code);
const approval = (review: ContractReview, acknowledgeWarnings = false) => ({ contractHash: review.contractHash, acknowledgeWarnings });
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function pending(contract = fullContract()) {
  const env = setup({ check: () => ({ ...green, report: report(contract.requirements.filter(r => !r.manual).map(r => ({ title: `[${r.id}] approval fixture evidence` }))) }) });
  const run = env.create();
  env.store.runs.put({ ...run, contract, status: 'awaiting_approval' });
  return { ...env, run: env.store.runs.get(run.id)! };
}
async function boot(contract = fullContract()) {
  const env = await pending(contract);
  app = await buildApp({ ...env, dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-contract-api-')), port: 4310 });
  const headers = { host: '127.0.0.1:4310', 'x-csrf-token': '' };
  headers['x-csrf-token'] = (await app.inject({ method: 'GET', url: '/api/session', headers })).json<{ token: string }>().token;
  const post = (action: string, payload: object) => app!.inject({ method: 'POST', url: `/api/runs/${env.run.id}/${action}`, payload, headers });
  const detail = async () => (await app!.inject({ method: 'GET', url: `/api/runs/${env.run.id}`, headers })).json<{ run: Run; contractReview: ContractReview }>();
  return { ...env, post, detail };
}

describe('deterministic contract review', () => {
  it('has no warnings when both behavior kinds and a concrete example are present', () => {
    const c = fullContract();
    expect(reviewContract(c)).toEqual({ contractHash: hashContract(c), contractVersion: c.version, warnings: [], problems: [] });
  });

  it.each(['expected', 'forbidden'] as const)('warns only about missing %s behavior', (kind) => {
    const c = fullContract(); c.requirements = c.requirements.filter((r) => r.kind !== kind);
    expect(codes(c)).toEqual([`missing_${kind}`]);
  });

  it('warns about missing examples and nonblank assumptions, independently', () => {
    const c = fullContract();
    expect(codes({ ...c, acceptanceExamples: ['', '   '] })).toEqual(['missing_examples']);
    expect(codes({ ...c, assumptions: ['Khóa retry do client cung cấp.'] })).toEqual(['assumptions_present']);
    expect(codes({ ...c, assumptions: ['', '   '] })).toEqual([]);
  });

  it('returns every omission without inventing a meaning for the text', () => {
    const c = { ...initialContract('Không được xóa dữ liệu.'), requirements: [], assumptions: ['Chưa xác nhận'] };
    expect(codes(c)).toEqual(['missing_expected', 'missing_forbidden', 'missing_examples', 'assumptions_present']);
    expect(codes(initialContract('Không được xóa dữ liệu.'))).toEqual(['missing_forbidden', 'missing_examples']);
  });

  it('does not normalize legacy contracts or change their approval hash while reading', async () => {
    const env = setup();
    const legacy = approveContract(initialContract('x'), new Date('2020-01-01T00:00:00Z'));
    const before = JSON.stringify(legacy), hash = legacy.approvedHash;
    const run = env.create(); env.store.runs.put({ ...run, status: 'completed', contract: legacy });
    const d = env.orchestrator.detail(run.id);
    expect(d.contractReview.contractHash).toBe(hash);
    expect(d.contractReview.warnings.map((w) => w.code)).not.toContain('missing_expected');
    expect(d.matrix[0]?.kind).toBe('expected');
    expect(JSON.stringify(env.store.runs.get(run.id)!.contract)).toBe(before);
    expect(isApproved(env.store.runs.get(run.id)!.contract)).toBe(true);
    expect(env.store.runs.get(run.id)?.contractReviewReceipt).toBeUndefined();
  });

  it.each(['empty', 'bad_id', 'duplicate', 'optional_only', 'bad_kind'] as const)('retains structural rejection for %s even with acknowledgement', async (problem) => {
    const c = fullContract();
    if (problem === 'empty') c.requirements[0]!.text = '  ';
    if (problem === 'bad_id') c.requirements[0]!.id = 'bad';
    if (problem === 'duplicate') c.requirements[1]!.id = 'R-1';
    if (problem === 'optional_only') c.requirements.forEach((r) => { r.required = false; });
    if (problem === 'bad_kind') Object.assign(c.requirements[0]!, { kind: 'guessed' });
    const env = await pending(c);
    expect(validateContract(c).length).toBeGreaterThan(0);
    expect(() => env.orchestrator.approveContract(env.run.id, approval(reviewContract(c), true))).toThrow();
    expect(env.store.runs.get(env.run.id)?.status).toBe('awaiting_approval');
    expect(env.runtime.calls).toEqual([]);
  });
});

describe('approval API and versioned receipt', () => {
  it.each([{}, { contractHash: 'wrong' }, { contractHash: 'a'.repeat(64), acknowledgeWarnings: 'yes' }])('rejects malformed approval input %j with 400', async (payload) => {
    const env = await boot();
    expect((await env.post('approve-contract', payload)).statusCode).toBe(400);
    expect(env.store.runs.get(env.run.id)?.status).toBe('awaiting_approval');
    expect(env.runtime.calls).toEqual([]);
  });

  it('computes review server-side, rejects a stale hash, and ignores a forged warning list', async () => {
    const env = await boot(initialContract('x'));
    const d = await env.detail();
    expect(d.contractReview.warnings.length).toBeGreaterThan(0);
    expect((await env.post('approve-contract', { contractHash: 'a'.repeat(64), acknowledgeWarnings: true })).statusCode).toBe(409);
    expect((await env.post('approve-contract', { contractHash: d.contractReview.contractHash, warnings: [], acknowledgedWarnings: ['all'] })).statusCode).toBe(409);
    expect((await env.post('approve-contract', approval(d.contractReview, false))).statusCode).toBe(409);
    expect(env.store.runs.get(env.run.id)?.contract.approvedHash).toBeUndefined();
    expect(env.runtime.calls).toEqual([]);
  });

  it('approves a complete contract without acknowledgement and stores the exact review snapshot', async () => {
    const env = await boot(); const review = (await env.detail()).contractReview;
    const res = await env.post('approve-contract', { contractHash: review.contractHash });
    expect(res.statusCode).toBe(200);
    await env.orchestrator.idle();
    const saved = env.store.runs.get(env.run.id)!;
    expect(saved.contract.approvedHash).toBe(review.contractHash);
    expect(saved.contractReviewReceipt).toMatchObject({ contractHash: review.contractHash, contractVersion: review.contractVersion, acknowledgedWarnings: [], reviewedAt: saved.contract.approvedAt });
    const artifact = env.store.artifacts.list(env.run.id).find((a) => a.title === 'Soát hợp đồng trước khi duyệt')!;
    expect(artifact).toMatchObject({ kind: 'report', checkpoint: null, contractVersion: review.contractVersion, valid: true });
    expect(JSON.parse(artifact.content)).toEqual({ review, receipt: saved.contractReviewReceipt });
    expect(env.runtime.calls.filter((c) => c.startsWith('agent:'))).toEqual(['agent:developer:A']);
  });

  it('allows acknowledged omissions, then invalidates acknowledgement after a real edit but preserves no-op approval', async () => {
    const env = await boot(initialContract('x')); const review = (await env.detail()).contractReview;
    expect((await env.post('approve-contract', approval(review, true))).statusCode).toBe(200);
    await env.orchestrator.idle();
    const before = env.store.runs.get(env.run.id)!;
    expect(before.contractReviewReceipt?.acknowledgedWarnings).toEqual(review.warnings.map((w) => w.code));
    env.orchestrator.reviseContract(env.run.id, before.contract);
    expect(env.store.runs.get(env.run.id)?.contractReviewReceipt).toEqual(before.contractReviewReceipt);
    env.orchestrator.reviseContract(env.run.id, { ...before.contract, acceptanceExamples: ['Xảy ra đúng một lần.'] });
    const edited = env.store.runs.get(env.run.id)!;
    expect(edited).toMatchObject({ status: 'awaiting_approval', contract: { version: review.contractVersion + 1 } });
    expect(edited.contractReviewReceipt).toBeUndefined(); expect(edited.contract.approvedHash).toBeUndefined();
    expect((await env.post('approve-contract', approval(review, true))).statusCode).toBe(409);
    const current = (await env.detail()).contractReview;
    expect((await env.post('approve-contract', approval(current))).statusCode).toBe(409);
    expect((await env.post('approve-contract', approval(current, true))).statusCode).toBe(200);
    await env.orchestrator.idle();
    expect(env.store.runs.get(env.run.id)?.contractReviewReceipt?.contractHash).toBe(current.contractHash);
  });

  it('rejects changed content even when an external edit did not bump the version', async () => {
    const env = await boot(); const review = (await env.detail()).contractReview;
    env.store.runs.put({ ...env.run, contract: { ...env.run.contract, assumptions: ['new'] } });
    expect((await env.post('approve-contract', approval(review, true))).statusCode).toBe(409);
    expect(env.runtime.calls).toEqual([]);
  });

  it('cannot enqueue twice through concurrent approvals', async () => {
    const env = await boot(); const input = approval((await env.detail()).contractReview);
    const results = await Promise.all([env.post('approve-contract', input), env.post('approve-contract', input)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    await env.orchestrator.idle();
    expect(env.runtime.calls.filter((c) => c.startsWith('agent:'))).toEqual(['agent:developer:A']);
  });
});

describe('behavior classification through the workflow', () => {
  it('keeps kind through the Planner schema, request schema, hashing and every role prompt', async () => {
    const c = fullContract();
    const parsed = parseOutput(ContractProposalSchema, `\`\`\`json\n${JSON.stringify(c)}\n\`\`\``);
    expect(parsed.requirements[1]!.kind).toBe('forbidden');
    const env = await boot(c);
    const changed = { ...c, requirements: c.requirements.map((r, i) => i === 0 ? { ...r, kind: 'forbidden' as const } : r) };
    expect((await env.post('contract', changed)).statusCode).toBe(200);
    const d = await env.detail();
    expect(d.run.contract.requirements.every((r) => r.kind === 'forbidden')).toBe(true);
    expect(d.contractReview.contractHash).not.toBe(hashContract(c));
    expect((await env.post('contract', { ...c, requirements: [{ ...c.requirements[0], kind: 'invalid' }] })).statusCode).toBe(400);
    const run = { ...env.run, contract: c };
    for (const text of [contractText(c), PROMPTS.developer(run), PROMPTS.author(run), PROMPTS.verifier(run, ''), PROMPTS.repair(run, ['fix']), PROMPTS.alternative(run, '')]) {
      expect(text).toContain('[R-2] (không được xảy ra)'); expect(text).toContain('Không tạo thêm đơn khi retry cùng khóa.');
    }
    expect(PROMPTS.planner(run)).toContain('expected|forbidden');
    expect(PROMPTS.synthesize(run)).toContain('forbidden');
  });

  it('requires evidence for a forbidden requirement, and preserves it in JSON and Markdown after checking', async () => {
    const c = fullContract();
    const env = setup({ check: () => green, reply: (e) => e.role === 'planner' ? `\`\`\`json\n${JSON.stringify(c)}\n\`\`\`` : undefined });
    const run = await env.drive(env.create());
    const d = env.orchestrator.detail(run.id);
    expect(d.run.status).toBe('blocked');
    expect(d.matrix.find((r) => r.requirementId === 'R-2')).toMatchObject({ kind: 'forbidden', status: 'unverified', evidence: [] });
    expect(d.completion.ready).toBe(false);
    const check = env.store.checks.list(run.id).at(-1)!;
    env.store.checks.put({ ...check, requirementIds: ['R-1', 'R-2'], testIds: ['[R-1] works', '[R-2] retry never duplicates'] });
    const verified = env.orchestrator.detail(run.id);
    expect(verified.matrix.find((r) => r.requirementId === 'R-2')).toMatchObject({ kind: 'forbidden', status: 'verified' });
    expect(verified.completion.ready).toBe(true);
    const report = await env.orchestrator.report(run.id);
    expect(report.requirements.find((r) => r.id === 'R-2')).toMatchObject({ kind: 'forbidden', tests: ['[R-2] retry never duplicates'] });
    expect(renderReportMarkdown(report)).toContain('| R-2 | Không tạo thêm đơn khi retry cùng khóa. | Không được xảy ra | verified');
    const manual = reviseContract(d.run.contract, { ...d.run.contract, requirements: d.run.contract.requirements.map((r) => r.id === 'R-2' ? { ...r, manual: true } : r) });
    env.store.runs.put({ ...d.run, contract: approveContract(manual) });
    expect(env.orchestrator.detail(run.id).matrix.find((r) => r.requirementId === 'R-2')).toMatchObject({ kind: 'forbidden', status: 'manual_pending' });
  });
});
