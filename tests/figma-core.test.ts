import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Sha256, sha256Bytes, sha256Text, utf8 } from '../src/shared/sha256.js';
import { canonicalJson } from '../src/shared/figma.js';
import { designRefProblems, designSummary, idHash, inTargets, mdCode, mdText, parseFigmaUrl, scopeHash, SUMMARY_MAX_CHARS, type SummaryInput } from '../src/core/design.js';
import { coverageLabel } from '../src/shared/designlabels.js';
import { bindDesign, hashContract, initialContract, reviseContract } from '../src/core/contract.js';
import type { DesignBinding } from '../src/shared/design.js';
import type { FieldValue } from '../src/shared/figma.js';
import type { TaskContract } from '../src/shared/types.js';

const node = (createHash as unknown as (a: string) => { update(d: Uint8Array | string): { digest(e: 'hex'): string } });

describe('the SHA-256 the plugin carries agrees with Node', () => {
  it.each([0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_000])('hashes %i bytes the same way, whole and in pieces', (n) => {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
    const want = node('sha256').update(bytes).digest('hex');
    expect(sha256Bytes(bytes)).toBe(want);
    const pieces = new Sha256();
    for (let i = 0; i < n; i += 37) pieces.update(bytes.subarray(i, i + 37));
    expect(pieces.hex()).toBe(want);
  });

  it('encodes text as UTF-8 like TextEncoder, with a lone surrogate replaced', () => {
    for (const text of ['', 'abc', 'Xin chào Figma', '日本語 🎨 emoji', 'a\u0000b']) expect([...utf8(text)]).toEqual([...new TextEncoder().encode(text)]);
    expect([...utf8('x\ud800y')]).toEqual([...new TextEncoder().encode('x\ud800y')]);
    expect(sha256Text('Đăng nhập')).toBe(node('sha256').update('Đăng nhập').digest('hex'));
  });

  it('writes the same canonical JSON whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined, e: null }] })).toBe(canonicalJson({ a: [{ e: null, d: 2 }], b: 1 }));
  });
});

describe('which file a person means, and what a Figma string is allowed to do', () => {
  it('reads a Figma URL for its file key, branch and node, and rejects anything else', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/AbCdEfGhIj123/Ten-file?node-id=12-34&t=x')).toEqual({ fileKey: 'AbCdEfGhIj123', nodeId: '12:34' });
    expect(parseFigmaUrl('https://figma.com/file/AbCdEfGhIj123/x')).toEqual({ fileKey: 'AbCdEfGhIj123' });
    expect(parseFigmaUrl('https://www.figma.com/design/AbCdEfGhIj123/branch/Branch123456/Ten')).toEqual({ fileKey: 'AbCdEfGhIj123', branchKey: 'Branch123456' });
    for (const bad of ['http://www.figma.com/design/AbCdEfGhIj123/x', 'https://evil.com/design/AbCdEfGhIj123/x', 'https://www.figma.com.evil.com/design/AbCdEfGhIj123/x', 'https://www.figma.com/design/short/x', 'https://www.figma.com/community/plugin/1', 'not a url', '']) expect(parseFigmaUrl(bad), bad).toBeNull();
    expect(parseFigmaUrl('https://www.figma.com/design/AbCdEfGhIj123/x?node-id=../../etc')).toEqual({ fileKey: 'AbCdEfGhIj123' });
  });

  it('keeps a scope hash the same for the same scope and different for a different source session or limit', () => {
    const base = { scope: 'selection' as const, rootIds: ['2:1', '1:1'], pageIds: [], sourceSession: 'abc', limits: { jobMs: 1, maxNodes: 2, maxBytes: 3, maxAssetBytes: 4 } };
    expect(scopeHash(base)).toBe(scopeHash({ ...base, rootIds: ['1:1', '2:1'] }));
    expect(scopeHash(base)).not.toBe(scopeHash({ ...base, sourceSession: 'abd' }));
    expect(scopeHash(base)).not.toBe(scopeHash({ ...base, limits: { ...base.limits, maxNodes: 9 } }));
    expect(idHash('1:2')).toMatch(/^[a-f0-9]{16}$/);
  });

  it('neutralises markup, fences, tables and control characters in a layer name', () => {
    const hostile = 'x</script><img src=1 onerror=alert(1)> ```js\n# heading | pipe [link](http://e) \u0000';
    const out = mdText(hostile);
    // No raw angle bracket or control character survives, and every backtick, pipe and bracket is escaped, so it cannot open markup or a table.
    expect(out).not.toMatch(/[<>\n\u0000]/);
    expect(out).not.toMatch(/(^|[^\\])[`|[\]#]/);
    expect(out).toContain('&lt;/script&gt;');
    expect(mdCode('a`b\nc')).toBe('`a b c`');
  });
});

const field = (s: FieldValue['s'], v?: unknown, r?: string): FieldValue => ({ s, ...(v !== undefined ? { v: v as never } : {}), ...(r ? { r } : {}) });
const nodes: Record<string, { id: string; type: string; parentId: string | null; fields: Record<string, FieldValue> }> = {
  frame: { id: '1:1', type: 'FRAME', parentId: null, fields: { 'common.name': field('read', 'F'), 'layout.paddingLeft': field('read', 0) } },
  text: { id: '1:2', type: 'TEXT', parentId: '1:1', fields: {
    'text.characters': field('read', 'Xin chào'), 'text.fontName': field('mixed', { $mixed: true, detail: { via: 'text.segments' } }), 'text.fontSize': field('mixed', { $mixed: true }),
    'text.hasMissingFont': field('unavailable', undefined, 'API không trả'), 'layout.layoutGrow': field('not_applicable', undefined, 'không có'), 'paint.fills': field('error', undefined, 'boom'), 'paint.strokes': field('unsupported', undefined, 'chưa'),
  } },
  stray: { id: '9:9', type: 'FRAME', parentId: null, fields: {} },
};
const lookup = (id: string) => Object.values(nodes).find((n) => n.id === id);
const binding = (targetIds: string[] = []): DesignBinding => ({ snapshotId: 'dsn_x', snapshotHash: 'h'.repeat(64), targetIds, acknowledgedIssueIds: [], designPolicyVersion: 1 });
const contractWith = (refs: { nodeId: string; fieldPath: string }[], onCase = false): TaskContract => ({
  ...initialContract('x'),
  requirements: [{ id: 'R-1', text: 'x', required: true, manual: false, ...(onCase ? {} : { designRefs: refs }) }],
  ...(onCase ? { testPlan: { schemaVersion: 2, cases: [{ id: 'C-1', requirementIds: ['R-1'], group: 'happy', risk: 'r', priority: 'high', preconditions: 'p', actions: 'a', expected: 'e', method: 'automated', required: true, designRefs: refs }], notApplicable: [], questions: [] } } : {}),
});

describe('a requirement that depends on a design field needs that field to have been read', () => {
  it('accepts a read field and a mixed one whose breakdown was captured, from a requirement or a case', () => {
    expect(designRefProblems(contractWith([{ nodeId: '1:2', fieldPath: 'text.characters' }]), lookup, binding())).toEqual([]);
    expect(designRefProblems(contractWith([{ nodeId: '1:2', fieldPath: 'text.fontName' }], true), lookup, binding())).toEqual([]);
    expect(designRefProblems(contractWith([{ nodeId: '1:1', fieldPath: 'layout.paddingLeft' }]), lookup, binding())).toEqual([]);
  });

  it.each([
    ['text.fontSize', /mixed/],            // a bare "mixed" says nothing
    ['text.hasMissingFont', /unavailable/],
    ['paint.fills', /error \(boom\)/],
    ['paint.strokes', /unsupported/],
    ['layout.layoutGrow', /not_applicable/],
    ['text.nonexistent', /không có trường/],
  ])('refuses %s, however many warnings were ticked', (fieldPath, why) => {
    const problems = designRefProblems(contractWith([{ nodeId: '1:2', fieldPath }]), lookup, binding());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(why);
  });

  it('refuses a node the snapshot lacks, a node outside the chosen targets, and any reference when nothing is bound', () => {
    expect(designRefProblems(contractWith([{ nodeId: '7:7', fieldPath: 'x' }]), lookup, binding())[0]).toContain('7:7');
    expect(designRefProblems(contractWith([{ nodeId: '9:9', fieldPath: 'common.name' }]), lookup, binding(['1:1']))[0]).toContain('ngoài target');
    expect(designRefProblems(contractWith([{ nodeId: '1:2', fieldPath: 'text.characters' }]), lookup, binding(['1:1']))).toEqual([]);
    expect(designRefProblems(contractWith([{ nodeId: '1:2', fieldPath: 'text.characters' }]), undefined, undefined)[0]).toContain('chưa gắn snapshot');
    expect(designRefProblems(initialContract('không cần thiết kế'), undefined, undefined)).toEqual([]);
  });

  it('walks up the recorded parents to decide whether a node is inside a target', () => {
    expect(inTargets('1:2', ['1:1'], lookup)).toBe(true);
    expect(inTargets('9:9', ['1:1'], lookup)).toBe(false);
    expect(inTargets('9:9', [], lookup)).toBe(true);
  });
});

describe('the design binding belongs to the server, and old contracts keep their hash', () => {
  const bound = (): TaskContract => ({ ...initialContract('x'), design: binding(['1:1']) });

  it('leaves a contract with no design byte for byte what it was, so an old run keeps its hash', () => {
    const c = initialContract('yêu cầu cũ');
    expect(canonicalJson(c)).not.toContain('design');
    expect(hashContract(c)).toBe(hashContract({ ...c, design: undefined }));
  });

  it('lets a Planner proposal neither drop nor replace it', () => {
    const current = bound();
    const proposal = { requirements: current.requirements, acceptanceExamples: [], interfaces: [], assumptions: [], scope: [] };
    expect(reviseContract(current, proposal)).toBe(current);
    const withOther = reviseContract(current, { ...proposal, assumptions: ['mới'], design: { ...binding(), snapshotId: 'dsn_khac' } } as never);
    expect(withOther.design).toEqual(current.design);
    expect(withOther.version).toBe(2);
  });

  it('changes only by an explicit choice, which raises the version and drops the approval', () => {
    const current = { ...bound(), approvedHash: 'x', approvedAt: 'y' };
    const other = bindDesign(current, { ...binding(), snapshotId: 'dsn_y' });
    expect(other).toMatchObject({ version: 2, design: { snapshotId: 'dsn_y' } });
    expect(other.approvedHash).toBeUndefined();
    expect(bindDesign(current, current.design)).toBe(current);
    expect(bindDesign(current, undefined).design).toBeUndefined();
    expect(bindDesign(current, undefined).version).toBe(2);
  });
});

const summaryInput = (over: Partial<SummaryInput> = {}): SummaryInput => ({
  snapshotId: 'dsn_1', snapshotHash: 'a'.repeat(64), coverageText: 'Có giới hạn', limited: true, identity: 'verified',
  issues: [{ id: 'i1', message: 'Trường text.fontName không đọc được' }],
  targets: [{ id: '1:1', name: 'Màn <hình>', type: 'FRAME', page: 'Trang 1' }],
  components: [{ id: '2:1', name: 'Button', axes: ['size'] }], tokens: { styles: 2, variables: 3, collections: ['Màu'] }, assets: [{ id: 'f'.repeat(64), kind: 'original_image', mime: 'image/png', bytes: 100 }],
  mountPath: '/aidept-design', ...over,
});

describe('what each role is told about the design', () => {
  it('gives every role the source, the limits and the targets, and the builders more', () => {
    const planner = designSummary('planner', summaryInput()), dev = designSummary('developer', summaryInput()), verifier = designSummary('verifier', summaryInput());
    for (const text of [planner, dev, verifier]) { expect(text).toContain('/aidept-design'); expect(text).toContain('Có giới hạn'); expect(text).toContain('visual verification'); expect(text).toContain('Màn \\<hình\\>'.replace('\\<', '&lt;').replace('\\>', '&gt;')); }
    expect(planner).not.toContain('Component (');
    expect(dev).toContain('Component (1)');
    expect(dev).toContain('Tài nguyên (1)');
    expect(verifier).not.toContain('Component (');
  });

  it('never exceeds its size, and says so when it cuts, pointing at the index', () => {
    const many = summaryInput({ targets: Array.from({ length: 5000 }, (_, i) => ({ id: `1:${i}`, name: 'n'.repeat(40), type: 'FRAME' })) });
    const text = designSummary('developer', many);
    expect(text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(text).toContain('index.json');
    expect(designSummary('developer', summaryInput({ limited: false, issues: [] }))).not.toContain('Giới hạn đã được chấp nhận');
  });

  it('uses only two labels for what was read, and never claims the design was understood', () => {
    const issue = (severity: 'limit' | 'blocker' | 'info') => ({ id: 'x', code: 'c', severity, message: 'm' });
    const c = {} as never;
    expect(coverageLabel(c, [])).toEqual({ limited: false, text: 'Đã đọc đủ cấu trúc trong phạm vi' });
    expect(coverageLabel(c, [issue('info')]).limited).toBe(false);
    expect(coverageLabel(c, [issue('limit')])).toEqual({ limited: true, text: 'Có giới hạn' });
  });
});
