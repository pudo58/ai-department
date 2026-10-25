import { describe, expect, it } from 'vitest';
import { readVerdict, renderReportMarkdown } from '../src/core/report.js';
import { green, setupLegacy as setup } from './helpers.js';

const files = (e: { role: string }) => e.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'];
async function reviewed() {
  const env = setup({ check: () => green, files });
  const run = await env.drive(env.create({ mode: 'verify', budgetUsd: 10 }));
  const verdict = env.store.artifacts.list(run.id).find((a) => a.title === 'Verifier verdict')!;
  const verifier = env.store.attempts.list(run.id).find((a) => a.role === 'verifier')!;
  const raw = env.store.artifacts.list(run.id).find((a) => a.kind === 'raw' && a.attemptId === verifier.id)!;
  return { ...env, run, verdict, verifier, raw };
}

describe('Verifier evidence belongs to an exact code and contract version', () => {
  it('keeps the matching verdict and never lets a newer stale artifact hide it', async () => {
    const { run, verdict } = await reviewed();
    expect(readVerdict([verdict, { ...verdict, checkpoint: 'old', content: '{"decision":"block"}' }], run)).toMatchObject({ decision: 'pass' });
  });

  it.each(['checkpoint', 'contractVersion', 'valid'] as const)('does not read a verdict with mismatched %s', async (field) => {
    const { run, verdict } = await reviewed();
    const stale = { ...verdict, [field]: field === 'checkpoint' ? 'old' : field === 'contractVersion' ? 99 : false };
    expect(readVerdict([stale], run)).toBeNull();
  });

  it.each(['attempt_checkpoint', 'attempt_contract', 'attempt_status', 'attempt_slot', 'raw_checkpoint', 'raw_contract', 'raw_valid', 'raw_attempt'] as const)(
    'does not recover stale raw output through %s, warns, and accepts only with acknowledgement', async (mismatch) => {
      const { store, orchestrator, runtime, run, verdict, verifier, raw } = await reviewed();
      store.artifacts.delete(verdict.id);
      if (mismatch === 'attempt_checkpoint') store.attempts.put({ ...verifier, checkpoint: 'old' });
      if (mismatch === 'attempt_contract') store.attempts.put({ ...verifier, contractVersion: 99 });
      if (mismatch === 'attempt_status') store.attempts.put({ ...verifier, status: 'interrupted' });
      if (mismatch === 'attempt_slot') store.attempts.put({ ...verifier, slot: 'B' });
      if (mismatch === 'raw_checkpoint') store.artifacts.put({ ...raw, checkpoint: 'old' });
      if (mismatch === 'raw_contract') store.artifacts.put({ ...raw, contractVersion: 99 });
      if (mismatch === 'raw_valid') store.artifacts.put({ ...raw, valid: false });
      if (mismatch === 'raw_attempt') store.artifacts.put({ ...raw, attemptId: 'other' });
      const calls = runtime.calls.slice();
      const r = await orchestrator.report(run.id);
      expect(r.verifier.verdict).toBeNull();
      expect(r.warnings).toContainEqual({ level: 'warn', text: 'Bản code này chưa có kết luận Verifier.' });
      expect(renderReportMarkdown(r)).toContain('Bản code này chưa có kết luận Verifier');
      expect(store.artifacts.list(run.id).some((a) => a.title === 'Verifier verdict')).toBe(false);
      await expect(orchestrator.acceptRun(run.id)).rejects.toMatchObject({ status: 409 });
      expect((await orchestrator.acceptRun(run.id, { acknowledgeWarnings: true })).status).toBe('completed');
      expect(runtime.calls.filter((c) => !c.startsWith('deliver:'))).toEqual(calls);
    },
  );

  it('does not read a verdict for a missing checkpoint or malformed JSON', async () => {
    const { run, verdict } = await reviewed();
    expect(readVerdict([verdict], { ...run, checkpoint: null })).toBeNull();
    expect(readVerdict([{ ...verdict, content: 'malformed JSON' }], run)).toBeNull();
  });

  it.each(['no_checkpoint', 'no_message', 'malformed_output', 'claude_result'] as const)('handles raw recovery with %s without creating a false pass', async (scenario) => {
    const { run, store, orchestrator, verdict, raw } = await reviewed();
    store.artifacts.delete(verdict.id);
    if (scenario === 'no_checkpoint') store.runs.put({ ...run, checkpoint: null });
    if (scenario === 'no_message') store.artifacts.put({ ...raw, content: 'not a JSON line\n{"type":"thread.started"}' });
    if (scenario === 'malformed_output') store.artifacts.put({ ...raw, content: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'No structured verdict' } }) });
    if (scenario === 'claude_result') store.artifacts.put({ ...raw, content: JSON.stringify({ type: 'result', result: 'Not enough evidence\n```json\n{"decision":"abstain","findings":[]}\n```' }) });
    const report = await orchestrator.report(run.id);
    expect(report.verifier.verdict?.decision ?? null).toBe(scenario === 'malformed_output' ? 'unparsed' : scenario === 'claude_result' ? 'abstain' : null);
  });

  it('recovers a matching completed Verifier even if a later attempt belongs to another checkpoint', async () => {
    const { store, orchestrator, run, verdict, verifier } = await reviewed();
    store.artifacts.delete(verdict.id);
    store.attempts.put({ ...verifier, id: 'later-stale-verifier', checkpoint: 'other' });
    expect((await orchestrator.report(run.id)).verifier.verdict).toMatchObject({ decision: 'pass' });
    expect(store.artifacts.list(run.id).filter((a) => a.title === 'Verifier verdict')).toMatchObject([{ checkpoint: run.checkpoint, contractVersion: run.contract.version }]);
  });
});
