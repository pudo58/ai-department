import { DiagnosisSchema as Diagnosis, diagnosisProblems, diagnosisOutputGuide, normalizeDiagnosis } from '../../core/diagnosis.js';
import type { Diagnosis as DiagnosisValue } from '../../core/diagnosis.js';
import { budgetState, remainingFor } from '../../core/budget.js';
import { isIntegrityIssue } from '../../core/checks.js';
import { auditManifestAssertions, assertionTokens } from '../../core/authoring.js';
import { manifestFindings, normalizeTestId } from '../../core/testplan.js';
import { deriveTitleManifest } from '../../core/sourcebindings.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseOutput } from '../../core/outputs.js';
import { contractText, originalRequirementBlock } from '../../core/prompts.js';
import { deepQuality, latestChecks, readManifest } from '../../core/qualityevidence.js';
import { DIAGNOSIS_ATTEMPT_TITLE, pendingTestRepair, TEST_REPAIR_TITLE, testRepairConfigHash, type TestRepairProposal } from '../../core/recovery.js';
import { evaluateChanges } from '../../core/scope.js';
import { hashContract, sha256 } from '../../core/contract.js';
import { unsafeTestPatch, validAssertionChanges } from '../../core/recovery.js';
import type { Slot } from '../../shared/types.js';
import { policyOf } from '../../core/policy.js';
import { setupRepairProblems, assertionCorrectionProblems } from '../../core/authoring.js';
import type { RunServices } from './services.js';
import type { ScopePolicy } from './scope.js';
import { Blocked, HttpError } from './support.js';

const REVIEW = DIAGNOSIS_ATTEMPT_TITLE;
/** A run may apply this many valid Author test corrections by itself; a further one waits for a person. */
const MAX_AUTO_TEST_REPAIRS = 3;

/** Failed assertions remain locked. Author may propose a test-only correction, never activate it. */
export class TestRecovery {
  constructor(private readonly s: RunServices, private readonly scope: ScopePolicy) {}

  async diagnose(runId: string, slot: Slot, problems: string[], signal: AbortSignal): Promise<string | undefined> {
    const run = this.s.run(runId), runtime = this.s.runtimeFor(run), policy = policyOf(run);
    if (!deepQuality(run) || !runtime.applyPatch) return;
    const artifacts = this.s.store.artifacts.list(runId), locked = readManifest(run, artifacts);
    if (!locked) return;
    const previousReview=artifacts.find(a => {
      if (a.title !== REVIEW || a.contractVersion !== run.contract.version) return false;
      try { const previous = JSON.parse(a.content); return !previous.manifestHash || (previous.manifestHash === locked.hash && previous.slot === slot); } catch { return true; }
    });
    if(previousReview){
      let receipt=artifacts.filter(a=>a.title==='Author test diagnosis result' && a.valid && a.contractVersion===run.contract.version).at(-1);
      // Re-read a completed diagnosis after a parser upgrade, never buy another model attempt.
      if (!receipt && previousReview.checkpoint === run.checkpoint) {
        const marker = JSON.parse(previousReview.content);
        const attempt = this.s.store.attempts.list(runId).filter(a=>a.role==='author' && a.stage==='repair' && a.status==='completed' && a.slot===slot && a.checkpoint===run.checkpoint && a.contractVersion===run.contract.version && a.startedAt>=previousReview.createdAt).at(-1);
        const raw=attempt && artifacts.find(a=>a.kind==='raw' && a.valid && a.attemptId===attempt.id && a.checkpoint===run.checkpoint && a.contractVersion===run.contract.version);
        if(raw && sha256(raw.content)===raw.hash && marker.configHash===testRepairConfigHash(run)) {
          let output='';
          for(const line of raw.content.split('\n'))try{const e=JSON.parse(line);if(e.type==='item.completed'&&e.item?.type==='agent_message')output=e.item.text;if(e.type==='result'&&typeof e.result==='string')output=e.result;}catch{}
          try{const diagnosis=parseOutput(Diagnosis,output);receipt=this.s.artifact(runId,{kind:'report',title:'Author test diagnosis result',content:JSON.stringify({...diagnosis,manifestHash:locked.hash,slot,checkpoint:run.checkpoint,configHash:testRepairConfigHash(run),recoveredFrom:raw.id}),checkpoint:run.checkpoint});}catch{ /* Keep the bounded diagnostic gate. */ }
        }
      }
      if(receipt && receipt.checkpoint===run.checkpoint && sha256(receipt.content)===receipt.hash){try{const d=JSON.parse(receipt.content),parsed=Diagnosis.parse(d),marker=JSON.parse(previousReview.content);const failedIds=latestChecks(run,this.s.store.checks.list(runId)).flatMap(c=>c.outcomes?.filter(o=>o.status==='failed').map(o=>o.id)??[]);if(d.manifestHash===locked.hash && d.slot===slot && d.checkpoint===run.checkpoint && d.configHash===testRepairConfigHash(run) && d.decision==='implementation'&&!diagnosisProblems(run,parsed,marker.caseIds??[],failedIds,locked.manifest.entries.map(e=>e.path),[]).length)return;}catch{}}
      return this.keepLocked(runId, 'Đã dùng lượt chẩn đoán cho manifest này và kết luận không còn dùng được');
    }
    const checks = latestChecks({ ...run, selectedSlot: slot }, this.s.store.checks.list(runId));
    if (checks.some(c => c.required && (c.missingTestIds.length || c.issues?.some(isIntegrityIssue)))) return;
    const cases = [...new Set(locked.manifest.entries.filter(e => checks.some(c => c.recipeId === e.recipeId && c.manifestHash === locked.hash && c.required && c.status === 'failed'
      && c.outcomes?.some(o => o.id === e.testId && o.status === 'failed'))).map(e => e.caseId))];
    if (!cases.length) return;
    // Persist before calling AI: interrupt/resume cannot silently buy another diagnosis.
    this.s.artifact(runId, { kind: 'report', title: REVIEW, content: JSON.stringify({ slot, caseIds: cases, manifestHash: locked.hash,configHash:testRepairConfigHash(run),checkpoint:run.checkpoint }), checkpoint: run.checkpoint });
    // v4 judges a correction against what the file said before the Author touched it, so read that first.
    const workspace = runtime.workspacePath?.(run, slot), beforeSources = new Map<string, string>();
    if (policy.strict && workspace) for (const e of locked.manifest.entries) if (!beforeSources.has(e.path)) beforeSources.set(e.path, await readFile(path.join(workspace, e.path), 'utf8').catch(() => ''));
    try {
      const request = (extra='') => this.s.attempt(runId, { role: 'author', stage: 'repair', slot, signal, prompt: `Bạn là Author chẩn đoán test thất bại. Đối chiếu hợp đồng, setup test và lỗi chạy thật; không lấy việc code hiện tại làm chuẩn đúng.
${contractText(run.contract)}
${originalRequirementBlock(run)}
Mọi quote trong oracle phải chép nguyên văn từ text của tiêu chí trong hợp đồng ở trên (hoặc từ yêu cầu gốc), không lấy từ một file trong repo như SPEC.md: quote không nằm trong text đó bị từ chối.
Ca lỗi: ${cases.join(', ')}
Bằng chứng runner: ${problems.join('\n').slice(0, 16000)}
Nếu lỗi implementation: KHÔNG sửa file, trả decision implementation. Nếu chưa đủ bằng chứng: KHÔNG sửa file, trả ambiguous và câu hỏi cụ thể.
Chỉ khi chứng minh setup test mâu thuẫn hợp đồng, đề xuất test_setup bằng cách sửa đúng file test của ca lỗi trong workspace. Giữ nguyên assertion hành vi, mã C-x/R-x và định danh test; không xóa/skip test, không sửa source, contract, recipe hay manifest. Mọi sửa đổi chỉ là đề xuất, sẽ bị hoàn nguyên và chờ người dùng đọc diff để duyệt.
Nếu assertion sai theo điều khoản rõ ràng, dùng test_assertion: chỉ sửa assertion của ca lỗi, giữ danh tính và số ca. Bắt buộc assertionChanges=[{caseId,before,after,oracle:{references:[{requirementId,quote}],explanation}}], trích nguyên văn hợp đồng, giải thích vì sao before sai và after phù hợp. Không đủ oracle thì ambiguous, không sửa để khớp implementation.
${policy.structuredDiagnosis?`Giao thức ${policy.strict?'v4':'v3'}: assessment bắt buộc. Đọc nhãn cùng expected/actual/đích sửa trước khi chốt; implementation chỉ khi testConformsToContract=true và target=source. Test sai thì target=test, conformity=false. Không đủ căn cứ dùng ambiguous/unknown/null. failingTestIds lấy NGUYÊN VĂN từ report. before/after trong assertionChanges phải là nguyên biểu thức assertion thực trong source; không mô tả bằng văn xuôi.\n${diagnosisOutputGuide}`:'Kết thúc bằng khối json: {"decision":"implementation|test_setup|test_assertion|ambiguous","reason":"...","evidence":"...","caseIds":["C-x"],"assertionChanges":[]}.'}
${extra}` });
      let {output}=await request();
      let diagnosis: DiagnosisValue | undefined;
      const failedIds=checks.flatMap(c=>c.outcomes?.filter(o=>o.status==='failed').map(o=>o.id)??[]);
      const paths=locked.manifest.entries.filter(e=>cases.includes(e.caseId)).map(e=>e.path);
      for(let round=0;round<2;round++){
        let errors:string[]=[];
        try{
          const parsed=parseOutput(Diagnosis,output),changedFiles=(await runtime.changes(run,slot)).files;
          const linkedFor=(ids:readonly string[])=>locked.manifest.entries.filter(e=>ids.includes(e.caseId)&&failedIds.includes(e.testId)).map(e=>e.testId);
          // A "the test is wrong" diagnosis is read by its decision and its diff; redundant fields are restated from the runner's facts.
          const normalized=normalizeDiagnosis(run,parsed,{failingCaseIds:cases,testPaths:paths,changedPaths:changedFiles,failedTestIds:linkedFor(cases)});
          diagnosis=normalized.diagnosis;
          if(normalized.notes.length)this.s.log(runId,'diagnosis.normalized',`Chẩn đoán được chuẩn hoá: ${normalized.notes.join(' ')}`);
          // An implementation or ambiguous diagnosis cannot edit anything: whatever the Author touched is thrown away at the end of this turn anyway.
          const edits=diagnosis.decision==='implementation'||diagnosis.decision==='ambiguous'?[]:changedFiles;
          errors=diagnosisProblems(run,diagnosis,cases,linkedFor(diagnosis.caseIds),paths,edits);
        }catch(error){errors=[(error as Error).message];}
        if(!errors.length)break;
        const changes=await runtime.changes(run,slot);
        this.s.artifact(runId,{kind:'report',title:'Author diagnosis rejected',content:JSON.stringify({output,errors,patch:changes.patch,checkpoint:run.checkpoint,manifestHash:locked.hash}),checkpoint:run.checkpoint});
        await runtime.revert(run,slot);
        diagnosis=undefined;
        if(!policy.authorRepair||round===1||remainingFor(budgetState(run,this.s.store.attempts.list(runId)),'repair')<=0)return this.keepLocked(runId, `Chẩn đoán Author không hợp lệ (${errors.join(' ')})`);
        // Saved before the second call; resume never grants another correction batch.
        this.s.artifact(runId,{kind:'report',title:'Author diagnosis correction attempt',content:JSON.stringify({manifestHash:locked.hash,checkpoint:run.checkpoint,errors}),checkpoint:run.checkpoint});
        this.s.retry(runId,'invalid_output','Author sửa chẩn đoán mâu thuẫn một lần, trước khi gọi Developer.');
        output=(await request(`Bản trước đã hoàn nguyên. Sửa đúng các lỗi cấu trúc và phân loại, không đoán từ implementation:\n${errors.join('\n')}\nBản trước:\n${output.slice(0,20000)}`)).output;
      }
      if(!diagnosis)return this.keepLocked(runId, 'Chẩn đoán chưa hợp lệ');
      this.s.artifact(runId,{kind:'report',title:'Author test diagnosis result',content:JSON.stringify({...diagnosis,manifestHash:locked.hash,slot,checkpoint:run.checkpoint,configHash:testRepairConfigHash(run)}),checkpoint:run.checkpoint});
      this.s.retry(runId,diagnosis.decision==='implementation'?'implementation':'test_error',`Chẩn đoán: ${diagnosis.decision}`);
      if (diagnosis.decision === 'implementation') return;
      if (diagnosis.decision === 'ambiguous') return this.keepLocked(runId, `Author chưa chắc test ${cases.join(', ')} đúng hay sai (${diagnosis.reason.slice(0, 300)})`);
      let changes = await runtime.changes(run, slot);
      const allowedPaths = locked.manifest.entries.filter(e => diagnosis.caseIds.includes(e.caseId)).map(e => e.path);
      // An Author that says the test is wrong but left the workspace untouched gets one reminder to make the edit.
      if (!changes.files.length && remainingFor(budgetState(this.s.run(runId), this.s.store.attempts.list(runId)), 'repair') > 0) {
        await request(`Bạn kết luận test sai nhưng workspace chưa có thay đổi nào. Sửa trực tiếp file test của ca lỗi (${allowedPaths.join(', ') || paths.join(', ')}) theo đúng kết luận rồi trả lại cùng quyết định; không sửa source, hợp đồng hay manifest.`);
        changes = await runtime.changes(run, slot);
      }
      const scope = evaluateChanges(changes.files, { ...this.scope.scopeFor(runId), lockedPaths: [] });
      const why: string[] = [];
      if (!diagnosis.caseIds.length || !diagnosis.caseIds.every(id => cases.includes(id))) why.push('caseIds không thuộc ca lỗi');
      if (!changes.files.length) why.push('Author không sửa file nào');
      else if (!changes.files.every(f => allowedPaths.includes(f))) why.push(`file ngoài các file test của ca lỗi: ${changes.files.filter(f => !allowedPaths.includes(f)).join(', ')}`);
      if (changes.files.length && !scope.accepted) why.push('thay đổi nằm ngoài phạm vi cho phép');
      if (changes.files.length && !changes.patch) why.push('diff rỗng');
      if (changes.patch.length > 1_000_000) why.push('diff quá lớn');
      if (unsafeTestPatch(changes.patch)) why.push('diff tạo/xóa/đổi tên file hoặc thêm skip/only');
      if (policy.strict && changes.files.length) {
        // A setup correction keeps every assertion; an assertion correction changes exactly the assertions it declared.
        if (!workspace) why.push('runtime không cho đối chiếu source trước/sau nên không chứng minh được bản sửa chỉ đổi đúng phần đã khai báo');
        else {
          const consumed = new Set<string>();
          for (const file of changes.files) {
            const before = beforeSources.get(file), after = await readFile(path.join(workspace, file), 'utf8').catch(() => undefined);
            if (before === undefined || after === undefined) { why.push(`${file}: không đọc được source trước/sau khi sửa`); continue; }
            if (diagnosis.decision === 'test_assertion') {
              const result = assertionCorrectionProblems(file, before, after, diagnosis.assertionChanges ?? []);
              why.push(...result.problems); result.used.forEach(u => consumed.add(u));
            } else why.push(...setupRepairProblems(file, before, after));
          }
          if (diagnosis.decision === 'test_assertion') for (const change of diagnosis.assertionChanges ?? []) if (!consumed.has(assertionTokens(change.before))) why.push(`assertion "${change.before.slice(0, 80)}" khai báo trong assertionChanges không được sửa trong file nào`);
        }
      }
      if (why.length) {
        this.s.artifact(runId, { kind: 'report', title: 'Author test proposal rejected', content: JSON.stringify({ why, files: changes.files, patch: changes.patch.slice(0, 200_000), checkpoint: run.checkpoint }), checkpoint: run.checkpoint });
        return this.keepLocked(runId, `Đề xuất sửa test của Author không hợp lệ (${why.join('; ')})`);
      }
      const proposal: TestRepairProposal = { schemaVersion: 1, checkpoint: run.checkpoint!, contractVersion: run.contract.version, contractHash: hashContract(run.contract), slot, configHash: testRepairConfigHash(run), manifestHash: locked.hash, paths: changes.files, patch: changes.patch, ...diagnosis, kind: diagnosis.decision === 'test_assertion' ? 'assertion' : 'setup' };
      if (!validAssertionChanges(run, proposal)) return this.keepLocked(runId, 'Bản sửa assertion của Author thiếu căn cứ hợp đồng hoặc giá trị trước/sau hợp lệ');
      if(policy.reasoning&&proposal.kind==='assertion'&&proposal.assertionChanges!.some(change=>!locked.manifest.entries.some(e=>e.caseId===change.caseId&&e.assertions?.some(a=>assertionTokens(a.expression)===assertionTokens(change.before)))))return this.keepLocked(runId, 'Giá trị "before" của bản sửa assertion không khớp assertion đã khóa');
      this.s.artifact(runId, { kind: 'report', title: TEST_REPAIR_TITLE, content: JSON.stringify(proposal), checkpoint: run.checkpoint });
      this.autoApprove(runId, proposal.caseIds, proposal.reason);
      return `Author đề xuất sửa ${proposal.kind === 'assertion' ? 'assertion' : 'setup'} test. Hãy đọc căn cứ và diff rồi duyệt trước khi thay bộ test đã khóa.`;
    } finally {
      await runtime.revert(this.s.run(runId), slot);
    }
  }

  /**
   * A diagnosis we cannot use is not a reason to stop: the locked tests stay authoritative and the Developer keeps
   * repairing the code. The report says the Author's second opinion was dropped, so the person can look at it at the end.
   */
  private keepLocked(runId: string, why: string): string | undefined {
    if (policyOf(this.s.run(runId)).strict) {
      // v4 never turns a diagnosis it cannot use into "the code must be wrong": it stops, says why, and says what a person can do.
      const message = `Chẩn đoán test dừng ở đây: ${why}. Bộ test đã khóa không đổi và Developer không được gọi để đoán nguyên nhân. Bước tiếp theo của bạn: đọc chẩn đoán đã lưu trong lịch sử run, rồi sửa hợp đồng hoặc kế hoạch ca (lên phiên bản mới để Author làm lại) nếu test nghi sai, hoặc chuyển chế độ nếu bạn muốn thử cách khác.`;
      this.s.log(runId, 'diagnosis.stopped', message);
      return message;
    }
    this.s.fallback(runId, 'Chẩn đoán test', `${why}. Giữ nguyên bộ test đã khóa và tiếp tục sửa code; nếu cuối cùng vẫn không đạt, hãy xem lại test bị nghi.`);
    return undefined;
  }

  /**
   * Nobody is there to read a diff in the middle of a run, so a proposal that already passed every check above (grounded
   * in the contract, matching the locked assertion, inside the Author's own test files) is applied (up to three times per run). It is
   * flagged as a degraded run and the receipt says the system, not a person, approved it. AIDEPT_AUTO_TEST_REPAIR=0 restores the manual gate.
   */
  private autoApprove(runId: string, caseIds: readonly string[], reason: string): void {
    // v4 freezes this at false: only a person who read the diff applies a correction. Older runs follow the operator's switch.
    if (!policyOf(this.s.run(runId)).autoTestRepair || process.env.AIDEPT_AUTO_TEST_REPAIR === '0') return;
    const run = this.s.run(runId), artifacts = this.s.store.artifacts.list(runId);
    if (artifacts.filter(a => a.title === 'Test repair receipt' && a.valid && a.contractVersion === run.contract.version).length >= MAX_AUTO_TEST_REPAIRS) return;
    const pending = pendingTestRepair(run, artifacts);
    if (!pending) return;
    this.s.mutate(runId, r => { r.testRepairApproval = { artifactId: pending.id, artifactHash: pending.hash, auto: true }; });
    this.s.fallback(runId, 'Sửa test của Author', `Author nghi test ${caseIds.join(', ')} sai (${reason.slice(0, 240)}). Đề xuất qua mọi kiểm tra nên được tự áp dụng một lần; diff và căn cứ nằm trong lịch sử run.`);
  }

  approve(runId: string, id: string, hash: string): void {
    const run = this.s.run(runId);
    if (!['blocked', 'failed'].includes(run.status)) throw new HttpError(409, 'Chỉ duyệt sửa test khi run đang dừng để xem xét.');
    const p = pendingTestRepair(run, this.s.store.artifacts.list(runId));
    if (!p || p.id !== id || p.hash !== hash) throw new HttpError(409, 'Đề xuất sửa test đã cũ; tải lại checkpoint và đọc diff hiện tại.');
    this.s.mutate(runId, r => { r.testRepairApproval = { artifactId: id, artifactHash: hash }; });
    this.s.log(runId, 'test_repair.approved', 'Đã duyệt diff sửa test; sẽ khóa lại và chạy bằng chứng mới.', { proposalId: id, proposalHash: hash });
  }

  reject(runId: string, id: string, hash: string): void {
    const run = this.s.run(runId), p = pendingTestRepair(run, this.s.store.artifacts.list(runId));
    if (!['blocked', 'failed'].includes(run.status) || !p || p.id !== id || p.hash !== hash) throw new HttpError(409, 'Đề xuất đã đổi hoặc run không còn chờ xem xét.');
    const artifact = this.s.store.artifacts.get(id)!;
    this.s.store.artifacts.put({ ...artifact, valid: false });
    this.s.mutate(runId, r => { delete r.testRepairApproval; r.blocker = 'Người dùng không duyệt bản sửa test. Bộ test vẫn được khóa; có thể tiếp tục sửa code hoặc xem lại hợp đồng.'; });
    this.s.log(runId, 'test_repair.rejected', 'Người dùng giữ nguyên bộ test đã khóa và không chấp nhận diff đề xuất.', { proposalId: id, proposalHash: hash });
  }

  async applyApproved(runId: string): Promise<void> {
    let run = this.s.run(runId);
    const approval = run.testRepairApproval;
    if (!approval) throw new Blocked('Chưa có bản sửa test được duyệt.');
    if (approval.appliedCheckpoint) {
      if (approval.appliedCheckpoint !== run.checkpoint) throw new Blocked('Checkpoint sau sửa test đã thay đổi.');
      return;
    }
    const artifacts = this.s.store.artifacts.list(runId), p = pendingTestRepair(run, artifacts);
    if (!p || p.id !== approval.artifactId || p.hash !== approval.artifactHash) throw new Blocked('Bản duyệt sửa test không còn khớp checkpoint, hợp đồng hoặc cấu hình.');
    const runtime = this.s.runtimeFor(run), manifest = readManifest(run, artifacts)!;
    if (!runtime.applyPatch) throw new Blocked('Runtime chưa hỗ trợ áp dụng bản sửa test đã duyệt.');
    if (!p.paths.length || p.paths.some(f => !manifest.manifest.entries.some(e => e.path === f)) || !evaluateChanges(p.paths, { ...this.scope.scopeFor(runId), lockedPaths: [] }).accepted) throw new Blocked('Bản sửa không còn nằm trong file test Author được phép.');
    await runtime.revert(run, p.slot);
    await runtime.applyPatch(run, p.slot, p.patch);
    const changes = await runtime.changes(run, p.slot);
    if (changes.files.length !== p.paths.length || changes.files.some(f => !p.paths.includes(f))) {
      await runtime.revert(run, p.slot); throw new Blocked('Diff áp dụng không khớp file test đã duyệt.');
    }
    let entries=structuredClone(manifest.manifest.entries);
    if(policyOf(run).reasoning){
      for(const e of entries)for(const binding of e.assertions??[]){
        delete binding.line;
        const correction=p.assertionChanges?.find(c=>c.caseId===e.caseId&&assertionTokens(c.before)===assertionTokens(binding.expression));
        if(correction)binding.expression=correction.after;
      }
    }
    const allPaths = [...new Set(entries.map(e => e.path))];
    let derivedManifest=!!manifest.manifest.derived;
    let audit=await auditManifestAssertions(run.contract,entries,runtime.workspacePath?.(run,p.slot),allPaths);
    const evidenceProblems=[...manifestFindings(run.contract,entries,run.configSnapshot.checks,allPaths,{derived:derivedManifest}).blocking,...audit.problems];
    let advisories:string[]=[];
    if(evidenceProblems.length&&policyOf(run).strict){
      // v4 never falls back to binding by test title: an assertion that no longer matches its step is a reason to stop.
      await runtime.revert(run,p.slot);
      throw new Blocked(`Bản sửa không giữ liên kết assertion với bước đã duyệt, nên không áp dụng: ${evidenceProblems.join(' ')}`);
    }
    if(evidenceProblems.length){
      // The correction changed text the assertion bindings pointed at. Tests are still identified by title, so bind by title and
      // say in the report that assertions are no longer tied to steps; stop only if even the titles no longer cover the plan.
      const workspace=runtime.workspacePath?.(run,p.slot),derived:typeof entries=[];
      if(workspace)for(const file of allPaths){
        const recipeId=manifest.manifest.entries.find(e=>e.path===file)?.recipeId;
        if(recipeId)for(const e of deriveTitleManifest(run.contract,file,recipeId,await readFile(path.join(workspace,file),'utf8')))derived.push({...e,path:e.path.replace(/\\/g,'/'),testId:normalizeTestId(e.testId)});
      }
      const found=manifestFindings(run.contract,derived,run.configSnapshot.checks,allPaths,{derived:true});
      if(!workspace||found.blocking.length){await runtime.revert(run,p.slot);throw new Blocked(`Bản sửa không giữ liên kết assertion/kế hoạch: ${evidenceProblems.join(' ')}`);}
      entries=derived;advisories=found.advisories;derivedManifest=true;audit={problems:[],advisories:[],audits:[]};
      this.s.fallback(runId,'Liên kết assertion sau khi sửa test','Bản sửa test làm đổi văn bản assertion nên manifest được gắn lại theo tên test; assertion chưa được đối chiếu với từng bước.');
    }
    const checkpoint = await runtime.commit(run, p.slot, `${run.title}: approved test ${p.kind ?? 'setup'} repair`);
    // Retain history, but no old suite/manifest/check may stand in for this revision.
    for (const a of artifacts.filter(a => a.kind === 'acceptance' && a.valid && a.contractVersion === run.contract.version)) this.s.store.artifacts.put({ ...a, valid: false });
    this.s.mutate(runId, r => { r.checkpoint = checkpoint; r.testRepairApproval!.appliedCheckpoint = checkpoint; });
    run = this.s.run(runId);
    const nextManifest = this.s.artifact(runId, { kind: 'acceptance', title: 'Test manifest', content: JSON.stringify({ ...manifest.manifest, entries, ...(policyOf(run).reasoning?{assertionAudit:audit.audits}:{}), ...(advisories.length?{advisories}:{}),...(derivedManifest?{derived:true}:{}), revision: { previousHash: manifest.hash, proposalId: p.id } }), checkpoint });
    this.scope.lockAcceptance(runId, allPaths, checkpoint, 'Acceptance suite (Author)', true);
    this.s.artifact(runId, { kind: 'diff', title: 'Diff Author test repair', content: p.patch, checkpoint });
    this.s.artifact(runId, { kind: 'report', title: 'Test repair receipt', content: JSON.stringify({ schemaVersion: 1, source: approval.auto ? 'auto_approved' : 'human_approved', kind: p.kind ?? 'setup', contractHash: hashContract(run.contract), assertionChanges: p.assertionChanges, proposalId: p.id, proposalHash: p.hash, previousCheckpoint: p.checkpoint, checkpoint, previousManifestHash: manifest.hash, manifestHash: nextManifest.hash, caseIds: p.caseIds, reason: p.reason }), checkpoint });
    this.s.log(runId, 'test_repair.applied', `Đã áp dụng bản sửa được duyệt tại ${checkpoint.slice(0, 8)}; cần kiểm chứng lại.`, { proposalId: p.id });
  }
}
