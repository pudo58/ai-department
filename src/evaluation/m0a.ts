import { z } from 'zod';
import { reviewerModel } from './manifest.js';
import { wilson, type Interval } from './stats.js';
import type { M0aManifest, ReviewCase, ReviewInput, ReviewRecord, ReviewResponse, ReviewVariant, Reviewer } from './types.js';

const ResponseSchema = z.object({
  decision: z.enum(['block', 'pass', 'abstain']),
  findings: z.array(z.object({
    id: z.string(), category: z.enum(['behavior', 'design']), severity: z.enum(['blocker', 'major', 'minor']),
    title: z.string(), location: z.string(), evidence: z.string(), rule: z.string().optional(),
  })),
});

/** The reviewer only ever sees requirement, policy and sources: no ground truth, author model or provenance. */
export function toReviewInput(c: ReviewCase): ReviewInput {
  return { caseId: c.caseId, requirement: c.requirement, policy: c.policy, base: c.base, candidate: c.candidate };
}

export function parseReviewResponse(raw: unknown): ReviewResponse | undefined {
  let value = raw;
  if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { return undefined; } }
  const parsed = ResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Runs every case × variant × repetition through a reviewer in a fresh session. Reviewer failures and
 * malformed output stay in the sample as non-decisions; nothing is dropped.
 */
export async function runM0a(manifest: M0aManifest, manifestHash: string, reviewer: Reviewer): Promise<ReviewRecord[]> {
  const records: ReviewRecord[] = [];
  // A session id seen twice means a reviewer kept context across cases, which breaks the fresh-session rule.
  const seenSessions = new Set<string>();
  for (const c of manifest.cases) for (const variant of manifest.variants) for (let repetition = 1; repetition <= manifest.repetitions; repetition++) {
    const requestedModel = reviewerModel(c.authorModel, manifest.models, variant);
    const sessionId = `${manifestHash.slice(0, 8)}-${c.caseId}-${variant}-${repetition}`;
    const base = { id: sessionId, manifestHash, caseId: c.caseId, variant, repetition, requestedModel, adjudications: [] };
    try {
      const out = await reviewer(toReviewInput(c), { model: requestedModel, variant, sessionId, freshSession: true });
      const response = parseReviewResponse(out.rawOutput);
      const reusedSession = !out.sessionId || seenSessions.has(out.sessionId);
      seenSessions.add(out.sessionId);
      const status = !response ? 'invalid' : out.model !== requestedModel || reusedSession ? 'invalid' : 'completed';
      records.push({ ...base, status, response: status === 'completed' ? response : undefined, rawOutput: out.rawOutput, actualModel: out.model, sessionId: out.sessionId, durationMs: out.durationMs, costUsd: out.costUsd,
        error: status === 'invalid' ? (!response ? 'Output không đúng schema.' : 'Model hoặc phiên không đúng cấu hình yêu cầu.') : undefined });
    } catch (error) {
      records.push({ ...base, status: 'error', rawOutput: null, error: (error as Error).message, actualModel: '', sessionId, durationMs: 0, costUsd: null });
    }
  }
  return records;
}

export interface Confusion { tp: number; fp: number; fn: number; tn: number; abstained: number; invalid: number }
export interface GroupReport {
  variant: ReviewVariant | 'all'; records: number; confusion: Confusion;
  /** Case-level: of cases the reviewer blocked, how many truly had a defect. */
  casePrecision: Interval; caseRecall: Interval; falseBlockRate: Interval;
  /** Finding-level, from independent adjudication. Unresolved findings count against precision. */
  findingPrecision: Interval; findingPrecisionByCategory: Record<'behavior' | 'design', Interval>;
  recallByCategory: Record<'behavior' | 'design', Interval>;
  arbitrationMinutes: number; costUsd: number | null; unadjudicated: number;
}

/**
 * A non-decision (abstain, invalid, error) never counts as a block: positives become misses, negatives
 * stay correct. It is counted openly so a reviewer cannot look good by refusing to answer.
 */
export function evaluateGroup(manifest: M0aManifest, records: readonly ReviewRecord[], variant: ReviewVariant | 'all'): GroupReport {
  const cases = new Map(manifest.cases.map((c) => [c.caseId, c]));
  const rows = records.filter((r) => variant === 'all' || r.variant === variant);
  const confusion: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0, abstained: 0, invalid: 0 };
  let supported = 0, judged = 0, unadjudicated = 0, minutes = 0, cost: number | null = 0;
  const byCat = { behavior: { s: 0, n: 0 }, design: { s: 0, n: 0 } };
  const recall = { behavior: { hit: 0, n: 0 }, design: { hit: 0, n: 0 } };
  for (const r of rows) {
    const truth = cases.get(r.caseId)?.truth;
    if (!truth) continue;
    const positive = truth.kind !== 'clean';
    const blocked = r.status === 'completed' && r.response?.decision === 'block';
    if (r.status !== 'completed') confusion.invalid++;
    else if (r.response?.decision === 'abstain') confusion.abstained++;
    if (positive) blocked ? confusion.tp++ : confusion.fn++; else blocked ? confusion.fp++ : confusion.tn++;
    minutes += r.arbitrationMinutes ?? 0;
    cost = cost === null || r.costUsd === null ? null : cost + r.costUsd;

    const reported = r.response?.findings ?? [];
    for (const f of reported) {
      const verdict = r.adjudications.find((a) => a.findingId === f.id);
      if (!verdict) { unadjudicated++; judged++; byCat[f.category].n++; continue; }
      judged++; byCat[f.category].n++;
      if (verdict.verdict === 'supported') { supported++; byCat[f.category].s++; }
    }
    for (const gold of truth.findings) {
      recall[gold.category].n++;
      if (r.adjudications.some((a) => a.verdict === 'supported' && a.goldId === gold.id)) recall[gold.category].hit++;
    }
  }
  return {
    variant, records: rows.length, confusion,
    casePrecision: wilson(confusion.tp, confusion.tp + confusion.fp), caseRecall: wilson(confusion.tp, confusion.tp + confusion.fn),
    falseBlockRate: wilson(confusion.fp, confusion.fp + confusion.tn),
    findingPrecision: wilson(supported, judged),
    findingPrecisionByCategory: { behavior: wilson(byCat.behavior.s, byCat.behavior.n), design: wilson(byCat.design.s, byCat.design.n) },
    recallByCategory: { behavior: wilson(recall.behavior.hit, recall.behavior.n), design: wilson(recall.design.hit, recall.design.n) },
    arbitrationMinutes: minutes, costUsd: cost, unadjudicated,
  };
}

export const PILOT_TARGET = { precision: 0.9, recall: 0.7, falseBlock: 0.1 } as const;
export interface PilotVerdict { meetsPilotTarget: boolean; mayBlockAutomatically: false; notes: string[] }

/**
 * Pilot gate only. Even a pass never grants blocking authority: that needs a confirmation run on natural
 * workload with fresh, held-out cases. A miss downgrades the Verifier to advisory/test-generation.
 */
export function pilotVerdict(report: GroupReport): PilotVerdict {
  const notes = [
    'Bộ case cố ý nhiều lỗi nên không đại diện tỷ lệ lỗi thực; cần xác nhận trên workload tự nhiên với case mới giữ kín.',
    `Mẫu nhỏ (${report.records} lượt): khoảng tin cậy Wilson rộng, đây không phải chứng nhận.`,
  ];
  const p = report.casePrecision.estimate, r = report.caseRecall.estimate, f = report.falseBlockRate.estimate;
  const meets = p >= PILOT_TARGET.precision && r >= PILOT_TARGET.recall && f <= PILOT_TARGET.falseBlock;
  if (!meets) notes.push('Dưới mục tiêu pilot: Verifier chỉ chạy tư vấn hoặc tạo phép thử; finding cần runner/người xác nhận trước khi chặn.');
  if (report.confusion.abstained || report.confusion.invalid) notes.push(`${report.confusion.abstained} abstain và ${report.confusion.invalid} lượt không hợp lệ vẫn nằm trong mẫu.`);
  if (report.unadjudicated) notes.push(`${report.unadjudicated} finding chưa được phân xử độc lập; chúng bị tính là không được chứng minh.`);
  return { meetsPilotTarget: meets, mayBlockAutomatically: false, notes };
}
