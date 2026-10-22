import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ContextRole, ContextSelection, MemoryItem, MemoryKind, ProjectProfile, RepoMap } from '../shared/types';
import { api } from './api';
import { Badge, Field, Modal } from './ui';

const KINDS: [MemoryKind, string][] = [['convention', 'Quy ước'], ['command', 'Lệnh'], ['pitfall', 'Lỗi đã gặp'], ['decision', 'Quyết định'], ['architecture', 'Kiến trúc']];
const KIND_LABEL = Object.fromEntries(KINDS) as Record<MemoryKind, string>;
const ROLES: [ContextRole, string][] = [['developer', 'Developer'], ['author', 'Author'], ['planner', 'Planner'], ['verifier', 'Verifier']];
const STATUS: Record<MemoryItem['status'], [string, string]> = { active: ['Đang dùng', 'good'], proposed: ['Chờ duyệt', 'warn'], stale: ['Cần xác nhận lại', 'warn'], archived: ['Đã lưu trữ', 'neutral'] };
type Tab = 'memory' | 'map' | 'preview';
interface Preview { enabled: boolean; defaults: Record<ContextRole, number>; selection: ContextSelection; skipped: { id: string; reason: string }[] }

/**
 * Project context: approved memory, the repo map, and a preview of exactly what each role would receive. Memory
 * edits apply to runs started afterwards; turning context on or changing budgets is a policy change.
 */
export function ProjectContext({ project, onClose, onProjectSaved }: { project: ProjectProfile; onClose: () => void; onProjectSaved: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('memory');
  return <Modal title={`Ngữ cảnh · ${project.name}`} subtitle="Sự kiện về repo gửi kèm prompt của agent. Chỉ mục bạn đã duyệt mới được gửi; mỗi run đóng băng ngữ cảnh lúc bắt đầu." onClose={onClose}><div>
    <div className="context-head">
      <div className="segmented" role="tablist" aria-label="Ngữ cảnh">{([['memory', 'Bộ nhớ'], ['map', 'Bản đồ repo'], ['preview', 'Xem trước & ngân sách']] as [Tab, string][]).map(([t, label]) =>
        <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{label}</button>)}</div>
      <Badge tone={project.contextEnabled ? 'good' : 'neutral'}>{project.contextEnabled ? 'Đang bật' : 'Đang tắt'}</Badge>
    </div>
    {tab === 'memory' && <MemoryTab projectId={project.id}/>}
    {tab === 'map' && <MapTab projectId={project.id}/>}
    {tab === 'preview' && <PreviewTab project={project} onProjectSaved={onProjectSaved}/>}
  </div></Modal>;
}

function MemoryTab({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [filter, setFilter] = useState<'open' | 'archived'>('open');
  const [editing, setEditing] = useState<MemoryItem | 'new' | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => { try { setItems(await api<MemoryItem[]>(`/api/projects/${projectId}/memory`)); } catch (e) { setError((e as Error).message); } }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  const act = async (item: MemoryItem, body: unknown, method: 'PATCH' | 'DELETE' = 'PATCH') => {
    setError('');
    try { await api(`/api/projects/${projectId}/memory/${item.id}`, method, method === 'PATCH' ? body : undefined); await load(); } catch (e) { setError((e as Error).message); }
  };
  if (!items) return <p className="muted small">{error || 'Đang tải…'}</p>;
  const order: Record<MemoryItem['status'], number> = { proposed: 0, stale: 1, active: 2, archived: 3 };
  const shown = items.filter((m) => (filter === 'archived') === (m.status === 'archived')).sort((a, b) => order[a.status] - order[b.status] || Number(!!b.pinned) - Number(!!a.pinned));
  const active = items.filter((m) => m.status === 'active').length;
  return <>
    <div className="row-actions">
      <div className="segmented" role="group" aria-label="Lọc bộ nhớ">
        <button className={filter === 'open' ? 'active' : ''} aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>Hiện hành <span className="n">{items.length - items.filter((m) => m.status === 'archived').length}</span></button>
        <button className={filter === 'archived' ? 'active' : ''} aria-pressed={filter === 'archived'} onClick={() => setFilter('archived')}>Lưu trữ <span className="n">{items.filter((m) => m.status === 'archived').length}</span></button>
      </div>
      <span className="muted small">{active}/50 mục đang dùng</span>
      <button className="button primary small" onClick={() => setEditing('new')}>+ Thêm mục</button>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {editing && <MemoryEditor projectId={projectId} item={editing === 'new' ? undefined : editing} onDone={async () => { setEditing(null); await load(); }} onCancel={() => setEditing(null)}/>}
    {!shown.length ? <p className="muted small">{filter === 'open' ? 'Chưa có mục nào. Ghi những điều agent hay làm sai hoặc phải mò mới biết: code nằm ở đâu, lệnh nào chạy được, file nào không được đụng.' : 'Không có mục lưu trữ.'}</p>
      : <ul className="memory-list">{shown.map((m) => <li key={m.id} className={`memory-item ${m.status}`}>
        <div className="memory-meta"><Badge tone={STATUS[m.status][1]}>{STATUS[m.status][0]}</Badge><span className="chip">{KIND_LABEL[m.kind]}</span>{m.pinned && <span className="chip">Ghim</span>}
          <span className="faint small">{m.source.type === 'human' ? 'Bạn thêm' : m.source.type === 'agent' ? `Agent đề xuất${m.source.runId ? ` · ${m.source.runId}` : ''}` : 'Hệ thống'} · dùng {m.usedCount} lần</span></div>
        <p className="memory-text">{m.text}</p>
        {m.paths.length > 0 && <div className="chip-row">{m.paths.map((p) => <span key={p} className="chip mono">{p}</span>)}</div>}
        {m.staleReason && m.status === 'stale' && <p className="notice-line">{m.staleReason}</p>}
        <div className="row-actions memory-actions">
          {m.status !== 'active' && m.status !== 'archived' && <button className="button small primary" onClick={() => void act(m, { status: 'active' })}>{m.status === 'proposed' ? 'Duyệt' : 'Xác nhận lại'}</button>}
          {m.status === 'archived' && <button className="button small" onClick={() => void act(m, { status: 'active' })}>Dùng lại</button>}
          <button className="button small ghost" onClick={() => setEditing(m)}>Sửa</button>
          {m.status !== 'archived' && <button className="button small ghost" onClick={() => void act(m, { pinned: !m.pinned })}>{m.pinned ? 'Bỏ ghim' : 'Ghim'}</button>}
          {m.status !== 'archived' ? <button className="button small ghost" onClick={() => void act(m, { status: 'archived' })}>Lưu trữ</button>
            : <button className="button small ghost danger-text" onClick={() => void act(m, undefined, 'DELETE')}>Xóa hẳn</button>}
        </div>
      </li>)}</ul>}
  </>;
}

function MemoryEditor({ projectId, item, onDone, onCancel }: { projectId: string; item?: MemoryItem; onDone: () => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState<MemoryKind>(item?.kind ?? 'architecture');
  const [text, setText] = useState(item?.text ?? '');
  const [paths, setPaths] = useState((item?.paths ?? []).join('\n'));
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    const body = { kind, text: text.trim(), paths: paths.split('\n').map((p) => p.trim()).filter(Boolean) };
    try { await api(item ? `/api/projects/${projectId}/memory/${item.id}` : `/api/projects/${projectId}/memory`, item ? 'PATCH' : 'POST', body); await onDone(); } catch (err) { setError((err as Error).message); }
  }
  return <form className="memory-editor" onSubmit={submit}>
    <div className="form-grid">
      <Field label="Loại"><select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      <Field label="Đường dẫn liên quan (mỗi dòng một)" hint="Neo mục này vào file/thư mục; nếu chúng biến mất, mục tự chuyển sang cần xác nhận lại."><textarea rows={2} value={paths} onChange={(e) => setPaths(e.target.value)} spellCheck={false} placeholder="worker/"/></Field>
    </div>
    <Field label={`Nội dung (${text.length}/500)`} hint="Một sự kiện kiểm chứng được, ngắn gọn. Ví dụ: Test chạy bằng node --test tests/*.test.cjs; repo không có script test."><textarea rows={3} maxLength={500} required minLength={3} value={text} onChange={(e) => setText(e.target.value)}/></Field>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="row-actions"><button type="button" className="button secondary small" onClick={onCancel}>Hủy</button><button className="button primary small">{item ? 'Lưu' : 'Thêm (đang dùng ngay)'}</button></div>
  </form>;
}

function MapTab({ projectId }: { projectId: string }) {
  const [map, setMap] = useState<RepoMap | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => { setError(''); try { setMap(await api<RepoMap>(`/api/projects/${projectId}/repomap`)); } catch (e) { setError((e as Error).message); } }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  return <>
    <div className="row-actions"><span className="muted small">Đọc từ thư mục project ngay lúc này, chỉ tên file và script, không đọc nội dung. Mỗi run tự tạo lại từ bản sao làm việc của nó.</span><button className="button small" onClick={() => void load()}>Làm mới</button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!map ? <p className="muted small">Đang đọc…</p> : <dl className="facts map-facts">
      <dt>Thư mục</dt><dd><pre className="detect-pre">{map.tree || '(trống)'}</pre></dd>
      <dt>Script</dt><dd><pre className="detect-pre">{map.scripts}</pre></dd>
      <dt>Điểm vào</dt><dd className="mono">{map.entries || '—'}</dd>
      <dt>Test</dt><dd>{map.tests}</dd>
      <dt>Tài liệu</dt><dd>{map.docs || '—'}</dd>
    </dl>}
  </>;
}

function PreviewTab({ project, onProjectSaved }: { project: ProjectProfile; onProjectSaved: () => Promise<void> }) {
  const [role, setRole] = useState<ContextRole>('developer');
  const [budget, setBudget] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [enabled, setEnabled] = useState(!!project.contextEnabled);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const effective = budget ?? project.contextBudget?.[role] ?? preview?.defaults[role] ?? 0;
  const load = useCallback(async () => {
    setError('');
    try { setPreview(await api<Preview>(`/api/projects/${project.id}/context?role=${role}${budget !== null ? `&budget=${budget}` : ''}`)); } catch (e) { setError((e as Error).message); }
  }, [project.id, role, budget]);
  useEffect(() => { void load(); }, [load]);
  async function save() {
    setError(''); setSaved('');
    try {
      await api(`/api/projects/${project.id}`, 'PATCH', { contextEnabled: enabled, contextBudget: { ...project.contextBudget, ...(budget !== null ? { [role]: budget } : {}) } });
      setSaved('Đã lưu. Policy cần được duyệt lại trước khi chạy thật.'); setBudget(null); await onProjectSaved();
    } catch (e) { setError((e as Error).message); }
  }
  const sel = preview?.selection;
  const max = Math.max(effective, 1);
  const dirty = enabled !== !!project.contextEnabled || budget !== null;
  return <>
    <div className="preview-controls">
      <label className="inline-check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}/>Gửi ngữ cảnh cho agent của project này</label>
      <div className="segmented" role="group" aria-label="Vai">{ROLES.map(([r, l]) => <button key={r} className={role === r ? 'active' : ''} aria-pressed={role === r} onClick={() => { setRole(r); setBudget(null); }}>{l}</button>)}</div>
      <label className="check-opt narrow-opt">Ngân sách (token ước tính)<input type="number" min={0} max={20000} step={100} value={effective} onChange={(e) => setBudget(Math.max(0, Number(e.target.value)))}/></label>
      <button className="button primary small" disabled={!dirty} onClick={() => void save()}>Lưu</button>
    </div>
    <p className="muted small">Mặc định: Developer {preview?.defaults.developer ?? 3000}, Planner {preview?.defaults.planner ?? 1500}, Author {preview?.defaults.author ?? 1000}, Verifier {preview?.defaults.verifier ?? 0} (tắt cho tới khi đo được lợi ích). Interpreter không bao giờ nhận ngữ cảnh. Guidance luôn được gửi và không tính vào ngân sách{sel ? ` (~${sel.guidanceTokens} token)` : ''}.</p>
    {saved && <p className="notice-line">{saved}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!sel ? <p className="muted small">Đang tính…</p> : <>
      <div className="budget-bar" role="img" aria-label={`Dùng ${sel.usedTokens} trên ${effective} token`}><span style={{ width: `${Math.min(100, (sel.usedTokens / max) * 100)}%` }}/></div>
      <p className="small">{!enabled && <strong>Đang tắt: chưa gửi gì. </strong>}{role === 'verifier' && effective === 0 ? 'Verifier đang tắt ngữ cảnh.' : `~${sel.usedTokens} / ${effective} token, ${sel.sections.filter((s) => s.included).length} phần được gửi, ${sel.sections.filter((s) => !s.included).length} phần bị bỏ.`}</p>
      <ul className="preview-list">{sel.sections.map((s, i) => <li key={i} className={s.included ? '' : 'dropped'}>
        <div className="preview-row"><strong>{s.name}</strong><span className="faint small">~{s.tokens} token</span>{!s.included && <Badge tone="warn">Bị bỏ</Badge>}</div>
        <pre className="detect-pre">{s.text}</pre>
        {s.reason && <small className="muted">{s.reason}</small>}
      </li>)}</ul>
      {preview!.skipped.length > 0 && <p className="notice-line">{preview!.skipped.length} mục bộ nhớ sẽ không được gửi vì không còn đúng với repo: {preview!.skipped.map((s) => s.reason).join(' ')}</p>}
    </>}
  </>;
}
