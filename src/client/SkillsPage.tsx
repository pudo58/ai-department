import { useCallback, useEffect, useState } from 'react';
import type { Role, SkillCandidate, SkillRecord } from '../shared/types';
import { api } from './api';
import { FolderPicker } from './projectform';
import { Badge, Empty, Icon, Modal, PageHeader, ago } from './ui';

type Listed = SkillRecord & { usedBy: { projectId: string; project: string; role: Role }[] };
const STATUS: Record<SkillRecord['status'], { label: string; tone: string }> = {
  review: { label: 'Chờ duyệt', tone: 'warn' }, active: { label: 'Đang dùng được', tone: 'good' }, disabled: { label: 'Đã tắt', tone: 'neutral' },
};
const SOURCE: Record<SkillRecord['source']['type'], string> = { local: 'Trên máy', zip: 'File .zip', github: 'GitHub' };
const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);

/** The skill library: what is installed, its review state, and where it is used; installing and reviewing happen in dialogs. */
export function SkillsPage() {
  const [skills, setSkills] = useState<Listed[] | null>(null);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setSkills(await api<Listed[]>('/api/skills')); setError(''); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <>
    <PageHeader title="Skill" subtitle="Hướng dẫn và công cụ đóng gói (SKILL.md) giao cho từng vai của agent. Skill chỉ được nạp sau khi bạn duyệt nội dung.">
      <button className="button primary" onClick={() => setInstalling(true)}><Icon name="plus" size={15}/>Cài skill</button>
    </PageHeader>
    {error && <div className="banner error" role="alert"><Icon name="alert" size={16}/><span>{error}</span></div>}
    {skills && !skills.length && <Empty title="Chưa có skill nào" action={<button className="button primary" onClick={() => setInstalling(true)}>Cài skill</button>}>Cài từ các skill có sẵn trên máy (Codex, Claude Code), một file .zip hoặc một thư mục trên GitHub. Sau đó gán cho từng vai trong Sửa dự án.</Empty>}
    {skills && skills.length > 0 && <ol className="project-list">{skills.map((s) => <li className="project-entry" key={s.name}>
      <span className="project-icon" aria-hidden="true"><Icon name="layers" size={16}/></span>
      <div className="project-main">
        <div className="project-name"><h2>{s.name}</h2><Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>{s.hasScripts && <Badge tone="warn">Có script</Badge>}</div>
        <p className="skill-desc">{s.description}</p>
        <p className="project-summary"><span>{SOURCE[s.source.type]}</span><span>{s.files.length} file · {kb(s.sizeBytes)}</span><span>Cập nhật {ago(s.updatedAt)}</span>
          <span>{s.usedBy.length ? `Dùng ở: ${s.usedBy.map((u) => `${u.project} (${u.role})`).join(', ')}` : 'Chưa gán cho vai nào'}</span></p>
      </div>
      <div className="project-actions">
        <button className={`button small${s.status === 'review' ? ' primary' : ''}`} onClick={() => setOpen(s.name)}>{s.status === 'review' ? 'Xem và duyệt' : 'Xem'}</button>
      </div>
    </li>)}</ol>}
    {installing && <InstallDialog onClose={() => setInstalling(false)} onInstalled={async (names) => { setInstalling(false); await load(); if (names.length === 1) setOpen(names[0]!); }}/>}
    {open && <SkillDialog name={open} onClose={() => setOpen(null)} onChanged={load}/>}
  </>;
}

/** One skill: its SKILL.md and files, so a person can read what an agent would be told (and could run) before approving. */
function SkillDialog({ name, onClose, onChanged }: { name: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<{ skill: SkillRecord; skillMd: string; usedBy: Listed['usedBy'] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<NonNullable<typeof data>>(`/api/skills/${name}`).then(setData).catch((e) => setError((e as Error).message)), [name]);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<unknown>, close = false) => {
    setBusy(true); setError('');
    try { await fn(); await onChanged(); if (close) onClose(); else await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const s = data?.skill;
  return <Modal title={name} subtitle={s?.description} onClose={onClose}>
    {!data && !error && <p className="muted">Đang tải…</p>}
    {error && <p className="inline-error">{error}</p>}
    {s && <>
      {s.status === 'review' && <p className="notice-line warn">Đọc nội dung bên dưới trước khi duyệt: agent sẽ làm theo SKILL.md{s.hasScripts ? ' và có thể chạy các script được đánh dấu' : ''}. Nội dung đổi thì phải duyệt lại.</p>}
      <dl className="facts">
        <dt>Trạng thái</dt><dd><Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>{s.reviewedAt && <small className="muted"> · duyệt {ago(s.reviewedAt)}</small>}</dd>
        <dt>Nguồn</dt><dd className="mono">{SOURCE[s.source.type]}: {s.source.url ?? s.source.path ?? ''}</dd>
        <dt>Dùng ở</dt><dd>{data.usedBy.length ? data.usedBy.map((u) => `${u.project} (${u.role})`).join(', ') : 'Chưa gán. Gán trong Sửa dự án → Ai làm việc → Tuỳ chỉnh từng vai.'}</dd>
      </dl>
      <h3 className="section-title">SKILL.md</h3>
      <pre className="detect-pre skill-md">{data.skillMd}</pre>
      <h3 className="section-title">File ({s.files.length})</h3>
      <ul className="filelist">{s.files.map((f) => <li key={f.path}><span className="mono">{f.path}</span> <small className="muted">{kb(f.size)}</small>{f.script && <> <Badge tone="warn">script</Badge></>}</li>)}</ul>
      <div className="row-actions">
        {s.status !== 'active' && <button className="button primary" disabled={busy} onClick={() => void act(() => api(`/api/skills/${name}/approve`, 'POST', {}))}>{s.status === 'review' ? 'Duyệt, cho phép dùng' : 'Bật lại'}</button>}
        {s.status === 'active' && <button className="button" disabled={busy} onClick={() => void act(() => api(`/api/skills/${name}`, 'PATCH', { status: 'disabled' }))}>Tắt</button>}
        <button className="button ghost danger-ghost" disabled={busy || data.usedBy.length > 0} title={data.usedBy.length ? 'Đang được gán; bỏ gán trước khi xoá' : undefined}
          onClick={() => void act(() => api(`/api/skills/${name}`, 'DELETE'), true)}><Icon name="trash" size={14}/>Xoá</button>
      </div>
    </>}
  </Modal>;
}

type Tab = 'local' | 'zip' | 'github';
type Result = { candidates: SkillCandidate[] } | { installed: string[] };

/**
 * Three ways in. Each first shows what the source holds (name, description, size, scripts, problems) and installs only
 * what the person picks; installed skills still wait for review.
 */
function InstallDialog({ onClose, onInstalled }: { onClose: () => void; onInstalled: (names: string[]) => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('local');
  const [found, setFound] = useState<SkillCandidate[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [folder, setFolder] = useState('');
  const [url, setUrl] = useState('');
  const [zip, setZip] = useState<{ fileName: string; dataBase64: string } | null>(null);
  const [picking, setPicking] = useState(false);

  const reset = (next: Tab) => { setTab(next); setFound(null); setPicked([]); setError(''); };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const show = (c: SkillCandidate[]) => { setFound(c); setPicked(c.filter((x) => !x.problems.length && !x.sameAsInstalled).map((x) => x.name)); };

  const scanLocal = (dir = folder) => run(async () => show(await api<SkillCandidate[]>(`/api/skills/local${dir.trim() ? `?path=${encodeURIComponent(dir.trim())}` : ''}`)));
  useEffect(() => { if (tab === 'local') void scanLocal(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = (path: string, body: Record<string, unknown>) => run(async () => show((await api<{ candidates: SkillCandidate[] }>(path, 'POST', { ...body, preview: true })).candidates));
  const install = () => run(async () => {
    const names: string[] = [];
    if (tab === 'local') {
      for (const c of found!.filter((x) => picked.includes(x.name))) names.push(...((await api<Result>('/api/skills/import', 'POST', { path: c.origin })) as { installed: string[] }).installed);
    } else {
      const result = await api<Result>(tab === 'zip' ? '/api/skills/upload' : '/api/skills/github', 'POST', { ...(tab === 'zip' ? zip : { url }), pick: picked });
      names.push(...(result as { installed: string[] }).installed);
    }
    await onInstalled(names);
  });
  const readZip = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataBase64 = String(reader.result).replace(/^data:[^,]*,/, '');
      setZip({ fileName: file.name, dataBase64 });
      void preview('/api/skills/upload', { fileName: file.name, dataBase64 });
    };
    reader.readAsDataURL(file);
  };

  return <Modal title="Cài skill" subtitle="Skill mới cài ở trạng thái Chờ duyệt cho tới khi bạn xem và duyệt nội dung." onClose={onClose}>
    <div className="tabs" role="tablist" style={{ marginTop: 0 }}>{([['local', 'Trên máy'], ['zip', 'File .zip'], ['github', 'GitHub']] as [Tab, string][]).map(([key, label]) =>
      <button key={key} role="tab" aria-selected={tab === key} onClick={() => reset(key)}>{label}</button>)}</div>
    {tab === 'local' && <div className="field"><span>Skill có sẵn của Codex (~/.codex/skills) và Claude Code (~/.claude/skills). Thêm một thư mục khác nếu cần:</span>
      <div className="model-pick"><input className="mono" placeholder="Thư mục skill (có SKILL.md) hoặc thư mục chứa nhiều skill" value={folder} onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void scanLocal(); }} spellCheck={false}/>
        <button type="button" className="button small" onClick={() => setPicking(true)}><Icon name="folder" size={14}/>Chọn thư mục</button>
        <button type="button" className="button small" disabled={busy} onClick={() => void scanLocal()}>Quét</button></div></div>}
    {picking && <FolderPicker start={folder} onClose={() => setPicking(false)} onPick={(dir) => { setPicking(false); setFolder(dir); void scanLocal(dir); }}/>}
    {tab === 'zip' && <label className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); readZip(e.dataTransfer.files[0]); }}>
      <input type="file" accept=".zip" onChange={(e) => readZip(e.target.files?.[0])}/>
      <span>{zip ? zip.fileName : 'Kéo thả hoặc chọn file .zip chứa thư mục skill (có SKILL.md). File .rar không được hỗ trợ.'}</span></label>}
    {tab === 'github' && <div className="field"><span>Link thư mục skill trên GitHub (repo công khai), ví dụ https://github.com/anthropics/skills/tree/main/skills/pdf</span>
      <div className="model-pick"><input className="mono" placeholder="https://github.com/<chủ>/<repo>/tree/<nhánh>/<thư mục>" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false}/>
        <button type="button" className="button small" disabled={busy || !url.trim()} onClick={() => void preview('/api/skills/github', { url })}>Tìm skill</button></div>
      <small className="muted">Nội dung từ Internet: đọc kỹ trước khi duyệt, nhất là skill có script.</small></div>}
    {busy && <p className="muted">Đang xử lý…</p>}
    {error && <p className="inline-error">{error}</p>}
    {found && !found.length && <p className="muted">Không tìm thấy skill nào (thư mục có SKILL.md).</p>}
    {found && found.length > 0 && <ul className="skill-candidates">{found.map((c) => {
      const bad = c.problems.length > 0;
      return <li key={c.origin}><label>
        <input type="checkbox" disabled={bad} checked={picked.includes(c.name)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.name] : p.filter((n) => n !== c.name)))}/>
        <span><strong>{c.name}</strong>{c.hasScripts && <> <Badge tone="warn">Có script</Badge></>}{c.installed && <> <Badge tone="neutral">{c.sameAsInstalled ? 'Đã cài, không đổi' : 'Đã cài, có bản mới'}</Badge></>}
          <small className="skill-desc">{c.description || c.origin}</small>
          {bad && <small className="inline-error">{c.problems.join(' ')}</small>}
          <small className="muted mono">{c.files.length} file · {kb(c.sizeBytes)} · {c.origin}</small></span>
      </label></li>;
    })}</ul>}
    <div className="row-actions"><button className="button primary" disabled={busy || !picked.length} onClick={() => void install()}>Cài {picked.length || ''} skill</button><button className="button ghost" onClick={onClose}>Đóng</button></div>
  </Modal>;
}
