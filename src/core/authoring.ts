import ts from 'typescript';
import type { TaskContract } from '../shared/types.js';
import { RISK_GROUPS } from '../shared/quality.js';
import type { AssertionAudit, ManifestEntry } from '../shared/quality.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
export function planningScaffold(contract: TaskContract): string {
  return JSON.stringify({ requirements: contract.requirements.map(r => ({ requirementId: r.id, quote: r.text, automaticRequired: r.required && !r.manual })),
    groups: RISK_GROUPS.map(group => ({ group, disposition: 'cases OR notApplicable reason' })),
    statefulCaseFields: { steps: [{ action: 'first action', expected: 'observable result' }, { action: 'next action', expected: 'observable result' }], invariants: ['must hold after each step'] } });
}
/** Conservative syntax check; never claims to prove test correctness. */
export function authorTestProblems(file: string, source: string): string[] {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'rejects' && ts.isCallExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'expect'
      && node.expression.arguments[0] && ts.isCallExpression(node.expression.arguments[0])) {
      const arg = node.expression.arguments[0];
      const safe = ts.isPropertyAccessExpression(arg.expression) && arg.expression.name.text === 'then';
      if (!safe) problems.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: expect(call()).rejects có thể bỏ lọt exception đồng bộ; dùng Promise.resolve().then(() => call()) nếu interface cho phép sync/async.`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return problems;
}

/**
 * Tokens of a snippet, compared by what they mean rather than how they are written: comments, whitespace, semicolons,
 * trailing commas and the choice of quote character do not matter; every literal's value, every identifier and operator does.
 */
export function assertionTokenList(expression: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, expression.trim().replace(/^await\s+/, '').replace(/;\s*$/, ''));
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SemicolonToken) continue;
    if (token === ts.SyntaxKind.StringLiteral || token === ts.SyntaxKind.NoSubstitutionTemplateLiteral) { tokens.push(`s:${scanner.getTokenValue()}`); continue; }
    if ([ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.CloseBraceToken].includes(token) && tokens.at(-1) === ',') tokens.pop();
    tokens.push(scanner.getTokenText());
  }
  return tokens;
}
export const assertionTokens = (expression: string): string => assertionTokenList(expression).join('\0');

/** Same members, in any order: the order a manifest lists requirement ids in carries no meaning. */
export const sameMembers = (a: readonly string[], b: readonly string[]): boolean => new Set(a).size === new Set(b).size && [...new Set(a)].every(x => b.includes(x));

/** A formatting correction may add observations and whole new tests, but cannot rewrite setup or remove old assertions. */
export function authorRepairSourceProblems(file: string, before: string, after: string): string[] {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return before === after ? [] : [`${file}: chỉ hỗ trợ sửa binding, không đổi source test ngoài JS/TS.`];
  const parse = (source: string) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const isCall = (n: ts.Node, names: string[]): n is ts.CallExpression => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.includes(n.expression.text);
  const staticTitle = (n: ts.CallExpression): string | undefined => { const first = n.arguments[0]; return first && ts.isStringLiteralLike(first) ? first.text : undefined; };
  /** Every test call with a static title, keyed by its describe chain, so a test added by the correction can be told from one that was there. */
  const testTitles = (source: string): Set<string> => {
    const found = new Set<string>(), tree = parse(source);
    const visit = (n: ts.Node, chain: string[]): void => {
      if (isCall(n, ['describe', 'test', 'it']) && staticTitle(n) !== undefined) {
        const title = staticTitle(n)!;
        if (isCall(n, ['describe'])) { n.arguments.forEach(a => visit(a, [...chain, title])); return; }
        found.add([...chain, title].join(' > '));
      }
      ts.forEachChild(n, c => visit(c, chain));
    };
    visit(tree, []);
    return found;
  };
  const inspect = (source: string, known?: Set<string>) => {
    const tree = parse(source);
    const spans: { start: number; end: number; tokens?: string }[] = [];
    const root = (n: ts.Node): string | undefined => ts.isIdentifier(n) ? n.text : ts.isCallExpression(n) ? root(n.expression) : ts.isPropertyAccessExpression(n) ? root(n.expression) : ts.isAwaitExpression(n) ? root(n.expression) : undefined;
    const visit = (n: ts.Node, chain: string[]): void => {
      // A whole test that the file did not have before is an addition (for example a missing required case), not a rewrite.
      if (known && ts.isExpressionStatement(n) && isCall(n.expression, ['test', 'it']) && staticTitle(n.expression) !== undefined && !known.has([...chain, staticTitle(n.expression)!].join(' > '))) { spans.push({ start: n.getStart(tree), end: n.end }); return; }
      if (ts.isExpressionStatement(n) && ['expect', 'assert'].includes(root(n.expression) ?? '')) spans.push({ start: n.getStart(tree), end: n.end, tokens: assertionTokens(n.expression.getText(tree)) });
      if (isCall(n, ['describe']) && staticTitle(n) !== undefined) { n.arguments.forEach(a => visit(a, [...chain, staticTitle(n)!])); return; }
      ts.forEachChild(n, c => visit(c, chain));
    };
    visit(tree, []);
    let stripped = source;
    for (const s of [...spans].reverse()) stripped = stripped.slice(0, s.start) + stripped.slice(s.end);
    return { body: assertionTokenList(stripped), assertions: spans.filter(s => s.tokens !== undefined).map(s => s.tokens!) };
  };
  const a = inspect(before), b = inspect(after, testTitles(before)), problems: string[] = [];
  const diverge = a.body.findIndex((token, i) => token !== b.body[i]);
  if (a.body.length !== b.body.length || diverge >= 0) {
    const at = diverge >= 0 ? diverge : Math.min(a.body.length, b.body.length), show = (t: string[]) => t.slice(Math.max(0, at - 2), at + 4).join(' ') || '(hết file)';
    problems.push(`${file}: lượt sửa manifest không được đổi setup, thao tác, danh tính test hoặc assertion lồng trong biểu thức (khác nhau ở: "${show(a.body)}" → "${show(b.body)}"). Định dạng, dấu chấm phẩy, kiểu nháy và comment được phép đổi.`);
  }
  const remaining = [...b.assertions];
  for (const old of a.assertions) { const i = remaining.indexOf(old); if (i < 0) problems.push(`${file}: không được xóa hoặc đổi assertion đã viết trong lượt sửa manifest.`); else remaining.splice(i, 1); }
  return [...new Set(problems)];
}

/** What a test file says, split into the statements that assert and everything else (setup, calls, titles). */
function splitTestSource(file: string, source: string): { body: string[]; assertions: string[]; titles: string[] } {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const spans: { start: number; end: number; tokens: string }[] = [], titles: string[] = [];
  const root = (n: ts.Node): string | undefined => ts.isIdentifier(n) ? n.text : ts.isCallExpression(n) ? root(n.expression) : ts.isPropertyAccessExpression(n) ? root(n.expression) : ts.isAwaitExpression(n) ? root(n.expression) : undefined;
  const isCall = (n: ts.Node, names: string[]): n is ts.CallExpression => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.includes(n.expression.text);
  const visit = (n: ts.Node, chain: string[]): void => {
    if (ts.isExpressionStatement(n) && ['expect', 'assert'].includes(root(n.expression) ?? '')) spans.push({ start: n.getStart(tree), end: n.end, tokens: assertionTokens(n.expression.getText(tree)) });
    if (isCall(n, ['describe', 'test', 'it'])) {
      const first = n.arguments[0];
      if (first && ts.isStringLiteralLike(first)) {
        if (isCall(n, ['describe'])) { n.arguments.forEach(a => visit(a, [...chain, first.text])); return; }
        titles.push([...chain, first.text].join(' > '));
      }
    }
    ts.forEachChild(n, c => visit(c, chain));
  };
  visit(tree, []);
  let stripped = source;
  for (const s of [...spans].reverse()) stripped = stripped.slice(0, s.start) + stripped.slice(s.end);
  return { body: assertionTokenList(stripped), assertions: spans.map(s => s.tokens), titles };
}
const sameSequence = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const sameBag = (a: readonly string[], b: readonly string[]): boolean => sameMembers(a, b) && a.length === b.length && [...new Set(a)].every(x => a.filter(y => y === x).length === b.filter(y => y === x).length);

/** v4: a setup correction may change anything but what the test asserts or is called. */
export function setupRepairProblems(file: string, before: string, after: string): string[] {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return [`${file}: chỉ đối chiếu được assertion của test JS/TS; bản sửa setup ngoài JS/TS cần Author chuyển sang đề xuất thủ công.`];
  const a = splitTestSource(file, before), b = splitTestSource(file, after), problems: string[] = [];
  if (!sameBag(a.assertions, b.assertions)) problems.push(`${file}: bản sửa setup không được thêm, xóa hoặc đổi assertion nào.`);
  if (!sameSequence(a.titles, b.titles)) problems.push(`${file}: bản sửa setup không được đổi tên, thêm hoặc xóa test.`);
  return problems;
}

/**
 * v4: a correction of assertions may change exactly the assertions it declared, each from its stated `before` to its stated
 * `after`. `used` lists the declared `before` expressions (as tokens) this file satisfied.
 */
export function assertionCorrectionProblems(file: string, before: string, after: string, changes: readonly { before: string; after: string }[]): { problems: string[]; used: string[] } {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return { problems: [`${file}: chỉ đối chiếu được assertion của test JS/TS.`], used: [] };
  const a = splitTestSource(file, before), b = splitTestSource(file, after), problems: string[] = [], used: string[] = [];
  if (!sameSequence(a.body, b.body)) problems.push(`${file}: ngoài các assertion đã khai báo, bản sửa còn đổi setup, thao tác hoặc danh tính test.`);
  if (!sameSequence(a.titles, b.titles)) problems.push(`${file}: bản sửa assertion không được đổi tên, thêm hoặc xóa test.`);
  const expected = [...a.assertions];
  for (const change of changes) {
    const was = assertionTokens(change.before), index = expected.indexOf(was);
    if (index < 0) continue;
    expected.splice(index, 1, assertionTokens(change.after)); used.push(was);
  }
  if (!sameBag(expected, b.assertions)) problems.push(`${file}: tập assertion sau khi sửa khác với đúng các thay đổi trước → sau mà bản đề xuất đã khai báo.`);
  return { problems, used };
}

/** Exact source snippets and line numbers for correction; no identity or oracle is inferred. */
export function assertionInventory(file: string, source: string): { path: string; line: number; expression: string }[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const result: { path: string; line: number; expression: string }[] = [];
  const root = (n: ts.Node): string | undefined => ts.isIdentifier(n) ? n.text : ts.isCallExpression(n) ? root(n.expression) : ts.isPropertyAccessExpression(n) ? root(n.expression) : undefined;
  const outer = (n: ts.Node) => (ts.isPropertyAccessExpression(n.parent) || ts.isCallExpression(n.parent)) && n.parent.expression === n;
  const visit = (n: ts.Node): void => { if (ts.isCallExpression(n) && !outer(n) && ((root(n.expression) === 'expect' && ts.isPropertyAccessExpression(n.expression)) || root(n.expression) === 'assert')) result.push({ path: file, line: tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1, expression: n.getText(tree) }); ts.forEachChild(n, visit); };
  visit(tree); return result;
}

export function auditAssertionSource(file: string, source: string, entries: ManifestEntry[]): { problems: string[]; advisories: string[]; audit: AssertionAudit } {
  const problems: string[] = [], advisories: string[] = [];
  if (!/\.[cm]?[jt]sx?$/.test(file)) return {problems,advisories,audit:{path:file,status:'unsupported',assertions:0,message:'Chỉ đối chiếu khai báo bước; chưa có adapter cú pháp assertion cho ngôn ngữ này.'}};
  const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,/tsx$/.test(file)?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const assertions:{expression:string;line:number;start:number}[]=[];
  const root=(node:ts.Expression):string|undefined=>ts.isIdentifier(node)?node.text:ts.isCallExpression(node)?root(node.expression):ts.isPropertyAccessExpression(node)?root(node.expression):undefined;
  const outer=(node:ts.Node):boolean=> (ts.isPropertyAccessExpression(node.parent)&&node.parent.expression===node)||(ts.isCallExpression(node.parent)&&node.parent.expression===node);
  const visit=(node:ts.Node):void=>{
    if(ts.isCallExpression(node)&&!outer(node)&&((root(node.expression)==='expect'&&ts.isPropertyAccessExpression(node.expression))||root(node.expression)==='assert'))assertions.push({expression:assertionTokens(node.getText(tree)),line:tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1,start:node.getStart(tree)});
    ts.forEachChild(node,visit);
  };
  visit(tree);
  const covered=new Set<number>();
  // Bindings that name a line are resolved first; the rest take identical assertions in source order. Two assertions with
  // the same tokens are interchangeable, so which one carries which binding is not a fact the Author has to supply.
  const bindings=entries.flatMap(entry=>(entry.assertions??[]).map(binding=>({entry,binding}))).sort((a,b)=>Number(b.binding.line!==undefined)-Number(a.binding.line!==undefined));
  for(const {entry,binding} of bindings){
    const tokens=assertionTokens(binding.expression),same=assertions.filter(a=>a.expression===tokens);
    const pick=binding.line!==undefined?same.find(a=>a.line===binding.line):same.find(a=>!covered.has(a.start))??same[0];
    if(!pick)problems.push(`${entry.caseId}.${binding.stepId}: expression không khớp assertion nào trong ${file}${same.length?` ở dòng ${binding.line}`:''}.`);
    else covered.add(pick.start);
  }
  for(const assertion of assertions)if(!covered.has(assertion.start))advisories.push(`${file}:${assertion.line}: assertion chưa liên kết với bước đã duyệt (không được tính là bằng chứng cho bước nào).`);
  return {problems,advisories,audit:{path:file,status:assertions.length?'checked':'unsupported',assertions:assertions.length,message:assertions.length?'Đã so khớp cú pháp expect/assert và khai báo bước; không chứng minh ngữ nghĩa hoặc đường thực thi.':'Chưa nhận diện expect/assert; không tuyên bố đã soát mọi assertion của framework này.'}};
}

export async function auditManifestAssertions(contract:TaskContract,entries:ManifestEntry[],workspace?:string,paths=entries.map(e=>e.path)):Promise<{problems:string[];advisories:string[];audits:AssertionAudit[]}>{
  const problems:string[]=[],advisories:string[]=[],audits:AssertionAudit[]=[];
  if(contract.testPlan?.reasoningVersion!==1)return {problems,advisories,audits};
  for(const file of new Set(paths)){
    if(!workspace){audits.push({path:file,status:'unsupported',assertions:0,message:'Runtime không cung cấp source để đối chiếu; chỉ có khai báo liên kết.'});continue;}
    try{const result=auditAssertionSource(file,await readFile(path.join(workspace,file),'utf8'),entries.filter(e=>e.path===file));problems.push(...result.problems);advisories.push(...result.advisories);audits.push(result.audit);}catch(error){problems.push(`${file}: chưa đọc được source assertion: ${(error as Error).message}`);}
  }
  return {problems,advisories,audits};
}
