import type { TestPlan, TestCase, QualityDetail } from '../shared/quality';
import { RISK_GROUPS, RISK_LABELS } from '../shared/quality';
import { Badge, Field, duration } from './ui';

export function TestPlanView({ plan }: { plan?: TestPlan }) {
  if (!plan) return <p className="muted small">Chưa có kế hoạch ca kiểm thử.</p>;
  return <div className="stack"><div className="table-scroll"><table className="compact"><thead><tr><th>Ca / yêu cầu</th><th>Rủi ro</th><th>Điều kiện và thao tác</th><th>Kết quả mong đợi</th><th>Kiểm tra</th></tr></thead><tbody>{plan.cases.map(c => <tr key={c.id}>
    <td><code>{c.id}</code><br/>{c.requirementIds.join(', ')}</td><td>{RISK_LABELS[c.group]}<br/>{c.risk}<br/><Badge tone={c.priority === 'high' ? 'warn' : 'neutral'}>{c.priority}</Badge></td>
    <td>{c.preconditions}<br/>{c.actions}{c.steps && <ol className="plain-list">{c.steps.map((step, i) => <li key={i}>{step.id&&<code>{step.id} · </code>}{step.action} → {step.expected}{step.before&&<p className="small">Trước: {step.before}</p>}{step.after&&<p className="small">Sau: {step.after} · {step.requirementIds?.join(', ')}</p>}</li>)}</ol>}{c.invariants && <p><strong>Bất biến:</strong> {c.invariants.join('; ')}</p>}</td><td>{c.expected}{c.oracle && <details><summary>Căn cứ hợp đồng</summary>{c.oracle.references.map((r, i) => <p key={i}><code>{r.requirementId}</code>: {r.quote}</p>)}<p>{c.oracle.explanation}</p><p className="muted small">Trích dẫn hợp lệ không chứng minh assertion đúng về ngữ nghĩa.</p></details>}</td><td>{c.method === 'manual' ? 'Thủ công' : 'Tự động'} · {c.required ? 'Bắt buộc' : 'Bổ sung'}</td>
  </tr>)}</tbody></table></div>
    {plan.notApplicable.length > 0 && <div><h3>Nhóm không áp dụng</h3><ul className="plain-list">{plan.notApplicable.map(n => <li key={n.group}>{RISK_LABELS[n.group]}: {n.reason}</li>)}</ul></div>}
    {plan.questions.length > 0 && <div className="banner warn"><div><strong>Câu hỏi chưa giải quyết</strong><ul>{plan.questions.map(q => <li key={q}>{q}</li>)}</ul></div></div>}
  </div>;
}

export function TestPlanEditor({ plan, onChange }: { plan?: TestPlan; onChange: (plan: TestPlan) => void }) {
  if (!plan) return <button type="button" className="button secondary" onClick={() => onChange({ schemaVersion: 2, reasoningVersion:1, statefulModelVersion: 1, cases: [], notApplicable: [], questions: [] })}>Thêm kế hoạch ca kiểm thử</button>;
  const edit = (index: number, patch: Partial<TestCase>) => onChange({ ...plan, statefulModelVersion: 1, cases: plan.cases.map((c, i) => i === index ? { ...c, ...patch } : c) });
  return <section className="stack" aria-label="Sửa kế hoạch ca"><h3>Kế hoạch ca kiểm thử</h3>
    {plan.schemaVersion === 1 && <button type="button" className="text-button" onClick={() => onChange({ ...plan, schemaVersion: 2 })}>Thêm căn cứ và nâng kế hoạch lên v2</button>}
    {plan.cases.map((c, i) => <fieldset key={i} className="quality-case"><legend>{c.id || `Ca ${i + 1}`}</legend>
      <div className="quality-grid"><Field label="Mã ca"><input required aria-label={`Mã ca ${i + 1}`} value={c.id} onChange={e => edit(i, { id: e.target.value })}/></Field>
        <Field label="Mã yêu cầu (phẩy phân cách)"><input required aria-label={`Yêu cầu ${c.id}`} value={c.requirementIds.join(', ')} onChange={e => edit(i, { requirementIds: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}/></Field>
        <Field label="Nhóm"><select aria-label={`Nhóm ${c.id}`} value={c.group} onChange={e => edit(i, { group: e.target.value as TestCase['group'] })}>{RISK_GROUPS.map(g => <option key={g} value={g}>{RISK_LABELS[g]}</option>)}</select></Field>
        <Field label="Ưu tiên"><select aria-label={`Ưu tiên ${c.id}`} value={c.priority} onChange={e => edit(i, { priority: e.target.value as TestCase['priority'] })}><option value="high">Cao</option><option value="normal">Thường</option><option value="low">Thấp</option></select></Field></div>
      {(['risk', 'preconditions', 'actions', 'expected'] as const).map((key, n) => <Field key={key} label={['Rủi ro', 'Điều kiện ban đầu', 'Dữ liệu và thao tác', 'Kết quả quan sát được'][n]!}><textarea required aria-label={`${key} ${c.id}`} rows={2} value={c[key]} onChange={e => edit(i, { [key]: e.target.value })}/></Field>)}
      {(plan.schemaVersion === 2 || c.oracle) && <fieldset><legend>Căn cứ hợp đồng {c.id}</legend>
        {(c.oracle?.references ?? []).map((ref, n) => <div className="quality-grid" key={n}>
          <Field label="Mã điều khoản"><input required aria-label={`Điều khoản ${c.id} ${n + 1}`} value={ref.requirementId} onChange={e => edit(i, { oracle: { explanation: c.oracle?.explanation ?? '', references: c.oracle!.references.map((r, j) => j === n ? { ...r, requirementId: e.target.value } : r) } })}/></Field>
          <Field label="Trích nguyên văn"><textarea required aria-label={`Trích dẫn ${c.id} ${n + 1}`} value={ref.quote} onChange={e => edit(i, { oracle: { explanation: c.oracle?.explanation ?? '', references: c.oracle!.references.map((r, j) => j === n ? { ...r, quote: e.target.value } : r) } })}/></Field>
          <button type="button" className="text-button" onClick={() => edit(i, { oracle: { explanation: c.oracle?.explanation ?? '', references: c.oracle!.references.filter((_, j) => j !== n) } })}>Bỏ trích dẫn</button>
        </div>)}
        <button type="button" className="text-button" onClick={() => edit(i, { oracle: { explanation: c.oracle?.explanation ?? '', references: [...(c.oracle?.references ?? []), { requirementId: c.requirementIds[0] ?? '', quote: '' }] } })}>+ Thêm căn cứ {c.id}</button>
        <Field label="Giải thích căn cứ của kết quả, từng bước và bất biến"><textarea required aria-label={`Giải thích căn cứ ${c.id}`} value={c.oracle?.explanation ?? ''} onChange={e => edit(i, { oracle: { references: c.oracle?.references ?? [], explanation: e.target.value } })}/></Field>
      </fieldset>}
      {(['state', 'concurrency', 'consistency'] as const).some(group => group === c.group) && <>
        {plan.reasoningVersion!==1&&<Field label="Chuỗi trạng thái (mỗi dòng: thao tác → kết quả quan sát ngay sau thao tác)" hint="Ca bắt buộc cần ít nhất hai bước; nêu retry, reopen hoặc thao tác đồng thời khi phù hợp."><textarea aria-label={`Chuỗi trạng thái ${c.id}`} rows={4} value={(c.steps ?? []).map(s => `${s.action} → ${s.expected}`).join('\n')} onChange={e => edit(i, { steps: e.target.value.split('\n').filter(Boolean).map(line => { const [action, ...rest] = line.split('→'); return { action: action?.trim() ?? '', expected: rest.join('→').trim() }; }) })}/></Field>}
        <Field label="Bất biến sau từng bước" hint="Mỗi dòng là điều kiện phải còn đúng sau mọi chuyển trạng thái."><textarea aria-label={`Bất biến ${c.id}`} rows={3} value={(c.invariants ?? []).join('\n')} onChange={e => edit(i, { invariants: e.target.value.split('\n').filter(Boolean) })}/></Field>
      </>}
      {plan.reasoningVersion===1&&<StepReasoningEditor testCase={c} onChange={steps=>edit(i,{steps})}/>}
      <div className="row-actions"><label><input type="checkbox" checked={c.required} onChange={e => edit(i, { required: e.target.checked })}/> Bắt buộc</label>
        <label><input type="checkbox" checked={c.method === 'manual'} onChange={e => edit(i, { method: e.target.checked ? 'manual' : 'automated' })}/> Thủ công (cần đổi tiêu chí liên quan ở trên)</label>
        <button type="button" className="text-button danger-text" onClick={() => onChange({ ...plan, cases: plan.cases.filter((_, index) => index !== i) })}>Xóa {c.id}</button></div>
    </fieldset>)}
    <button type="button" className="text-button" onClick={() => onChange({ ...plan, statefulModelVersion: 1, cases: [...plan.cases, { id: `C-${crypto.randomUUID().slice(0, 6)}`, requirementIds: [], group: 'boundary', risk: '', priority: 'normal', preconditions: '', actions: '', expected: '', method: 'automated', required: true }] })}>+ Thêm ca</button>
    {RISK_GROUPS.filter(g => !plan.cases.some(c => c.group === g)).map(group => <Field key={group} label={`Lý do không áp dụng: ${RISK_LABELS[group]}`}><textarea rows={2} value={plan.notApplicable.find(n => n.group === group)?.reason ?? ''} onChange={e => onChange({ ...plan, notApplicable: [...plan.notApplicable.filter(n => n.group !== group), ...(e.target.value.trim() ? [{ group, reason: e.target.value }] : [])] })}/></Field>)}
    {plan.notApplicable.filter(n => plan.cases.some(c => c.group === n.group)).map(n => <p className="notice-line warn" key={n.group}>Nhóm {RISK_LABELS[n.group]} vừa có ca vừa không áp dụng. <button type="button" className="text-button" onClick={() => onChange({ ...plan, notApplicable: plan.notApplicable.filter(x => x.group !== n.group) })}>Bỏ lý do không áp dụng</button></p>)}
    <Field label="Câu hỏi chưa giải quyết" hint="Trả lời vào hợp đồng hoặc ghi giả định rõ ràng, rồi xóa câu hỏi trước khi duyệt."><textarea rows={3} value={plan.questions.join('\n')} onChange={e => onChange({ ...plan, questions: e.target.value.split('\n').filter(Boolean) })}/></Field>
  </section>;
}

function StepReasoningEditor({testCase:c,onChange}:{testCase:TestCase;onChange:(steps:NonNullable<TestCase['steps']>)=>void}){
 const steps=c.steps??[],edit=(index:number,patch:Partial<(typeof steps)[number]>)=>onChange(steps.map((s,i)=>i===index?{...s,...patch}:s));
 return <fieldset><legend>Trạng thái và căn cứ từng bước {c.id}</legend><p className="small muted">Mọi thay đổi làm hợp đồng cần duyệt lại. Các trường này ghi lập luận để soát, chưa chứng minh chuyển trạng thái đúng về nghiệp vụ.</p>{steps.map((s,i)=><fieldset key={i}><legend>{s.id??`Bước ${i+1}`}</legend><Field label="Mã bước"><input aria-label={`Mã bước ${c.id} ${i+1}`} value={s.id??''} onChange={e=>edit(i,{id:e.target.value})}/></Field>{(['before','action','expected','after'] as const).map((key,n)=><Field key={key} label={['Trạng thái và đồng hồ trước','Thao tác','Kết quả quan sát','Trạng thái và đồng hồ sau'][n]!}><textarea aria-label={`${key} ${c.id} ${i+1}`} value={s[key]??''} onChange={e=>edit(i,{[key]:e.target.value})}/></Field>)}<Field label="Điều khoản làm căn cứ"><input aria-label={`Điều khoản bước ${c.id} ${i+1}`} value={(s.requirementIds??[]).join(', ')} onChange={e=>edit(i,{requirementIds:e.target.value.split(',').map(x=>x.trim()).filter(Boolean)})}/></Field><button type="button" className="text-button" onClick={()=>onChange(steps.filter((_,n)=>n!==i))}>Bỏ bước</button></fieldset>)}<button type="button" className="text-button" onClick={()=>onChange([...steps,{id:`S-${crypto.randomUUID().slice(0,6)}`,action:'',expected:'',before:'',after:'',requirementIds:[]}])}>+ Thêm bước {c.id}</button></fieldset>;
}

export function QualityResults({ quality }: { quality: QualityDetail }) {
  if (!quality.enabled) return <section className="panel"><h2>Kiểm thử sâu</h2><p className="muted">Chưa áp dụng kiểm thử sâu cho run này.</p></section>;
  const m = quality.mutation;
  const allPassed = quality.cases.length > 0 && quality.cases.every(c => c.status === 'passed');
  return <section className="panel" aria-label="Bằng chứng ca kiểm thử"><div className="card-head"><h2>Các ca đã khai báo</h2><Badge tone={allPassed ? 'good' : 'warn'}>{allPassed ? 'Các ca đã khai báo đạt' : 'Còn ca chưa được kiểm tra đạt'}</Badge></div>
    <p className="muted small">Kết quả này không chứng minh mọi tình huống nghiệp vụ đều đã được kiểm tra.</p>
    {quality.manifestProblems.length > 0 && <ul className="plain-list warn-list">{quality.manifestProblems.map(p => <li key={p}>{p}</li>)}</ul>}
    <div className="table-scroll"><table className="compact"><thead><tr><th>Ca</th><th>Loại</th><th>Kết quả</th><th>Test chứng minh</th></tr></thead><tbody>{quality.cases.map(c => <tr key={c.caseId}>
      <td><code>{c.caseId}</code> · {c.requirementIds.join(', ')}</td><td>{c.required ? 'Bắt buộc' : 'Bổ sung'} · {c.method === 'manual' ? 'Thủ công' : 'Tự động'}</td>
      <td><Badge tone={c.status === 'passed' ? 'good' : c.status === 'failed' ? 'bad' : 'warn'}>{{ passed: 'Đạt', failed: 'Thất bại', missing: 'Thiếu bằng chứng', manual_pending: 'Chờ kiểm tra thủ công' }[c.status]}</Badge></td>
      <td>{c.tests.join('; ') || '—'}{c.reasons.map(r => <p className="small muted" key={r}>{r}</p>)}</td></tr>)}</tbody></table></div>
    <p className="small muted">Thời gian checks: {duration(quality.testMs)} · Manifest: <code>{quality.manifestHash?.slice(0, 12) ?? 'chưa có'}</code></p>
    <h3>Khả năng bắt lỗi của bộ test — mutation</h3><p><Badge tone={quality.capability.status === 'available' ? 'info' : 'warn'}>{quality.capability.status}</Badge> {quality.capability.reason}</p>
    {quality.capability.candidates && quality.capability.status === 'ambiguous' && <p>Package ứng viên: {quality.capability.candidates.join(', ')}. Chọn trong Sửa project → Nâng cao → Thư mục mutation.</p>}
    {quality.capability.status === 'missing_tool' && <p className="small">{quality.capability.install}</p>}
    {m ? <><p><strong>{m.status}</strong> · Baseline: {m.baseline} · {duration(m.durationMs)}</p><p>Killed: {m.counts.killed} · Sống sót: {m.counts.survived} · Không được phủ: {m.counts.no_coverage} · Timeout: {m.counts.timeout} · Lỗi: {m.counts.errors} · Chưa chạy: {m.pendingUnknown ? 'chưa xác định' : m.counts.pending}</p><p>{m.message}</p>
      <p className="muted small">Timeout và lỗi công cụ không được tính là test phát hiện lỗi nghiệp vụ.</p>
      {m.mutants.some(x => x.status !== 'Killed') && <details><summary>Mutation còn cần xem xét</summary><ul className="plain-list">{m.mutants.filter(x => x.status !== 'Killed').slice(0, 100).map((x, i) => <li key={i}><code>{x.file}:{x.line}</code> · {x.mutator} · {x.status}</li>)}</ul></details>}
    </> : <p className="muted small">Chưa có kết quả mutation cho bản code và cấu hình hiện tại.</p>}
  </section>;
}
