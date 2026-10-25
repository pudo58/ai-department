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

/** Token normalization preserves literals; comments and whitespace never stand in for an assertion. */
export function assertionTokens(expression: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, expression.trim().replace(/^await\s+/, '').replace(/;\s*$/, ''));
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) tokens.push(scanner.getTokenText());
  return tokens.join('\0');
}

/** A formatting correction may add observations, but cannot rewrite setup or remove old assertions. */
export function authorRepairSourceProblems(file: string, before: string, after: string): string[] {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return before === after ? [] : [`${file}: chỉ hỗ trợ sửa binding, không đổi source test ngoài JS/TS.`];
  const inspect = (source: string) => {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const spans: { start: number; end: number; tokens: string }[] = [];
    const root = (n: ts.Node): string | undefined => ts.isIdentifier(n) ? n.text : ts.isCallExpression(n) ? root(n.expression) : ts.isPropertyAccessExpression(n) ? root(n.expression) : ts.isAwaitExpression(n) ? root(n.expression) : undefined;
    const visit = (n: ts.Node): void => {
      if (ts.isExpressionStatement(n) && ['expect', 'assert'].includes(root(n.expression) ?? '')) spans.push({ start: n.getStart(tree), end: n.end, tokens: assertionTokens(n.expression.getText(tree)) });
      ts.forEachChild(n, visit);
    };
    visit(tree);
    let stripped = source;
    for (const s of [...spans].reverse()) stripped = stripped.slice(0, s.start) + stripped.slice(s.end);
    return { body: assertionTokens(stripped), assertions: spans.map(s => s.tokens) };
  };
  const a = inspect(before), b = inspect(after), problems: string[] = [];
  if (a.body !== b.body) problems.push(`${file}: lượt sửa manifest không được đổi setup, thao tác, danh tính test hoặc assertion lồng trong biểu thức.`);
  const remaining = [...b.assertions];
  for (const old of a.assertions) { const i = remaining.indexOf(old); if (i < 0) problems.push(`${file}: không được xóa hoặc đổi assertion đã viết trong lượt sửa manifest.`); else remaining.splice(i, 1); }
  return [...new Set(problems)];
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

export function auditAssertionSource(file: string, source: string, entries: ManifestEntry[]): { problems: string[]; audit: AssertionAudit } {
  const problems: string[] = [];
  if (!/\.[cm]?[jt]sx?$/.test(file)) return {problems,audit:{path:file,status:'unsupported',assertions:0,message:'Chỉ đối chiếu khai báo bước; chưa có adapter cú pháp assertion cho ngôn ngữ này.'}};
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
  for(const entry of entries)for(const binding of entry.assertions??[]){
    const matches=assertions.filter(a=>a.expression===assertionTokens(binding.expression)&&(binding.line===undefined||binding.line===a.line));
    if(matches.length!==1)problems.push(`${entry.caseId}.${binding.stepId}: expression không khớp duy nhất một assertion thực trong ${file}; thêm line khi trùng.`);
    else covered.add(matches[0]!.start);
  }
  for(const assertion of assertions)if(!covered.has(assertion.start))problems.push(`${file}:${assertion.line}: assertion chưa liên kết với bước đã duyệt.`);
  return {problems,audit:{path:file,status:assertions.length?'checked':'unsupported',assertions:assertions.length,message:assertions.length?'Đã so khớp cú pháp expect/assert và khai báo bước; không chứng minh ngữ nghĩa hoặc đường thực thi.':'Chưa nhận diện expect/assert; không tuyên bố đã soát mọi assertion của framework này.'}};
}

export async function auditManifestAssertions(contract:TaskContract,entries:ManifestEntry[],workspace?:string,paths=entries.map(e=>e.path)):Promise<{problems:string[];audits:AssertionAudit[]}>{
  const problems:string[]=[],audits:AssertionAudit[]=[];
  if(contract.testPlan?.reasoningVersion!==1)return {problems,audits};
  for(const file of new Set(paths)){
    if(!workspace){audits.push({path:file,status:'unsupported',assertions:0,message:'Runtime không cung cấp source để đối chiếu; chỉ có khai báo liên kết.'});continue;}
    try{const result=auditAssertionSource(file,await readFile(path.join(workspace,file),'utf8'),entries.filter(e=>e.path===file));problems.push(...result.problems);audits.push(result.audit);}catch(error){problems.push(`${file}: chưa đọc được source assertion: ${(error as Error).message}`);}
  }
  return {problems,audits};
}
