import { z } from 'zod';

/** Parse a fenced block, pure JSON, or a complete trailing JSON value on its own lines.
 * No brace balancing, JSON repair, schema coercion, or fallback from a malformed fenced result. */
export function extractJsonBlock(text: string): unknown {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks[blocks.length - 1];
  if (!last) {
    try { return JSON.parse(text.trim()); }
    catch {
      const lines = text.trim().split(/\r?\n/), candidates: unknown[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!/^[\[{]/.test(lines[i]!.trim())) continue;
        try { candidates.push(JSON.parse(lines.slice(i).join('\n'))); } catch { /* Only complete trailing JSON is eligible. */ }
      }
      if (candidates.length === 1) return candidates[0];
      throw new Error('Không tìm thấy khối ```json hoặc một giá trị JSON hoàn chỉnh ở cuối phản hồi.');
    }
  }
  return JSON.parse(last[1]!);
}

const text = z.string().max(8000);
/** Real models sometimes return structured items where a string was asked for; keep them as JSON text instead of rejecting the whole reply. */
const looseText = z.preprocess((v) => (typeof v === 'string' ? v : JSON.stringify(v)), text);
const list = z.array(looseText).max(100).default([]);

export const ContractProposalSchema = z.object({
  requirements: z.array(z.object({ id: z.string().regex(/^R-[A-Za-z0-9_-]+$/), text: text.min(1), required: z.boolean().default(true), manual: z.boolean().default(false), kind: z.enum(['expected', 'forbidden']).optional() })).min(1).max(50),
  acceptanceExamples: list, interfaces: list, assumptions: list, scope: list,
});
export type ContractProposal = z.infer<typeof ContractProposalSchema>;

export const InterpretationSchema = z.object({ interpretation: text.min(1), questions: list });

export const ReuseAssessmentSchema = z.object({
  reuse: z.array(z.object({
    path: z.string().min(1), fit: z.enum(['high', 'partial', 'low']),
    decision: z.enum(['use', 'extend', 'refactor', 'new']), reason: text.min(1),
  })).max(50),
});
export type ReuseAssessment = z.infer<typeof ReuseAssessmentSchema>;

export const FindingsSchema = z.object({
  scope: z.object({reviewed:z.array(text.min(1)).max(100),checkIds:z.array(text.min(1)).max(100),limitations:z.array(text.min(1)).max(100),additionalChecks:z.array(z.object({command:text.min(1),status:z.enum(['passed','failed','incomplete']),detail:text})).max(100)}).optional(),
  decision: z.enum(['pass', 'block', 'abstain']).default('pass'),
  findings: z.array(z.object({
    category: z.enum(['behavior', 'design']), severity: z.enum(['blocker', 'major', 'minor']),
    code: z.string().optional(), title: text.min(1), location: text.default(''),
    rule: text.optional(), precedent: text.optional(), evidence: text.default(''), suggestion: text.default(''),
    reproduction: z.unknown().optional(), reproductionLimitation: text.optional(),
  })).max(50).default([]),
});
export type FindingsOutput = z.infer<typeof FindingsSchema>;

export function parseOutput<T>(schema: z.ZodType<T>, output: string): T {
  const result = schema.safeParse(extractJsonBlock(output));
  if (!result.success) throw new Error(`Phản hồi sai định dạng: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return result.data;
}
