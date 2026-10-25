import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve('.'),out=path.join(root,'test-results/2026-10-25-escrowbatch-rerun');
const read=async f=>JSON.parse(await readFile(path.join(out,f),'utf8'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const protocol=await read('protocol.json'),rows=await read('runs.json'),audit=await read('grader-audit.json');
if(rows.length!==2||rows.some(r=>!r.endedAt))throw new Error('Both runs must finish first');
if(hash(await readFile(path.join(out,'grade.mjs')))!==protocol.graderHash||hash(await readFile(path.join(out,'reference.mjs')))!==protocol.referenceHash||hash(await readFile(path.join(out,'SPEC.md')))!==protocol.specHash)throw new Error('Frozen input changed');
const manifest=await read('source-manifest.json');
for(const f of manifest.filter(f=>f.path.startsWith('src/')||f.path==='package.json'||f.path==='pnpm-lock.yaml'))if(hash(await readFile(path.join(root,f.path)))!==f.sha256)throw new Error(`Product source changed: ${f.path}`);
const summaries=[];
for(const row of rows){
  const detail=await read(`${row.arm}-detail.json`),grade=row.grade?await read(`${row.arm}-grade.json`):null;
  const sum=key=>row.usage.reduce((n,u)=>n+(u[key]??0),0);
  const summary={arm:row.arm,runId:row.runId,status:row.status,checkpoint:row.checkpoint,candidateProduced:!!grade,automaticMs:detail.execution?.automaticMs??row.automaticMs,waitingMs:detail.execution?.waitingMs??null,agentMs:detail.execution?.agentMs??null,attempts:row.attempts.length,roles:Object.fromEntries([...new Set(row.attempts.map(a=>a.role))].map(role=>[role,row.attempts.filter(a=>a.role===role).length])),models:[...new Set(row.attempts.map(a=>a.model))],inputTokens:sum('inputTokens'),cachedTokens:sum('cachedTokens'),outputTokens:sum('outputTokens'),estimatedUsd:detail.budget?.spentUsd??null,interventions:row.interventions,blocker:row.blocker,contractProblems:detail.contractReview.problems,testPlanCases:detail.run.contract.testPlan?.cases.length??0,checks:detail.checks?.map(c=>({recipeId:c.recipeId,status:c.status,counts:c.counts,checkpoint:c.checkpoint}))??[],mutation:row.mutation,grade:grade?{passed:grade.passed,total:grade.total,score:grade.score,byGroup:grade.byGroup,failures:grade.results.filter(t=>t.status==='FAILED')}:null};
  if(grade){
    const dest=path.join(out,`candidate-${row.arm}`);await mkdir(dest,{recursive:true});
    for(const file of ['src','tests','README.md','SPEC.md','package.json','vitest.config.js'])await cp(path.join(row.workspace,file),path.join(dest,file),{recursive:true});
    const source=await readFile(path.join(dest,'src/ledger.js'),'utf8');summary.sourceLines=source.split(/\r?\n/).length;summary.sourceBytes=Buffer.byteLength(source);summary.sourceHash=hash(source);
  }
  summaries.push(summary);
}
let review=null;try{review=await read('code-review.json');}catch(e){if(e.code!=='ENOENT')throw e;}
let diagnosis=null;try{diagnosis=await read('single-failure-diagnosis.json');}catch(e){if(e.code!=='ENOENT')throw e;}
const comparison={schemaVersion:1,createdAt:new Date().toISOString(),protocol,audit,summaries,review,diagnosis,limitations:['One attempt per mode on one synthetic task; no population-level reliability or speed conclusion.','Single means application Single mode, with Planner and self review; not one raw CLI call.','Both modes share model family/provider and local host; independent role sessions do not prove independent model errors.','Dollar figures are application estimates for subscription usage, not measured API bills.','53 directed cases plus 12 fixed-seed stateful traces do not establish exhaustive correctness.','A missing candidate has no code score, not a fabricated 0/65.','No failed run was retried, no contract/test/source was repaired by benchmark operator, and external grader output was never fed to agents.','Local runtime uses CLI sandbox and scope enforcement; external grader remains outside workspace but is not hidden behind a container security boundary.']};
await writeFile(path.join(out,'comparison.json'),JSON.stringify(comparison,null,2));
const [d,s]=summaries,seconds=n=>n==null?'Chưa có số đo':(n/1000).toFixed(1)+'s';
const lines=['# EscrowBatch — AI Department và Single','', '**Kết luận:** Single đi được tới chờ nghiệm thu; Department chưa qua bước duyệt kế hoạch. Tuy nhiên code Single có lỗi nghiêm trọng trong batch và chưa đạt SPEC, dù toàn bộ 15 test nội bộ đều xanh. Chưa thể so chất lượng hai bản code vì Department chưa tạo candidate.', '',`Ngày ${comparison.createdAt}. Cả hai dùng **${protocol.model}, ${protocol.effort}**, cùng scaffold, SPEC, công cụ và trần hiệu lực **$${protocol.effectiveCapUsd}**. Một lượt mỗi bên, tuần tự. Không retry hoặc sửa hộ output.`,
'','Bài toán: sổ cái giữ chỗ/chuyển tiền với atomic batch, rollback, CAS revision, expiry, idempotency ưu tiên trước CAS và snapshot tách biệt. Bộ chấm ngoài workspace: **53 ca cụ thể + 12 chuỗi 100 bước**; 65 mục chấm độc lập. Bộ chấm được khóa hash trước lượt model đầu tiên.',
'','| Tiêu chí | AI Department / Verify | Single |','|---|---|---|',
`| Trạng thái cuối | ${d.status} | ${s.status} |`,
`| Candidate code | ${d.candidateProduced?'Có':'Chưa có'} | ${s.candidateProduced?'Có':'Chưa có'} |`,
`| Điểm hành vi | ${d.grade?`${d.grade.passed}/${d.grade.total} (${d.grade.score}%)`:'Không chấm: chưa có code'} | ${s.grade?`${s.grade.passed}/${s.grade.total} (${s.grade.score}%)`:'Không chấm: chưa có code'} |`,
`| Thời gian tự động | ${seconds(d.automaticMs)} | ${seconds(s.automaticMs)} |`,
`| Thời gian chờ tại mốc kết thúc | ${seconds(d.waitingMs)} | ${seconds(s.waitingMs)} |`,
`| Lượt model | ${d.attempts} (${JSON.stringify(d.roles)}) | ${s.attempts} (${JSON.stringify(s.roles)}) |`,
`| Input token quan sát, gồm cache | ${d.inputTokens} | ${s.inputTokens} |`,
`| Cached token (nằm trong input) | ${d.cachedTokens} | ${s.cachedTokens} |`,
`| Output token | ${d.outputTokens} | ${s.outputTokens} |`,
`| Chi phí quy đổi ước tính của ứng dụng | $${d.estimatedUsd?.toFixed(3)??'?'} | $${s.estimatedUsd?.toFixed(3)??'?'} |`,
`| Checks nội bộ | ${d.checks.map(c=>`${c.counts?.passed??'?'} đạt / ${c.counts?.failed??'?'} lỗi`).join('; ')||'Chưa chạy'} | ${s.checks.map(c=>`${c.counts?.passed??'?'} đạt / ${c.counts?.failed??'?'} lỗi`).join('; ')||'Chưa chạy'} |`,
`| Can thiệp người soát benchmark | ${d.interventions.length} | ${s.interventions.length} |`,
`| Ca kế hoạch Author | ${d.testPlanCases} | Không có Author độc lập |`,
'','## Quy trình và điểm nghẽn','',
...summaries.flatMap(x=>[`### ${x.arm}`,`Run: \`${x.runId}\`. Các model thực ghi nhận: ${x.models.join(', ')}.`,x.blocker?`Blocker: ${x.blocker}`:'Không có blocker runtime được ghi nhận.',...x.contractProblems.map(p=>`- ${p}`),`Can thiệp: ${JSON.stringify(x.interventions)}`,x.mutation?`Mutation: ${x.mutation.status}; ${JSON.stringify(x.mutation.counts)}; ${seconds(x.mutation.durationMs)}.`:'Mutation: chưa có kết quả ở mốc kết thúc.','']),
'Department sinh được kế hoạch có nhiều ca rollback, expiry, idempotency và snapshot, nhưng kế hoạch không qua kiểm tra căn cứ/cấu trúc nên chưa tới Developer. Không được dùng thời gian dừng sớm này để kết luận Department nhanh hơn.',
'', '## Hành vi theo nhóm','', '| Nhóm | Department | Single |','|---|---|---|',
...[...new Set(summaries.flatMap(x=>Object.keys(x.grade?.byGroup??{})))].map(group=>`| ${group} | ${d.grade?.byGroup[group]?`${d.grade.byGroup[group].passed}/${d.grade.byGroup[group].total}`:'Chưa có code'} | ${s.grade?.byGroup[group]?`${s.grade.byGroup[group].passed}/${s.grade.byGroup[group].total}`:'Chưa có code'} |`),
'',...summaries.flatMap(x=>x.grade?.failures.length?[`### Ca lỗi ${x.arm}`,...x.grade.failures.map(f=>`- ${f.id}: ${f.error}`),'']:[]),
'## Review code','',...(review?[review.summary,'',...review.strengths.map(x=>`- Điểm tốt: ${x}`),...review.concerns.map(x=>`- **${x.severity} — ${x.title}:** ${x.detail} (${x.evidence})`),'',`Quyết định review: **${review.releaseDecision}**.`]:['Chưa có review thủ công; điểm hành vi không thay thế review code.']),
'', '## Môi trường và lượt chạy trong agent', '',review?.environmentEvidence??'Chưa phân tích raw command output.', '', 'Single không có Author/Verifier độc lập và không tự chạy mutation trong chế độ hiện tại. Verify dừng trước Developer nên chưa tới checks/mutation/Verifier. Không có kết quả mutation để so ở lần này.',
'','## Chẩn đoán bổ sung sau chấm','',...(diagnosis?['Các probe sau chỉ dùng xác nhận nguyên nhân; **không cộng vào hay thay đổi điểm 64/65 đã khóa**.','',...diagnosis.probes.map(p=>`- ${p.id}: expected ${JSON.stringify(p.expected)}; actual ${JSON.stringify(p.actual)}.`),'','Tình huống chi vượt: a có 100; batch chuyển 80 rồi chuyển thêm 80 đáng ra phải rollback. Code Single lại commit a=-60, b=160. Nguồn lỗi: available() đọc Map accounts đã commit, còn batch cập nhật nextAccounts.','', '12 trace cố định không bắt lỗi này vì các batch hợp lệ trong generator chủ yếu có một op; ca D21 và probe nhiều op bổ sung mới chạm tới. Vì vậy 1.200 bước không thay thế thiết kế chuỗi thay đổi trạng thái trong cùng transaction.']:['Chưa có probe bổ sung.']),
'','## Kiểm tra bộ chấm','',`Oracle qua ${audit.selfCheck.passed}/${audit.selfCheck.total}; scaffold chưa triển khai qua ${audit.scaffold.passed}/${audit.scaffold.total}. Biến thể cố ý sai CAS bị bắt ${audit.brokenCAS.failed} mục; sai expiry bị bắt ${audit.brokenExpiry.failed} mục. Đây là kiểm tra sức bắt lỗi của grader, không chứng minh oracle không có bug.`,
'','## Giới hạn','',...comparison.limitations.map(l=>`- ${l}`),
'','## Cải tiến rút ra','',...(review?.recommendations??[]).map(x=>`- ${x}`),
'','## Hồ sơ','', '`protocol.json`, `source-manifest.json`, `SPEC.md`, `runs.json`, `<arm>-detail.json`, `<arm>-grade.json` (nếu có candidate), `candidate-<arm>/`, `grader-audit.json`, `comparison.json`. Các benchmark cũ giữ nguyên. Không nghiệm thu hoặc giao branch tự động.'];
lines.push('', 'Chấm lại bản code đã lưu (không gọi model):', '', '```powershell', 'node test-results/2026-10-25-escrowbatch-rerun/grade.mjs test-results/2026-10-25-escrowbatch-rerun/candidate-single test-results/2026-10-25-escrowbatch-rerun/recheck.json', '```');
await writeFile(path.join(out,'report.md'),lines.join('\n')+'\n');console.log(JSON.stringify(summaries.map(x=>({arm:x.arm,status:x.status,grade:x.grade?{passed:x.grade.passed,total:x.grade.total}:null,automaticMs:x.automaticMs,attempts:x.attempts}))));
