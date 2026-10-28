import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesignSnapshot, FigmaExportJob, InstallJob, IntegrationSummary, SnapshotDiff } from '../shared/design';
import type { ExportIssue, HelloInfo, RootInfo } from '../shared/figma';
import { DEFAULT_LIMITS } from '../shared/figma';
import { coverageLabel, identityLabel } from '../shared/designlabels';
import { api } from './api';
import { Badge, Empty, Field, Icon, Modal, PageHeader, ago, dateTime } from './ui';

type Listed = DesignSnapshot & { references: { projects: string[]; runs: string[] } };

const STEP_TONE: Record<string, string> = { done: 'good', skipped: 'neutral', running: 'blue', failed: 'bad', pending: 'neutral' };
const EXPORT_LABEL: Record<string, string> = {
  queued: 'Đang chờ', preparing: 'Chuẩn bị', inventory: 'Kiểm kê node', reading: 'Đọc thuộc tính', dependencies: 'Đọc style, variable, component', assets: 'Đọc tài nguyên', verifying: 'Đối chiếu',
  assembling: 'Dựng snapshot', review_ready: 'Chờ bạn duyệt', partial: 'Chưa đầy đủ', failed: 'Lỗi', cancelled: 'Đã hủy', interrupted: 'Bị gián đoạn',
};
const ACTIVE = ['queued', 'preparing', 'inventory', 'reading', 'dependencies', 'assets', 'verifying', 'assembling'];
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The MCP page: connect Figma Desktop directly, export a design into a snapshot, review it and publish it for tasks to use. */
export function McpPage() {
  const [summary, setSummary] = useState<IntegrationSummary | null>(null);
  const [install, setInstall] = useState<InstallJob | null>(null);
  const [jobs, setJobs] = useState<FigmaExportJob[]>([]);
  const [snapshots, setSnapshots] = useState<Listed[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [checking, setChecking] = useState<{ id: string; ok: boolean; detail: string }[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, j, s] = await Promise.all([api<IntegrationSummary[]>('/api/integrations'), api<FigmaExportJob[]>('/api/design-exports'), api<Listed[]>('/api/design-snapshots')]);
      setSummary(list[0] ?? null); setJobs(j); setSnapshots(s);
      const installs = await api<InstallJob[]>('/api/integrations/figma/install');
      setInstall(installs[0] ?? null);
      setError('');
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 2000); return () => clearInterval(t); }, [load]);

  const act = async (key: string, run: () => Promise<unknown>, done?: string) => {
    setBusy(key); setError(''); setNotice('');
    try { await run(); if (done) setNotice(done); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };

  const desktop = summary?.desktop, bundle = summary?.bundle, conn = summary?.connection;
  const installing = install?.status === 'running';
  const active = jobs.find((j) => ACTIVE.includes(j.status));

  return <>
    <PageHeader title="MCP" subtitle="Kết nối công cụ ngoài để lấy dữ liệu cho task. Hiện có Figma Desktop, đọc trực tiếp bằng plugin, không qua MCP server hay Figma REST API.">
      <span className="muted">Chưa có trình nhập MCP tùy ý trong bản này.</span>
    </PageHeader>
    {error && <div className="banner error" role="alert"><Icon name="alert" size={16}/><span>{error}</span></div>}
    {notice && <div className="banner" role="status"><Icon name="info" size={16}/><span>{notice}</span></div>}

    <section className="panel" aria-label="Figma Desktop · Kết nối trực tiếp">
      <div className="panel-heading"><h2>Figma Desktop · Kết nối trực tiếp</h2><Badge tone="blue">Desktop · Trực tiếp</Badge></div>
      <p className="muted">Plugin “AI Department Exporter” đọc file đang mở trong Figma Desktop rồi gửi về máy này. Department không nhận mật khẩu, cookie hay token đăng nhập của Figma.</p>
      {summary && !summary.platform.supported && <div className="notice-line warn">{summary.platform.reason}</div>}
      <dl className="status-grid">
        <div><dt>Figma Desktop</dt><dd data-testid="desktop-state">
          {!desktop ? '…' : desktop.state === 'installed' ? <Badge tone="good">Đã cài{desktop.version ? ` · ${desktop.version}` : ''}{desktop.running ? ' · đang mở' : ''}</Badge>
            : desktop.state === 'installing' ? <Badge tone="blue" live>Đang cài</Badge> : desktop.state === 'unverified' ? <Badge tone="bad">Không xác minh được</Badge> : <Badge tone="warn">Chưa cài</Badge>}
          {desktop?.note && <small>{desktop.note}</small>}</dd></div>
        <div><dt>Plugin Exporter</dt><dd data-testid="bundle-state">
          {!bundle ? '…' : bundle.state === 'prepared' ? <Badge tone="good">Đã chuẩn bị · cần import một lần</Badge> : bundle.state === 'missing' ? <Badge tone="warn">Chưa chuẩn bị</Badge> : bundle.state === 'stale' ? <Badge tone="warn">Cổng đã đổi, cần import lại</Badge> : <Badge tone="bad">Không tương thích</Badge>}
          {bundle?.note && <small>{bundle.note}</small>}</dd></div>
        <div><dt>Kết nối</dt><dd data-testid="connection-state">
          {!conn ? '…' : conn.state === 'connected' ? <Badge tone="good">Đã kết nối · {conn.hello?.fileName}</Badge> : conn.state === 'pairing' ? <Badge tone="blue" live>Chờ nhập mã</Badge> : conn.state === 'interrupted' ? <Badge tone="warn">Gián đoạn</Badge> : <Badge>Chưa ghép đôi</Badge>}
          {conn?.state === 'connected' && <small>Desktop đã mở chưa phải đã đọc đủ: bấm “Kiểm tra kết nối” để thử đọc.</small>}</dd></div>
        <div><dt>Export</dt><dd>{active ? <Badge tone="blue" live>{EXPORT_LABEL[active.status]}</Badge> : <Badge>Không có export đang chạy</Badge>}</dd></div>
      </dl>

      {conn?.state === 'pairing' && conn.pairingCode && <div className="notice-line" role="status">
        Nhập mã này vào plugin trong Figma (hết hạn {dateTime(conn.pairingCode.expiresAt)}): <strong className="mono" data-testid="pairing-code">{conn.pairingCode.code}</strong></div>}

      <div className="actions">
        <button className="button primary" disabled={!!busy || installing} onClick={() => void act('install', () => api('/api/integrations/figma/install', 'POST'))}>Cài Figma Desktop &amp; Exporter</button>
        <button className="button" disabled={!!busy || desktop?.state !== 'installed'} onClick={() => void act('open', () => api('/api/integrations/figma/open-desktop', 'POST'), 'Đã mở Figma. Hãy đăng nhập trên giao diện chính thức của Figma. Nếu trình duyệt đăng nhập xong mà app không nhận, tắt hẳn Figma rồi mở lại từ Start menu.')}>Mở Figma để đăng nhập</button>
        <button className="button" disabled={!!busy || !bundle || bundle.state === 'missing'} onClick={() => void act('folder', () => api('/api/integrations/figma/open-plugin-folder', 'POST'), 'Đã mở thư mục Exporter. Import manifest.json trong Figma.')}>Mở thư mục Exporter</button>
        {conn?.state === 'connected'
          ? <button className="button" disabled={!!busy || !!active} onClick={() => void act('disconnect', () => api('/api/integrations/figma/disconnect', 'POST'), 'Đã ngắt kết nối.')}>Ngắt kết nối</button>
          : <button className="button" disabled={!!busy} onClick={() => void act('pair', () => api('/api/integrations/figma/pairing', 'POST'))}>Ghép đôi</button>}
        <button className="button" disabled={!!busy || conn?.state !== 'connected' || !!active} onClick={() => void act('check', async () => { const r = await api<{ checks: { id: string; ok: boolean; detail: string }[] }>('/api/integrations/figma/check', 'POST'); setChecking(r.checks); })}>Kiểm tra kết nối</button>
        <button className="button primary" disabled={!!busy || conn?.state !== 'connected' || !!active} onClick={() => setExporting(true)}>Chọn nguồn và phạm vi</button>
      </div>
      {checking && <ul className="checklist" aria-label="Kết quả kiểm tra">{checking.map((c) => <li key={c.id}><Badge tone={c.ok ? 'good' : 'warn'}>{c.ok ? 'Đạt' : 'Lưu ý'}</Badge> {c.detail}</li>)}</ul>}
    </section>

    {install && <section className="panel" aria-label="Cài đặt">
      <div className="panel-heading"><h2>Cài đặt</h2><Badge tone={install.status === 'completed' ? 'good' : install.status === 'running' ? 'blue' : 'bad'} live={install.status === 'running'}>{install.status === 'completed' ? 'Hoàn tất' : install.status === 'running' ? 'Đang chạy' : install.status === 'failed' ? 'Lỗi' : 'Bị gián đoạn'}</Badge></div>
      <ol className="steps">{install.steps.map((s) => <li key={s.id}><Badge tone={STEP_TONE[s.status]}>{s.status === 'done' ? 'Xong' : s.status === 'skipped' ? 'Bỏ qua' : s.status === 'running' ? 'Đang làm' : s.status === 'failed' ? 'Lỗi' : 'Chờ'}</Badge> <strong>{s.label}</strong>{s.detail && <small> — {s.detail}</small>}</li>)}</ol>
      {install.error && <div className="banner error" role="alert"><Icon name="alert" size={16}/><span><strong>{install.error.message}</strong>{install.error.hint ? ` ${install.error.hint}` : ''}</span></div>}
      {installing && <button className="button" onClick={() => void act('cancel-install', () => api(`/api/integrations/figma/install/${install.id}/cancel`, 'POST'))}>Hủy</button>}
    </section>}

    <section className="panel" aria-label="Export">
      <div className="panel-heading"><h2>Export gần đây</h2></div>
      {!jobs.length && <Empty title="Chưa có export nào">Kết nối Figma rồi bấm “Chọn nguồn và phạm vi”.</Empty>}
      <ol className="project-list">{jobs.slice(0, 6).map((j) => <li className="project-entry" key={j.id}>
        <div className="project-main">
          <div className="project-name"><h3>{j.source.fileName}</h3><Badge tone={j.status === 'review_ready' ? 'good' : ACTIVE.includes(j.status) ? 'blue' : j.status === 'partial' ? 'warn' : 'bad'} live={ACTIVE.includes(j.status)}>{EXPORT_LABEL[j.status] ?? j.status}</Badge><Badge>{j.scope === 'file' ? 'Toàn bộ file' : j.scope === 'pages' ? 'Trang' : 'Frame đã chọn'}</Badge></div>
          <p className="project-summary"><span>{j.counts.nodes} node</span><span>{mb(j.counts.bytes)}</span><span>{ago(j.createdAt)}</span>{j.phase && <span>{j.phase}</span>}</p>
          {j.error && <p className="muted">{j.error.message}{j.error.hint ? ` ${j.error.hint}` : ''}</p>}
        </div>
        <div className="project-actions">
          {ACTIVE.includes(j.status) && <button className="button small" onClick={() => void act('cancel', () => api(`/api/design-exports/${j.id}/cancel`, 'POST'))}>Hủy</button>}
          {j.snapshotId && <button className="button small primary" onClick={() => setOpen(j.snapshotId!)}>Xem snapshot</button>}
        </div>
      </li>)}</ol>
    </section>

    <section className="panel" aria-label="Thư viện snapshot">
      <div className="panel-heading"><h2>Thư viện snapshot</h2></div>
      {!snapshots.length && <Empty title="Chưa có snapshot">Snapshot được tạo sau mỗi export và chỉ dùng cho task khi bạn đã duyệt.</Empty>}
      <ol className="project-list">{snapshots.map((s) => {
        const label = coverageLabel(s.coverage, s.issues);
        return <li className="project-entry" key={s.id}>
          <div className="project-main">
            <div className="project-name"><h3>{s.source.fileName}</h3>
              <Badge tone={s.status === 'published' ? 'good' : 'warn'}>{s.status === 'published' ? 'Đã duyệt' : 'Chờ duyệt'}</Badge>
              <Badge tone={label.limited ? 'warn' : 'good'}>{label.text}</Badge>
              {s.issues.some((i) => i.severity === 'blocker') && <Badge tone="bad">Có lỗi chặn</Badge>}</div>
            <p className="project-summary"><span>{s.counts.nodes} node</span><span>{s.counts.pages} trang</span><span>{s.counts.components} component</span><span>{s.counts.assets} tài nguyên</span><span>{ago(s.createdAt)}</span>
              <span>{s.references.projects.length + s.references.runs.length ? `Đang được dùng (${s.references.projects.length} dự án, ${s.references.runs.length} task)` : 'Chưa ai dùng'}</span></p>
          </div>
          <div className="project-actions">
            <button className="button small primary" onClick={() => setOpen(s.id)}>{s.status === 'published' ? 'Xem' : 'Xem và duyệt'}</button>
            <button className="button small" disabled={s.references.projects.length + s.references.runs.length > 0} title={s.references.projects.length + s.references.runs.length ? 'Còn được dự án hoặc task tham chiếu' : 'Xóa snapshot'} onClick={() => void act('delete', () => api(`/api/design-snapshots/${s.id}`, 'DELETE'), 'Đã xóa snapshot.')}>Xóa</button>
          </div>
        </li>;
      })}</ol>
    </section>

    {exporting && <ExportDialog snapshots={snapshots} onClose={() => setExporting(false)} onStarted={async () => { setExporting(false); await load(); }}/>}
    {open && <SnapshotDialog id={open} others={snapshots.filter((s) => s.id !== open)} onClose={() => setOpen(null)} onChanged={load}/>}
  </>;
}

// ------------------------------------------------------------------ export dialog

function ExportDialog({ snapshots, onClose, onStarted }: { snapshots: Listed[]; onClose: () => void; onStarted: () => Promise<void> }) {
  const [hello, setHello] = useState<HelloInfo | null>(null);
  const [scope, setScope] = useState<'selection' | 'pages' | 'file' | ''>('');
  const [roots, setRoots] = useState<string[]>([]);
  const [pages, setPages] = useState<string[]>([]);
  const [pageRoots, setPageRoots] = useState<RootInfo[]>([]);
  const [url, setUrl] = useState('');
  const [attest, setAttest] = useState(false);
  const [previous, setPrevious] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [limits, setLimits] = useState({ minutes: DEFAULT_LIMITS.jobMs / 60_000, nodes: DEFAULT_LIMITS.maxNodes, mb: DEFAULT_LIMITS.maxBytes / 1048576, assetMb: DEFAULT_LIMITS.maxAssetBytes / 1048576 });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ hello: HelloInfo }>('/api/integrations/figma/browse', 'POST', {}).then((r) => { setHello(r.hello); setScope(r.hello.selection.length ? 'selection' : ''); setRoots(r.hello.selection.map((s) => s.id)); }).catch((e) => setError((e as Error).message)); }, []);
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const needsAttest = !!hello && !hello.fileKey;
  const ready = !!hello && !!scope && (scope === 'file' || (scope === 'pages' ? pages.length > 0 : roots.length > 0)) && (!needsAttest || attest);
  const start = async () => {
    setBusy(true); setError('');
    try {
      await api('/api/design-exports', 'POST', {
        scope, rootIds: scope === 'selection' ? roots : undefined, pageIds: scope === 'pages' ? pages : undefined, declaredUrl: url.trim() || undefined, attestSource: needsAttest ? attest : undefined,
        previousSnapshotId: previous || undefined,
        ...(advanced ? { limits: { jobMs: limits.minutes * 60_000, maxNodes: limits.nodes, maxBytes: limits.mb * 1048576, maxAssetBytes: limits.assetMb * 1048576 } } : {}),
      });
      await onStarted();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const loadPage = async (pageId: string) => { try { const r = await api<{ roots?: RootInfo[] }>('/api/integrations/figma/browse', 'POST', { pageId }); setPageRoots(r.roots ?? []); } catch (e) { setError((e as Error).message); } };
  return <Modal title="Chọn nguồn và phạm vi" subtitle="Giữ file đang mở và đừng sửa nó cho tới khi export xong." onClose={onClose}>
    <div className="modal-body">
      {error && <div className="banner error" role="alert"><Icon name="alert" size={16}/><span>{error}</span></div>}
      {!hello && !error && <p className="muted">Đang đọc thông tin file từ Figma…</p>}
      {hello && <>
        <p><strong>{hello.fileName}</strong> · {hello.pages.length} trang · {hello.fileKey ? 'plugin trả được file key' : 'plugin không trả được file key'}</p>
        <fieldset className="field"><legend>Phạm vi</legend>
          <label><input type="radio" name="scope" checked={scope === 'selection'} onChange={() => setScope('selection')}/> Frame đang chọn ({hello.selection.length}){!hello.selection.length && ' — chưa chọn gì trong Figma'}</label>
          {scope === 'selection' && <>
            {hello.selection.map((s) => <label key={s.id} className="indent"><input type="checkbox" checked={roots.includes(s.id)} onChange={() => toggle(roots, setRoots, s.id)}/> {s.name} <small>({s.type}, {s.pageName})</small></label>)}
            <details className="indent"><summary>Chọn frame khác trong một trang</summary>
              {hello.pages.map((p) => <button type="button" className="button small" key={p.id} onClick={() => void loadPage(p.id)}>{p.name}</button>)}
              {pageRoots.map((s) => <label key={s.id} className="indent"><input type="checkbox" checked={roots.includes(s.id)} onChange={() => toggle(roots, setRoots, s.id)}/> {s.name} <small>({s.type})</small></label>)}
            </details></>}
          <label><input type="radio" name="scope" checked={scope === 'pages'} onChange={() => setScope('pages')}/> Một hoặc nhiều trang</label>
          {scope === 'pages' && hello.pages.map((p) => <label key={p.id} className="indent"><input type="checkbox" checked={pages.includes(p.id)} onChange={() => toggle(pages, setPages, p.id)}/> {p.name}</label>)}
          <label><input type="radio" name="scope" checked={scope === 'file'} onChange={() => setScope('file')}/> Toàn bộ file đang mở (lựa chọn tường minh; có thể chậm với file lớn)</label>
        </fieldset>
        <Field label="URL Figma của file (không bắt buộc)" hint="Nếu plugin trả được file key, URL sai file sẽ bị chặn."><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.figma.com/design/…"/></Field>
        {needsAttest && <label className="notice-line warn"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)}/> Tôi xác nhận đây đúng là file cần đọc: “{hello.fileName}”, {hello.pages.length} trang. Snapshot sẽ ghi “nguồn do người dùng xác nhận”.</label>}
        {snapshots.length > 0 && <Field label="Nối tiếp snapshot trước (tùy chọn)" hint="Chỉ chọn khi bạn chắc đây cùng một file, để xem được khác biệt."><select value={previous} onChange={(e) => setPrevious(e.target.value)}><option value="">Không nối</option>{snapshots.map((s) => <option key={s.id} value={s.id}>{s.source.fileName} · {dateTime(s.createdAt)}</option>)}</select></Field>}
        <label><input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)}/> Giới hạn nâng cao</label>
        {advanced && <div className="form-grid">
          <Field label="Thời gian tối đa (phút)"><input type="number" min={1} max={60} value={limits.minutes} onChange={(e) => setLimits({ ...limits, minutes: Number(e.target.value) })}/></Field>
          <Field label="Số node tối đa"><input type="number" min={1} max={200000} value={limits.nodes} onChange={(e) => setLimits({ ...limits, nodes: Number(e.target.value) })}/></Field>
          <Field label="Dung lượng tối đa (MB)"><input type="number" min={1} max={2048} value={limits.mb} onChange={(e) => setLimits({ ...limits, mb: Number(e.target.value) })}/></Field>
          <Field label="Một tài nguyên tối đa (MB)"><input type="number" min={1} max={100} value={limits.assetMb} onChange={(e) => setLimits({ ...limits, assetMb: Number(e.target.value) })}/></Field>
        </div>}
        <p className="muted">Chạm giới hạn sẽ tạo bản chưa đầy đủ để xem, không tự giảm phạm vi hay nâng trần.</p>
      </>}
    </div>
    <div className="modal-footer"><button className="button" onClick={onClose}>Đóng</button><button className="button primary" disabled={!ready || busy} onClick={() => void start()}>Bắt đầu export</button></div>
  </Modal>;
}

// ------------------------------------------------------------------ snapshot review

interface NodeRow { id: string; name: string; type: string; hasChildren: boolean }
type NodeRecord = { id: string; type: string; name: string; fields: Record<string, { s: string; v?: unknown; r?: string; a?: string }>; groups: Record<string, string> };

/**
 * Review of one snapshot: how much was read (six separate measures, never one percentage), what could not be, the data itself, the
 * difference from an earlier export, and the one decision that makes it usable by tasks. The accepted limits are ticked one by one and
 * the choice is dropped as soon as the snapshot changes.
 */
export function SnapshotDialog({ id, others, onClose, onChanged }: { id: string; others: Listed[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const [snap, setSnap] = useState<(Listed & { integrity: { ok: boolean; problems: string[] } }) | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'inventory' | 'issues' | 'nodes' | 'diff'>('inventory');
  const [acked, setAcked] = useState<{ hash: string; ids: string[] }>({ hash: '', ids: [] });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<NonNullable<typeof snap>>(`/api/design-snapshots/${id}`).then(setSnap).catch((e) => setError((e as Error).message)), [id]);
  useEffect(() => { void load(); }, [load]);
  if (!snap) return <Modal title="Snapshot" onClose={onClose}><div className="modal-body">{error ? <div className="banner error" role="alert">{error}</div> : <p className="muted">Đang tải…</p>}</div></Modal>;

  // A choice made for another hash is not a choice about this one.
  const chosen = acked.hash === snap.snapshotHash ? acked.ids : [];
  const blockers = snap.issues.filter((i) => i.severity === 'blocker'), limits = snap.issues.filter((i) => i.severity === 'limit'), infos = snap.issues.filter((i) => i.severity === 'info');
  const label = coverageLabel(snap.coverage, snap.issues);
  const allAcked = limits.every((i) => chosen.includes(i.id));
  const canPublish = snap.status === 'draft' && !blockers.length && allAcked && snap.integrity.ok;
  const c = snap.coverage;
  const publish = async () => {
    setBusy(true); setError('');
    try { await api(`/api/design-snapshots/${snap.id}/publish`, 'POST', { snapshotHash: snap.snapshotHash, acknowledgedIssueIds: chosen }); await onChanged(); await load(); } catch (e) { setError((e as Error).message); void load(); } finally { setBusy(false); }
  };
  const g = c.fieldCoverage.all;
  return <Modal title={`Snapshot · ${snap.source.fileName}`} subtitle={`${label.text} · ${identityLabel(snap.source.identity)}`} onClose={onClose}>
    <div className="modal-body">
      {error && <div className="banner error" role="alert"><Icon name="alert" size={16}/><span>{error}</span></div>}
      {!snap.integrity.ok && <div className="banner error" role="alert"><Icon name="alert" size={16}/><span>Dữ liệu snapshot không còn khớp bản đã lưu: {snap.integrity.problems.slice(0, 2).join(' ')}</span></div>}
      <div className="tabs" role="tablist">{(['inventory', 'issues', 'nodes', 'diff'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{({ inventory: 'Kiểm kê', issues: `Giới hạn (${blockers.length + limits.length})`, nodes: 'Node', diff: 'So sánh' })[t]}</button>)}</div>

      {tab === 'inventory' && <>
        <table className="table" aria-label="Kiểm kê"><tbody>
          <tr><th>Cấu trúc</th><td>{c.structureComplete ? 'Đã đọc đủ cấu trúc trong phạm vi' : 'Cấu trúc có lỗi'}</td></tr>
          <tr><th>Trường dữ liệu</th><td>{g.read} đã đọc · {g.mixed} thay đổi theo đoạn · {g.notApplicable} không áp dụng · {g.unsupported} chưa hỗ trợ · {g.unavailable} không đọc được · {g.error} lỗi (trên {g.total})</td></tr>
          <tr><th>Phụ thuộc</th><td>{c.dependencyCoverage.resolved}/{c.dependencyCoverage.total} có dữ liệu · {c.dependencyCoverage.dependencyOnly} chỉ để tham chiếu · {c.dependencyCoverage.unavailable} không đọc được</td></tr>
          <tr><th>Tài nguyên</th><td>{c.assetCoverage.stored}/{c.assetCoverage.total} đã lưu · {c.assetCoverage.missing} thiếu · {c.assetCoverage.oversize} quá lớn · {c.assetCoverage.error} lỗi · {c.assetCoverage.previewOnly} ảnh xem trước</td></tr>
          <tr><th>Nguồn</th><td>{identityLabel(c.sourceIdentity)}</td></tr>
          <tr><th>Nhất quán</th><td>{c.consistency === 'unchanged_across_passes' ? 'Không thấy thay đổi qua các lượt đối chiếu (Figma không khóa tài liệu)' : c.consistency === 'source_changed' ? 'Nguồn đã thay đổi lúc đọc' : 'Chưa đối chiếu'}</td></tr>
        </tbody></table>
        <p className="muted">{snap.counts.nodes} node · {snap.counts.pages} trang · {snap.counts.components} component · {snap.counts.styles} style · {snap.counts.variables} variable · {snap.counts.assets} tài nguyên · hash <span className="mono">{snap.snapshotHash.slice(0, 12)}</span></p>
        <Previews snap={snap}/>
      </>}

      {tab === 'issues' && <>
        {blockers.length > 0 && <><h3>Lỗi chặn (không thể duyệt)</h3><ul>{blockers.map((i) => <li key={i.id}><Badge tone="bad">Chặn</Badge> {i.message}</li>)}</ul></>}
        {limits.length > 0 && <><h3>Giới hạn cần bạn xác nhận từng mục</h3><ul className="checklist">{limits.map((i) => <li key={i.id}><label><input type="checkbox" disabled={snap.status === 'published'} checked={snap.status === 'published' ? !!snap.publish?.acknowledgedIssueIds.includes(i.id) : chosen.includes(i.id)}
          onChange={(e) => setAcked({ hash: snap.snapshotHash, ids: e.target.checked ? [...chosen, i.id] : chosen.filter((x) => x !== i.id) })}/> {i.message}</label></li>)}</ul>
          <p className="muted">Task cần dữ liệu thiếu này vẫn bị chặn trước khi gọi AI; xác nhận ở đây không vượt được yêu cầu bắt buộc của hợp đồng.</p></>}
        {infos.length > 0 && <><h3>Ghi chú</h3><ul>{infos.map((i) => <li key={i.id}>{i.message}</li>)}</ul></>}
        {!snap.issues.length && <p>Không có issue nào.</p>}
      </>}

      {tab === 'nodes' && <NodeBrowser snapshotId={snap.id} roots={snap.roots}/>}
      {snap.status === 'published' && <ProjectDefault snapshotId={snap.id}/>}
      {tab === 'diff' && <DiffTab headId={snap.id} others={others}/>}
    </div>
    <div className="modal-footer">
      <button className="button" onClick={onClose}>Đóng</button>
      {snap.status === 'published'
        ? <Badge tone="good">Đã duyệt {snap.publish ? dateTime(snap.publish.publishedAt) : ''}{snap.limited ? ' · Có giới hạn' : ''}</Badge>
        : <button className="button primary" disabled={!canPublish || busy} title={!canPublish ? (blockers.length ? 'Còn lỗi chặn' : 'Xác nhận từng giới hạn trước') : 'Duyệt để task dùng'} onClick={() => void publish()}>Duyệt snapshot{snap.limited || limits.length ? ' (có giới hạn)' : ''}</button>}
    </div>
  </Modal>;
}

/** Makes a published snapshot the default for new tasks of a project. Existing tasks keep the source their contract locked. */
function ProjectDefault({ snapshotId }: { snapshotId: string }) {
  const [projects, setProjects] = useState<{ id: string; name: string; designSource?: { snapshotId: string } }[]>([]);
  const [pick, setPick] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => { api<typeof projects>('/api/projects').then(setProjects).catch(() => setProjects([])); }, []);
  const save = async (snapshot: string | null) => {
    try { await api(`/api/projects/${pick}/design-source`, 'POST', { snapshotId: snapshot }); setMessage(snapshot ? 'Đã đặt làm nguồn mặc định cho task mới của dự án.' : 'Đã bỏ nguồn mặc định.'); setProjects(await api<typeof projects>('/api/projects')); }
    catch (e) { setMessage((e as Error).message); }
  };
  const chosen = projects.find((p) => p.id === pick);
  return <div className="notice-line" aria-label="Nguồn mặc định của dự án">
    <Field label="Dùng làm nguồn mặc định cho dự án"><select value={pick} onChange={(e) => { setPick(e.target.value); setMessage(''); }}><option value="">Chọn dự án…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.designSource?.snapshotId === snapshotId ? ' · đang dùng bản này' : ''}</option>)}</select></Field>
    <div className="actions"><button className="button small" disabled={!pick} onClick={() => void save(snapshotId)}>Đặt làm mặc định</button>
      {chosen?.designSource && <button className="button small" onClick={() => void save(null)}>Bỏ nguồn mặc định</button>}</div>
    {message && <p role="status">{message}</p>}
  </div>;
}

function Previews({ snap }: { snap: DesignSnapshot }) {
  const previews = snap.files.filter((f) => f.kind === 'asset' && f.mime === 'image/png').slice(0, 6);
  if (!previews.length) return null;
  return <div className="preview-strip" aria-label="Ảnh xem trước">{previews.map((f) => <img key={f.id} alt="Ảnh xem trước (không phải dữ liệu gốc)" src={`/api/design-snapshots/${snap.id}/files/${f.id}`} width={96} height={96}/>)}</div>;
}

function NodeBrowser({ snapshotId, roots }: { snapshotId: string; roots: RootInfo[] }) {
  const [rows, setRows] = useState<NodeRow[]>([]);
  const [trail, setTrail] = useState<NodeRow[]>([]);
  const [record, setRecord] = useState<NodeRecord | null>(null);
  const [error, setError] = useState('');
  const first = useRef(true);
  const children = useCallback((parent?: string) => api<NodeRow[]>(`/api/design-snapshots/${snapshotId}/tree${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`).then(setRows).catch((e) => setError((e as Error).message)), [snapshotId]);
  useEffect(() => { if (first.current) { first.current = false; void children(); } }, [children]);
  const enter = (n: NodeRow) => { setTrail([...trail, n]); void children(n.id); void api<NodeRecord>(`/api/design-snapshots/${snapshotId}/nodes/${encodeURIComponent(n.id)}`).then(setRecord).catch((e) => setError((e as Error).message)); };
  return <div>
    {error && <div className="banner error" role="alert">{error}</div>}
    <p className="muted">{roots.length} node gốc. {trail.length > 0 && <button className="button small" onClick={() => { const t = trail.slice(0, -1); setTrail(t); setRecord(null); void children(t.at(-1)?.id); }}>← {trail.at(-1)!.name}</button>}</p>
    <ul className="checklist">{rows.map((n) => <li key={n.id}><button type="button" className="button small" onClick={() => enter(n)}>{n.name || n.id}</button> <small>{n.type}{n.hasChildren ? ' · có node con' : ''}</small></li>)}</ul>
    {record && <details open><summary>Bản ghi {record.id} ({record.type})</summary>
      <p>Nhóm trường: {Object.entries(record.groups).map(([g, s]) => `${g}: ${s}`).join(' · ')}</p>
      <table className="table" aria-label="Trường của node"><thead><tr><th>Trường</th><th>Trạng thái</th><th>Giá trị</th></tr></thead><tbody>
        {Object.entries(record.fields).slice(0, 120).map(([k, f]) => <tr key={k}><td className="mono">{k}</td><td>{f.s}</td><td className="mono">{f.s === 'read' || f.s === 'mixed' ? JSON.stringify(f.v).slice(0, 160) : f.r}</td></tr>)}
      </tbody></table></details>}
  </div>;
}

function DiffTab({ headId, others }: { headId: string; others: Listed[] }) {
  const [base, setBase] = useState('');
  const [diff, setDiff] = useState<SnapshotDiff | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { if (!base) { setDiff(null); return; } api<SnapshotDiff>(`/api/design-snapshots/${headId}/diff?base=${base}`).then((d) => { setDiff(d); setError(''); }).catch((e) => setError((e as Error).message)); }, [base, headId]);
  return <div>
    <Field label="So với snapshot"><select value={base} onChange={(e) => setBase(e.target.value)}><option value="">Chọn…</option>{others.map((s) => <option key={s.id} value={s.id}>{s.source.fileName} · {dateTime(s.createdAt)}</option>)}</select></Field>
    {error && <div className="banner error" role="alert">{error}</div>}
    {diff && !diff.comparable && <p className="notice-line warn">{diff.reason}</p>}
    {diff?.comparable && <>
      <p>{diff.summary.added} thêm · {diff.summary.removed} xóa · {diff.summary.changed} đổi</p>
      <ul>{[...diff.nodes, ...diff.components, ...diff.tokens, ...diff.assets].slice(0, 80).map((d) => <li key={`${d.type}-${d.id}`}><Badge tone={d.change === 'added' ? 'good' : d.change === 'removed' ? 'bad' : 'warn'}>{d.change === 'added' ? 'Thêm' : d.change === 'removed' ? 'Xóa' : 'Đổi'}</Badge> {d.type} {d.name ?? d.id}{d.fields?.length ? ` · ${d.fields.slice(0, 5).join(', ')}` : ''}</li>)}</ul>
      {diff.newIssues.length > 0 && <><h4>Giới hạn mới</h4><ul>{diff.newIssues.map((i: ExportIssue) => <li key={i.id}>{i.message}</li>)}</ul></>}
    </>}
  </div>;
}
