import { useEffect, useState } from 'react';
import type { DesignSnapshot } from '../shared/design';
import type { Run } from '../shared/types';
import { coverageLabel, identityLabel } from '../shared/designlabels';
import { api } from './api';
import { Badge, Field, Modal, dateTime } from './ui';

export type DesignChoice = { kind: 'default' } | { kind: 'none' } | { kind: 'snapshot'; id: string; targetIds: string[] };

/** The `design` field of a run request for a choice. A default is left out so the server uses the project's own. */
export const designField = (choice: DesignChoice): { design?: { snapshotId: string | null; targetIds?: string[] } } =>
  choice.kind === 'default' ? {} : choice.kind === 'none' ? { design: { snapshotId: null } } : { design: { snapshotId: choice.id, targetIds: choice.targetIds } };

/** Published snapshots only: nothing else can be bound to a task. */
export function useDesignSnapshots(): DesignSnapshot[] {
  const [list, setList] = useState<DesignSnapshot[]>([]);
  useEffect(() => { api<DesignSnapshot[]>('/api/design-snapshots').then((all) => setList(all.filter((s) => s.status === 'published'))).catch(() => setList([])); }, []);
  return list;
}

/** Choose the design a task uses: the project's default, none, or one published snapshot (and optionally some of its roots). */
export function DesignPicker({ value, onChange, allowDefault = true }: { value: DesignChoice; onChange: (v: DesignChoice) => void; allowDefault?: boolean }) {
  const snapshots = useDesignSnapshots();
  if (!snapshots.length && value.kind === 'default') return null;
  const current = value.kind === 'snapshot' ? snapshots.find((s) => s.id === value.id) : undefined;
  const targets = value.kind === 'snapshot' ? value.targetIds : [];
  return <Field label="Nguồn thiết kế (Figma)" hint="Chỉ snapshot đã duyệt ở tab MCP mới chọn được. Hợp đồng khóa đúng bản này theo hash.">
    <div>
      <select aria-label="Nguồn thiết kế" value={value.kind === 'snapshot' ? value.id : value.kind} onChange={(e) => { const v = e.target.value; onChange(v === 'default' || v === 'none' ? { kind: v } : { kind: 'snapshot', id: v, targetIds: [] }); }}>
        {allowDefault && <option value="default">Theo mặc định của dự án</option>}
        <option value="none">Không dùng thiết kế</option>
        {snapshots.map((s) => <option key={s.id} value={s.id}>{s.source.fileName} · {dateTime(s.createdAt)}{s.limited ? ' · có giới hạn' : ''}</option>)}
      </select>
      {current && current.roots.length > 0 && <fieldset className="check-options"><legend>Target (bỏ trống = tất cả node gốc)</legend>
        {current.roots.map((r) => <label key={r.id}><input type="checkbox" checked={targets.includes(r.id)}
          onChange={(e) => onChange({ kind: 'snapshot', id: current.id, targetIds: e.target.checked ? [...targets, r.id] : targets.filter((x) => x !== r.id) })}/> {r.name} <small>({r.type})</small></label>)}
      </fieldset>}
    </div>
  </Field>;
}

/** What a contract says about its design source, and the one way to change it (a contract change: version up, approval asked again). */
export function DesignBindingView({ run, canChange, onChanged }: { run: Run; canChange: boolean; onChanged?: () => void }) {
  const binding = run.contract.design;
  const [snap, setSnap] = useState<DesignSnapshot | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (binding) api<DesignSnapshot>(`/api/design-snapshots/${binding.snapshotId}`).then(setSnap).catch(() => setSnap(null)); else setSnap(null);
  }, [binding?.snapshotId, binding?.snapshotHash]);
  const label = snap ? coverageLabel(snap.coverage, snap.issues) : undefined;
  return <section className="panel" aria-label="Nguồn thiết kế của hợp đồng">
    <div className="card-head"><h3 style={{ margin: 0 }}>Nguồn thiết kế</h3>{canChange && <button className="button small" onClick={() => setEditing(true)}>{binding ? 'Đổi nguồn thiết kế' : 'Gắn nguồn thiết kế'}</button>}</div>
    {!binding && <p className="muted">Task này không dùng nguồn thiết kế.</p>}
    {binding && <>
      <p>{snap ? <strong>{snap.source.fileName}</strong> : <code>{binding.snapshotId}</code>} {label && <Badge tone={label.limited ? 'warn' : 'good'}>{label.text}</Badge>} {snap && <Badge>{identityLabel(snap.source.identity)}</Badge>}</p>
      <p className="muted small">Hash khóa trong hợp đồng <code>{binding.snapshotHash.slice(0, 12)}</code> · {binding.targetIds.length ? `${binding.targetIds.length} target: ${binding.targetIds.join(', ')}` : 'mọi node gốc của snapshot'} · {binding.acknowledgedIssueIds.length} giới hạn đã chấp nhận.</p>
      {snap && snap.snapshotHash !== binding.snapshotHash && <div className="banner error" role="alert">Snapshot hiện tại khác bản mà hợp đồng đã khóa; task sẽ bị chặn trước khi gọi AI.</div>}
      <p className="muted small">Chưa có kiểm chứng hình ảnh (visual verification): dữ liệu thiết kế chỉ là căn cứ, không chứng minh giao diện cuối giống thiết kế.</p>
    </>}
    {editing && <DesignChangeDialog run={run} onClose={() => setEditing(false)} onChanged={() => { setEditing(false); onChanged?.(); }}/>}
  </section>;
}

function DesignChangeDialog({ run, onClose, onChanged }: { run: Run; onClose: () => void; onChanged: () => void }) {
  const [choice, setChoice] = useState<DesignChoice>(run.contract.design ? { kind: 'snapshot', id: run.contract.design.snapshotId, targetIds: run.contract.design.targetIds } : { kind: 'none' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError('');
    try { await api(`/api/runs/${run.id}/design`, 'POST', choice.kind === 'snapshot' ? { snapshotId: choice.id, targetIds: choice.targetIds } : { snapshotId: null }); onChanged(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal title="Đổi nguồn thiết kế" subtitle="Đây là thay đổi hợp đồng: phiên bản tăng lên, bằng chứng cũ mất hiệu lực và bạn duyệt lại." onClose={onClose}>
    <div className="modal-body">
      <DesignPicker value={choice} onChange={setChoice} allowDefault={false}/>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
    <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>Hủy</button><button className="button primary" disabled={busy} onClick={() => void save()}>Lưu và tăng phiên bản hợp đồng</button></div>
  </Modal>;
}
