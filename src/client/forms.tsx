import { TestPlanEditor } from './Quality';
import { useState, type FormEvent } from 'react';
import type { Mode, ProjectProfile, ProviderName, Run, TaskContract } from '../shared/types';
import { PROVIDER_LABEL } from '../shared/providers';
import { Field, Modal } from './ui';
export { ProjectEditForm, ProjectForm } from './projectform';

const modeDescriptions: Record<Mode, string> = {
  single: 'Một Developer với đầy đủ tool. Đây là chế độ mặc định.',
  clarify: 'So sánh cách hiểu độc lập trước khi duyệt hợp đồng.',
  verify: 'Bổ sung kiểm chứng với phiên riêng và nguồn yêu cầu gốc.',
  compare: 'Hai phương án cho cùng yêu cầu, trong một ngân sách chung.',
};
/** "Developer: Codex · Verifier: Claude …" for the chosen project, so it is clear who will do the work. */
const roleSummary = (p?: ProjectProfile) => (p ? ([['planner', 'Planner'], ['developer', 'Developer'], ['author', 'Author'], ['verifier', 'Verifier']] as const).map(([r, l]) => `${l}: ${PROVIDER_LABEL[p.roles[r].provider]}`).join(' · ') + '. Đổi trong Sửa project.' : '');
export function RunForm({ projects, onClose, onSave, busy }: { projects: ProjectProfile[]; onClose: () => void; onSave: (body: unknown) => Promise<void>; busy: boolean }) {
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [title, setTitle] = useState(''); const [requirement, setRequirement] = useState('');
  const [mode, setMode] = useState<Mode>('single'); const [provider, setProvider] = useState<ProviderName>('codex');
  const [budget, setBudget] = useState(projects[0]?.singleBudgetUsd || 5);
  const [taskKind, setTaskKind] = useState<'' | 'bugfix' | 'refactor'>('');
  const [signals, setSignals] = useState<string[]>([]); const [error, setError] = useState('');
  async function submit(e: FormEvent) { e.preventDefault(); setError(''); try { await onSave({ projectId, title: title.trim(), originalRequirement: requirement.trim(), mode, provider, budgetUsd: budget, signals, ...(taskKind ? { taskKind } : {}) }); } catch (e) { setError((e as Error).message); } }
  return <Modal title="Giao việc" subtitle="Viết yêu cầu như nói với một đồng nghiệp. Bằng chứng sẽ gắn với từng bản làm xong." onClose={onClose}><form onSubmit={submit}>
    <Field label="Dự án"><select required value={projectId} onChange={e => { setProjectId(e.target.value); setBudget(projects.find(p => p.id === e.target.value)?.singleBudgetUsd || 5); }}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.approved ? '' : ' · Chưa duyệt policy'}</option>)}</select></Field>
    <Field label="Tên việc"><input required maxLength={180} value={title} onChange={e => setTitle(e.target.value)} placeholder="Ví dụ: Ngăn tạo đơn trùng khi retry"/></Field>
    <Field label="Yêu cầu gốc"><textarea required rows={5} value={requirement} onChange={e => setRequirement(e.target.value)} placeholder="Mô tả hành vi mong đợi, điều kiện biên và hành vi cần giữ…"/></Field>
    <div className="mode-options">{(['single', 'clarify', 'verify', 'compare'] as Mode[]).map(value => <button key={value} className={`mode-option ${mode === value ? 'selected' : ''}`} type="button" onClick={() => setMode(value)}><strong>{value === 'single' ? 'Single' : `Team · ${value}`}</strong><small>{modeDescriptions[value]}</small></button>)}</div>
    <div className="form-grid"><Field label="Cách chạy" hint={provider === 'fake' ? 'Không gọi AI, chỉ thử luồng làm việc.' : roleSummary(projects.find(p => p.id === projectId))}><select value={provider} onChange={e => setProvider(e.target.value as ProviderName)}><option value="codex">Chạy thật · theo vai của project</option><option value="fake">Mô phỏng · không gọi AI</option></select></Field><Field label="Ngân sách (USD)"><input required type="number" min="0.1" step="0.1" value={budget} onChange={e => setBudget(Number(e.target.value))}/></Field></div>
    <Field label="Loại việc (tùy chọn)" hint="Bugfix: cần test fail trên code cũ và pass trên code mới. Refactor: hành vi giữ nguyên, test pass cả hai. Bỏ trống nếu không chắc."><select value={taskKind} onChange={e => setTaskKind(e.target.value as '' | 'bugfix' | 'refactor')}><option value="">Không chỉ định</option><option value="bugfix">Bugfix</option><option value="refactor">Refactor</option></select></Field>
    {provider === 'fake' && <p className="notice">Mô phỏng chỉ kiểm tra workflow. Không chạy agent, không sửa repository và không chứng minh task đã đạt.</p>}
    <details className="advanced"><summary>Dấu hiệu rủi ro cho đề xuất chế độ</summary><div className="check-options">{[['ambiguity', 'Yêu cầu còn nhiều cách hiểu'], ['permissions', 'Quyền truy cập'], ['concurrency', 'Concurrency / retry'], ['public-api', 'Public API dùng chung'], ['alternatives', 'Có hai hướng giải']].map(([value, label]) => <label key={value}><input type="checkbox" checked={signals.includes(value)} onChange={e => setSignals(current => e.target.checked ? [...current, value] : current.filter(x => x !== value))}/>{label}</label>)}</div></details>
    {error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>Hủy</button><button className="button primary" disabled={busy || !projects.length}>{busy ? 'Đang tạo…' : 'Giao việc'}</button></div>
  </form></Modal>;
}
export function ContractForm({ run, onClose, onSave, busy }: { run: Run; onClose: () => void; onSave: (contract: TaskContract) => Promise<void>; busy: boolean }) {
  const [contract, setContract] = useState<TaskContract>(structuredClone(run.contract)); const [error, setError] = useState('');
  const update = (key: 'acceptanceExamples' | 'interfaces' | 'assumptions' | 'scope', text: string) => setContract(c => ({ ...c, [key]: text.split('\n').filter(Boolean) }));
  return <Modal title={`Hợp đồng · v${run.contract.version}`} subtitle="Thay đổi hợp đồng sẽ làm mất hiệu lực bằng chứng và phê duyệt trước đó." onClose={onClose}><form onSubmit={async e => { e.preventDefault(); try { await onSave(contract); } catch (e) { setError((e as Error).message); } }}>
    <div className="field"><span>Tiêu chí nghiệm thu</span>{contract.requirements.map((req, index) => <div className="requirement-edit" key={req.id}><code>{req.id}</code><input aria-label={`Nội dung ${req.id}`} required value={req.text} onChange={e => setContract(c => ({ ...c, requirements: c.requirements.map((r, i) => i === index ? { ...r, text: e.target.value } : r) }))}/><select aria-label={`Hành vi ${req.id}`} value={req.kind ?? 'expected'} onChange={e => setContract(c => ({ ...c, requirements: c.requirements.map((r, i) => i === index ? { ...r, kind: e.target.value as 'expected' | 'forbidden' } : r) }))}><option value="expected">Hành vi mong muốn</option><option value="forbidden">Không được xảy ra</option></select><label><input type="checkbox" checked={req.required} onChange={e => setContract(c => ({ ...c, requirements: c.requirements.map((r, i) => i === index ? { ...r, required: e.target.checked } : r) }))}/>Bắt buộc</label><label><input type="checkbox" checked={req.manual} onChange={e => setContract(c => ({ ...c, requirements: c.requirements.map((r, i) => i === index ? { ...r, manual: e.target.checked } : r) }))}/>Thủ công</label><button type="button" className="text-button danger-text" onClick={() => setContract(c => ({ ...c, requirements: c.requirements.filter((_, i) => i !== index) }))}>Xóa</button></div>)}<button className="text-button" type="button" onClick={() => setContract(c => ({ ...c, requirements: [...c.requirements, { id: `R-${crypto.randomUUID().slice(0, 6)}`, text: '', required: true, manual: false, kind: 'expected' }] }))}>+ Thêm tiêu chí</button></div>
    {([['acceptanceExamples', 'Ví dụ đúng/sai'], ['interfaces', 'Interface công khai'], ['assumptions', 'Giả định cần xác nhận'], ['scope', 'Phạm vi path']] as const).map(([key, label]) => <Field key={key} label={label} hint="Mỗi dòng một mục."><textarea rows={3} value={contract[key].join('\n')} onChange={e => update(key, e.target.value)}/></Field>)}
    <TestPlanEditor plan={contract.testPlan} onChange={testPlan => setContract(c => ({ ...c, testPlan }))}/>
    {error && <p className="inline-error">{error}</p>}<div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>Hủy</button><button className="button primary" disabled={busy || contract.requirements.length === 0}>Lưu phiên bản mới</button></div>
  </form></Modal>;
}
export function ReasonForm({ title, description, onClose, onSave, busy, modeControl }: { title: string; description: string; onClose: () => void; onSave: (reason: string, mode?: Mode) => Promise<void>; busy: boolean; modeControl?: Mode }) {
  const [reason, setReason] = useState(''); const [mode, setMode] = useState<Mode>(modeControl || 'single'); const [error, setError] = useState('');
  return <Modal title={title} subtitle={description} onClose={onClose}><form onSubmit={async e => { e.preventDefault(); try { await onSave(reason, mode); } catch (e) { setError((e as Error).message); } }}>{modeControl && <Field label="Chế độ mới"><select value={mode} onChange={e => setMode(e.target.value as Mode)}>{Object.keys(modeDescriptions).map(m => <option value={m} key={m}>{m === 'single' ? 'Single' : `Team · ${m}`}</option>)}</select></Field>}<Field label="Lý do"><textarea autoFocus required minLength={3} rows={4} value={reason} onChange={e => setReason(e.target.value)}/></Field>{error && <p className="inline-error">{error}</p>}<div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>Hủy</button><button className="button primary" disabled={busy}>Xác nhận</button></div></form></Modal>;
}
