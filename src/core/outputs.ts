import { z } from 'zod';

/** Agents end their reply with one fenced ```json block. Anything unparsable is rejected, never guessed. */
export function extractJsonBlock(text: string): unknown {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks[blocks.length - 1];
  if (!last) throw new Error('Không tìm thấy khối ```json trong phản hồi của agent.');
  return JSON.parse(last[1]!);
}

const text = z.string().max(8000);
/** Real models sometimes return structured items where a string was asked for; keep them as JSON text instead of rejecting the whole reply. */
const looseText = z.preprocess((v) => (typeof v === 'string' ? v : JSON.stringify(v)), text);
const list = z.array(looseText).max(100).default([]);

export const ContractProposalSchema = z.object({
  requirements: z.array(z.object({ id: z.string().regex(/^R-[A-Za-z0-9_-]+$/), text: text.min(1), required: z.boolean().default(true), manual: z.boolean().default(false) })).min(1).max(50),
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
  decision: z.enum(['pass', 'block', 'abstain']).default('pass'),
  findings: z.array(z.object({
    category: z.enum(['behavior', 'design']), severity: z.enum(['blocker', 'major', 'minor']),
    code: z.string().optional(), title: text.min(1), location: text.default(''),
    rule: text.optional(), precedent: text.optional(), evidence: text.default(''), suggestion: text.default(''),
  })).max(50).default([]),
});
export type FindingsOutput = z.infer<typeof FindingsSchema>;

export function parseOutput<T>(schema: z.ZodType<T>, output: string): T {
  const result = schema.safeParse(extractJsonBlock(output));
  if (!result.success) throw new Error(`Phản hồi sai định dạng: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return result.data;
}
