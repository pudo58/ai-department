import { afterEach, describe, expect, it } from 'vitest';
import type { CandidateRecord } from '../src/server/run/support.js';
import { cleanupFixtures, v4Fixture } from './v4-fixtures.js';

afterEach(cleanupFixtures);

/** A run whose Verifier found a defect it could not prove, then repaired at the person's request: two checkpoints, the second one the real head. */
async function repairedRun() {
  const f = await v4Fixture({ finding: 'prose' });
  await f.approve(f.run.id);
  const stopped = f.orch.detail(f.run.id);
  const first = stopped.run.checkpoint!, findingId = stopped.findings[0]!.id;
  f.orch.confirmFinding(f.run.id, findingId, { manualReason: 'Đã đọc: đúng là lỗi thật cần sửa.' });
  f.orch.repairFindings(f.run.id);
  await f.orch.idle();
  const repaired = f.orch.detail(f.run.id).run.checkpoint!;
  const candidate = () => JSON.parse(f.store.artifacts.get(`cand-${f.run.id}-A`)!.content) as CandidateRecord;
  return { f, first, repaired, candidate };
}

describe('a repair of a confirmed finding is the new head of the run', () => {
  it('is what the stored candidate points at, so nothing later can move the run back to the version before it', async () => {
    const { first, repaired, candidate } = await repairedRun();
    expect(repaired).not.toBe(first);
    expect(candidate().checkpoint).toBe(repaired);
    expect(candidate().success).toBe(true);
  }, 120000);

  it('stays the checkpoint when the person presses "Chạy tiếp" afterwards, and no agent is called for it', async () => {
    const { f, repaired } = await repairedRun();
    const agentCalls = f.calls.length;
    f.orch.resumeRun(f.run.id);
    await f.orch.idle();
    expect(f.orch.detail(f.run.id).run.checkpoint).toBe(repaired);
    expect(f.calls.length).toBe(agentCalls);
  }, 120000);

  it('brings a run that an older version already moved back forward to the repaired head, from what the run recorded', async () => {
    const { f, first, repaired, candidate } = await repairedRun();
    // What the run looked like after the old behaviour: the candidate and the run both pointing at the version before the repair.
    const stored = f.store.artifacts.get(`cand-${f.run.id}-A`)!;
    f.store.artifacts.put({ ...stored, content: JSON.stringify({ ...candidate(), checkpoint: first }) });
    f.store.runs.put({ ...f.store.runs.get(f.run.id)!, checkpoint: first });
    f.orch.resumeRun(f.run.id);
    await f.orch.idle();
    expect(f.orch.detail(f.run.id).run.checkpoint).toBe(repaired);
    expect(candidate().checkpoint).toBe(repaired);
  }, 120000);

  it('is also done when the server starts, so the page is true before anyone presses anything', async () => {
    const { f, first, repaired, candidate } = await repairedRun();
    const stored = f.store.artifacts.get(`cand-${f.run.id}-A`)!;
    f.store.artifacts.put({ ...stored, content: JSON.stringify({ ...candidate(), checkpoint: first, success: false, problems: ['Report không thuộc checkpoint đang kiểm tra.'] }) });
    f.store.runs.put({ ...f.store.runs.get(f.run.id)!, checkpoint: first });
    await f.orch.recover();
    expect(f.orch.detail(f.run.id).run.checkpoint).toBe(repaired);
    expect(candidate()).toMatchObject({ checkpoint: repaired, success: true, problems: [] });
  }, 120000);
});
