import { TestPlanSchema } from '../../core/testplan.js';
import { z } from 'zod';
import { isSafeRelative } from '../../core/scope.js';
import { MEMORY_KINDS, MEMORY_MAX_TEXT } from '../../core/memory.js';
import type { MemoryKind } from '../../shared/types.js';
import { GUIDANCE_MAX_CHARS, normalizeGuidance } from '../../shared/guidance.js';

/** Request body schemas shared by the route modules. */
const ROLES = ['planner', 'author', 'developer', 'verifier', 'investigator'] as const;
const RoleConfig = z.object({ provider: z.enum(['codex', 'claude', 'antigravity']), model: z.string().max(100).default(''), effort: z.enum(['low', 'medium', 'high']).default('medium'), skills: z.array(z.string().max(500)).max(20).default([]) });
const Recipe = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), command: z.array(z.string().max(1000)).min(1).max(50), required: z.boolean().default(true), timeoutMs: z.number().int().min(1000).max(3_600_000).default(600_000), reportPath: z.string().max(300).optional() });
const Budget = z.number().int().min(0).max(20_000);
const MemoryPath = z.string().trim().min(1).max(300).refine((p) => isSafeRelative(p), 'Đường dẫn phải là đường dẫn tương đối trong repo.');
export const MemoryBody = z.object({
  kind: z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]), text: z.string().trim().min(3).max(MEMORY_MAX_TEXT),
  paths: z.array(MemoryPath).max(10).default([]), pinned: z.boolean().default(false),
});
export const ProjectBody = z.object({
  name: z.string().trim().min(1).max(120), repository: z.string().trim().min(1).max(500),
  modules: z.array(z.string().trim().min(1).max(300)).min(1).max(50),
  checks: z.array(Recipe).min(1).max(20).refine((list) => new Set(list.map((c) => c.id)).size === list.length, 'Mỗi check cần một id riêng.'),
  guidance: z.string().max(GUIDANCE_MAX_CHARS, `Hướng dẫn tối đa ${GUIDANCE_MAX_CHARS} ký tự.`).transform(normalizeGuidance).default(''),
  singleBudgetUsd: z.number().positive().max(1000), roles: z.object(Object.fromEntries(ROLES.map((r) => [r, RoleConfig])) as Record<typeof ROLES[number], typeof RoleConfig>),
  runnerImage: z.string().trim().min(1).max(300), setupCommand: z.array(z.string().max(1000)).max(50).default([]),
  agentNetwork: z.string().max(100).default('aidept-agent'),
  executionMode: z.enum(['docker', 'local']).default('local'),
  mutationRoot: z.string().max(300).refine((p) => p === '' || p === '.' || isSafeRelative(p), 'Thư mục mutation phải nằm trong repo.').optional(),
  regressionDir: z.string().max(300).refine((p) => p === '' || isSafeRelative(p), 'Thư mục regression phải nằm trong repo.').optional(),
  regressionRecipe: z.union([z.literal(''), z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)]).optional(),
  contextEnabled: z.boolean().default(false),
  allowScaffold: z.boolean().default(false),
  previewCommand: z.array(z.string().min(1).max(1000)).max(50).default([]),
  contextBudget: z.object({ planner: Budget, developer: Budget, author: Budget, verifier: Budget }).partial().default({}),
});
export const RunBody = z.object({
  projectId: z.string(), title: z.string().trim().min(1).max(180), originalRequirement: z.string().trim().min(1).max(20000),
  mode: z.enum(['single', 'clarify', 'verify', 'compare']).default('single'), provider: z.enum(['fake', 'codex', 'claude']).default('fake'),
  budgetUsd: z.number().positive().max(1000), signals: z.array(z.string().max(40)).max(10).default([]),
  taskKind: z.enum(['bugfix', 'feature', 'refactor']).optional(),
  /** Omitted: the project's default design snapshot; `snapshotId: null`: none. The server fixes the hash. */
  design: z.object({ snapshotId: z.string().max(40).nullable(), targetIds: z.array(z.string().min(1).max(200)).max(200).optional() }).optional(),
});
export const ContractBody = z.object({
  testPlan: TestPlanSchema.optional(),
  requirements: z.array(z.object({ id: z.string(), text: z.string().max(8000), required: z.boolean(), manual: z.boolean(), kind: z.enum(['expected', 'forbidden']).optional(), designRefs: z.array(z.object({ nodeId: z.string().min(1).max(200), fieldPath: z.string().min(1).max(300) })).max(50).optional() })).min(1).max(50),
  acceptanceExamples: z.array(z.string().max(4000)).max(100), interfaces: z.array(z.string().max(4000)).max(100),
  assumptions: z.array(z.string().max(4000)).max(100), scope: z.array(z.string().max(500)).max(100),
});
export const Category = z.enum(['clarification', 'approval', 'review', 'quota', 'acceptance', 'rework', 'onboarding', 'research']);
