import ts from 'typescript';
import {z} from 'zod';
import {readFile} from 'node:fs/promises';import path from 'node:path';
import type {TaskContract} from '../shared/types.js';import type {ManifestEntry} from '../shared/quality.js';
import {hashContract} from './contract.js';import {parseOutput} from './outputs.js';import {identityId,extractCaseIds} from './testids.js';
import {isSafeRelative} from './scope.js';import {isTestPath} from './testpath.js';

export const SourceBindingSchema=z.object({bindingProtocol:z.literal(2),contractHash:z.string().regex(/^[a-f0-9]{64}$/),files:z.array(z.object({path:z.string().min(1),recipeId:z.string().min(1)})).min(1).max(200)});

/** Explicit source declarations plus real syntax; names/tags never guess a missing binding. */
export function compileSourceBindings(contract:TaskContract,file:string,recipeId:string,source:string):ManifestEntry[]{
 if(!/\.[cm]?[jt]sx?$/.test(file))throw Error(`${file}: source binding chỉ hỗ trợ JS/TS.`);
 const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,/tsx$/.test(file)?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 const comments=(node:ts.Node)=>{let s:ts.Node=node;while(s.parent&&!ts.isExpressionStatement(s)&&!ts.isSourceFile(s.parent))s=s.parent;return (ts.getLeadingCommentRanges(source,s.getFullStart())??[]).map(r=>source.slice(r.pos,r.end)).join('\n');};
 const root=(n:ts.Node):string|undefined=>ts.isIdentifier(n)?n.text:ts.isCallExpression(n)?root(n.expression):ts.isPropertyAccessExpression(n)?root(n.expression):undefined;
 const outer=(n:ts.Node)=>(ts.isPropertyAccessExpression(n.parent)||ts.isCallExpression(n.parent))&&n.parent.expression===n;
 const entries:ManifestEntry[]=[],assertions:{node:ts.CallExpression;entry?:ManifestEntry}[]=[],problems:string[]=[];
 const visit=(node:ts.Node,titles:string[],entry?:ManifestEntry):void=>{
  if(ts.isCallExpression(node)&&['describe','test','it'].includes(root(node.expression)??'')){
   const kind=root(node.expression)!,first=node.arguments[0],callback=node.arguments.find(a=>ts.isArrowFunction(a)||ts.isFunctionExpression(a));
   if(!ts.isIdentifier(node.expression)||!first||!ts.isStringLiteralLike(first)||!callback){problems.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1}: source binding cần tên describe/test tĩnh và không dùng skip/only/each.`);return;}
   if(kind==='describe'){visit(callback,[...titles,first.text]);return;}
   const caseIds=[...comments(node).matchAll(/@aidept-case\s+(C-[A-Za-z0-9_-]+)/g)].map(m=>m[1]!);
   if(caseIds.length!==1){problems.push(`${file}: mỗi test cần đúng một @aidept-case C-x.`);return;}
   const c=contract.testPlan?.cases.find(c=>c.id===caseIds[0]&&c.method==='automated');
   if(!c){problems.push(`${file}: @aidept-case ${caseIds[0]} không phải ca tự động hiện tại.`);return;}
   const identity={kind:'json' as const,file,titles:[...titles,first.text]},next:ManifestEntry={caseId:c.id,requirementIds:[...c.requirementIds],recipeId,path:file,identity,testId:identityId(identity),assertions:[]};entries.push(next);visit(callback,titles,next);return;
  }
  if(ts.isCallExpression(node)&&!outer(node)&&((root(node.expression)==='expect'&&ts.isPropertyAccessExpression(node.expression))||root(node.expression)==='assert'))assertions.push({node,entry});
  ts.forEachChild(node,child=>visit(child,titles,entry));
 };
 visit(tree,[]);
 for(const {node,entry}of assertions){
  const text=comments(node),refs=[...text.matchAll(/@aidept-bind\s+([^\r\n*]+)/g)].flatMap(m=>m[1]!.split(/[\s,]+/).filter(Boolean)),steps=[...text.matchAll(/@aidept-step\s+(S-[A-Za-z0-9_-]+)/g)].map(m=>m[1]!);
  if(steps.length&&(steps.length!==1||!entry))problems.push(`${file}: @aidept-step cần đúng một bước bên trong test đã khai báo.`);
  const bindings=[...refs,...(entry&&steps.length===1?[`${entry.caseId}/${steps[0]}`]:[])];
  if(!bindings.length){problems.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1}: assertion thiếu @aidept-step hoặc @aidept-bind.`);continue;}
  for(const ref of bindings){const match=/^(C-[A-Za-z0-9_-]+)\/(S-[A-Za-z0-9_-]+)$/.exec(ref);if(!match){problems.push(`${file}: binding sai định dạng ${ref}.`);continue;}
   const [,caseId,stepId]=match,targets=entry?[entry].filter(e=>e.caseId===caseId):entries.filter(e=>e.caseId===caseId),step=contract.testPlan?.cases.find(c=>c.id===caseId)?.steps?.find(s=>s.id===stepId);
   if(!targets.length||!step){problems.push(`${file}: binding ${ref} không có ca/bước đúng phạm vi.`);continue;}
   for(const target of targets)target.assertions!.push({stepId:stepId!,expected:step.expected,expression:node.getText(tree),line:tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1});
  }
 }
 if(problems.length)throw Error(problems.join(' '));
 if(!entries.length)throw Error(`${file}: không có test với khai báo @aidept-case.`);
 return entries;
}

export async function readSourceBindingManifest(contract:TaskContract,output:string,workspace:string|undefined,paths:readonly string[]):Promise<ManifestEntry[]>{
 const data=parseOutput(SourceBindingSchema,output);
 if(!workspace||contract.testPlan?.reasoningVersion!==1||data.contractHash!==hashContract(contract))throw Error('Source binding thuộc hợp đồng khác hoặc runtime chưa hỗ trợ.');
 const seen=new Set<string>(),entries:ManifestEntry[]=[];
 for(const f of data.files){const file=f.path.replace(/\\/g,'/');if(!isSafeRelative(file)||!isTestPath(file)||!paths.includes(file)||seen.has(file))throw Error(`Source binding không khớp file test thay đổi: ${file}`);seen.add(file);entries.push(...compileSourceBindings(contract,file,f.recipeId,await readFile(path.join(workspace,file),'utf8')));}
 if(paths.some(p=>!seen.has(p)))throw Error('Source binding chưa kê khai mọi file test thay đổi.');
 return entries;
}

/**
 * Last resort when an Author's own bookkeeping cannot be made valid: read which test belongs to which case from the
 * static test titles (which must carry the case and requirement tags anyway). Assertions stay unbound, which the caller
 * reports as an advisory; nothing here guesses an assertion or a step.
 */
export function deriveTitleManifest(contract:TaskContract,file:string,recipeId:string,source:string):ManifestEntry[]{
 if(!/\.[cm]?[jt]sx?$/.test(file))return [];
 const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,/tsx$/.test(file)?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 const cases=new Map((contract.testPlan?.cases??[]).filter(c=>c.method==='automated').map(c=>[c.id,c]));
 const entries:ManifestEntry[]=[];
 const visit=(node:ts.Node,titles:string[]):void=>{
  if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&['describe','test','it'].includes(node.expression.text)){
   const first=node.arguments[0],callback=node.arguments.find(a=>ts.isArrowFunction(a)||ts.isFunctionExpression(a));
   if(first&&ts.isStringLiteralLike(first)&&callback){
    if(node.expression.text==='describe'){visit(callback,[...titles,first.text]);return;}
    const all=[...titles,first.text];
    for(const caseId of extractCaseIds(all.join(' '))){
     const c=cases.get(caseId);if(!c)continue;
     const identity={kind:'json' as const,file,titles:all};
     entries.push({caseId,requirementIds:[...c.requirementIds],recipeId,path:file,identity,testId:identityId(identity)});
    }
    return;
   }
  }
  ts.forEachChild(node,child=>visit(child,titles));
 };
 visit(tree,[]);
 return entries;
}
