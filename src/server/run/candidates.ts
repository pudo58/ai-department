import { deepQuality } from '../../core/qualityevidence.js';
import { normalizeTestId, manifestFindings } from '../../core/testplan.js';
import { hashContract } from '../../core/contract.js';
import type { TestManifest } from '../../shared/quality.js';
import type { Independence, Slot, Stage } from '../../shared/types.js';
import { budgetState, candidateCap, candidateSpend, MAX_REPAIRS_PER_CANDIDATE } from '../../core/budget.js';
import { isTestPath } from '../../core/testpath.js';
import { parseOutput, extractJsonBlock, ReuseAssessmentSchema } from '../../core/outputs.js';
import { PROMPTS } from '../../core/prompts.js';
import { evaluateChanges } from '../../core/scope.js';
import type { CandidateEval } from '../../core/selection.js';
import { ANALYSIS_TOOLS, toolDelta } from '../../core/tools.js';
import { Blocked, type CandidateRecord } from './support.js';
import type { RunServices } from './services.js';
import type { ScopePolicy } from './scope.js';
import type { CheckRunner } from './checks.js';
import { buildMatrix } from '../../core/completion.js';
import { TestRecovery } from './recovery.js';
import { latestChecks } from '../../core/qualityevidence.js';
import { AUTHOR_DRAFT_TITLE, pendingAuthorDraft } from '../../core/authordraft.js';
import { testRepairConfigHash } from '../../core/recovery.js';
import type { AuthorDraft } from '../../shared/execution.js';
import { routeCheckFailure } from '../../core/checkrouting.js';
import { authorTestProblems, auditManifestAssertions } from '../../core/authoring.js';
import { authorRepairSourceProblems, assertionInventory, sameMembers } from '../../core/authoring.js';
import { parseAuthorManifest, resolveAuthorManifest, AUTHOR_MANIFEST_REPAIR_TITLE } from '../../core/authormanifest.js';
import { SourceBindingSchema } from '../../core/sourcebindings.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Produces a candidate solution: the Developer loop (implement, scope check, commit, checks, repairs) and the Author's locked acceptance tests. */
export class CandidateBuilder {
  constructor(private readonly s: RunServices, private readonly scope: ScopePolicy, private readonly checks: CheckRunner) {}

  async implementCandidate(runId: string, slot: Slot, signal: AbortSignal): Promise<CandidateRecord> {
    let run = this.s.run(runId);
    const runtime = this.s.runtimeFor(run);
    const record: CandidateRecord = { slot, checkpoint: null, success: false, problems: [], fatal: false, changedFiles: [], testFiles: [], newToolIssues: 0, flakyChecks: 0, summary: '' };
    let problems: string[] = [];
    const primary = slot === 'B' ? this.candidateRecord(runId, 'A') : undefined;
    if (this.s.store.attempts.list(runId).some(a => a.role === 'developer' && a.slot === slot)) record.checkpoint = run.checkpoint;
    const reset = this.s.store.artifacts.list(runId).filter(a => a.title === 'Developer retry authorization' && a.contractVersion === run.contract.version).at(-1);
    const authorizedBefore = new Set<string>(reset ? (JSON.parse(reset.content) as { previousAttemptIds: string[] }).previousAttemptIds : []);
    const previousRounds = this.s.store.attempts.list(runId).filter(a => !authorizedBefore.has(a.id) && a.role === 'developer' && a.slot === slot && a.contractVersion === run.contract.version && (a.stage === 'implement' || a.stage === 'repair')).length;
    const evidenceAttempted = () => this.s.store.artifacts.list(runId).some(a => a.title === `Evidence repair attempt (${slot})` && a.contractVersion === run.contract.version);
    if (previousRounds) {
      record.checkpoint = run.checkpoint;
      const unresolved = buildMatrix({ ...run, selectedSlot: slot }, this.s.store.checks.list(runId)).filter(r => r.required && !r.manual && r.status !== 'verified');
      if (evidenceAttempted() && unresolved.length) {
        record.fatal = true; record.problems = [`Đã dùng lượt bổ sung bằng chứng; còn thiếu ${unresolved.map(r => r.requirementId).join(', ')}. Cần xem xét test hoặc hợp đồng trước khi thử thêm.`];
        return record;
      }
      problems = ['Tiếp tục trên checkpoint đang có, giữ nguyên test đã khóa. Kiểm tra lỗi và ma trận bằng chứng; không chỉ đổi nhãn test để báo đạt.', ...this.s.store.checks.list(runId).filter(c => c.valid && c.checkpoint === run.checkpoint && c.contractVersion === run.contract.version && (!c.slot || c.slot === slot)).map(c => `Check ${c.recipeId}: ${c.status}; ${(c.outcomes ?? []).filter(o => o.status !== 'passed').map(o => `${o.id}: ${o.status}`).join('; ')}`)];
    }

    // Explicit retry can reset the Developer round counter, but must not bypass diagnosis of existing evidence.
    if(deepQuality(run) && run.checkpoint && this.s.store.attempts.list(runId).some(a=>a.role==='developer' && a.slot===slot && a.contractVersion===run.contract.version)) {
      const current=latestChecks({...run,selectedSlot:slot},this.s.store.checks.list(runId)).filter(c=>c.required);
      const route=routeCheckFailure({...run,selectedSlot:slot},this.s.store.checks.list(runId),this.s.store.artifacts.list(runId));
      if(route.kind==='blocked'){record.fatal=true;record.problems=route.reasons;return record;}
      if(current.some(c=>c.status==='failed')){
        const digest=current.map(c=>`Check ${c.recipeId}: ${c.status}\n${this.s.store.artifacts.list(runId).find(a=>a.title===`Check failure digest ${c.id}` && a.checkpoint===run.checkpoint)?.content??''}\n${c.attempts.at(-1)?.log??''}\n${(c.issues??[]).map(i=>i.message).join('\n')}`);
        const diagnosis=route.kind==='assertion' ? await new TestRecovery(this.s,this.scope).diagnose(runId,slot,digest,signal) : undefined;
        if(diagnosis){record.fatal=true;record.problems=[diagnosis];return record;}
        this.s.retry(runId,'implementation','Chẩn đoán xác định cần sửa implementation trước Developer.');
        problems=digest;
      }
    }

    for (let round = previousRounds; round <= MAX_REPAIRS_PER_CANDIDATE; round++) {
      run = this.s.run(runId);
      const stage: Stage = round === 0 && !problems.length ? 'implement' : 'repair';
      if (slot === 'B') {
        const cap = candidateCap(budgetState(run, this.s.store.attempts.list(runId)), 2);
        if (candidateSpend(run, this.s.store.attempts.list(runId), 'B') >= cap) { record.problems = ['Phương án B đã dùng hết phần ngân sách của nó.']; break; }
      }
      const resume = round > 0 ? this.s.sessions.get(`${runId}:${slot}`) : undefined;
      const prompt = round === 0 && !problems.length
        ? (slot === 'B' ? PROMPTS.alternative(run, primary?.summary || 'Không có tóm tắt.') : PROMPTS.developer(run, this.scope.hasAuthorTests(runId) ? 'Test nghiệm thu do Author viết đã bị khóa; làm cho chúng pass mà không sửa chúng.' : ''))
        : resume ? PROMPTS.repairFollowUp(problems) : PROMPTS.repair(run, problems);
      const { output } = await this.s.attempt(runId, { role: 'developer', stage, slot, prompt, signal, resumeSession: resume });
      this.recordReuse(runId, output);
      record.summary = output.slice(0, 1500);
      if (round > 0) this.s.mutate(runId, (r) => { r.repairCount += 1; });

      const changes = await runtime.changes(run, slot);
      if (!changes.files.length) {
        // An empty patch proves nothing; committing it and running checks would only burn a round on the old code.
        problems = ['Developer không thay đổi file nào. Hãy thực sự sửa mã và thêm test gắn thẻ [R-x]; nếu không thể thực thi lệnh hoặc ghi file, hãy nói rõ lý do.'];
        record.problems = problems;
        this.s.log(runId, 'patch.empty', `Round ${round}: không có thay đổi nào.`);
        continue;
      }
      const scope = evaluateChanges(changes.files, this.scope.scopeFor(runId));
      if (!scope.accepted) {
        this.s.artifact(runId, { kind: 'diff', title: `Patch bị từ chối (${slot})`, content: changes.patch, checkpoint: null, valid: false });
        await runtime.revert(run, slot);
        problems = [
          ...scope.protected.map((f) => `${f}: file được bảo vệ, không được sửa.`),
          ...scope.needsApproval.map((f) => `${f}: nằm ngoài module cho phép, cần người dùng duyệt.`),
        ];
        this.s.log(runId, 'scope.rejected', `Patch bị từ chối: ${problems.join(' ')}`);
        record.problems = problems;
        continue;
      }
      const checkpoint = await runtime.commit(run, slot, `${run.title} (${slot}${round ? ` r${round}` : ''})`);
      record.checkpoint = checkpoint;
      record.changedFiles = [...new Set([...record.changedFiles, ...changes.files])];
      record.testFiles = [...new Set([...record.testFiles, ...changes.files.filter((f) => isTestPath(f))])];
      this.s.artifact(runId, { kind: 'diff', title: `Diff ${slot} @ ${checkpoint.slice(0, 8)}`, content: changes.patch, checkpoint });
      if (slot === 'A') this.s.mutate(runId, (r) => { r.checkpoint = checkpoint; });

      const outcome = await this.checks.runChecks(runId, slot, checkpoint, record.testFiles, signal);
      record.flakyChecks = outcome.flaky;
      problems = outcome.problems;
      record.problems = problems;
      if (outcome.fatal.length) { record.fatal = true; record.problems = outcome.fatal; break; }
      if (!problems.length) {
        const liveRun = { ...this.s.run(runId), checkpoint, selectedSlot: slot };
        const uncovered = buildMatrix(liveRun, this.s.store.checks.list(runId)).filter(r => r.required && !r.manual && r.status !== 'verified');
        if (!uncovered.length) { record.success = true; record.problems = []; break; }
        problems = [`Checks đạt nhưng thiếu bằng chứng cho: ${uncovered.map(r => `${r.requirementId}: ${r.text}`).join('\n')}. Bổ sung test có thao tác và assertion kiểm chứng đúng hành vi, gắn mã yêu cầu tương ứng. Không chỉ thêm nhãn vào test không liên quan; không sửa hợp đồng hay test đã khóa.`];
        record.problems = problems;
        const attempted = evidenceAttempted();
        if (attempted || round === MAX_REPAIRS_PER_CANDIDATE) { record.fatal = true; break; }
        this.s.artifact(runId, { kind: 'report', title: `Evidence repair attempt (${slot})`, content: JSON.stringify({ checkpoint, requirementIds: uncovered.map(r => r.requirementId) }), checkpoint });
        this.s.retry(runId,'missing_evidence',`Bổ sung bằng chứng cho ${uncovered.map(r=>r.requirementId).join(', ')}.`);
        // Keep observed identities while allowing Developer to add assertions to its still-unlocked test file.
        if (!deepQuality(run) && run.mode !== 'compare') this.scope.lockAcceptance(runId, [], checkpoint);
        continue;
      }
      if (!outcome.repairable) break;
      const route=deepQuality(run)?routeCheckFailure({...this.s.run(runId),checkpoint,selectedSlot:slot},this.s.store.checks.list(runId),this.s.store.artifacts.list(runId)):undefined;
      if(route?.kind==='blocked'){record.problems=route.reasons;record.fatal=true;break;}
      const diagnosis = route?.kind==='implementation' ? undefined : await new TestRecovery(this.s, this.scope).diagnose(runId, slot, problems, signal);
      if (diagnosis) { record.problems = [diagnosis]; record.fatal = true; break; }
    }
    if (previousRounds > MAX_REPAIRS_PER_CANDIDATE) { record.fatal = true; record.problems = ['Đã dùng hết số lượt Developer/sửa của hợp đồng này; resume không tự mở thêm lượt AI.']; }
    if (record.checkpoint) await this.analyzeTools(runId, slot, record);
    this.s.store.artifacts.put({ ...this.s.baseArtifact(runId, { kind: 'checkpoint', title: `Candidate ${slot}`, content: JSON.stringify(record), checkpoint: record.checkpoint }), id: `cand-${runId}-${slot}` });
    return record;
  }

  private async analyzeTools(runId: string, slot: Slot, record: CandidateRecord): Promise<void> {
    const run = this.s.run(runId);
    const runtime = this.s.runtimeFor(run);
    const deltas = [];
    for (const tool of ANALYSIS_TOOLS) {
      const [base, candidate] = [await runtime.runTool(run, slot, tool, 'base'), await runtime.runTool(run, slot, tool, 'candidate')];
      deltas.push(toolDelta(base, candidate));
    }
    record.newToolIssues = deltas.reduce((n, d) => n + d.newIssues.length, 0);
    this.s.artifact(runId, { kind: 'tool', title: `Phân tích công cụ (${slot})`, content: JSON.stringify(deltas), checkpoint: record.checkpoint });
  }

  candidateRecord(runId: string, slot: Slot): CandidateRecord | undefined {
    const run = this.s.run(runId);
    const artifact = this.s.store.artifacts.get(`cand-${runId}-${slot}`);
    if (!artifact || artifact.contractVersion !== run.contract.version || !artifact.valid) return undefined;
    return JSON.parse(artifact.content) as CandidateRecord;
  }

  evaluateCandidate(record: CandidateRecord): CandidateEval {
    return { slot: record.slot, eliminatedBecause: record.success ? null : record.problems.join(' ') || 'Không đạt check bắt buộc.', changedFiles: record.changedFiles.length, newToolIssues: record.newToolIssues, flakyChecks: record.flakyChecks };
  }

  testFilesFromDiffs(runId: string): string[] {
    const files = new Set<string>();
    for (const a of this.s.store.artifacts.list(runId).filter((x) => x.kind === 'diff' && x.valid)) {
      for (const m of a.content.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) if (isTestPath(m[2]!)) files.add(m[2]!);
    }
    return [...files];
  }

  /** Verify mode: an Author writes tests from the contract alone; they are locked before the Developer starts. */
  async authorAcceptanceTests(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.s.run(runId);
    const runtime = this.s.runtimeFor(run);
    const independence: Independence = { independent: true, reason: 'Author chỉ nhận hợp đồng; chưa có kế hoạch triển khai của Developer.' };
    // A non-test file inside the allowed modules (a .md note, a helper) is a slip the Author can fix, so it gets one retry
    // with the offending files named. Out-of-scope or protected paths need a person, so they block immediately.
    let extra = '';
    let authorOutput = '', authorAttemptId = '';
    if (deepQuality(run) && this.s.store.artifacts.list(runId).some(a => a.title === 'Author manifest attempt' && a.valid && a.contractVersion === run.contract.version)) {
      if (run.qualityPolicyVersion === 3 && pendingAuthorDraft(run,this.s.store.artifacts.list(runId))) return this.repairAuthorManifest(runId,signal);
      throw new Blocked('Author chưa tạo được manifest hợp lệ. Sửa hợp đồng hoặc kế hoạch ca để thử lượt mới; không tự gọi lại AI.');
    }
    if (deepQuality(run)) this.s.artifact(runId, { kind: 'report', title: 'Author manifest attempt', content: JSON.stringify({ schemaVersion: 1, source: 'author', contractHash: hashContract(run.contract) }), checkpoint: run.checkpoint });
    let changes: Awaited<ReturnType<typeof runtime.changes>>;
    for (let round = 0; ; round++) {
      const author = await this.s.attempt(runId, { role: 'author', stage: 'implement', slot: 'A', prompt: PROMPTS.author(run, extra), independence, signal });
      authorOutput = author.output;
      authorAttemptId = author.attempt.id;
      changes = await runtime.changes(run, 'A');
      const stray = changes.files.filter((f) => !isTestPath(f));
      const scope = evaluateChanges(changes.files, this.scope.scopeFor(runId));
      let testProblems: string[] = [];
      const workspace = runtime.workspacePath?.(run, 'A');
      if (!stray.length && scope.accepted && workspace && /\bsync\b|\bsynchronous\b|đồng bộ/i.test(run.originalRequirement)) {
        for (const file of changes.files) testProblems.push(...authorTestProblems(file, await readFile(path.join(workspace, file), 'utf8')));
      }
      if (!stray.length && scope.accepted && !testProblems.length) break;
      const strayOnly = scope.accepted && !scope.protected.length && !scope.needsApproval.length;
      // Recorded like a rejected Developer patch, so the run page can offer to approve the out-of-scope paths.
      this.s.artifact(runId, { kind: 'diff', title: 'Patch bị từ chối (Author)', content: changes.patch, checkpoint: null, valid: false });
      await runtime.revert(run, 'A');
      const violations = [...new Set([...stray, ...scope.protected, ...scope.needsApproval])];
      const protectedTestRetry = !stray.length && !scope.needsApproval.length && scope.protected.length > 0 && scope.protected.every(isTestPath);
      if ((strayOnly || protectedTestRetry) && round === 0) {
        extra = `Patch trước đã hoàn nguyên. Sửa đúng các lỗi sau, giữ nguyên hành vi/assertion và danh tính: ${[...stray.map(f=>`${f}: không phải file test`),...scope.protected.map(f=>`${f}: file bảo vệ, phải giữ nguyên; tạo file test mới thay vì sửa/xóa file này`),...testProblems].join('; ')}. CHỈ tạo file test.\n`;
        this.s.retry(runId,'invalid_output','Author sửa phạm vi/test helper một lần trước khi khóa.');
        this.s.log(runId, 'author.retry', `Author cần sửa phạm vi/test helper: ${[...stray,...testProblems].join('; ')}; đã hoàn nguyên và chỉ cho làm lại một lần.`);
        continue;
      }
      if (deepQuality(run)) for (const a of this.s.store.artifacts.list(runId).filter(a => a.title === 'Author manifest attempt' && a.valid && a.contractVersion === run.contract.version)) this.s.store.artifacts.put({ ...a, valid: false });
      throw new Blocked(testProblems.length ? `Test Author chưa an toàn trước khi khóa: ${testProblems.join('; ')}` : `Author chỉ được thêm file test (tests/, *.test.ts, *.spec.ts) trong module cho phép. Vi phạm: ${violations.join(', ')}`);
    }
    let manifest: TestManifest | undefined;
    if (deepQuality(run)) {
      try {
        const structured = (run.qualityPolicyVersion??0) >= 2;
        const normalized = await resolveAuthorManifest(run.contract,authorOutput,structured,runtime.workspacePath?.(run,'A'),changes.files);
        const found = manifestFindings(run.contract, normalized, run.configSnapshot.checks, changes.files), problems = [...found.blocking];
        const audit=await auditManifestAssertions(run.contract,normalized,runtime.workspacePath?.(run,'A'),changes.files);
        problems.push(...audit.problems);
        const advisories = [...new Set([...found.advisories, ...audit.advisories])];
        // Binding gaps are not worth blocking on, but the one correction round exists to close them while it is still free to use.
        if (run.qualityPolicyVersion === 3) problems.push(...advisories);
        if (problems.length) throw new Error(problems.join(' '));
        manifest = { schemaVersion: structured ? 2 : 1, source: 'author', contractHash: hashContract(run.contract), contractVersion: run.contract.version, slot: 'A', entries: normalized, ...(run.contract.testPlan?.reasoningVersion===1?{assertionAudit:audit.audits}:{}), ...(advisories.length ? { advisories } : {}) };
      } catch (error) {
        const draft:AuthorDraft={schemaVersion:1,attemptId:authorAttemptId,checkpoint:run.checkpoint??run.baseSha!,contractHash:hashContract(run.contract),contractVersion:run.contract.version,configHash:testRepairConfigHash(run),slot:'A',output:authorOutput,patch:changes.patch,paths:changes.files,problems:[(error as Error).message]};
        this.s.artifact(runId,{kind:'report',title:AUTHOR_DRAFT_TITLE,content:JSON.stringify(draft),checkpoint:run.checkpoint,attemptId:authorAttemptId});
        this.s.log(runId,'author.draft_saved','Manifest Author chưa hợp lệ; giữ draft trước khi hoàn nguyên.');
        await runtime.revert(run, 'A');
        if (run.qualityPolicyVersion === 3) return this.repairAuthorManifest(runId,signal);
        throw new Blocked(`Manifest Author không hợp lệ: ${(error as Error).message}`);
      }
    }
    const checkpoint = await runtime.commit(run, 'A', `${run.title}: acceptance tests`);
    if (manifest) this.s.artifact(runId, { kind: 'acceptance', title: 'Test manifest', content: JSON.stringify(manifest), checkpoint });
    this.s.mutate(runId, (r) => { r.checkpoint = checkpoint; });
    this.s.artifact(runId, { kind: 'diff', title: 'Diff Author', content: changes.patch, checkpoint });
    // The artifact is also the marker that the Author step is done. Without it, an Author that wrote nothing would be
    // run again on every resume, spending tokens each time for the same empty result.
    if (!changes.files.length) this.s.log(runId, 'author.empty', 'Author không viết test nào; tiếp tục với Developer (yêu cầu sẽ chỉ được xác minh bằng test Developer viết).');
    this.scope.lockAcceptance(runId, changes.files, checkpoint, 'Acceptance suite (Author)', true);
  }

  /** One correction of an unaccepted draft; never a route around the lock/identity gates. */
  private async repairAuthorManifest(runId:string,signal:AbortSignal):Promise<void>{
    const run=this.s.run(runId),artifacts=this.s.store.artifacts.list(runId),draft=pendingAuthorDraft(run,artifacts);
    if(!draft)throw new Blocked('Không có draft Author đúng checkpoint/hợp đồng/cấu hình để sửa.');
    // Include historical markers, even if invalidated by a config change. A resume is not a new allowance.
    if(artifacts.some(a=>a.title===AUTHOR_MANIFEST_REPAIR_TITLE&&a.contractVersion===run.contract.version))throw new Blocked('Đã dùng lượt sửa manifest Author cho hợp đồng này; draft còn lỗi hoặc lượt sửa bị gián đoạn. Không tự gọi thêm AI.');
    const runtime=this.s.runtimeFor(run),workspace=runtime.workspacePath?.(run,'A');
    const scope=evaluateChanges(draft.paths,this.scope.scopeFor(runId));
    if(!runtime.applyPatch||!workspace||!draft.patch||!draft.paths.length||draft.paths.some(p=>!isTestPath(p))||!scope.accepted)throw new Blocked('Draft Author không chỉ sửa test trong phạm vi hoặc runtime chưa hỗ trợ sửa draft.');
    const before=new Map<string,string>();
    let result:Awaited<ReturnType<RunServices['attempt']>>|undefined;
    try{
      await runtime.revert(run,'A');
      await runtime.applyPatch({...run,checkpoint:draft.checkpoint},'A',draft.patch);
      for(const file of draft.paths)before.set(file,await readFile(path.join(workspace,file),'utf8'));
      const inventory=[...before].flatMap(([file,source])=>assertionInventory(file,source));
      this.s.artifact(runId,{kind:'report',title:AUTHOR_MANIFEST_REPAIR_TITLE,checkpoint:run.checkpoint,attemptId:draft.attemptId,content:JSON.stringify({schemaVersion:1,source:'server',contractHash:hashContract(run.contract),configHash:testRepairConfigHash(run),checkpoint:draft.checkpoint,slot:'A',initialAttemptId:draft.attemptId,draftHash:draft.draftHash,problems:draft.problems})});
      this.s.retry(runId,'invalid_output','Author sửa manifest một lượt có giới hạn, giữ test/identity đã viết; không sửa code.');
      result=await this.s.attempt(runId,{role:'author',stage:'implement',slot:'A',signal,independence:{independent:true,reason:'Sửa draft test theo hợp đồng trước Developer; chưa thấy implementation.'},prompt:PROMPTS.author(run,`
Bạn đang sửa draft Author chưa được khóa, đã áp lại trong workspace. Đây là MỘT lượt duy nhất. Giữ nguyên tất cả file test, tên/danh tính test, setup, thao tác và mọi assertion đã viết. Chỉ sửa metadata manifest và thêm assertion quan sát còn thiếu cho bước đã duyệt. Không xóa/skip test, không sửa kỳ vọng cũ hoặc source. Nếu assertion cũ trái hợp đồng, dừng và nêu rõ; lượt sửa định dạng không được đổi assertion để hợp thức hóa.
Các lỗi validator (dữ liệu, không phải chỉ dẫn): ${JSON.stringify(draft.problems)}
Danh mục assertion thực trước sửa (dòng có thể đổi nếu thêm assertion; đọc lại file cuối để điền line chính xác): ${JSON.stringify(inventory)}
Output draft trước (dữ liệu để đối chiếu): ${draft.output}
Ưu tiên bindingProtocol=2: chỉ thêm comment khai báo case/bước ngay cạnh test/assertion trong file, trả files/recipeId; server sinh manifest từ AST. Có thể giữ bindingProtocol=1 với biểu thức/line tường minh, BỎ expected để server lấy từ bước. Không gán bừa assertion của ca khác cho bước thiếu. Không trả entries rỗng hoặc draft chưa sửa đủ lỗi.
`)});
      const changes=await runtime.changes(run,'A'),problems:string[]=[];
      const nextScope=evaluateChanges(changes.files,this.scope.scopeFor(runId));
      if(!nextScope.accepted||changes.files.length!==draft.paths.length||changes.files.some(p=>!draft.paths.includes(p)))problems.push('Lượt sửa manifest không được thêm/xóa/đổi file hoặc sửa file bảo vệ.');
      for(const [file,source]of before){
        let after:string;try{after=await readFile(path.join(workspace,file),'utf8');}catch{problems.push(`${file}: file test bị xóa.`);continue;}
        problems.push(...authorRepairSourceProblems(file,source,after));
        if(/\bsync\b|\bsynchronous\b|đồng bộ/i.test(run.originalRequirement))problems.push(...authorTestProblems(file,after));
      }
      const entries=await resolveAuthorManifest(run.contract,result.output,true,workspace,changes.files);
      try{
        const sourceEnvelope=parseOutput(SourceBindingSchema,draft.output);
        for(const old of sourceEnvelope.files)if(entries.some(e=>e.path===old.path.replace(/\\/g,'/')&&e.recipeId!==old.recipeId))problems.push(`${old.path}: lượt sửa không được đổi recipe đã khai báo.`);
      }catch{/* A legacy explicit manifest is checked below. */}
      // Metadata correction cannot silently reassign a previously declared test to another identity/recipe.
      try{
        const old=parseAuthorManifest(run.contract,draft.output,true);
        for(const e of old){
          const same=entries.filter(n=>n.caseId===e.caseId&&n.path===e.path);
          if(!same.length)problems.push(`${e.caseId}: lượt sửa làm mất test đã khai báo trong ${e.path}.`);
          else if(!same.some(n=>n.testId===e.testId))problems.push(`${e.caseId}: lượt sửa đổi tên/danh tính test (${e.testId} → ${same.map(n=>n.testId).join(', ')}).`);
          else if(!same.some(n=>n.testId===e.testId&&n.recipeId===e.recipeId))problems.push(`${e.caseId}: lượt sửa đổi recipe của test đã khai báo (${e.recipeId}).`);
          else if(!same.some(n=>n.testId===e.testId&&sameMembers(n.requirementIds,e.requirementIds)))problems.push(`${e.caseId}: lượt sửa đổi tập yêu cầu liên kết của test (${e.requirementIds.join(', ')}).`);
        }
      }catch{/* Source AST guard still preserves actual test names and setup in a schema-invalid draft. */}
      const found=manifestFindings(run.contract,entries,run.configSnapshot.checks,changes.files);problems.push(...found.blocking);
      const audit=await auditManifestAssertions(run.contract,entries,workspace,changes.files);problems.push(...audit.problems);
      if(problems.length)throw new Error(problems.join(' '));
      const advisories=[...new Set([...found.advisories,...audit.advisories])];
      const checkpoint=await runtime.commit(run,'A',`${run.title}: corrected Author manifest`);
      const manifest:TestManifest={schemaVersion:2,source:'author',contractHash:hashContract(run.contract),contractVersion:run.contract.version,slot:'A',entries,assertionAudit:audit.audits,...(advisories.length?{advisories}:{})};
      this.s.artifact(runId,{kind:'acceptance',title:'Test manifest',content:JSON.stringify(manifest),checkpoint,attemptId:result.attempt.id});
      this.s.artifact(runId,{kind:'diff',title:'Diff Author',content:changes.patch,checkpoint,attemptId:result.attempt.id});
      this.s.mutate(runId,r=>{r.checkpoint=checkpoint;});
      this.scope.lockAcceptance(runId,changes.files,checkpoint,'Acceptance suite (Author)',true);
      this.s.store.artifacts.put({...this.s.store.artifacts.get(draft.artifactId)!,valid:false});
      this.s.log(runId,'author.manifest_repaired','Manifest Author đã qua cùng validator/AST gate và khóa trước Developer.');
    }catch(error){
      if(result){const changes=await runtime.changes(run,'A');const saved:AuthorDraft={schemaVersion:1,attemptId:result.attempt.id,checkpoint:draft.checkpoint,contractHash:hashContract(run.contract),contractVersion:run.contract.version,configHash:testRepairConfigHash(run),slot:'A',output:result.output,patch:changes.patch,paths:changes.files,problems:[(error as Error).message]};this.s.artifact(runId,{kind:'report',title:AUTHOR_DRAFT_TITLE,content:JSON.stringify(saved),checkpoint:run.checkpoint,attemptId:result.attempt.id});}
      await runtime.revert(this.s.run(runId),'A');
      if(result)throw new Blocked(`Manifest Author vẫn chưa hợp lệ sau một lượt sửa: ${(error as Error).message}`);
      throw error;
    }
  }

  async revalidateAuthorDraft(runId:string):Promise<void>{
    this.s.retry(runId,'invalid_output','Kiểm tra lại output Author đã lưu, không gọi AI.');
    const run=this.s.run(runId), artifacts=this.s.store.artifacts.list(runId),draft=pendingAuthorDraft(run,artifacts);
    if(!draft || draft.attemptId!==run.authorDraftRequest?.attemptId || draft.draftHash!==run.authorDraftRequest?.draftHash)throw new Blocked('Draft đã cũ; không thay workspace.');
    const runtime=this.s.runtimeFor(run);if(!runtime.applyPatch)throw new Blocked('Runtime chưa hỗ trợ áp dụng draft.');
    const scope=evaluateChanges(draft.paths,{...this.scope.scopeFor(runId),lockedPaths:[]});
    if(!draft.patch || draft.paths.some(p=>!isTestPath(p)) || !scope.accepted)throw new Blocked('Draft không chỉ sửa file test trong phạm vi.');
    const structured=(run.qualityPolicyVersion??0)>=2;
    let applied=false;
    let entries:TestManifest['entries'];
    try {
      // Source-declared bindings need their exact saved patch present before parsing.
      if(structured&&(extractJsonBlock(draft.output) as {bindingProtocol?:unknown}).bindingProtocol===2){
        await runtime.revert(run,'A');applied=true;
        await runtime.applyPatch({...run,checkpoint:draft.checkpoint},'A',draft.patch);
      }
      entries=await resolveAuthorManifest(run.contract,draft.output,structured,runtime.workspacePath?.(run,'A'),draft.paths);
    } catch(error) { if(applied)await runtime.revert(run,'A');throw new Blocked(`Draft vẫn chưa hợp lệ: ${(error as Error).message}`); }
    const normalized=entries.map(e=>({...e,path:e.path.replace(/\\/g,'/'),testId:normalizeTestId(e.testId)}));
    const found=manifestFindings(run.contract,normalized,run.configSnapshot.checks,draft.paths),problems=[...found.blocking];
    if(problems.length){if(applied)await runtime.revert(run,'A');throw new Blocked(`Draft vẫn chưa hợp lệ: ${problems.join(' ')}`);}
    try{
      // An Author's first draft precedes the first checkpoint; Git still has the frozen base HEAD.
      if(!applied){await runtime.revert(run,'A');await runtime.applyPatch({...run,checkpoint:draft.checkpoint},'A',draft.patch);}
      const changes=await runtime.changes(run,'A');
      if(changes.files.length!==draft.paths.length || changes.files.some(f=>!draft.paths.includes(f)))throw new Error('Patch draft không khớp các file đã ghi.');
      const audit=await auditManifestAssertions(run.contract,normalized,runtime.workspacePath?.(run,'A'),draft.paths);
      if(audit.problems.length)throw new Error(audit.problems.join(' '));
      const checkpoint=await runtime.commit(run,'A',`${run.title}: recovered Author draft`);
      const advisories=[...new Set([...found.advisories,...audit.advisories])];
      const manifest:TestManifest={schemaVersion:structured?2:1,source:'author',contractHash:hashContract(run.contract),contractVersion:run.contract.version,slot:'A',entries:normalized,...(run.contract.testPlan?.reasoningVersion===1?{assertionAudit:audit.audits}:{}),...(advisories.length?{advisories}:{})};
      this.s.artifact(runId,{kind:'acceptance',title:'Test manifest',content:JSON.stringify(manifest),checkpoint});
      this.s.artifact(runId,{kind:'diff',title:'Diff Author recovered',content:changes.patch,checkpoint});
      this.s.mutate(runId,r=>{r.checkpoint=checkpoint;});this.scope.lockAcceptance(runId,draft.paths,checkpoint,'Acceptance suite (Author)',true);
      this.s.store.artifacts.put({...this.s.store.artifacts.get(draft.artifactId)!,valid:false});
      this.s.mutate(runId,r=>{r.status='paused';r.blocker='Draft đã được khóa thành test nghiệm thu; bấm Chạy tiếp để bắt đầu Developer.';});
    }catch(e){await runtime.revert(this.s.run(runId),'A');throw e;}
  }

  private recordReuse(runId: string, output: string): void {
    try {
      const reuse = parseOutput(ReuseAssessmentSchema, output);
      this.s.artifact(runId, { kind: 'reuse', title: 'ReuseAssessment', content: JSON.stringify(reuse), checkpoint: this.s.run(runId).checkpoint });
    } catch { this.s.log(runId, 'reuse.missing', 'Developer không cung cấp ReuseAssessment hợp lệ.'); }
  }
}
