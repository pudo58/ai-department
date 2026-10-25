import { z } from 'zod';
import type { TaskContract } from '../shared/types.js';
import type { ManifestEntry } from '../shared/quality.js';
import { hashContract } from './contract.js';
import { parseOutput } from './outputs.js';
import { AssertionBindingSchema, ManifestSchema, StructuredManifestSchema, normalizeTestId } from './testplan.js';
import { identityId } from './testids.js';
import { readSourceBindingManifest } from './sourcebindings.js';

export async function resolveAuthorManifest(contract:TaskContract,output:string,structured:boolean,workspace:string|undefined,paths:readonly string[]):Promise<ManifestEntry[]>{
  if(structured&&parseOutput(z.object({bindingProtocol:z.unknown().optional()}).passthrough(),output).bindingProtocol===2)return readSourceBindingManifest(contract,output,workspace,paths);
  return parseAuthorManifest(contract,output,structured);
}

// Only the new output protocol may refer to an expected result instead of copying it.
// Stored manifests and historical output keep their strict, explicit expected field.
export const ReferencedManifestSchema = z.object({
  bindingProtocol: z.literal(1), contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.array(StructuredManifestSchema.shape.entries.element.extend({
    assertions: z.array(AssertionBindingSchema.extend({ expected: AssertionBindingSchema.shape.expected.optional() })).min(1).max(200),
  })).max(1000),
});

export function parseAuthorManifest(contract: TaskContract, output: string, structured: boolean): ManifestEntry[] {
  let entries: ManifestEntry[];
  if (structured) {
    // Use the shared extractor, so malformed JSON never falls back to a different protocol.
    const envelope = parseOutput(z.object({ bindingProtocol: z.unknown().optional() }).passthrough(), output);
    if (envelope.bindingProtocol !== undefined) {
      const parsed = parseOutput(ReferencedManifestSchema, output);
      if (contract.testPlan?.reasoningVersion !== 1 || parsed.contractHash !== hashContract(contract)) throw new Error('Manifest reference thuộc hợp đồng khác hoặc chưa bật reasoning.');
      entries = parsed.entries.map(e => ({ ...e, testId: identityId(e.identity), assertions: e.assertions.map(binding => {
        const step = contract.testPlan!.cases.find(c => c.id === e.caseId)?.steps?.find(s => s.id === binding.stepId);
        if (!step) throw new Error(`${e.caseId}.${binding.stepId}: không có bước đã duyệt để tham chiếu.`);
        // An explicitly wrong expected must still fail validateManifest; never silently fix it.
        return { ...binding, expected: binding.expected ?? step.expected };
      }) }));
    } else entries = parseOutput(StructuredManifestSchema, output).entries.map(e => ({ ...e, testId: identityId(e.identity) }));
  } else entries = parseOutput(ManifestSchema, output).entries;
  return entries.map(e => ({ ...e, path: e.path.replace(/\\/g, '/'), testId: normalizeTestId(e.testId),
    ...(e.identity?.kind === 'json' ? { identity: { ...e.identity, file: normalizeTestId(e.identity.file) } } : {}) }));
}

export function authorManifestScaffold(contract: TaskContract, recipeIds: string[]): string {
  return JSON.stringify({ bindingProtocol: 2, contractHash: hashContract(contract), recipeIds,
    entries: (contract.testPlan?.cases ?? []).filter(c => c.method === 'automated').map(c => ({
      caseId: c.id, requirementIds: c.requirementIds, required: c.required,
      nameTags: [...c.requirementIds, c.id].map(id => `[${id}]`).join(''),
      steps: (c.steps ?? []).map(s => ({ stepId: s.id, expected: s.expected, action: s.action })),
    })) });
}

export const AUTHOR_MANIFEST_REPAIR_TITLE = 'Author manifest repair attempt';
